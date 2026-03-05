import AppIntents

/// Registers built-in Siri phrases for OpenClaw shortcuts.
/// Users can say any of these phrases directly to Siri without setting up a shortcut first.
@available(iOS 16.4, *)
struct OpenClawShortcutsProvider: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: SendAgentMessageIntent(),
            phrases: [
                "Send \(\.$message) with \(.applicationName)",
                "Ask \(.applicationName) \(\.$message)",
                "Tell \(.applicationName) \(\.$message)",
                "Message \(.applicationName) \(\.$message)",
            ],
            shortTitle: "Send to Agent",
            systemImageName: "bubble.left.and.bubble.right.fill")
    }
}
