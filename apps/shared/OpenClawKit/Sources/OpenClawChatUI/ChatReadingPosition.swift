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
    case answerBlock(run: String, block: String)

    var answerRun: String? {
        if case let .answer(run) = self { return run }
        return nil
    }

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
    /// The scroller's whole bottom inset, including `floorInset`.
    var insetBottom: CGFloat
    /// Room under the content kept for a sent turn's reply (`ChatReadingPolicy.floor`); part of
    /// `insetBottom` but not of the visible area.
    var floorInset: CGFloat = 0

    var topOffset: CGFloat {
        -self.insetTop
    }

    var bottomOffset: CGFloat {
        max(self.topOffset, self.contentHeight - self.viewportHeight + self.insetBottom)
    }

    /// The bottom offset without the reply's room.
    var naturalBottomOffset: CGFloat {
        max(self.topOffset, self.contentHeight - self.viewportHeight + self.baseInsetBottom)
    }

    /// The composer, keyboard and safe area: the bottom inset the reader cannot see through.
    var baseInsetBottom: CGFloat {
        self.insetBottom - self.floorInset
    }

    var visibleMinY: CGFloat {
        self.offsetY + self.insetTop
    }

    var visibleMaxY: CGFloat {
        self.offsetY + self.viewportHeight - self.baseInsetBottom
    }

    func clamped(_ y: CGFloat) -> CGFloat {
        min(max(y, self.topOffset), self.bottomOffset)
    }
}

/// One laid-out List row: its key and its committed layout frame.
struct ChatReadingRow: Equatable {
    var key: ChatReadingRowKey
    var frame: CGRect
    var answerTop: CGFloat?
}

/// Where a sent turn rests while its reply begins.
enum ChatSentTurnRest: Equatable {
    /// Keyboard down: the turn's top at `ChatReadingPolicy.turnAnchor` of the visible height, with
    /// the rest of the screen kept for the reply.
    case anchor
    /// Keyboard up: the turn's bottom `reserve` above the composer, room for the reply's first row.
    case aboveComposer(reserve: CGFloat)
}

/// The send's springs. `rise` moves the offset and the bubble's height; `slide` the bubble's
/// sideways move, faster, so the path bends to the trailing side first like the reference.
struct ChatSendMotion: Equatable {
    static let rise = ChatSendMotion(response: 0.34, dampingFraction: 0.88)
    static let slide = ChatSendMotion(response: 0.24, dampingFraction: 1)
    /// Past this the spring is within a tenth of a point on any phone travel; it ends exactly there.
    static let settle: TimeInterval = 0.55

    var response: TimeInterval
    var dampingFraction: Double

    /// 0 at rest, 1 at the target, starting with no velocity.
    func progress(_ elapsed: TimeInterval) -> CGFloat {
        guard elapsed > 0 else { return 0 }
        guard elapsed < Self.settle else { return 1 }
        let omega = 2 * Double.pi / self.response
        let zeta = self.dampingFraction
        let decay = exp(-zeta * omega * elapsed)
        if zeta >= 1 { return CGFloat(1 - (1 + omega * elapsed) * decay) }
        let damped = omega * (1 - zeta * zeta).squareRoot()
        return CGFloat(1 - decay * (cos(damped * elapsed) + zeta * omega / damped * sin(damped * elapsed)))
    }
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
        var answerTop: CGFloat?
        /// Offset when `top` was measured: `top - offsetY` is the row's screen Y.
        var offsetY: CGFloat

