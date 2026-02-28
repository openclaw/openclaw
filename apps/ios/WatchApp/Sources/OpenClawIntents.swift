import AppIntents

/// Opens the Watch app and focuses on the latest notification's reply actions.
struct QuickReplyIntent: AppIntent {
    static let title: LocalizedStringResource = "Quick Reply"
    static let description: IntentDescription = "Open OpenClaw to reply to the latest notification"
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

/// Opens the Watch app (used by the connection status control).
struct OpenClawOpenAppIntent: AppIntent {
    static let title: LocalizedStringResource = "Open OpenClaw"
    static let description: IntentDescription = "Open the OpenClaw Watch app"
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}

/// Intent for the connection status control. The control is read-only display;
/// tapping it simply opens the app.
struct ConnectionStatusIntent: AppIntent {
    static let title: LocalizedStringResource = "Connection Status"
    static let description: IntentDescription = "Open OpenClaw to view connection status"
    static let openAppWhenRun = true

    func perform() async throws -> some IntentResult {
        .result()
    }
}
