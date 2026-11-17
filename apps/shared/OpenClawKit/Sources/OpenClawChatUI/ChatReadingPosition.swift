import CoreGraphics
import Foundation
#if os(iOS)
import SwiftUI
import UIKit
#endif

/// A transcript List row the reading position can hold.
enum ChatReadingRowKey: Hashable {
    case cell(ChatAssistantListCell.ID)
    /// A run's answer: the live cell while it streams, then the final answer row replacing it.
    /// Finalization is a delete plus an insert, so only this shared key keeps the reader on it.
    case answer(String)

    init(_ cell: ChatAssistantListCell) {
        if let runID = cell.group.runID {
            if cell.part == nil {
                self = .answer(runID)
                return
            }
            // While the run is live its earlier replies keep their own keys; the live cell is the answer.
            if !cell.group.includesLive, case let .row(row) = cell.part, row.id == cell.group.answerID {
                self = .answer(runID)
                return
            }
        }
        self = .cell(cell.id)
    }
}

/// The transcript scroller as the policy sees it, in content coordinates.
struct ChatReadingGeometry: Equatable {
    var offsetY: CGFloat
    var contentHeight: CGFloat
    var viewportHeight: CGFloat
    var insetTop: CGFloat
    var insetBottom: CGFloat

    var topOffset: CGFloat {
        -self.insetTop
    }

    var bottomOffset: CGFloat {
        max(self.topOffset, self.contentHeight - self.viewportHeight + self.insetBottom)
    }

    var visibleMinY: CGFloat {
        self.offsetY + self.insetTop
    }

    var visibleMaxY: CGFloat {
        self.offsetY + self.viewportHeight - self.insetBottom
    }

    func clamped(_ y: CGFloat) -> CGFloat {
        min(max(y, self.topOffset), self.bottomOffset)
    }
}

/// One laid-out List row: its key and its committed layout frame.
struct ChatReadingRow: Equatable {
    var key: ChatReadingRowKey
    var frame: CGRect
}

struct ChatReadingWrite: Equatable {
    enum Reason: Equatable {
        case follow
        case turn
        case anchor
        case prepend
        case jump
    }

    var y: CGFloat
    var reason: Reason
}

/// Where the transcript's reading position goes for each event (event + state -> target offset).
/// The only producer of transcript offsets on iOS; `ChatReadingPosition` applies its writes.
///
/// Modes (`ScrollFollowTarget?`): `.latest` follows the bottom edge, `.turn(id)` holds a sent
/// turn's top at 18% of the viewport, `nil` reads: the row at the top of the viewport stays at
/// its screen Y.
///
/// List itself writes the offset too: it compensates rows that self-size above the viewport, and
/// around a prepend it re-estimates the rows above and compensates that (a -746 then +744 pt pair
/// in the harness). So every correction is measured in screen space or from the end of the
/// content, both of which List's compensation leaves unchanged, never from a row's content
/// position alone, which would count List's compensation twice.
struct ChatReadingPolicy {
    static let turnAnchor: CGFloat = 0.18
    /// Layout passes a prepend may wait for its rows before it is abandoned.
    static let prependPassLimit = 30
    /// Passes after the rows land that still hold the position while List settles their sizes.
    static let prependSettlePasses = 3

    struct Anchor: Equatable {
        var key: ChatReadingRowKey
        /// Row top in content coordinates.
        var top: CGFloat
        /// Offset when `top` was measured: `top - offsetY` is the row's screen Y.
        var offsetY: CGFloat

        init(_ row: ChatReadingRow, offsetY: CGFloat) {
            self.key = row.key
            self.top = row.frame.minY
            self.offsetY = offsetY
        }
    }

    /// A disclosure toggle in flight: its layout change keeps the tapped header's screen Y.
    struct Disclosure: Equatable {
        var resumesFollowing: Bool
    }

    /// An older page about to land above the reader, usually mid-fling. Everything from the
    /// viewport down is unchanged by it, so the distance from the end of the content is the
    /// reading position. List's compensation moves content height and offset together and the
    /// reader's fling is re-read on every pass without new content, so neither is undone.
    struct Prepend: Equatable {
        var distanceFromEnd: CGFloat
        var contentHeight: CGFloat
        var passes = 0
        var passesSinceLanding: Int?
    }

    private(set) var mode: ScrollFollowTarget? = .latest
    private(set) var anchor: Anchor?
    private(set) var disclosure: Disclosure?
    private(set) var prepend: Prepend?

