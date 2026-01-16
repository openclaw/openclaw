import AppKit
import ClawdbotKit
import CoreLocation
import Foundation

enum SystemRunDecision: Sendable {
    case allowOnce
    case allowAlways
    case deny
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

    func confirmSystemRun(command: String, cwd: String?) async -> SystemRunDecision
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

    func confirmSystemRun(command: String, cwd: String?) async -> SystemRunDecision {
        let alert = NSAlert()
        alert.alertStyle = .warning
        alert.messageText = "Allow this command?"

        var details = "Clawdbot wants to run:\n\n\(command)"
        let trimmedCwd = cwd?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !trimmedCwd.isEmpty {
            details += "\n\nWorking directory:\n\(trimmedCwd)"
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