        init(_ row: ChatReadingRow, offsetY: CGFloat) {
            self.key = row.key
            self.top = row.frame.minY
            self.answerTop = row.answerTop
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

    /// The jump button's glide to the live edge, held as a distance from the end of the content:
    /// List's compensation and a growing reply both move the end, and the glide lands wherever it is.
    struct Jump: Equatable {
        /// From farther away the glide starts this many viewports above the end, so List does not
        /// realize every row in between.
        static let maxViewports: CGFloat = 1.5
        var distance: CGFloat
        var duration: TimeInterval
    }

    /// The latest sent turn. Its room under the content lasts until the next send or session reset,
    /// shrinking as the reply fills it, so neither the reply's first row nor its words move the turn.
    struct SentTurn: Equatable {
        var key: ChatReadingRowKey
        var rest: ChatSentTurnRest
        /// The last room computed; kept while the turn's row is not laid out.
        var floor: CGFloat = 0
        /// Content under the turn when its row first laid out (the list's end padding), before any
        /// reply row: the reply's room is measured past it.
        var tail: CGFloat?
        /// Passes without the turn's row: sent while reading far up, it is not in the list yet.
        var missingPasses = 0
    }

    /// A send's glide from where the transcript was to the turn's rest, on `ChatSendMotion.rise`.
    struct Glide: Equatable {
        /// Passes the glide waits for the turn's row before following goes on without it.
        static let rowPassLimit = 4
        /// From farther away the glide starts this many viewports from the rest (as `Jump`).
        static let maxViewports: CGFloat = 1.5
        /// Rest minus the offset when the turn's row first laid out; nil until then.
        var distance: CGFloat?
        var elapsed: TimeInterval = 0
        var rowPasses = 0
    }

    private(set) var mode: ScrollFollowTarget? = .latest
    private(set) var anchor: Anchor?
    private(set) var disclosure: Disclosure?
    private(set) var prepend: Prepend?
    private(set) var jump: Jump?
    private(set) var sentTurn: SentTurn?
    private(set) var glide: Glide?

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
        self.jump = nil
        self.glide = nil
    }

    /// A send: the turn rests at once (`glides` false) or glides there, and keeps the reply's room
    /// under it, which holds it still until the reply outgrows the room. Then `follows` (keyboard
    /// up) keeps the reply's end in view; otherwise the turn rises with the reply only up to the
    /// turn anchor and stays there, so the reply reads from its start with Jump to latest below.
    mutating func turnSent(_ id: UUID, rest: ChatSentTurnRest, follows: Bool, glides: Bool) {
        self.setMode(follows ? .latest : .turn(id))
        self.jump = nil
        self.sentTurn = SentTurn(key: .cell(.row(id)), rest: rest)
        self.glide = glides ? Glide() : nil
    }

    /// The room under the content that lets the sent turn reach its rest; zero once the reply fills
    /// it. Computed before each layout write; the caller adds it to the scroller's bottom inset.
    mutating func floor(_ geometry: ChatReadingGeometry, row: (ChatReadingRowKey) -> ChatReadingRow?) -> CGFloat {
        guard var sent = self.sentTurn else { return 0 }
        guard let turn = row(sent.key) else { return sent.floor }
        let tail = sent.tail ?? max(0, geometry.contentHeight - turn.frame.maxY)
        sent.tail = tail
        let rest = Self.restOffset(sent.rest, turn: turn.frame, tail: tail, geometry: geometry)
        sent.floor = max(0, (rest - geometry.naturalBottomOffset).rounded(.up))
        self.sentTurn = sent
        return sent.floor
    }

    /// A working row still under the sent turn's finished reply, in the passes before the run clears:
    /// its height, which the transcript does not count, so it neither rises for the row nor falls
    /// back when it goes. Only the reply row (whose marker can register a pass late) and the
    /// working row may sit under the turn, and the working row no longer directly under it.
    static func settlingTail(turn: ChatReadingRow, rows: [ChatReadingRow], workingRowOnly: Bool) -> CGFloat {
        guard workingRowOnly else { return 0 }
        let below = rows.filter { $0.key != turn.key && $0.frame.minY >= turn.frame.maxY - 0.5 }
            .sorted { $0.frame.minY < $1.frame.minY }
        guard let live = below.last, below.count <= 2,
              live.key == .cell(.live) || live.key.answerRun != nil,
              live.frame.minY > turn.frame.maxY + 1 else { return 0 }
        for row in below.dropLast() {
            guard case .cell(.row) = row.key else { return 0 }
        }
        return live.frame.height
    }

    /// The offset that puts a sent turn at its rest. `tail`: content under the turn that is not
    /// reply (the list's end padding).
    static func restOffset(
        _ rest: ChatSentTurnRest,
        turn: CGRect,
        tail: CGFloat = 0,
        geometry: ChatReadingGeometry) -> CGFloat
    {
        switch rest {
        case .anchor:
            let visible = geometry.viewportHeight - geometry.insetTop - geometry.baseInsetBottom
            return turn.minY - (visible - turn.height) * Self.turnAnchor - geometry.insetTop
        case let .aboveComposer(reserve):
            return turn.maxY + tail + reserve - geometry.viewportHeight + geometry.baseInsetBottom
        }
    }

