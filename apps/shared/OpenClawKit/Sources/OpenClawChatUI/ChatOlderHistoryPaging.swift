#if os(iOS)
import SwiftUI
import UIKit

/// Reader-driven older history for the iOS transcript List (web `ui/src/pages/chat/chat-pane-history.ts:292-381`).
///
/// Prepending rows keeps List's raw content offset, so everything on screen would drop by the
/// inserted height. Just before the rows are published, the topmost visible row's position in the
/// content is recorded; after the scroller's layout places the new rows, the content offset moves
/// by however far that row moved, so the same pixel stays under the reader (web
/// `chat-transcript-prepend-anchor.ts`). The correction is a plain offset shift, so it neither
/// animates nor stops a deceleration. Nothing here is measured per frame unless a restore is pending.
@MainActor
final class ChatOlderHistoryReader {
    /// Web `CHAT_HISTORY_PREFETCH_EDGE_PX` (`chat-pane-shared.ts:128`).
    static let prefetchEdge: CGFloat = 1200
    /// Layout passes a restore may wait for the prepend before it is abandoned.
    private static let restorePassLimit = 30

    private struct WeakMarker {
        weak var view: UIView?
    }

    private struct PendingRestore {
        let rowID: UUID
        /// The anchor row's content y the offset already accounts for.
        var contentY: CGFloat
        let contentHeight: CGFloat
        var estimated = false
        var moved = false
        var passes = 0
    }

    private var lastTopDistance: CGFloat?
    private var markers: [UUID: WeakMarker] = [:]
    private weak var scroller: UIScrollView?
    private var sentinel: Sentinel?
    private var observations: [NSKeyValueObservation] = []
    private var pending: PendingRestore?
    private var restoring = false

    /// True when the reader's own upward scroll moves within the prefetch edge. Layout-driven
    /// offset changes (prepends, keyboard, following) never count as intent.
    func observe(topDistance: CGFloat, readerScrolling: Bool) -> Bool {
        defer { self.lastTopDistance = topDistance }
        guard readerScrolling, let last = self.lastTopDistance else { return false }
        return topDistance < last && topDistance <= Self.prefetchEdge
    }

    func load(_ viewModel: OpenClawChatViewModel) {
        guard viewModel.canLoadOlderHistory, !viewModel.isLoadingOlderHistory else { return }
        viewModel.olderHistoryWillPrepend = { [weak self] in self?.recordAnchor() }
        Task { @MainActor in await viewModel.loadOlderHistory() }
    }

    func reset() {
        self.lastTopDistance = nil
        self.pending = nil
    }

    fileprivate func register(_ marker: UIView, id: UUID) {
        self.markers[id] = WeakMarker(view: marker)
        self.attach(from: marker)
        if self.pending?.rowID == id { self.sentinel?.setNeedsLayout() }
    }

    fileprivate func unregister(_ marker: UIView, id: UUID) {
        if self.markers[id]?.view === marker { self.markers[id] = nil }
    }

    private func attach(from marker: UIView) {
        var parent = marker.superview
        while let view = parent, !(view is UIScrollView) {
            parent = view.superview
        }
        guard let scroll = parent as? UIScrollView, scroll !== self.scroller else { return }
        self.scroller = scroll
        self.pending = nil
        self.sentinel?.removeFromSuperview()
        let sentinel = Sentinel(frame: .zero)
        sentinel.reader = self
        scroll.addSubview(sentinel)
        self.sentinel = sentinel
        self.observations = [
            scroll.observe(\.contentSize, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.layoutChanged() }
            },
            scroll.observe(\.bounds, options: [.new]) { [weak self] _, _ in
                MainActor.assumeIsolated { self?.layoutChanged() }
            },
        ]
    }

    private func layoutChanged() {
        guard self.pending != nil, !self.restoring else { return }
        self.sentinel?.setNeedsLayout()
    }

    private func mountedMarker(_ id: UUID, in scroll: UIScrollView) -> UIView? {
        guard let view = self.markers[id]?.view, view.window != nil, view.isDescendant(of: scroll) else { return nil }
        return view
    }

    /// Runs synchronously before the older rows are published, while List still shows the old rows.
    private func recordAnchor() {
        guard let scroll = self.scroller, scroll.window != nil else { return }
        let top = scroll.contentOffset.y + scroll.adjustedContentInset.top
        let bottom = scroll.contentOffset.y + scroll.bounds.height - scroll.adjustedContentInset.bottom
        var anchor: (id: UUID, y: CGFloat)?
        for id in self.markers.keys {
            guard let view = self.mountedMarker(id, in: scroll),
                  ChatReaderRunAnchor.isPositioned(view, in: scroll) else { continue }
            let y = view.convert(CGPoint.zero, to: scroll).y
            guard y + view.bounds.height > top, y < bottom else { continue }
            if anchor.map({ y < $0.y }) ?? true { anchor = (id, y) }
        }
        self.pending = anchor.map {
            PendingRestore(rowID: $0.id, contentY: $0.y, contentHeight: scroll.contentSize.height)
        }
        self.sentinel?.setNeedsLayout()
    }

    /// Called after the scroller's layout pass, before the frame renders.
    fileprivate func restore() {
        guard !self.restoring, var pending = self.pending,
              let scroll = self.scroller, scroll.window != nil else { return }
        pending.passes += 1
        if let view = self.mountedMarker(pending.rowID, in: scroll) {
            // A replaced cell can still carry its sizing origin; wait for its committed frame.
            if ChatReaderRunAnchor.isPositioned(view, in: scroll) {
                let y = view.convert(CGPoint.zero, to: scroll).y
                let shift = y - pending.contentY
                if abs(shift) > 0.5 {
                    self.shiftContentOffset(scroll, by: shift)
                    // Verify once more after the shifted layout settles.
                    self.sentinel?.setNeedsLayout()
                    pending.contentY = y
                    pending.moved = true
                } else if pending.moved {
                    self.pending = nil
                    return
                }
            }
        } else if !pending.estimated, scroll.contentSize.height != pending.contentHeight {
            // The inserted rows pushed the anchor out of the mounted range. Move by their
            // (estimated) height to mount it; the next pass measures the remainder.
            let estimate = scroll.contentSize.height - pending.contentHeight
            self.shiftContentOffset(scroll, by: estimate)
            pending.contentY += estimate
            pending.estimated = true
            pending.moved = true
            self.sentinel?.setNeedsLayout()
        }
        self.pending = pending.passes < Self.restorePassLimit ? pending : nil
    }

    private func shiftContentOffset(_ scroll: UIScrollView, by delta: CGFloat) {
        let minY = -scroll.adjustedContentInset.top
        let maxY = max(minY, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let y = min(max(scroll.contentOffset.y + delta, minY), maxY)
        guard abs(y - scroll.contentOffset.y) > 0.5 else { return }
        self.restoring = true
        defer { self.restoring = false }
        // Assign rather than `setContentOffset(_:animated:)`, so an active deceleration continues.
        scroll.contentOffset.y = y
    }

    /// A scroller subview lays out after its parent in the same commit, once List has placed its cells.
    final class Sentinel: UIView {
        weak var reader: ChatOlderHistoryReader?

        override init(frame: CGRect) {
            super.init(frame: frame)
            self.isUserInteractionEnabled = false
            self.accessibilityElementsHidden = true
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            self.reader?.restore()
        }
    }
}