    /// While a prepend is pending every frame lays out, even if nothing changes: the reader's fling
    /// is re-read before the rows land, and once they land a later, unrelated content change
    /// cannot be read as part of the prepend.
    var needsNextPass: Bool {
        self.prepend != nil
    }

    /// Send, session open, a turn leaving the transcript, the reader's scroll starting.
    mutating func setMode(_ mode: ScrollFollowTarget?) {
        guard mode != self.mode else { return }
        self.mode = mode
        self.anchor = nil
        self.disclosure = nil
        self.prepend = nil
    }

    /// The reader's scroll ended away from the live edge: hold the row now at the top.
    mutating func readerSettled(_ geometry: ChatReadingGeometry, topRow: ChatReadingRow?) {
        self.mode = nil
        self.disclosure = nil
        self.anchor = topRow.map { Anchor($0, offsetY: geometry.offsetY) }
    }

    /// A disclosure is a user content edit: the rows above the tapped header, and so the header,
    /// stay put while its row grows or shrinks below it, even while following.
    mutating func disclosureWillToggle(_ geometry: ChatReadingGeometry, topRow: ChatReadingRow?) {
        let resumesFollowing = self.mode == .latest || self.disclosure?.resumesFollowing == true
        self.mode = nil
        self.anchor = topRow.map { Anchor($0, offsetY: geometry.offsetY) }
        self.disclosure = Disclosure(resumesFollowing: resumesFollowing)
    }

    /// The toggle's animation finished. Following resumes only if the reader was following and
    /// the bottom edge is still visible; resuming writes nothing, so the header stays.
    mutating func disclosureDidSettle(_ geometry: ChatReadingGeometry) {
        guard let disclosure, self.mode == nil else { return }
        self.disclosure = nil
        if disclosure.resumesFollowing, geometry.offsetY >= geometry.bottomOffset - 0.5 {
            self.mode = .latest
            self.anchor = nil
        }
    }

    /// Runs synchronously before older rows are published, while List still shows the old rows.
    mutating func olderPageWillPrepend(_ geometry: ChatReadingGeometry) {
        guard self.mode == nil else { return }
        self.prepend = Prepend(
            distanceFromEnd: geometry.contentHeight - geometry.offsetY,
            contentHeight: geometry.contentHeight)
    }

    mutating func jumpToLatest(_ geometry: ChatReadingGeometry) -> ChatReadingWrite? {
        self.setMode(.latest)
        return Self.write(geometry.bottomOffset, .jump, from: geometry)
    }

    /// A content size, viewport size, inset or keyboard change, after List has laid out its cells.
    /// `interacting`: the reader's finger, fling or system scroll (until SwiftUI reports idle).
    mutating func layout(
        _ geometry: ChatReadingGeometry,
        interacting: Bool,
        row: (ChatReadingRowKey) -> ChatReadingRow?,
        topRow: () -> ChatReadingRow?) -> ChatReadingWrite?
    {
        switch self.mode {
        case .latest:
            guard !interacting else { return nil }
            return Self.write(geometry.bottomOffset, .follow, from: geometry)
        case let .turn(id):
            guard !interacting, let turn = row(.cell(.row(id))) else { return nil }
            let viewport = geometry.viewportHeight - geometry.insetTop - geometry.insetBottom
            let desired = turn.frame.minY - (viewport - turn.frame.height) * Self.turnAnchor - geometry.insetTop
            return Self.write(geometry.clamped(desired), .turn, from: geometry)
        case nil:
            if interacting { self.disclosure = nil }
            if self.prepend != nil { return self.holdPrepend(geometry) }
            // The reader's own scroll owns the offset; List compensates rows sizing above it.
            guard !interacting else { return nil }
            return self.holdAnchor(geometry, row: row, topRow: topRow)
        }
    }

