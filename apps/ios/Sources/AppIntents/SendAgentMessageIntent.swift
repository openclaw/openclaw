import AppIntents
import Foundation

/// Sends a message to the OpenClaw AI agent from Shortcuts or Siri.
/// Runs fully in the background — the app does not need to be open.
@available(iOS 16.0, *)
struct SendAgentMessageIntent: AppIntent {
    static var title: LocalizedStringResource = "Send Message to Agent"
    static var description = IntentDescription(
        "Sends a message to your OpenClaw AI agent. The agent processes it in the background and can deliver the reply to any connected messaging channel.",
        categoryName: "Agent")

    /// Do not open the app — run silently in the background.
    static var openAppWhenRun: Bool = false

    @Parameter(
        title: "Message",
        description: "The message or task to send to your agent.",
        inputOptions: String.IntentInputOptions(capitalizationType: .sentences))
    var message: String

    @Parameter(
        title: "Thinking",
        description: "How much reasoning effort the agent applies. Low is faster; High is deeper.",
        default: .low)
    var thinking: ThinkingLevel

    func perform() async throws -> some IntentResult & ProvidesDialog {
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw $message.needsValueError("Please enter a message to send.")
        }

        try await AgentIntentGatewayRelay.send(
            .init(message: trimmed, thinking: thinking.rawValue))

        return .result(dialog: "Sent to your OpenClaw agent.")
    }
}

/// The amount of reasoning effort the agent applies.
@available(iOS 16.0, *)
enum ThinkingLevel: String, AppEnum {
    case low
    case medium
    case high

    static var typeDisplayRepresentation: TypeDisplayRepresentation = "Thinking Level"
    static var caseDisplayRepresentations: [ThinkingLevel: DisplayRepresentation] = [
        .low: DisplayRepresentation(title: "Low", subtitle: "Faster responses"),
        .medium: DisplayRepresentation(title: "Medium"),
        .high: DisplayRepresentation(title: "High", subtitle: "Deeper reasoning"),
    ]
}
