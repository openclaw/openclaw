import AppIntents

// MARK: - Intent

/// An App Intent that opens OpenClaw directly in Talk Mode.
///
/// Assign this intent to the iPhone Action Button via:
/// Settings → Action Button → Custom Action → OpenClaw → "Open Talk Mode"
///
/// It also appears in the Shortcuts app and is accessible via Siri:
/// "Hey Siri, open Talk Mode in OpenClaw"
///
struct OpenTalkModeIntent: AppIntent {
    static let title: LocalizedStringResource = "Open Talk Mode"
    static let description = IntentDescription(
        "Opens OpenClaw and activates Talk Mode for voice interaction.",
        categoryName: "Communication"
    )

    /// Bring OpenClaw to the foreground when this intent runs.
    static let openAppWhenRun: Bool = true

    /// Shared `UserDefaults` key used to signal a pending Talk Mode navigation.
    /// Follows the app's dot-separated camelCase key convention (e.g. "gateway.preferredStableID").
    /// Referenced by `RootCanvas` via `OpenTalkModeIntent.pendingTalkModeKey`.
    static let pendingTalkModeKey = "talk.pendingTalkMode"

    func perform() async throws -> some IntentResult {
        // Signal the app to navigate to Talk Mode.
        // RootCanvas observes this via @AppStorage and reacts immediately,
        // including when the app is already in the foreground.
        await MainActor.run {
            UserDefaults.standard.set(true, forKey: Self.pendingTalkModeKey)
        }
        return .result()
    }
}

// MARK: - App Shortcuts

/// Registers OpenClaw shortcuts so Siri and the Action Button can discover them.
/// Requires `ENABLE_APP_INTENTS_METADATA_GENERATION = YES` in build settings.
struct OpenClawShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: OpenTalkModeIntent(),
            phrases: [
                "Open Talk Mode in \(.applicationName)",
                "Talk to \(.applicationName)",
                "Activate \(.applicationName) voice",
            ],
            shortTitle: "Open Talk Mode",
            systemImageName: "mic.fill"
        )
    }
}
