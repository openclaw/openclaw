import AppKit
import Foundation
import SwiftUI

enum DebugActions {
    @MainActor
    static func openAgentEventsWindow() {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 620, height: 420),
            styleMask: [.titled, .closable, .miniaturizable, .resizable],
            backing: .buffered,
            defer: false)
        window.title = "Agent Events"
        window.isReleasedWhenClosed = false
        window.contentView = NSHostingView(rootView: AgentEventsWindow())
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    @MainActor
    static func openLog() {
        let path = self.pinoLogPath()
        let url = URL(fileURLWithPath: path)
        guard FileManager.default.fileExists(atPath: path) else {
            let alert = NSAlert()
            alert.messageText = "Log file not found"
            alert.informativeText = path
            alert.runModal()
            return
        }
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }

    static func sendTestNotification() async {
        _ = await NotificationManager().send(title: "Clawdis", body: "Test notification", sound: nil)
    }

    static func sendDebugVoice() async -> Result<String, String> {
        let message = """
        This is a debug test from the Mac app. Reply with "Debug test works (and a funny pun)" \
        if you received that.
        """
        let config = await MainActor.run { AppStateStore.shared.voiceWakeForwardConfig }
        let shouldForward = config.enabled

        if shouldForward {
            let result = await VoiceWakeForwarder.forward(transcript: message, config: config)
            switch result {
            case .success:
                return .success("Forwarded. Await reply.")
            case let .failure(error):
                let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
                return .failure("Forward failed: \(detail)")
            }
        }

        do {
            let status = await AgentRPC.shared.status()
            if !status.ok {
                try await AgentRPC.shared.start()
            }

            let rpcResult = await AgentRPC.shared.send(
                text: message,
                thinking: "low",
                session: "main",
                deliver: true,
                to: nil)

            if rpcResult.ok {
                return .success("Sent locally via voice wake path.")
            } else {
                let reason = rpcResult.error?.trimmingCharacters(in: .whitespacesAndNewlines)
                let detail = (reason?.isEmpty == false)
                    ? reason!
                    : "No error returned. Check /tmp/clawdis.log or rpc output."
                return .failure("Local send failed: \(detail)")
            }
        } catch {
            let detail = error.localizedDescription.trimmingCharacters(in: .whitespacesAndNewlines)
            return .failure("Local send failed: \(detail)")
        }
    }

    static func restartGateway() {
        Task { @MainActor in
            RelayProcessManager.shared.stop()
            try? await Task.sleep(nanoseconds: 300_000_000)
            RelayProcessManager.shared.setActive(true)
        }
    }

    private static func pinoLogPath() -> String {
        let df = DateFormatter()
        df.calendar = Calendar(identifier: .iso8601)
        df.locale = Locale(identifier: "en_US_POSIX")
        df.dateFormat = "yyyy-MM-dd"
        let today = df.string(from: Date())
        let rolling = URL(fileURLWithPath: "/tmp/clawdis/clawdis-\(today).log").path
        if FileManager.default.fileExists(atPath: rolling) { return rolling }
        return "/tmp/clawdis.log"
    }
}
