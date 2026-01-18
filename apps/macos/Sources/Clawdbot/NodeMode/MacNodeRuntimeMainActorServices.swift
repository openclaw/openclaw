import AppKit
import ClawdbotKit
import CoreLocation
import Foundation

enum SystemRunDecision: Sendable {
    case allowOnce
    case allowAlways
    case deny
}

struct SystemRunPromptContext: Sendable {
    let command: String
    let cwd: String?
    let agentId: String?
    let executablePath: String?
}

@MainActor
protocol MacNodeRuntimeMainActorServices: Sendable {
    func recordScreen(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)

    func locationAuthorizationStatus() -> CLAuthorizationStatus
    func locationAccuracyAuthorization() -> CLAccuracyAuthorization
    func currentLocation(
        desiredAccuracy: ClawdbotLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation

    func confirmSystemRun(context: SystemRunPromptContext) async -> SystemRunDecision
}

@MainActor
final class LiveMacNodeRuntimeMainActorServices: MacNodeRuntimeMainActorServices, @unchecked Sendable {
    private let screenRecorder = ScreenRecordService()
    private let locationService = MacNodeLocationService()

    func recordScreen(
        screenIndex: Int?,
        durationMs: Int?,
        fps: Double?,
        includeAudio: Bool?,
        outPath: String?) async throws -> (path: String, hasAudio: Bool)
    {
        try await self.screenRecorder.record(
            screenIndex: screenIndex,
            durationMs: durationMs,
            fps: fps,
            includeAudio: includeAudio,
            outPath: outPath)
    }

    func locationAuthorizationStatus() -> CLAuthorizationStatus {
        self.locationService.authorizationStatus()
    }

    func locationAccuracyAuthorization() -> CLAccuracyAuthorization {
        self.locationService.accuracyAuthorization()
    }

    func currentLocation(
        desiredAccuracy: ClawdbotLocationAccuracy,
        maxAgeMs: Int?,
        timeoutMs: Int?) async throws -> CLLocation
    {
        try await self.locationService.currentLocation(
            desiredAccuracy: desiredAccuracy,
            maxAgeMs: maxAgeMs,
            timeoutMs: timeoutMs)
    }

    func confirmSystemRun(context: SystemRunPromptContext) async -> SystemRunDecision {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow this command?"

        var details = "Clawdbot wants to run:\n\n\(context.command)"
        let trimmedCwd = context.cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedCwd.isEmpty {
            details += "\n\nWorking directory:\n\(trimmedCwd)"
        }
        let trimmedAgent = context.agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedAgent.isEmpty {
            details += "\n\nAgent:\n\(trimmedAgent)"
        }
        let trimmedPath = context.executablePath?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedPath.isEmpty {
            details += "\n\nExecutable:\n\(trimmedPath)"
        }
        details += "\n\nThis runs on this Mac via node mode."
        alert.informativeText = details

        alert.addButton(withTitle: "Allow Once")
        alert.addButton(withTitle: "Always Allow")
        alert.addButton(withTitle: "Don't Allow")

        switch alert.runModal() {
        case .alertFirstButtonReturn:
            return .allowOnce
        case .alertSecondButtonReturn:
            return .allowAlways
        default:
            return .deny
        }
    }
}
