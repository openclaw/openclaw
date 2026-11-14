#if os(iOS)
import QuartzCore
import SwiftUI
import UIKit

/// Keeps the rows a reader is looking at in place while history pages are added or dropped above them.
///
/// List keeps the raw content offset when rows change above the viewport, so the visible text would
/// move by the height of the change. A page read records the realized rows' content positions right
/// before it changes the transcript; once List lays out the change, the offset moves by however far
/// those rows moved. The shift is content-relative, so it never undoes the reader's own scrolling, and
/// the hold ends once the change settles: later self-sizing above the reader is ordinary scrolling.
@MainActor
final class ChatReaderPageAnchor {
    private struct Hold {
        let id: ChatAssistantListCell.ID
        var contentY: CGFloat
    }

    private struct Entry {
        weak var view: UIView?
    }

    /// Layout passes after the first correction; List settles replaced cells within these.
    private static let settlePasses = 3
    /// A change that moved nothing above the reader (a page dropped below them) ends the hold here.
    private static let holdLifetime: CFTimeInterval = 1

    private var markers: [ChatAssistantListCell.ID: Entry] = [:]
    private var holds: [Hold] = []
    private var capturedAt: CFTimeInterval = 0
    private var remainingSettles: Int?
    private weak var follow: ChatScrollFollowState?
    private weak var scroller: UIScrollView?
    private var sentinel: Sentinel?

    func register(_ marker: UIView, id: ChatAssistantListCell.ID) {
        self.markers[id] = Entry(view: marker)
    }

    func unregister(_ marker: UIView, id: ChatAssistantListCell.ID) {
        guard self.markers[id]?.view === marker else { return }
        self.markers.removeValue(forKey: id)
    }

    /// Records the realized rows against the current layout, before the transcript changes.
    func capture(_ follow: ChatScrollFollowState) {
        self.follow = follow
        self.holds = []
        guard let scroll = follow.transcriptScroller, scroll.window != nil else { return }
        if scroll !== self.scroller {
            self.scroller = scroll
            self.sentinel?.removeFromSuperview()
            let sentinel = Sentinel(frame: .zero)
            sentinel.anchor = self
            scroll.addSubview(sentinel)
            self.sentinel = sentinel
        }
        for (id, entry) in self.markers {
            guard let view = entry.view, let y = Self.contentY(of: view, in: scroll) else { continue }
            self.holds.append(Hold(id: id, contentY: y))
        }
        // Prefer the row at the top of the viewport; any realized row below the change moves with it.
        let top = scroll.contentOffset.y + scroll.adjustedContentInset.top
        self.holds.sort { abs($0.contentY - top) < abs($1.contentY - top) }
        self.capturedAt = CACurrentMediaTime()
        self.remainingSettles = nil
        self.sentinel?.setNeedsLayout()
    }

    /// Runs after the scroller lays out, in the same commit, before the frame renders. A swap that
    /// adds and drops equal heights leaves the content size unchanged, so layout, not size, drives this.
    fileprivate func scrollerLaidOut() {
        guard !self.holds.isEmpty else { return }
        if self.reconcile(), self.remainingSettles == nil { self.remainingSettles = Self.settlePasses }
        if let remaining = self.remainingSettles {
            self.remainingSettles = remaining - 1
            if remaining <= 1 { self.holds = [] }
        } else if CACurrentMediaTime() - self.capturedAt >= Self.holdLifetime {
            self.holds = []
        }
        guard !self.holds.isEmpty else { return }
        // List can apply the change on a later pass than the one that read the capture.
        DispatchQueue.main.async { [weak self] in self?.sentinel?.setNeedsLayout() }
    }

    /// Moves the offset by the held rows' content shift; true when a shift was applied.
    private func reconcile() -> Bool {
        guard let scroll = self.scroller, scroll.window != nil,
              // The live-edge follower owns the offset there.
              self.follow?.followTarget != .latest
        else {
            self.holds = []
            return false
        }
        for hold in self.holds {
            guard let view = self.markers[hold.id]?.view,
                  let y = Self.contentY(of: view, in: scroll) else { continue }
            let shift = y - hold.contentY
            guard abs(shift) > 0.5 else { return false }
            // Every held row moved with the same change above it.
            for index in self.holds.indices {
                self.holds[index].contentY += shift
            }
            let minY = -scroll.adjustedContentInset.top
            let maxY = max(minY, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
            // Assigning the offset, unlike setContentOffset(_:animated:), keeps a drag or fling going.
            scroll.contentOffset.y = min(max(scroll.contentOffset.y + shift, minY), maxY)
            return true
        }
        return false
    }

    private static func contentY(of marker: UIView, in scroll: UIScrollView) -> CGFloat? {
        guard marker.window != nil, marker.isDescendant(of: scroll),
              ChatReaderRunAnchor.isPositioned(marker, in: scroll) else { return nil }
        let y = marker.convert(CGPoint.zero, to: scroll).y
        return y.isFinite ? y : nil
    }

    final class Sentinel: UIView {
        weak var anchor: ChatReaderPageAnchor?

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
            self.anchor?.scrollerLaidOut()
        }
    }
}

/// Marks the top of one transcript cell for ChatReaderPageAnchor.
struct ChatReaderRowMarker: UIViewRepresentable {
    let id: ChatAssistantListCell.ID
    let anchor: ChatReaderPageAnchor

    final class Marker: UIView {
        var id: ChatAssistantListCell.ID?
        weak var anchor: ChatReaderPageAnchor?
    }

    func makeUIView(context: Context) -> Marker {
        let marker = Marker()
        marker.isUserInteractionEnabled = false
        marker.accessibilityElementsHidden = true
        return marker
    }

    func updateUIView(_ marker: Marker, context: Context) {
        if let previous = marker.id, previous != self.id {
            marker.anchor?.unregister(marker, id: previous)
        }
        marker.id = self.id
        marker.anchor = self.anchor
        self.anchor.register(marker, id: self.id)
    }

    static func dismantleUIView(_ marker: Marker, coordinator: ()) {
        if let id = marker.id { marker.anchor?.unregister(marker, id: id) }
        marker.anchor = nil
    }
}

extension View {
    /// Lets a history page change keep this cell where the reader sees it.
    func chatReaderRowMarker(_ id: ChatAssistantListCell.ID, anchor: ChatReaderPageAnchor) -> some View {
        self.background(alignment: .topLeading) {
            ChatReaderRowMarker(id: id, anchor: anchor).frame(width: 1, height: 1)
        }
    }
}
#endif
