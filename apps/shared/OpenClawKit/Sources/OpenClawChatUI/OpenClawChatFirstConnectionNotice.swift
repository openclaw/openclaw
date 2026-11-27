/// Replaces the transcript's "Disconnected / Refresh" card for a host that has never had a
/// connection to restore, so the action sets one up instead of retrying a missing one.
public struct OpenClawChatFirstConnectionNotice {
    public var title: String
    public var message: String
    public var actionTitle: String
    public var action: () -> Void

    public init(title: String, message: String, actionTitle: String, action: @escaping () -> Void) {
        self.title = title
        self.message = message
        self.actionTitle = actionTitle
        self.action = action
    }
}

extension OpenClawChatFirstConnectionNotice {
    @MainActor var card: ChatNoticeCard {
        ChatNoticeCard(
            systemImage: "wifi.slash",
            title: self.title,
            message: self.message,
            actionTitle: self.actionTitle,
            action: self.action)
    }
}

/// The transcript's "Disconnected" errors, which a first-connection notice may replace.
func chatErrorIsDisconnected(_ error: String) -> Bool {
    let lower = error.lowercased()
    return lower.contains("not connected") || lower.contains("socket")
}
