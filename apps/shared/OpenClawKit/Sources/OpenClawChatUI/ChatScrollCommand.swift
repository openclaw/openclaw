import SwiftUI

enum ScrollFollowTarget: Equatable {
    case latest
    case turn(UUID)
}

enum ChatReaderUserTransition: Equatable {
    case unchanged
    case added(UUID)
    case removed(latestRemainingID: UUID?)
}

enum ChatReaderInitialRestorePolicy: Equatable {
    case liveEdge
    case latestTurn
}

func chatReaderInitialRestorePolicy() -> ChatReaderInitialRestorePolicy {
    #if os(iOS)
    .liveEdge
    #else
    .latestTurn
    #endif
}

/// Hydration may add or re-identify old boundaries. Only live user admission can start a reader turn.
func chatReaderUserTransition(
    previousID: UUID?,
    visibleIDs: [UUID],
    liveTurnID: UUID? = nil) -> ChatReaderUserTransition
{
    if let liveTurnID, liveTurnID != previousID, visibleIDs.contains(liveTurnID) {
        return .added(liveTurnID)
    }
    if let previousID, !visibleIDs.contains(previousID) {
        return .removed(latestRemainingID: visibleIDs.last)
    }
    return .unchanged
}

func chatReaderHasAssistantReply(after messageID: UUID, rows: [ChatTranscriptRow]) -> Bool {
    guard let index = rows.firstIndex(where: { $0.id == messageID }) else { return false }
    for row in rows.dropFirst(index + 1) {
        if row.startsTurn { return false }
        if case let .message(message) = row, message.role == "assistant" { return true }
    }
    return false
}

func chatReaderHasNewerContent(
    after messageID: UUID,
    visibleIDs: [UUID],
    hasTransientContent: Bool) -> Bool
{
    guard let messageIndex = visibleIDs.firstIndex(of: messageID) else { return false }
    return messageIndex < visibleIDs.index(before: visibleIDs.endIndex) || hasTransientContent
}

/// `hasNewerContentBelow` is derived structurally (a later message or streaming text exists),
/// which is true from the first Writing tick of a turn even when the whole transcript is on
/// screen. Gating on the live-edge geometry keeps the jump affordance hidden until content is
/// actually below the viewport; without it the button flashes during every reply (#108693).
func chatReaderShowsJumpToLatest(
    hasNewerContentBelow: Bool,
    isAtLiveEdge: Bool,
    hasVisibleContent: Bool,
    isLoading: Bool) -> Bool
{
    hasNewerContentBelow && !isAtLiveEdge && hasVisibleContent && !isLoading
}

/// The view's own one-shot positioning always runs in a nil-animation transaction, so
/// `.animating` only comes from system scrolls (status-bar scroll-to-top, keyboard
/// avoidance). Not releasing there lets the next timeline tick yank the reader back down.
func chatReaderScrollReleasesFollow(_ phase: ScrollPhase) -> Bool {
    switch phase {
    case .tracking, .interacting, .decelerating, .animating:
        true
    case .idle:
        false
    @unknown default:
        false
    }
}

struct ChatScrollRowGeometry: Equatable {
    let targetID: UUID
    let preservationID: UUID?
    let contentMinY: CGFloat
}

/// Passive layout samples must not invalidate the transcript that produced them.
final class ChatHistoryScrollGeometry {
    let contentSpace = UUID()
    var row: ChatScrollRowGeometry?
    var settledOffset: CGFloat = 0
    /// Paging can discover a steer predecessor and retroactively collapse its work.
    /// Keep the reader's exposed message until they leave this session.
    var preservedRowID: UUID?
    var pagingRowID: UUID?
    #if os(iOS)
    var nativeViewport: ChatNativePrependViewport?
    #endif

    func preserve(_ id: UUID?) -> (UUID?, CGFloat?) {
        let offset = self.offsetFromRow(id)
        self.preservedRowID = id
        self.pagingRowID = id
        self.row = nil
        return (id, offset)
    }

    func offsetFromRow(_ id: UUID?) -> CGFloat? {
        guard let row, row.targetID == id else { return nil }
        return self.settledOffset - row.contentMinY
    }
}

struct ChatScrollHistoryRowModifier: ViewModifier {
    let rowID: UUID
    let command: ChatScrollCommand
    let boundaryID: UUID?
    let geometry: ChatHistoryScrollGeometry
    @Binding var preservationGeometry: ChatScrollRowGeometry?

    func body(content: Content) -> some View {
        let contentSpace = self.geometry.contentSpace
        return content.onGeometryChange(for: ChatScrollRowGeometry?.self) { proxy in
            guard self.rowID == (self.command.preserving?.targetID ?? self.geometry.pagingRowID ?? self.boundaryID)
            else { return nil }
            return ChatScrollRowGeometry(
                targetID: self.rowID,
                preservationID: self.command.preserving?.id,
                contentMinY: proxy.frame(in: .named(contentSpace)).minY)
        } action: { row in
            guard let row else { return }
            self.geometry.row = row
            if row.preservationID != nil { self.preservationGeometry = row }
        }
    }
}