    /// Runs during the reader's fling too: the write is an assignment that does not stop it.
    private mutating func holdPrepend(_ geometry: ChatReadingGeometry) -> ChatReadingWrite? {
        guard var prepend = self.prepend else { return nil }
        prepend.passes += 1
        var write: ChatReadingWrite?
        if abs(geometry.contentHeight - prepend.contentHeight) > 0.5 {
            // Rows changed above the reader: hold the distance from the end. Accepted edge: the
            // reader's fling in the ~2 frames where List changes content at the landing is not kept
            // (~8 pt measured). There List's compensation cannot be told from the reader's scroll:
            // it can land before the content height changes, so observing the offset adopted it.
            write = Self.write(
                geometry.clamped(geometry.contentHeight - prepend.distanceFromEnd),
                .prepend,
                from: geometry)
            prepend.contentHeight = geometry.contentHeight
            prepend.distanceFromEnd = geometry.contentHeight - (write?.y ?? geometry.offsetY)
            prepend.passesSinceLanding = 0
        } else {
            // Unchanged content: the offset moved only by the reader's own scrolling.
            prepend.distanceFromEnd = geometry.contentHeight - geometry.offsetY
            prepend.passesSinceLanding = prepend.passesSinceLanding.map { $0 + 1 }
        }
        let settled = (prepend.passesSinceLanding ?? 0) >= Self.prependSettlePasses ||
            prepend.passes >= Self.prependPassLimit
        self.prepend = settled ? nil : prepend
        // The rows that held the position may be gone; hold the new top row from the next pass.
        if settled { self.anchor = nil }
        return write
    }

    private mutating func holdAnchor(
        _ geometry: ChatReadingGeometry,
        row: (ChatReadingRowKey) -> ChatReadingRow?,
        topRow: () -> ChatReadingRow?) -> ChatReadingWrite?
    {
        guard let anchor, let current = row(anchor.key) else {
            // The held row left the List (recycled, or replaced without a shared key).
            self.anchor = topRow().map { Anchor($0, offsetY: geometry.offsetY) }
            return nil
        }
        // Screen space: the held row returns to where the reader last saw it.
        let target = current.frame.minY - (anchor.top - anchor.offsetY)
        // A collapsing disclosure keeps its header even if blank space opens below the content;
        // only content shorter than the viewport pins it back to the top.
        let fits = geometry.bottomOffset <= geometry.topOffset
        let y = self.disclosure == nil || fits ? geometry.clamped(target) : max(target, geometry.topOffset)
        let write = Self.write(y, .anchor, from: geometry)
        self.anchor = Anchor(current, offsetY: write?.y ?? geometry.offsetY)
        return write
    }

    private static func write(
        _ y: CGFloat,
        _ reason: ChatReadingWrite.Reason,
        from geometry: ChatReadingGeometry) -> ChatReadingWrite?
    {
        guard y.isFinite, abs(y - geometry.offsetY) > 0.5 else { return nil }
        return ChatReadingWrite(y: y, reason: reason)
    }
}

#if os(iOS)
/// The one writer of the iOS transcript's content offset. Attached once to the List's
/// UICollectionView, it applies `ChatReadingPolicy` in the layout pass that changed the content,
/// after List has placed its cells and before the frame renders.
///
/// Triggers: content size changes, viewport size changes (a full-size autoresizing sentinel, so
/// scrolling never runs it), content inset changes, keyboard frame changes, and explicit events.
/// Nothing runs per scroll frame, except while an older page is landing (at most 30 frames).
@MainActor
final class ChatReadingPosition {
    private var policy = ChatReadingPolicy()
    /// Reader-scroll state between SwiftUI's interacting and idle phases.
    weak var follow: ChatScrollFollowState?
    private weak var scroller: UICollectionView?
    private var sentinel: Sentinel?
    private var observations: [NSKeyValueObservation] = []
    private var rows: [ChatReadingRowKey: WeakMarker] = [:]
    private var reconciling = false
    private var prependSignpost = ChatScrollSignpostInterval("OlderPagePrepend")

    private struct WeakMarker {
        weak var marker: Marker?
    }

    var mode: ScrollFollowTarget? {
        self.policy.mode
    }

    func setMode(_ mode: ScrollFollowTarget?) {
        self.policy.setMode(mode)
        self.sentinel?.setNeedsLayout()
    }

    func readerSettled() {
        guard let collection = self.scroller, let geometry = Self.geometry(collection) else {
            self.policy.setMode(nil)
            return
        }
        self.policy.readerSettled(geometry, topRow: self.topRow(in: collection, geometry))
    }

    func disclosureWillToggle() {
        guard let collection = self.scroller, let geometry = Self.geometry(collection) else { return }
        self.policy.disclosureWillToggle(geometry, topRow: self.topRow(in: collection, geometry))
    }

    func disclosureDidSettle() {
        guard let collection = self.scroller, let geometry = Self.geometry(collection) else { return }
        self.policy.disclosureDidSettle(geometry)
    }

