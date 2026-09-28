import SwiftUI

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

struct ChatScrollCommand {
    struct Request: Equatable {
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
