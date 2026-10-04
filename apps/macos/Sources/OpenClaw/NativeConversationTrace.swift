import Foundation
import OpenClawKit

enum NativeConversationTrace {
    private static let enabled = ProcessInfo.processInfo.environment["OPENCLAW_DEBUG_CONVERSATION_BRIDGE"] == "1"
    private static let messageTypes: Set<String> = [
        "ready", "state", "route-changed", "open-dashboard", "command-result", "session-facts",
    ]

    static func receive(_ body: Any) {
        guard self.enabled else { return }
        let fields = body as? [String: Any]
        let type = fields?["type"] as? String ?? "unsupported"
        let revision = (fields?["revision"] as? NSNumber)?.stringValue ?? "-"
        NSLog(
            "[ConversationBridge] receive type=%@ revision=%@ documentId=%@",
            self.messageTypes.contains(type) ? type : "unsupported",
            revision,
            self.documentID(fields?["documentId"] as? String))
    }

    static func command(_ command: NativeConversationCommand) {
        guard self.enabled else { return }
        NSLog(
            "[ConversationBridge] send type=%@ requestId=%@ documentId=%@",
            self.type(command.action),
            command.requestId,
            self.documentID(command.documentId))
    }

    static func result(_ command: NativeConversationCommand, result: NativeConversationResult) {
        guard self.enabled else { return }
        // Errors are arbitrary web strings. Log only known transport codes, never
        // an error description that might contain a session name or message text.
        let error = result.error ?? "web-error"
        let outcome = result.ok ? "ok" : ["timeout", "stale-document", "unsupported"].contains(error)
            ? error : "web-error"
        NSLog(
            "[ConversationBridge] result type=%@ requestId=%@ documentId=%@ result=%@",
            self.type(command.action),
            command.requestId,
            self.documentID(command.documentId),
            outcome)
    }

    private static func documentID(_ value: String?) -> String {
        guard let value else { return "-" }
        return UUID(uuidString: value) == nil ? "invalid" : value
    }

    private static func type(_ action: NativeConversationCommand.Action) -> String {
        switch action {
        case .navigate: "navigate"
        case .presentation: "presentation"
        case .focusComposer: "focus-composer"
        case .openSessionActions: "open-session-actions"
        }
    }
}