    func olderPageWillPrepend() {
        ChatBehaviorProbe.mark("older-prepend")
        guard let collection = self.scroller, let geometry = Self.geometry(collection) else { return }
        self.policy.olderPageWillPrepend(geometry)
        guard self.policy.prepend != nil else { return }
        self.prependSignpost.begin()
        self.sentinel?.setNeedsLayout()
    }

    func jumpToLatest() {
        guard let collection = self.scroller, let geometry = Self.geometry(collection) else {
            self.policy.setMode(.latest)
            return
        }
        self.apply(self.policy.jumpToLatest(geometry), to: collection)
    }

    /// Keyboard avoidance may move only the safe area; measure after it.
    func keyboardFrameChanged() {
        self.sentinel?.setNeedsLayout()
    }

    func reset() {
        self.policy = ChatReadingPolicy()
        self.prependSignpost.end()
        self.sentinel?.setNeedsLayout()
    }

    // MARK: Rows

    func register(_ marker: Marker, key: ChatReadingRowKey) {
        if let old = marker.key, old != key, self.rows[old]?.marker === marker {
            self.rows[old] = nil
        }
        marker.key = key
        self.rows[key] = WeakMarker(marker: marker)
    }

    func unregister(_ marker: Marker) {
        if let key = marker.key, self.rows[key]?.marker === marker {
            self.rows[key] = nil
        }
        marker.key = nil
    }

    private func row(_ key: ChatReadingRowKey, in collection: UICollectionView) -> ChatReadingRow? {
        guard let marker = self.rows[key]?.marker else { return nil }
        return Self.row(of: marker, key: key, in: collection)
    }

    /// Only the collection's current cell for an item and its committed layout frame count: a
    /// replacement cell can still carry its sizing origin while it is mounted.
    private static func row(of marker: Marker, key: ChatReadingRowKey, in collection: UICollectionView)
        -> ChatReadingRow?
    {
        guard marker.window != nil else { return nil }
        var view: UIView? = marker
        while let current = view, current !== collection, !(current is UICollectionViewCell) {
            view = current.superview
        }
        guard let cell = view as? UICollectionViewCell,
              let index = collection.indexPath(for: cell),
              collection.cellForItem(at: index) === cell,
              let frame = collection.layoutAttributesForItem(at: index)?.frame,
              !frame.isEmpty else { return nil }
        return ChatReadingRow(key: key, frame: frame)
    }

    /// The topmost keyed row reaching into the viewport. Unkeyed rows (the older-history
    /// boundary, cards) never hold the position: rows are inserted below the boundary.
    private func topRow(in collection: UICollectionView, _ geometry: ChatReadingGeometry) -> ChatReadingRow? {
        var best: ChatReadingRow?
        for (key, entry) in self.rows {
            guard let marker = entry.marker, let row = Self.row(of: marker, key: key, in: collection),
                  row.frame.maxY > geometry.visibleMinY + 0.5, row.frame.minY < geometry.visibleMaxY
            else { continue }
            if best.map({ row.frame.minY < $0.frame.minY }) ?? true { best = row }
        }
        return best
    }

    // MARK: Scroller

    func attach(from view: UIView) {
        var parent = view.superview
        while let current = parent, !(current is UICollectionView) {
            parent = current.superview
        }
        guard let collection = parent as? UICollectionView, collection !== self.scroller else { return }
        ChatScrollWriter.watch(collection)
        self.scroller = collection
        // A horizontal-dominant swipe (drawer, back-swipe, sideways) must not scroll the transcript vertically.
        collection.isDirectionalLockEnabled = true
        self.sentinel?.removeFromSuperview()
        let sentinel = Sentinel(frame: CGRect(origin: .zero, size: collection.bounds.size))
        sentinel.owner = self
        collection.addSubview(sentinel)
        self.sentinel = sentinel
        self.observations = [
            collection.observe(\.contentSize, options: [.old, .new]) { [weak self] _, change in
                guard change.oldValue != change.newValue else { return }
                MainActor.assumeIsolated { self?.sentinel?.setNeedsLayout() }
            },
            collection.observe(\.contentInset, options: [.old, .new]) { [weak self] _, change in
                guard change.oldValue != change.newValue else { return }
                MainActor.assumeIsolated { self?.sentinel?.setNeedsLayout() }
            },
        ]
        sentinel.setNeedsLayout()
    }

    private static func geometry(_ scroll: UIScrollView) -> ChatReadingGeometry? {
        guard scroll.window != nil, scroll.bounds.height > 0 else { return nil }
        return ChatReadingGeometry(
            offsetY: scroll.contentOffset.y,
            contentHeight: scroll.contentSize.height,
            viewportHeight: scroll.bounds.height,
            insetTop: scroll.adjustedContentInset.top,
            insetBottom: scroll.adjustedContentInset.bottom)
    }

