import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit

@MainActor
@Observable
final class AmbientCommandDockModel {
    var inputText: String = "" {
        didSet { self.refreshSuggestions() }
    }

    private(set) var suggestions: [AmbientCommandSpec] = []
    var selectedSuggestionIndex: Int = 0
    var result: AmbientCommandResult = .none
    var thomasState: AmbientThomasOrbState = .ready
    var sessionLabel: String = "main session"
    var isSubmitting = false
    private(set) var assistantSnapshot: AmbientAssistantSurfaceSnapshot = .default
    private var localChatMessages: [AmbientAssistantChatMessage] = []
    var shouldAcceptSuggestionOnReturn: Bool {
        guard !self.suggestions.isEmpty else { return false }
        if case .command = self.parsedInput() {
            return false
        }
        return true
    }

    private let registry: AmbientCommandRegistry
    private let actions: AmbientCommandDockActionExecutor

    init(
        registry: AmbientCommandRegistry = .default,
        actions: AmbientCommandDockActionExecutor = AmbientCommandDockActionExecutor())
    {
        self.registry = registry
        self.actions = actions
    }

    func clear() {
        self.inputText = ""
        self.result = .none
        self.suggestions = []
        self.selectedSuggestionIndex = 0
        self.thomasState = .ready
        self.assistantSnapshot = .default
        self.localChatMessages = []
    }

    func acceptSuggestion(_ suggestion: AmbientCommandSpec) {
        self.inputText = "\(suggestion.displayName) "
        self.suggestions = []
        self.selectedSuggestionIndex = 0
        self.result = .none
        self.thomasState = .focused
    }

    func moveSuggestionSelection(delta: Int) {
        guard !self.suggestions.isEmpty else { return }
        let next = self.selectedSuggestionIndex + delta
        self.selectedSuggestionIndex = min(max(next, 0), self.suggestions.count - 1)
    }

    func parsedInput() -> AmbientParsedInput {
        self.registry.parse(self.inputText)
    }

    func submit() async {
        await self.refreshAssistantSnapshot()
        let parsed = self.parsedInput()
        switch parsed {
        case .empty:
            return
        case let .prompt(message):
            await self.submitPrompt(message)
        case let .command(name, arguments):
            await self.submitCommand(name: name, arguments: arguments)
        case let .unknown(name, suggestions):
            let hint = suggestions.prefix(3).map(\.displayName).joined(separator: ", ")
            self.result = .failure(hint.isEmpty ? "Unknown command /\(name)" : "Unknown command /\(name). Try \(hint)")
            self.thomasState = .error
        }
    }

    func refreshAssistantSnapshot() async {
        var snapshot = await self.actions.assistantSnapshot()
        self.mergeLocalChatMessages(into: &snapshot)
        self.assistantSnapshot = snapshot
        self.sessionLabel = self.assistantSnapshot.context.sessionLabel
        if !self.isSubmitting {
            self.thomasState = self.thomasState(for: self.assistantSnapshot.status.tone)
        }
    }

    func consumeAssistantEvents() async {
        let sessionKey = await GatewayConnection.shared.mainSessionKey()
        await GatewayPushSubscription.consume(bufferingNewest: 20) { [weak self] push in
            self?.handleAssistantPush(push, sessionKey: sessionKey)
        }
    }

    private func refreshSuggestions() {
        let trimmed = self.inputText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.hasPrefix("/") else {
            self.suggestions = []
            self.selectedSuggestionIndex = 0
            self.thomasState = trimmed.isEmpty ? .ready : .focused
            return
        }

        self.suggestions = Array(self.registry.suggestions(for: trimmed).prefix(8))
        self.selectedSuggestionIndex = min(self.selectedSuggestionIndex, max(self.suggestions.count - 1, 0))
        self.thomasState = .focused
    }

    private func submitPrompt(_ message: String) async {
        self.isSubmitting = true
        self.thomasState = .sending
        self.showPendingUserMessage(message)
        let outcome = await self.actions.sendPrompt(message)
        self.isSubmitting = false
        if case .failure = outcome {
            self.result = outcome
            self.markPendingUserMessageSent()
            self.thomasState = .error
            return
        }
        self.result = .none
        if case .success = outcome {
            self.inputText = ""
        }
        if case .info = outcome {
            self.inputText = ""
        }
        self.thomasState = .working
    }

    private func submitCommand(name: String, arguments: String) async {
        if self.registry.command(named: name)?.name == "clear" {
            self.clear()
            return
        }

        self.isSubmitting = true
        self.thomasState = .sending
        let outcome = await self.actions.execute(name: name, arguments: arguments)
        self.isSubmitting = false
        self.result = outcome
        if case .failure = outcome {
            self.thomasState = .error
        } else {
            self.inputText = ""
            self.thomasState = .success
        }
    }

    private func thomasState(for result: AmbientCommandResult) -> AmbientThomasOrbState {
        switch result {
        case .failure:
            .error
        case .none:
            .ready
        case .info, .success:
            .success
        }
    }

    private func thomasState(for tone: AmbientAssistantTone) -> AmbientThomasOrbState {
        switch tone {
        case .ready:
            .ready
        case .reading:
            .reading
        case .planning:
            .planning
        case .waitingForApproval:
            .waitingForApproval
        case .working:
            .working
        case .success:
            .success
        case .blocked, .error:
            .error
        }
    }

