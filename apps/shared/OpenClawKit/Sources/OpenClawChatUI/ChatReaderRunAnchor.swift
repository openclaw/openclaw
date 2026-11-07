#if os(iOS)
import SwiftUI
import UIKit

/// Away from the live edge, the reader keeps the newest run's answer where they left it.
///
/// Finalization replaces the live cell (working chrome plus streaming text) with the final
/// answer row, and settled work above it is regrouped. Those are deletions and insertions,
/// not size changes, so List keeps the raw content offset and the answer jumps. The answer
/// text itself is shared by both cells, so its top is the anchor. It is measured only when
/// the scroller lays out or scrolls; nothing observes the transcript per token.
@MainActor
final class ChatReaderRunAnchor {
    /// Newest run whose live answer was shown; it survives finalization.
    private(set) var run: String?
    /// Held marker's top relative to the viewport while the reader holds it.
    private(set) var pin: CGFloat?
    /// The held block (whitespace-free text key) of the run's answer; nil = the answer top.
    private(set) var pinKey: String?
    private weak var follow: ChatScrollFollowState?
    private weak var scroller: UIScrollView?
    private var sentinel: Sentinel?
    private var observations: [NSKeyValueObservation] = []
    private var markers: [ObjectIdentifier: Entry] = [:]
    private var reconciling = false
    /// Explicit navigation owns the position until the reader scrolls again.
    private var released = false
    private var settlePending = false

    private struct Entry {
        weak var view: UIView?
        let run: String
        let key: String?
        let isLive: Bool
    }

    func register(_ marker: UIView, tag: ChatReaderAnchorTag) {
        self.follow = tag.follow
        if tag.isLive, self.run != tag.run {
            self.run = tag.run
            self.pin = nil
            self.pinKey = nil
        }
        let isNew = self.markers[ObjectIdentifier(marker)] == nil
        self.markers[ObjectIdentifier(marker)] = Entry(view: marker, run: tag.run, key: tag.block, isLive: tag.isLive)
        self.attach(from: marker)
        if isNew { self.scheduleSettle() }
    }

    func release() {
        self.pin = nil
        self.pinKey = nil
        self.released = true
    }

    func unregister(_ marker: UIView) {
        self.markers.removeValue(forKey: ObjectIdentifier(marker))
        self.scheduleSettle()
    }