    /// Runs after the collection view's own layout pass, in the same commit.
    fileprivate func reconcile() {
        guard !self.reconciling, let collection = self.scroller else { return }
        self.reconciling = true
        defer {
            self.reconciling = false
            // The older page landed (or was abandoned): close its interval. Until it settles, lay
            // out every frame so the reader's fling is re-read between passes.
            if self.policy.prepend?.passesSinceLanding != nil || self.policy.prepend == nil {
                self.prependSignpost.end()
            }
            if self.policy.needsNextPass { self.sentinel?.setNeedsLayout() }
        }
        // A write re-lays out the cells, which can resize them again; converge within this pass.
        for _ in 0..<3 {
            guard let geometry = Self.geometry(collection) else { return }
            let interacting = collection.isTracking || collection.isDragging || collection.isDecelerating ||
                self.follow?.isUserScrolling == true
            guard let write = self.policy.layout(
                geometry,
                interacting: interacting,
                row: { self.row($0, in: collection) },
                topRow: { self.topRow(in: collection, geometry) }) else { return }
            self.apply(write, to: collection)
            collection.layoutIfNeeded()
        }
    }

    private func apply(_ write: ChatReadingWrite?, to scroll: UIScrollView) {
        guard let write else { return }
        let point = CGPoint(x: scroll.contentOffset.x, y: write.y)
        switch write.reason {
        case .follow:
            ChatScrollWriter.perform("ReadingPosition.follow") { scroll.setContentOffset(point, animated: false) }
        case .turn:
            ChatScrollWriter.perform("ReadingPosition.turn") { scroll.setContentOffset(point, animated: false) }
        case .jump:
            // Unanimated: an animated write reports `.animating`, which releases following.
            ChatScrollWriter.perform("ReadingPosition.jump") { scroll.setContentOffset(point, animated: false) }
        case .anchor:
            // Assign rather than `setContentOffset(_:animated:)`, so an active fling continues.
            ChatScrollSignpost.interval("ReadingRestore") {
                ChatScrollWriter.perform("ReadingPosition.anchor") { scroll.contentOffset = point }
            }
        case .prepend:
            ChatScrollSignpost.interval("ReadingRestore") {
                ChatScrollWriter.perform("ReadingPosition.prepend") { scroll.contentOffset = point }
            }
        }
    }

    /// Full-size and autoresizing: its layout runs after the collection view's in the same pass
    /// whenever it is marked, and viewport size changes mark it. Scrolling never does.
    private final class Sentinel: UIView {
        weak var owner: ChatReadingPosition?

        override init(frame: CGRect) {
            super.init(frame: frame)
            self.isUserInteractionEnabled = false
            self.accessibilityElementsHidden = true
            self.autoresizingMask = [.flexibleWidth, .flexibleHeight]
        }

        @available(*, unavailable)
        required init?(coder: NSCoder) {
            fatalError("init(coder:) is not supported")
        }

        override func layoutSubviews() {
            super.layoutSubviews()
            self.owner?.reconcile()
        }
    }

    /// Names one List cell for the owner. No layout callbacks and no geometry work.
    final class Marker: UIView {
        weak var owner: ChatReadingPosition?
        fileprivate(set) var key: ChatReadingRowKey?

        override func didMoveToWindow() {
            super.didMoveToWindow()
            guard self.window != nil else { return }
            self.owner?.attach(from: self)
        }
    }
}

struct ChatReadingRowMarker: UIViewRepresentable {
    let key: ChatReadingRowKey
    let owner: ChatReadingPosition

    func makeUIView(context: Context) -> ChatReadingPosition.Marker {
        let marker = ChatReadingPosition.Marker()
        marker.isUserInteractionEnabled = false
        marker.accessibilityElementsHidden = true
        marker.owner = self.owner
        return marker
    }

    func updateUIView(_ marker: ChatReadingPosition.Marker, context: Context) {
        marker.owner = self.owner
        self.owner.register(marker, key: self.key)
    }

    static func dismantleUIView(_ marker: ChatReadingPosition.Marker, coordinator: ()) {
        marker.owner?.unregister(marker)
        marker.owner = nil
    }
}

extension EnvironmentValues {
    @Entry var openClawReadingPosition: ChatReadingPosition?
}
#endif
