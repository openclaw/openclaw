import SwiftUI

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

func chatReaderUserTransition(
    previousID: UUID?,
    visibleIDs: [UUID]) -> ChatReaderUserTransition
{
    let latestID = visibleIDs.last
    if let previousID, !visibleIDs.contains(previousID) {
        return .removed(latestRemainingID: latestID)
    }
    if let latestID, latestID != previousID {
        return .added(latestID)
    }
    return .unchanged
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
    case .interacting, .animating:
        true
    case .idle, .tracking, .decelerating:
        false
    @unknown default:
        false
    }
}

enum ScrollFollowTarget: Equatable {
    case latest
    case turn(UUID)
}

/// What the transcript follows. Held by reference and read only by the small views below, so
/// the start and end of a swipe do not re-evaluate the transcript and rebuild every row.
@MainActor
@Observable
final class ChatScrollFollowState {
    var followTarget: ScrollFollowTarget? = .latest
    var isAtLiveEdge = true
    var isUserScrolling = false
    var hasNewerContentBelow = false
}

/// Keeps the end of the transcript in view while it follows the latest content.
/// `defaultScrollAnchor(_:for: .sizeChanges)` alone left the offset at 0 while a reply grew
/// thousands of points below the composer, and live words change no timeline revision that
/// could re-scroll. Pin the bottom edge on every height change instead: edge scrolling does not
/// depend on estimated row heights, so later changes (the final row replacing the live bubble,
/// lazy rows measuring) converge on the real end. It runs here, outside the transcript body.
struct ChatScrollFollowAnchorModifier: ViewModifier {
    let scroll: ChatScrollFollowState
    @State private var position = ScrollPosition()

    func body(content: Content) -> some View {
        content
            .defaultScrollAnchor(self.follows ? .bottom : nil, for: .sizeChanges)
            .scrollPosition(self.$position)
            .onScrollGeometryChange(for: CGFloat.self) { $0.contentSize.height } action: { _, _ in
                guard self.follows else { return }
                withTransaction(Transaction(animation: nil)) { self.position.scrollTo(edge: .bottom) }
            }
    }

    private var follows: Bool {
        self.scroll.followTarget == .latest && !self.scroll.isUserScrolling
    }
}

struct ChatJumpToLatestSlot<Content: View>: View {
    let scroll: ChatScrollFollowState
    let hasVisibleContent: Bool
    let isLoading: Bool
    @ViewBuilder let button: Content

    var body: some View {
        if chatReaderShowsJumpToLatest(
            hasNewerContentBelow: self.scroll.hasNewerContentBelow,
            isAtLiveEdge: self.scroll.isAtLiveEdge,
            hasVisibleContent: self.hasVisibleContent,
            isLoading: self.isLoading)
        {
            self.button
                .padding(.bottom, 12)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                .transition(.move(edge: .bottom).combined(with: .opacity))
        }
    }
}

struct ChatScrollCommand {
    struct Request: Equatable {
        // periphery:ignore - Synthesized Equatable keeps identical scroll requests distinct.
        let id = UUID()
        let targetID: UUID
        let anchor: UnitPoint
        let sessionTarget: OpenClawChatSessionTarget
    }

    private(set) var pending: Request?

    mutating func enqueue(to id: UUID, anchor: UnitPoint, sessionTarget: OpenClawChatSessionTarget) {
        self.pending = Request(targetID: id, anchor: anchor, sessionTarget: sessionTarget)
    }

    mutating func cancel() {
        self.pending = nil
    }

    mutating func cancel(targetID: UUID?) {
        guard let targetID, self.pending?.targetID == targetID else { return }
        self.cancel()
    }

    mutating func take(_ request: Request, sessionTarget: OpenClawChatSessionTarget) -> Request? {
        guard self.pending?.id == request.id else { return nil }
        self.pending = nil
        guard request.sessionTarget == sessionTarget else { return nil }
        return request
    }
}

struct ChatScrollCommandModifier: ViewModifier {
    @Binding var command: ChatScrollCommand
    let currentSessionTarget: @MainActor () -> OpenClawChatSessionTarget

    func body(content: Content) -> some View {
        ScrollViewReader { proxy in
            content.onChange(of: self.command.pending) { _, request in
                guard let request else { return }
                // Let the new rows lay out without retaining an ID-based scroll constraint.
                DispatchQueue.main.async {
                    guard let command = self.command.take(request, sessionTarget: self.currentSessionTarget()) else {
                        return
                    }
                    withTransaction(Transaction(animation: nil)) {
                        proxy.scrollTo(command.targetID, anchor: command.anchor)
                    }
                }
            }
        }
    }
}