    /// A replaced cell can be positioned after the scroller's contentSize change that
    /// announced it, and an equal-height swap announces nothing (r1: 14 pt for 0.3 s).
    /// Measure once more after the current layout, only on cell churn or a correction.
    private func scheduleSettle() {
        guard !self.settlePending, self.pin != nil else { return }
        self.settlePending = true
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.settlePending = false
            self.reconcile()
        }
    }

    func attach(from marker: UIView) {
        var parent = marker.superview
        while let view = parent, !(view is UIScrollView) {
            parent = view.superview
        }
        guard let scroll = parent as? UIScrollView, scroll !== self.scroller else { return }
        self.scroller = scroll
        self.pin = nil
        self.pinKey = nil
        self.sentinel?.removeFromSuperview()
        let sentinel = Sentinel(frame: .zero)
        sentinel.anchor = self
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

    /// Size and offset changes arrive mid-layout, before List has positioned replaced cells or
    /// applied its own self-sizing compensation (r1/r2: a -74 then +14 pt pair, and same-frame
    /// +/-2.3 pt pairs). Measure once the scroller's layout pass has finished: the sentinel is a
    /// subview, so it lays out after its parent, in the same commit, before the frame renders.
    func layoutChanged() {
        guard !self.reconciling else { return }
        if let follow = self.follow, follow.followTarget != .latest,
           follow.isUserScrolling || (self.scroller?.isTracking ?? false) ||
           (self.scroller?.isDragging ?? false) || (self.scroller?.isDecelerating ?? false)
        {
            self.reconcile() // The reader moves; pin updates only, no write.
            return
        }
        self.sentinel?.setNeedsLayout()
    }

    final class Sentinel: UIView {
        weak var anchor: ChatReaderRunAnchor?

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
            self.anchor?.reconcile()
        }
    }

    /// The owning List cell, independent of UIKit's intermediate container views.
    private static func cell(of marker: UIView, in scroll: UIScrollView) -> UICollectionViewCell? {
        var view: UIView? = marker
        while let current = view, current !== scroll {
            if let cell = current as? UICollectionViewCell { return cell }
            view = current.superview
        }
        return nil
    }

    /// Mounted replacement cells can still carry their sizing origin. Only the collection's
    /// current item and committed layout frame may supply reader geometry (s3: a 13,889 pt write).
    private static func isPositioned(_ marker: UIView, in scroll: UIScrollView) -> Bool {
        guard let collection = scroll as? UICollectionView,
              let cell = Self.cell(of: marker, in: scroll),
              let index = collection.indexPath(for: cell),
              collection.cellForItem(at: index) === cell,
              let layout = collection.layoutAttributesForItem(at: index) else { return false }
        let frame = cell.frame
        let expected = layout.frame
        let tolerance = 1 / (scroll.window?.screen.scale ?? 1)
        guard !frame.isEmpty, !expected.isEmpty,
              abs(frame.minX - expected.minX) <= tolerance,
              abs(frame.minY - expected.minY) <= tolerance,
              abs(frame.width - expected.width) <= tolerance,
              abs(frame.height - expected.height) <= tolerance else { return false }
        return cell.bounds.insetBy(dx: -tolerance, dy: -tolerance)
            .contains(marker.convert(CGPoint.zero, to: cell))
    }

    /// A laid-out marker of the anchored run inside the scroller: the answer top (key nil) or
    /// one block. When the live and final cells briefly coexist, the final one wins.
    private func marker(in scroll: UIScrollView, key: String?) -> UIView? {
        guard let run = self.run else { return nil }
        var live: UIView?
        for entry in self.markers.values where entry.run == run && entry.key == key {
            guard let view = entry.view, view.window != nil, view.bounds.height > 0,
                  view.isDescendant(of: scroll) else { continue }
            guard Self.isPositioned(view, in: scroll) else {
                continue
            }
            if !entry.isLive { return view }
            live = live ?? view
        }
        return live
    }

    private func offsetY(_ marker: UIView, in scroll: UIScrollView) -> CGFloat {
        marker.convert(CGPoint.zero, to: scroll).y - scroll.contentOffset.y
    }

    /// The reader's place: the topmost answer block whose top is inside the viewport.
    private func topVisibleBlock(in scroll: UIScrollView) -> (key: String, y: CGFloat)? {
        guard let run = self.run else { return nil }
        let top = scroll.adjustedContentInset.top
        let bottom = scroll.bounds.height - scroll.adjustedContentInset.bottom
        var best: (key: String, y: CGFloat)?
        for entry in self.markers.values where entry.run == run {
            guard let key = entry.key, let view = entry.view, view.window != nil, view.bounds.height > 0,
                  view.isDescendant(of: scroll), Self.isPositioned(view, in: scroll) else { continue }
            let y = self.offsetY(view, in: scroll)
            guard y.isFinite, y >= top, y < bottom else { continue }
            if best.map({ y < $0.y }) ?? true { best = (key, y) }
        }
        return best
    }

    func reconcile() {
        guard !self.reconciling, let follow = self.follow, let scroll = self.scroller,
              scroll.window != nil else { return }
        guard follow.followTarget != .latest else {
            self.pin = nil
            self.pinKey = nil
            self.released = false
            return
        }
        let interacting = follow.isUserScrolling || scroll.isTracking || scroll.isDragging || scroll.isDecelerating
        if interacting { self.released = false }
        guard !self.released else { return }
        if interacting {
            // Only the reader's own scroll sets the pin, and only while they are inside the answer.
            // Hold the block they are reading, so text reflowing above it inside the same answer
            // (s1c: final prose "P 9" wraps one more line than live "P9", +21.6 pt) cannot move it.
            let answer = self.marker(in: scroll, key: nil)
            let answerY = answer.map { self.offsetY($0, in: scroll) }
            guard let answerY, answerY.isFinite, answerY < scroll.adjustedContentInset.top else {
                // Answer not realized or not above the top: reading elsewhere (no stale pin).
                self.pin = nil
                self.pinKey = nil
                return
            }
            if let block = self.topVisibleBlock(in: scroll) {
                self.pinKey = block.key
                self.pin = block.y
            } else {
                self.pinKey = nil
                self.pin = answerY
            }
            return
        }
        // Never pin without the reader: cell churn (a live cell removed and re-added) measured a new
        // marker before List placed it and pinned there, then "corrected" by 1117 pt (f5 probe).
        guard let pin = self.pin, let marker = self.marker(in: scroll, key: self.pinKey) else { return }
        Self.cell(of: marker, in: scroll)?.layoutIfNeeded()
        guard Self.isPositioned(marker, in: scroll) else { return }
        let y = self.offsetY(marker, in: scroll)
        guard y.isFinite, abs(y - pin) > 0.5 else { return }
        let minY = -scroll.adjustedContentInset.top
        let maxY = max(minY, scroll.contentSize.height - scroll.bounds.height + scroll.adjustedContentInset.bottom)
        let target = min(max(scroll.contentOffset.y + y - pin, minY), maxY)
        guard abs(target - scroll.contentOffset.y) > 0.5 else { return }
        self.reconciling = true
        defer { self.reconciling = false }
        scroll.setContentOffset(CGPoint(x: scroll.contentOffset.x, y: target), animated: false)
        self.scheduleSettle()
    }
}

