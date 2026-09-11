import AppIntents
import OpenClawKit

extension OpenClawApp: AppIntentsPackage {
    nonisolated static var includedPackages: [any AppIntentsPackage.Type] {
        [OpenClawNativeAppIntents.self]
    }
}

struct StartLiveVoiceIntent: AppIntent {
    static let title: LocalizedStringResource = "Start Live Voice"
    // periphery:ignore - App Intents consumes this metadata for Siri and Shortcuts.
    static let description: IntentDescription? = IntentDescription(
        "Open the current chat in OpenClaw and start a voice conversation.")
    static let openAppWhenRun = true

    @MainActor
    func perform() async throws -> some IntentResult {
        OpenClawAppModelRegistry.requestLiveVoiceStart()
        return .result()
    }
}

struct OpenClawShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: StartLiveVoiceIntent(),
            phrases: ["Start live voice with \(.applicationName)"],
            shortTitle: "Start Live Voice",
            systemImageName: "waveform")
        AppShortcut(
            intent: OpenSessionIntent(),
            phrases: ["Open a session in \(.applicationName)"],
            shortTitle: "Open Session",
            systemImageName: "bubble.left.and.bubble.right")
        AppShortcut(
            intent: OpenComposeIntent(),
            phrases: ["Compose a message in \(.applicationName)"],
            shortTitle: "Compose Message",
            systemImageName: "square.and.pencil")
        AppShortcut(
            intent: SendMessageIntent(),
            phrases: ["Send a message with \(.applicationName)"],
            shortTitle: "Send Message",
            systemImageName: "paperplane")
        AppShortcut(
            intent: InspectRunIntent(),
            phrases: ["Inspect a run in \(.applicationName)"],
            shortTitle: "Inspect Run",
            systemImageName: "clock")
    }
}