    private func showPendingUserMessage(_ message: String) {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        var snapshot = self.assistantSnapshot
        let localMessage = AmbientAssistantChatMessage(
            id: "local-\(Date().timeIntervalSince1970)",
            role: .user,
            text: trimmed,
            isPending: true)
        self.localChatMessages.append(localMessage)
        self.localChatMessages = Array(self.localChatMessages.suffix(6))
        snapshot.chatMessages.append(localMessage)
        snapshot.chatMessages = Array(snapshot.chatMessages.suffix(6))
        snapshot.liveCards = snapshot.liveCards.map { item in
            guard item.id == "chat" else { return item }
            return AmbientAssistantLaneItem(
                id: item.id,
                title: item.title,
                detail: "Waiting for Thomas: \(trimmed)",
                tone: .working)
        }
        snapshot.status = AmbientAssistantLaneItem(
            id: "status",
            title: "Thomas",
            detail: "Reading your message",
            tone: .working)
        self.assistantSnapshot = snapshot
    }

    private func markPendingUserMessageSent() {
        var snapshot = self.assistantSnapshot
        self.localChatMessages = self.localChatMessages.map { message in
            guard message.isPending else { return message }
            var sent = message
            sent.isPending = false
            return sent
        }
        snapshot.chatMessages = snapshot.chatMessages.map { message in
            guard message.isPending else { return message }
            var sent = message
            sent.isPending = false
            return sent
        }
        self.assistantSnapshot = snapshot
    }

    private func mergeLocalChatMessages(into snapshot: inout AmbientAssistantSurfaceSnapshot) {
        self.localChatMessages.removeAll { local in
            snapshot.chatMessages.contains { persisted in
                persisted.role == local.role && persisted.text == local.text
            }
        }
        guard !self.localChatMessages.isEmpty else { return }
        snapshot.chatMessages = Array((snapshot.chatMessages + self.localChatMessages).suffix(6))
        if let pending = self.localChatMessages.last(where: { $0.isPending && $0.role == .user }) {
            snapshot.liveCards = snapshot.liveCards.map { item in
                guard item.id == "chat" else { return item }
                return AmbientAssistantLaneItem(
                    id: item.id,
                    title: item.title,
                    detail: "Waiting for Thomas: \(pending.text)",
                    tone: .working)
            }
            snapshot.status = AmbientAssistantLaneItem(
                id: "status",
                title: "Thomas",
                detail: "Waiting for Thomas",
                tone: .working)
        }
    }

    private func handleAssistantPush(_ push: GatewayPush, sessionKey: String) {
        guard case let .event(event) = push else { return }
        switch event.event {
        case "chat":
            guard let payload = event.payload,
                  let chat = try? GatewayPayloadDecoding.decode(payload, as: OpenClawChatEventPayload.self)
            else {
                return
            }
            if let eventSessionKey = chat.sessionKey, eventSessionKey != sessionKey {
                return
            }
            if chat.state == "error" {
                self.applyAssistantError(chat.errorMessage ?? "Thomas could not reply.")
                return
            }
            guard let text = OpenClawChatEventText.assistantText(from: chat) else { return }
            self.applyAssistantMessage(text, isPending: chat.state != "final")
        case "session.message":
            guard let payload = event.payload,
                  let message = try? GatewayPayloadDecoding.decode(payload, as: OpenClawSessionMessageEventPayload.self),
                  message.sessionKey == nil || message.sessionKey == sessionKey,
                  let chatMessage = message.message,
                  let role = AmbientAssistantChatRole(rawValue: chatMessage.role),
                  role == .user || role == .assistant
            else {
                return
            }
            let text = chatMessage.content.compactMap(\.text).joined(separator: "\n")
                .trimmingCharacters(in: .whitespacesAndNewlines)
            guard !text.isEmpty else { return }
            self.applyChatMessage(role: role, text: text, isPending: false)
        default:
            break
        }
    }

    private func applyAssistantMessage(_ text: String, isPending: Bool) {
        self.applyChatMessage(role: .assistant, text: text, isPending: isPending)
        self.thomasState = isPending ? .working : .success
    }

    private func applyAssistantError(_ text: String) {
        self.applyChatMessage(role: .assistant, text: text, isPending: false)
        self.result = .failure(text)
        self.thomasState = .error
    }

    private func applyChatMessage(role: AmbientAssistantChatRole, text: String, isPending: Bool) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let message = AmbientAssistantChatMessage(
            id: "push-\(Date().timeIntervalSince1970)-\(role.rawValue)",
            role: role,
            text: trimmed,
            isPending: isPending)
        if role == .assistant {
            self.localChatMessages = self.localChatMessages.map { message in
                guard message.isPending else { return message }
                var sent = message
                sent.isPending = false
                return sent
            }
        }
        self.localChatMessages.removeAll { $0.role == role && $0.text == trimmed }
        self.localChatMessages.append(message)
        self.localChatMessages = Array(self.localChatMessages.suffix(6))
        var snapshot = self.assistantSnapshot
        self.mergeLocalChatMessages(into: &snapshot)
        self.assistantSnapshot = snapshot
    }
}