struct ChatReaderAnchorTag: Equatable {
    let follow: ChatScrollFollowState
    let run: String
    let isLive: Bool
    /// Block identity inside the answer (whitespace-free text prefix); nil marks the answer top.
    var block: String?

    func block(_ key: String) -> Self {
        var tag = self
        tag.block = key
        return tag
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.follow === rhs.follow && lhs.run == rhs.run && lhs.isLive == rhs.isLive && lhs.block == rhs.block
    }
}

/// Marks the top of one answer block. No layout callbacks: a long answer carries many of these,
/// and the scroller's KVO plus the sentinel already time every measurement.
struct ChatReaderBlockMarker: UIViewRepresentable {
    let tag: ChatReaderAnchorTag

    final class Marker: UIView {
        weak var anchor: ChatReaderRunAnchor?
    }

    func makeUIView(context: Context) -> Marker {
        let marker = Marker()
        marker.isUserInteractionEnabled = false
        marker.accessibilityElementsHidden = true
        return marker
    }

    func updateUIView(_ marker: Marker, context: Context) {
        let anchor = self.tag.follow.readerAnchor
        marker.anchor = anchor
        anchor.register(marker, tag: self.tag)
    }

    static func dismantleUIView(_ marker: Marker, coordinator: ()) {
        marker.anchor?.unregister(marker)
        marker.anchor = nil
    }
}

/// Marks the top of a run's answer text.
struct ChatReaderAnchorMarker: UIViewRepresentable {
    let tag: ChatReaderAnchorTag

    final class Marker: UIView {
        weak var anchor: ChatReaderRunAnchor?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard self.window != nil else { return }
            self.anchor?.attach(from: self)
            self.anchor?.layoutChanged()
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            self.anchor?.layoutChanged()
        }
    }

    func makeUIView(context: Context) -> Marker {
        let marker = Marker()
        marker.isUserInteractionEnabled = false
        marker.accessibilityElementsHidden = true
        return marker
    }

    func updateUIView(_ marker: Marker, context: Context) {
        let anchor = self.tag.follow.readerAnchor
        marker.anchor = anchor
        anchor.register(marker, tag: self.tag)
    }

    static func dismantleUIView(_ marker: Marker, coordinator: ()) {
        marker.anchor?.unregister(marker)
        marker.anchor = nil
    }
}

extension EnvironmentValues {
    @Entry var openClawReaderAnchor: ChatReaderAnchorTag?
}

extension View {
    /// Marks a run's answer text so a reader away from the live edge keeps it in place.
    func chatReaderAnchor(_ tag: ChatReaderAnchorTag?) -> some View {
        self.background {
            if let tag { ChatReaderAnchorMarker(tag: tag) }
        }
    }

    /// Marks one block of a run's answer (see ChatReaderBlockMarker).
    func chatReaderBlockAnchor(_ tag: ChatReaderAnchorTag?, key: String?) -> some View {
        self.background(alignment: .topLeading) {
            if let tag, let key { ChatReaderBlockMarker(tag: tag.block(key)).frame(width: 1, height: 1) }
        }
    }
}
#endif