    /// One display frame of the send's glide.
    mutating func glideFrame(
        _ geometry: ChatReadingGeometry,
        elapsed: TimeInterval,
        interacting: Bool,
        row: (ChatReadingRowKey) -> ChatReadingRow?) -> ChatReadingWrite?
    {
        guard self.glide != nil else { return nil }
        self.glide?.elapsed = elapsed
        return self.layout(geometry, interacting: interacting, row: row, topRow: { nil })
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

    /// Unanimated, one write to the bottom. Animated, the write is where the glide starts and
    /// `jumpFrame` moves it from there.
    mutating func jumpToLatest(_ geometry: ChatReadingGeometry, animated: Bool) -> ChatReadingWrite? {
        self.setMode(.latest)
        self.jump = nil
        guard animated else { return Self.write(geometry.bottomOffset, .jump, from: geometry) }
        let viewport = geometry.viewportHeight - geometry.insetTop - geometry.baseInsetBottom
        let limit = max(0, viewport) * Jump.maxViewports
        let distance = min(geometry.bottomOffset - geometry.offsetY, limit)
        guard distance > 0.5 else { return nil }
        self.jump = Jump(distance: distance, duration: 0.26 + 0.16 * Double(distance / limit))
        return Self.write(geometry.bottomOffset - distance, .jump, from: geometry)
    }

    /// One display frame of the glide, eased out. The last frame ends it and following takes over.
    mutating func jumpFrame(_ geometry: ChatReadingGeometry, elapsed: TimeInterval) -> ChatReadingWrite? {
        guard let jump else { return nil }
        let progress = min(1, max(0, elapsed / jump.duration))
        if progress >= 1 { self.jump = nil }
        let remaining = pow(1 - progress, 3)
        return Self.write(geometry.bottomOffset - jump.distance * remaining, .jump, from: geometry)
    }

    /// The reader touched the transcript mid-glide: their scroll owns the offset from here.
    mutating func cancelJump() {
        self.jump = nil
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
            if interacting { self.glide = nil }
            // The glide owns the offset until it lands; a follow write would cut it short.
            guard !interacting, self.jump == nil else { return nil }
            // A send's glide starts from where the reader was once the turn's row and room exist.
            if var glide = self.glide, glide.distance == nil, let sent = self.sentTurn, row(sent.key) == nil {
                glide.rowPasses += 1
                guard glide.rowPasses > Glide.rowPassLimit else {
                    self.glide = glide
                    return nil
                }
                self.glide = nil
            }
            return self.glided(geometry.bottomOffset, .follow, from: geometry)
        case let .turn(id):
            if interacting { self.glide = nil }
            guard !interacting else { return nil }
            guard let turn = row(.cell(.row(id))) else {
                // Sent from far up: its row comes into the list at the end, where the turn is.
                guard var sent = self.sentTurn, sent.key == .cell(.row(id)) else { return nil }
                sent.missingPasses += 1
                self.sentTurn = sent
                guard sent.missingPasses > Glide.rowPassLimit else { return nil }
                self.glide = nil
                return Self.write(geometry.bottomOffset, .turn, from: geometry)
            }
            let desired = Self.restOffset(.anchor, turn: turn.frame, geometry: geometry)
            return self.glided(geometry.clamped(desired), .turn, from: geometry)
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
        guard let anchor else {
            self.anchor = topRow().map { Anchor($0, offsetY: geometry.offsetY) }
            return nil
        }
        guard let current = row(anchor.key) else {
            if case let .answerBlock(run, _) = anchor.key {
                // The block can be absent during replacement or change text. Keep the owning
                // answer in place while waiting for a matching laid-out block.
                guard let priorTop = anchor.answerTop, let answer = row(.answer(run)) else { return nil }
                let target = answer.frame.minY - (priorTop - anchor.offsetY)
                return Self.write(geometry.clamped(target), .anchor, from: geometry)
            }
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

    /// The target, or the glide's way to it: the distance left shrinks on the spring while the
    /// target itself may move (rows sizing, the keyboard), so the glide lands wherever the rest is.
    private mutating func glided(
        _ target: CGFloat,
        _ reason: ChatReadingWrite.Reason,
        from geometry: ChatReadingGeometry) -> ChatReadingWrite?
    {
        guard var glide = self.glide else { return Self.write(target, reason, from: geometry) }
        let visible = geometry.viewportHeight - geometry.insetTop - geometry.baseInsetBottom
        let limit = max(0, visible) * Glide.maxViewports
        let distance = glide.distance ?? min(max(target - geometry.offsetY, -limit), limit)
        glide.distance = distance
        let progress = ChatSendMotion.rise.progress(glide.elapsed)
        self.glide = progress >= 1 ? nil : glide
        return Self.write(target - distance * (1 - progress), reason, from: geometry)
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
    private var blocks: [ObjectIdentifier: WeakMarker] = [:]
    private var reconciling = false
    private var jumpClock: JumpClock?
    private var prependSignpost = ChatScrollSignpostInterval("OlderPagePrepend")
    /// The sent turn's room, as added to the scroller's bottom inset, and the inset value written
    /// with it. Another writer of the inset (SwiftUI) drops it; the next pass adds it again.
    private var floorApplied: CGFloat = 0
    private var floorWritten: CGFloat?
    private var entrance: Entrance?
    private var sendClock: JumpClock?
    /// The run's live cell shows only the working row, no words.
    var workingRowOnly = false

    private struct WeakMarker {
        weak var marker: Marker?
    }

    /// The sent message's way in. `travels`: from the composer field to its row, drawn by moving
    /// the row's cell layer (render only; the row's layout and accessibility frame are at rest).
    /// Otherwise a short fade in place.
    private struct Entrance {
        var key: ChatReadingRowKey
        var travels: Bool
        /// The cell's offset from its row at the start, in screen points; the spring takes it to zero.
        var start: CGPoint = .zero
        weak var layer: CALayer?
        /// The working row under the slot, hidden while the message rises past it.
        weak var working: CALayer?
    }

    var mode: ScrollFollowTarget? {
        self.policy.mode
    }

    func setMode(_ mode: ScrollFollowTarget?) {
        self.policy.setMode(mode)
        self.sentinel?.setNeedsLayout()
    }

    func readerSettled() {
        guard let collection = self.scroller, let geometry = self.geometry(collection) else {
            self.policy.setMode(nil)
            return
        }
        self.policy.readerSettled(geometry, topRow: self.topRow(in: collection, geometry))
    }

    func disclosureWillToggle() {
        guard let collection = self.scroller, let geometry = self.geometry(collection) else { return }
        self.policy.disclosureWillToggle(geometry, topRow: self.topRow(in: collection, geometry))
    }

    func disclosureDidSettle() {
        guard let collection = self.scroller, let geometry = self.geometry(collection) else { return }
        self.policy.disclosureDidSettle(geometry)
    }

    func olderPageWillPrepend() {
        ChatBehaviorProbe.mark("older-prepend")
        guard let collection = self.scroller, let geometry = self.geometry(collection) else { return }
        self.policy.olderPageWillPrepend(geometry)
        guard self.policy.prepend != nil else { return }
        self.prependSignpost.begin()
        self.sentinel?.setNeedsLayout()
    }

    func jumpToLatest() {
        self.jumpClock?.stop()
        self.jumpClock = nil
        guard let collection = self.scroller, let geometry = self.geometry(collection) else {
            self.policy.setMode(.latest)
            return
        }
        self.apply(
            self.policy.jumpToLatest(geometry, animated: !UIAccessibility.isReduceMotionEnabled),
            to: collection)
        guard self.policy.jump != nil else { return }
        self.jumpClock = JumpClock { [weak self] elapsed in self?.jumpFrame(elapsed) ?? false }
    }

    /// Returns false once the glide has landed or the reader took the scroll back.
    private func jumpFrame(_ elapsed: TimeInterval) -> Bool {
        guard let collection = self.scroller, let geometry = self.geometry(collection),
              !collection.isTracking, !collection.isDragging
        else {
            self.policy.cancelJump()
            return false
        }
        self.apply(self.policy.jumpFrame(geometry, elapsed: elapsed), to: collection)
        guard self.policy.jump == nil else { return true }
        // Landed: following settles the exact end in the next layout pass.
        self.sentinel?.setNeedsLayout()
        return false
    }

    /// Keyboard avoidance may move only the safe area; measure after it.
    func keyboardFrameChanged() {
        self.sentinel?.setNeedsLayout()
    }

    func reset() {
        self.jumpClock?.stop()
        self.jumpClock = nil
        self.finishEntrance()
        self.policy = ChatReadingPolicy()
        self.removeFloor()
        self.prependSignpost.end()
        self.sentinel?.setNeedsLayout()
    }

    // MARK: Send

    /// A message was sent: it rests in the next layout pass, the transcript glides there, and the
    /// message travels from the composer field (`travels`, a touch on Send) or fades in place.
    /// Reduce Motion: nothing moves or fades; the message is simply there.
    /// A sent message rests this far above the composer: the reply's first row (the working row,
    /// then its first line) fits under it without moving it.
    static let replyRoom: CGFloat = 52

    /// The sent turn is the last user message; finding it needs no presentation pass.
    func turnSent(in messages: [OpenClawChatMessage], keyboardUp: Bool) {
        guard let id = messages.last(where: { $0.role.lowercased() == "user" })?.presentationID else {
            self.setMode(.latest)
            return
        }
        self.turnSent(
            id,
            rest: .aboveComposer(reserve: Self.replyRoom),
            follows: keyboardUp,
            travels: ChatSendEntrance.takeComposerSend())
    }

    func turnSent(_ id: UUID, rest: ChatSentTurnRest, follows: Bool, travels: Bool) {
        self.jumpClock?.stop()
        self.jumpClock = nil
        self.finishEntrance()
        let reduceMotion = UIAccessibility.isReduceMotionEnabled
        self.policy.turnSent(id, rest: rest, follows: follows, glides: !reduceMotion)
        self.entrance = reduceMotion ? nil : Entrance(key: .cell(.row(id)), travels: travels)
        self.sentinel?.setNeedsLayout()
    }

    /// The sent row laid out: put its cell at the composer field (or start its fade) in this pass,
    /// before the frame renders, and run the spring from the next frame.
    private func beginEntrance(in collection: UICollectionView) {
        guard var entrance = self.entrance, entrance.layer == nil,
              let cell = self.cell(for: entrance.key, in: collection) else { return }
        entrance.layer = cell.layer
        // A reply already under the turn: no travel across it, the message is simply in place.
        if entrance.travels, self.hasRow(below: entrance.key, in: collection) {
            self.entrance = nil
            self.startSendClock()
            return
        }
        if entrance.travels, let start = Self.travelStart(of: cell, in: collection) {
            entrance.start = start
            Self.translate(cell.layer, by: start)
            self.entrance = entrance
            self.holdWorkingRow(in: collection)
        } else {
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.2
            fade.timingFunction = CAMediaTimingFunction(controlPoints: 0.23, 1, 0.32, 1)
            cell.layer.add(fade, forKey: "openclaw.sendArrival")
            self.entrance = nil
        }
        self.startSendClock()
    }

    private func startSendClock() {
        guard self.sendClock == nil, self.policy.glide != nil || self.entrance != nil else { return }
        self.sendClock = JumpClock { [weak self] elapsed in self?.sendFrame(elapsed) ?? false }
    }

    /// One display frame of the send: the glide's offset, then the cell's remaining travel.
    private func sendFrame(_ elapsed: TimeInterval) -> Bool {
        guard let collection = self.scroller, let geometry = self.geometry(collection) else {
            self.finishEntrance()
            return false
        }
        if self.policy.glide != nil {
            let interacting = collection.isTracking || collection.isDragging || collection.isDecelerating
            self.apply(
                self.policy.glideFrame(
                    geometry,
                    elapsed: elapsed,
                    interacting: interacting,
                    row: { self.row($0, in: collection) }),
                to: collection)
        }
        if var entrance = self.entrance {
            // A recycled cell gives the travel to the row's current cell.
            if let cell = self.cell(for: entrance.key, in: collection), cell.layer !== entrance.layer {
                entrance.layer.map { Self.translate($0, by: .zero) }
                entrance.layer = cell.layer
                self.entrance = entrance
            }
            let x = 1 - ChatSendMotion.slide.progress(elapsed)
            let y = 1 - ChatSendMotion.rise.progress(elapsed)
            // A reply that starts during the rise: the message lands at once rather than cross it.
            if x <= 0 && y <= 0 || self.hasRow(below: entrance.key, in: collection) {
                self.finishEntrance()
            } else if let layer = entrance.layer {
                self.holdWorkingRow(in: collection)
                Self.translate(layer, by: CGPoint(x: entrance.start.x * x, y: entrance.start.y * y))
            }
        }
        let running = self.policy.glide != nil || self.entrance != nil
        if !running { self.sendClock = nil }
        return running
    }

    private func finishEntrance() {
        self.sendClock?.stop()
        self.sendClock = nil
        if let layer = self.entrance?.layer { Self.translate(layer, by: .zero) }
        if let working = self.entrance?.working {
            CATransaction.begin()
            CATransaction.setDisableActions(true)
            working.opacity = 1
            CATransaction.commit()
            let fade = CABasicAnimation(keyPath: "opacity")
            fade.fromValue = 0
            fade.toValue = 1
            fade.duration = 0.2
            working.add(fade, forKey: "openclaw.workingArrival")
        }
        self.entrance = nil
    }

    /// Like the reference's thinking mark, the working row appears once the message has landed.
    private func holdWorkingRow(in collection: UICollectionView) {
        guard var entrance = self.entrance, self.workingRowOnly,
              let turn = self.row(entrance.key, in: collection),
              let key = self.rows.keys.first(where: { key in
                  (key == .cell(.live) || key.answerRun != nil) &&
                      (self.row(key, in: collection)?.frame.minY ?? 0) >= turn.frame.maxY - 0.5
              }),
              let layer = self.cell(for: key, in: collection)?.layer else { return }
        if entrance.working !== layer { entrance.working?.opacity = 1 }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.opacity = 0
        CATransaction.commit()
        entrance.working = layer
        self.entrance = entrance
    }

    private static func translate(_ layer: CALayer, by offset: CGPoint) {
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        layer.sublayerTransform = offset == .zero
            ? CATransform3DIdentity
            : CATransform3DMakeTranslation(offset.x, offset.y, 0)
        CATransaction.commit()
    }

    /// Where the sent cell starts, relative to where it rests: its bubble's first text line on the
    /// field's first line (a message taller than the field: last lines together, so it rises out of
    /// the field). Nil when the field is not on screen.
    private static func travelStart(of cell: UICollectionViewCell, in collection: UICollectionView) -> CGPoint? {
        guard let window = collection.window,
              let field = composerField(in: window, excluding: collection), field.window != nil,
              !field.isHidden, field.alpha > 0.01 else { return nil }
        let inset = field.textContainerInset
        let padding = field.textContainer.lineFragmentPadding
        let box = field.convert(field.bounds, to: window)
        let text = CGRect(
            x: box.minX + inset.left + padding,
            y: box.minY + inset.top,
            width: box.width,
            height: max(0, box.height - inset.top - inset.bottom))
        guard let bubble = bubbleMarker(in: cell) else {
            // Photos alone: the row rises from the field's top.
            return CGPoint(x: 0, y: text.minY - cell.convert(cell.bounds, to: window).minY)
        }
        let frame = bubble.convert(bubble.bounds, to: window)
        let lines = CGRect(
            x: frame.minX + bubble.textInset.left,
            y: frame.minY + bubble.textInset.top,
            width: frame.width,
            height: frame.height - bubble.textInset.top - bubble.textInset.bottom)
        let dy = lines.height > text.height + 1 ? text.maxY - lines.maxY : text.minY - lines.minY
        return CGPoint(x: text.minX - lines.minX, y: dy)
    }

    /// The composer's text view, outside the transcript.
    private static func composerField(in view: UIView, excluding transcript: UIView) -> UITextView? {
        for subview in view.subviews where subview !== transcript {
            if let field = subview as? UITextView,
               field.accessibilityIdentifier == "chat-message-input" { return field }
            if let field = composerField(in: subview, excluding: transcript) { return field }
        }
        return nil
    }

    private static func bubbleMarker(in view: UIView) -> BubbleMarker? {
        for subview in view.subviews {
            if let marker = subview as? BubbleMarker { return marker }
            if let marker = bubbleMarker(in: subview) { return marker }
        }
        return nil
    }

    private func settlingTail(in collection: UICollectionView) -> CGFloat {
        guard self.workingRowOnly, let key = self.policy.sentTurn?.key,
              let turn = self.row(key, in: collection) else { return 0 }
        let rows = self.rows.compactMap { key, entry in
            entry.marker.flatMap { Self.row(of: $0, key: key, in: collection) }
        }
        return ChatReadingPolicy.settlingTail(turn: turn, rows: rows, workingRowOnly: true)
    }

    /// A laid-out row under this one (the reply's first row).
    private func hasRow(below key: ChatReadingRowKey, in collection: UICollectionView) -> Bool {
        guard let turn = self.row(key, in: collection) else { return false }
        return self.rows.contains { other, entry in
            // The working row alone is not a reply: the message rises past it, hidden meanwhile.
            if self.workingRowOnly, other == .cell(.live) || other.answerRun != nil { return false }
            guard other != key, let marker = entry.marker,
                  let row = Self.row(of: marker, key: other, in: collection) else { return false }
            return row.frame.minY >= turn.frame.maxY - 0.5
        }
    }

    private func cell(for key: ChatReadingRowKey, in collection: UICollectionView) -> UICollectionViewCell? {
        guard let marker = self.rows[key]?.marker, marker.window != nil else { return nil }
        var view: UIView? = marker
        while let current = view, current !== collection, !(current is UICollectionViewCell) {
            view = current.superview
        }
        guard let cell = view as? UICollectionViewCell, let index = collection.indexPath(for: cell),
              collection.cellForItem(at: index) === cell else { return nil }
        return cell
    }

    private func removeFloor() {
        if let collection = self.scroller, self.floorApplied != 0 {
            self.floorWritten = nil
            collection.contentInset.bottom -= self.floorApplied
        }
        self.floorApplied = 0
        self.floorWritten = nil
    }

    // MARK: Rows

    func register(_ marker: Marker, key: ChatReadingRowKey) {
        if case .answerBlock = key {
            let changed = marker.key != key || self.blocks[ObjectIdentifier(marker)] == nil
            marker.key = key
            self.blocks[ObjectIdentifier(marker)] = WeakMarker(marker: marker)
            if changed, self.policy.anchor?.key == key { self.sentinel?.setNeedsLayout() }
            return
        }
        if let old = marker.key, old != key, self.rows[old]?.marker === marker {
            self.rows[old] = nil
        }
        marker.key = key
        self.rows[key] = WeakMarker(marker: marker)
        // A sent turn's row registers after the layout pass that added it; that pass found no
        // row to place, so place it now instead of leaving it under the composer.
        var awaited = key == self.policy.sentTurn?.key
        if case let .turn(id) = self.policy.mode, key == .cell(.row(id)) { awaited = true }
        if awaited { self.sentinel?.setNeedsLayout() }
    }

    func unregister(_ marker: Marker) {
        self.blocks.removeValue(forKey: ObjectIdentifier(marker))
        if let key = marker.key, self.rows[key]?.marker === marker {
            self.rows[key] = nil
        }
        marker.key = nil
    }

    func isTurnRealized(_ id: UUID) -> Bool {
        guard let collection = self.scroller else { return false }
        return self.row(.cell(.row(id)), in: collection) != nil
    }

    private func row(_ key: ChatReadingRowKey, in collection: UICollectionView) -> ChatReadingRow? {
        if case let .answerBlock(run, oldBlock) = key {
            let blocks = self.answerBlocks(run: run, in: collection)
            let exact = blocks.filter { $0.key == key }
            if !exact.isEmpty { return exact.count == 1 ? exact.first : nil }
            // A short streaming block changes its key while its text prefix grows. The key
            // starts with the block position, so this never adopts another block's prefix.
            let extended = blocks.filter {
                if case let .answerBlock(_, newBlock) = $0.key { return newBlock.hasPrefix(oldBlock) }
                return false
            }
            return extended.count == 1 ? extended.first : nil
        }
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
        guard let best, let run = best.key.answerRun, best.frame.minY < geometry.visibleMinY else { return best }
        let visibleBlocks = self.answerBlocks(run: run, in: collection)
        let counts = Dictionary(grouping: visibleBlocks, by: \.key)
        return visibleBlocks.filter {
            counts[$0.key]?.count == 1 &&
                $0.frame.minY >= geometry.visibleMinY && $0.frame.minY < geometry.visibleMaxY
        }.min { $0.frame.minY < $1.frame.minY } ?? best
    }

    private func answerBlocks(run: String, in collection: UICollectionView) -> [ChatReadingRow] {
        guard let marker = self.rows[.answer(run)]?.marker,
              let answer = Self.row(of: marker, key: .answer(run), in: collection) else { return [] }
        return self.blocks.values.compactMap { entry in
            guard let view = entry.marker,
                  let key = view.key,
                  case let .answerBlock(markerRun, _) = key,
                  markerRun == run,
                  let ownerRow = Self.row(of: view, key: key, in: collection),
                  ownerRow.frame == answer.frame
            else { return nil }
            let frame = view.convert(view.bounds, to: collection)
            guard !frame.isEmpty, frame.minY.isFinite, answer.frame.insetBy(dx: -1, dy: -1).contains(frame.origin)
            else { return nil }
            return ChatReadingRow(key: key, frame: frame, answerTop: answer.frame.minY)
        }
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
                MainActor.assumeIsolated {
                    guard let self else { return }
                    // Another writer replaced the inset, and the reply's room with it.
                    if let written = self.floorWritten, change.newValue?.bottom != written {
                        self.floorApplied = 0
                        self.floorWritten = nil
                    }
                    self.sentinel?.setNeedsLayout()
                }
            },
        ]
        sentinel.setNeedsLayout()
    }

    private func geometry(_ scroll: UIScrollView) -> ChatReadingGeometry? {
        guard scroll.window != nil, scroll.bounds.height > 0 else { return nil }
        return ChatReadingGeometry(
            offsetY: scroll.contentOffset.y,
            contentHeight: scroll.contentSize.height,
            viewportHeight: scroll.bounds.height,
            insetTop: scroll.adjustedContentInset.top,
            insetBottom: scroll.adjustedContentInset.bottom,
            floorInset: self.floorApplied)
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
        defer { self.beginEntrance(in: collection) }
        for _ in 0..<3 {
            guard var geometry = self.geometry(collection) else { return }
            geometry.contentHeight -= self.settlingTail(in: collection)
            // The sent turn's room first: it moves the end the writes below are measured from.
            let floor = self.policy.floor(geometry, row: { self.row($0, in: collection) })
            if abs(floor - self.floorApplied) > 0.5 {
                let base = collection.contentInset.bottom - self.floorApplied
                self.floorApplied = floor
                self.floorWritten = base + floor
                collection.contentInset.bottom = base + floor
                collection.layoutIfNeeded()
                continue
            }
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
            // Unanimated, also for each frame of the glide: UIKit's own animated write reports
            // `.animating`, which releases following.
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

    /// Calls `frame` with the elapsed time once per display frame until it returns false.
    @MainActor
    private final class JumpClock: NSObject {
        private var link: CADisplayLink?
        private var start: CFTimeInterval?
        private let frame: @MainActor (TimeInterval) -> Bool

        init(frame: @escaping @MainActor (TimeInterval) -> Bool) {
            self.frame = frame
            super.init()
            let link = CADisplayLink(target: self, selector: #selector(self.tick(_:)))
            link.add(to: .main, forMode: .common)
            self.link = link
        }

        func stop() {
            self.link?.invalidate()
            self.link = nil
        }

        @objc private func tick(_ link: CADisplayLink) {
            let start = self.start ?? link.timestamp
            self.start = start
            if !self.frame(link.targetTimestamp - start) { self.stop() }
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

/// The composer notes a send it starts with a touch on Send; that message travels from the field.
/// Sends from a hardware key or a Shortcut leave no note and fade in place. One note for the app:
/// a touch and the send it starts are one person's action, consumed by the next sent turn.
@MainActor
enum ChatSendEntrance {
    private static var notedAt: CFTimeInterval?

    static func composerWillSend() {
        self.notedAt = CACurrentMediaTime()
    }

    /// True once per noted send. A send waits for at most a health check or an outbox write.
    static func takeComposerSend() -> Bool {
        defer { self.notedAt = nil }
        guard let notedAt else { return false }
        return CACurrentMediaTime() - notedAt < 5
    }
}

extension ChatReadingPosition {
    /// Names a user bubble and its text inset, so a send's travel lines its text up with the field.
    final class BubbleMarker: UIView {
        var textInset: UIEdgeInsets = .zero
    }
}

struct ChatReadingBubbleMarker: UIViewRepresentable {
    let textInset: EdgeInsets

    func makeUIView(context: Context) -> ChatReadingPosition.BubbleMarker {
        let marker = ChatReadingPosition.BubbleMarker()
        marker.isUserInteractionEnabled = false
        marker.accessibilityElementsHidden = true
        return marker
    }

    func updateUIView(_ marker: ChatReadingPosition.BubbleMarker, context: Context) {
        marker.textInset = UIEdgeInsets(
            top: self.textInset.top,
            left: self.textInset.leading,
            bottom: self.textInset.bottom,
            right: self.textInset.trailing)
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
    @Entry var openClawReadingAnswerRun: String?
}
#endif