/// Marks one transcript row so a prepend can measure where it sits. No callbacks while scrolling.
private struct ChatOlderHistoryRowMarker: UIViewRepresentable {
    let reader: ChatOlderHistoryReader
    let id: UUID

    final class Marker: UIView {
        weak var reader: ChatOlderHistoryReader?
        var rowID: UUID?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            if self.window != nil, let rowID = self.rowID { self.reader?.register(self, id: rowID) }
        }
    }

    func makeUIView(context: Context) -> Marker {
        let marker = Marker()
        marker.isUserInteractionEnabled = false
        marker.accessibilityElementsHidden = true
        return marker
    }

    func updateUIView(_ marker: Marker, context: Context) {
        if let previous = marker.rowID, previous != self.id { marker.reader?.unregister(marker, id: previous) }
        marker.reader = self.reader
        marker.rowID = self.id
        self.reader.register(marker, id: self.id)
    }

    static func dismantleUIView(_ marker: Marker, coordinator: ()) {
        if let rowID = marker.rowID { marker.reader?.unregister(marker, id: rowID) }
        marker.reader = nil
    }
}

extension View {
    /// Lets the prepend anchor measure this transcript row.
    func chatOlderHistoryRow(_ reader: ChatOlderHistoryReader, id: UUID) -> some View {
        self.background(ChatOlderHistoryRowMarker(reader: reader, id: id))
    }

    /// Requests the next older page after an upward reader scroll near the top of the transcript.
    func chatOlderHistoryTrigger(
        _ reader: ChatOlderHistoryReader,
        viewModel: OpenClawChatViewModel,
        scroll: ChatScrollFollowState,
        load: @escaping @MainActor () -> Void) -> some View
    {
        self.onScrollGeometryChange(for: CGFloat.self) { geometry in
            geometry.contentOffset.y + geometry.contentInsets.top
        } action: { _, topDistance in
            // A failed read stays manual until "Show earlier" succeeds (web `chat-pane-history.ts:332-337`).
            guard reader.observe(topDistance: topDistance, readerScrolling: scroll.isUserScrolling),
                  viewModel.canLoadOlderHistory, !viewModel.isLoadingOlderHistory,
                  !viewModel.olderHistoryLoadFailed else { return }
            load()
        }
    }
}

/// First List row while older history exists. Its height is constant across idle, loading and
/// failed states so the rows below it never move until a page is prepended.
struct ChatOlderHistoryBoundaryRow: View {
    let viewModel: OpenClawChatViewModel
    let load: @MainActor () -> Void

    var body: some View {
        if self.viewModel.canLoadOlderHistory {
            ZStack {
                if self.viewModel.isLoadingOlderHistory {
                    ProgressView()
                        .controlSize(.small)
                        .accessibilityLabel(Text("Loading earlier messages"))
                } else if self.viewModel.olderHistoryLoadFailed {
                    Button(action: self.load) {
                        Text("Show earlier")
                            .font(OpenClawChatTypography.footnote)
                    }
                    .buttonStyle(.borderless)
                    .foregroundStyle(.secondary)
                    .accessibilityIdentifier("chat-older-history-retry")
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44)
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
            .listRowBackground(Color.clear)
        }
    }
}
#endif