struct ChatScrollCommand {
    struct Request: Equatable {
        let id = UUID()
        let targetID: UUID
        let anchor: UnitPoint
        let sessionTarget: OpenClawChatSessionTarget
        let offsetFromRow: CGFloat?
    }

    private(set) var pending: Request?
    private(set) var preserving: Request?
    var historyGeometry: ChatScrollRowGeometry?
    mutating func enqueue(
        to id: UUID,
        anchor: UnitPoint,
        sessionTarget: OpenClawChatSessionTarget,
        offsetFromRow: CGFloat? = nil)
    {
        self.preserving = nil
        self.pending = Request(
            targetID: id, anchor: anchor, sessionTarget: sessionTarget, offsetFromRow: offsetFromRow)
    }

    mutating func cancel() {
        self.pending = nil
        self.preserving = nil
    }

    mutating func cancelSession(geometry: ChatHistoryScrollGeometry) {
        self.cancel()
        geometry.preservedRowID = nil
        geometry.pagingRowID = nil
        geometry.row = nil
    }

    mutating func cancel(targetID: UUID?) {
        guard let targetID, self.pending?.targetID == targetID || self.preserving?.targetID == targetID else { return }
        self.cancel()
    }

    mutating func cancelMissingPreservation(in availableIDs: [UUID]) {
        let target = self.pending.flatMap { $0.offsetFromRow == nil ? nil : $0.targetID }
            ?? self.preserving?.targetID
        guard let target, !availableIDs.contains(target) else { return }
        self.cancel(targetID: target)
    }

    mutating func take(_ request: Request, sessionTarget: OpenClawChatSessionTarget) -> Request? {
        guard self.pending?.id == request.id else { return nil }
        self.pending = nil
        guard request.sessionTarget == sessionTarget else { return nil }
        return request
    }

    mutating func beginPreservation(_ request: Request) {
        self.preserving = request
    }

    mutating func preservedOffset(
        for geometry: ChatScrollRowGeometry,
        sessionTarget: OpenClawChatSessionTarget) -> CGFloat?
    {
        guard let request = self.preserving, geometry.preservationID == request.id,
              geometry.targetID == request.targetID else { return nil }
        guard request.sessionTarget == sessionTarget, let offset = request.offsetFromRow else {
            self.preserving = nil
            return nil
        }
        // Lazy estimates and regrouping can refine this frame more than once.
        // Reader movement or a new command owns cancellation, not the first sample.
        return geometry.contentMinY + offset
    }
}

struct ChatScrollCommandModifier: ViewModifier {
    @Binding var command: ChatScrollCommand
    @Binding var position: ScrollPosition
    let bottomID: UUID
    let geometry: ChatHistoryScrollGeometry
    let historyRowGeometry: ChatScrollRowGeometry?
    let historyScrollTargets: [UUID: ChatAssistantRunGroup.ID]
    let currentSessionTarget: @MainActor () -> OpenClawChatSessionTarget

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onChange(of: self.command.pending) { _, request in
                guard let request else { return }
                DispatchQueue.main.async {
                    guard self.command.pending?.id == request.id else { return }
                    self.command.cancelMissingPreservation(in: Array(self.historyScrollTargets.keys))
                    guard let command = self.command.take(request, sessionTarget: self.currentSessionTarget()) else {
                        return
                    }
                    withTransaction(Transaction(animation: nil)) {
                        if command.targetID == self.bottomID {
                            // A lazy tail's estimated footer frame is not the content bottom.
                            self.position.scrollTo(edge: .bottom)
                        } else {
                            if command.offsetFromRow != nil { self.command.beginPreservation(command) }
                            if command.offsetFromRow != nil, let row = self.geometry.row,
                               row.targetID == command.targetID
                            {
                                self.command.historyGeometry = ChatScrollRowGeometry(
                                    targetID: row.targetID, preservationID: command.id, contentMinY: row.contentMinY)
                            }
                            // Lazy roots own layout targets; nested row IDs can be offscreen and unmeasured.
                            if let target = self.historyScrollTargets[command.targetID] {
                                proxy.scrollTo(target, anchor: command.anchor)
                            }
                        }
                    }
                }
            }
            .onChange(of: self.historyRowGeometry) { _, geometry in
                guard let geometry,
                      let offset = self.command.preservedOffset(
                          for: geometry, sessionTarget: self.currentSessionTarget()) else { return }
                withTransaction(Transaction(animation: nil)) {
                    self.position.scrollTo(y: offset)
                }
            }
            .onChange(of: self.historyScrollTargets) { _, targets in
                self.command.cancelMissingPreservation(in: Array(targets.keys))
            }
        }
    }
}
