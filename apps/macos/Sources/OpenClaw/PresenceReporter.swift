import Cocoa
import Foundation
import OpenClawKit
import OSLog

@MainActor
final class PresenceReporter {
    static let shared = PresenceReporter()

    private let logger = Logger(subsystem: "ai.openclaw", category: "presence")
    private var task: Task<Void, Never>?
    private let interval: TimeInterval = 180 // a few minutes
    private let instanceId: String = InstanceIdentity.instanceId
    private static let clearLastInputTag = "system-presence-clear-last-input"
    private static let legacyClearedLastInputSeconds = 30 * 24 * 60 * 60

    static let activityPrivacyParameters: [String: AnyHashable] = [
        // Older Gateways overwrite exact recency with the sentinel; current ones
        // let the tag win and delete the field.
        "lastInputSeconds": AnyHashable(legacyClearedLastInputSeconds),
        "tags": AnyHashable([clearLastInputTag]),
    ]

    func start() {
        guard self.task == nil else { return }
        self.task = Task.detached { [weak self] in
            guard let self else { return }
            await self.push(reason: "launch")
            while await SimpleTaskSupport.waitForNextOperation(interval: self.interval) {
                await self.push(reason: "periodic")
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }

    @Sendable
    private func push(reason: String) async {
        let mode = await MainActor.run { AppStateStore.shared.connectionMode.rawValue }
        let host = InstanceIdentity.displayName
        let ip = NetworkInterfaces.primaryIPv4Address() ?? "ip-unknown"
        let version = Self.appVersionString()
        let platform = Self.platformString()
        let text = Self.composePresenceSummary(mode: mode, reason: reason)
        var params = Self.activityPrivacyParameters
        params.merge([
            "instanceId": AnyHashable(self.instanceId),
            "host": AnyHashable(host),
            "ip": AnyHashable(ip),
            "mode": AnyHashable(mode),
            "version": AnyHashable(version),
            "platform": AnyHashable(platform),
            "deviceFamily": AnyHashable("Mac"),
            "reason": AnyHashable(reason),
        ]) { _, value in value }
        if let model = InstanceIdentity.modelIdentifier { params["modelIdentifier"] = AnyHashable(model) }
        do {
            try await ControlChannel.shared.sendSystemEvent(text, params: params)
        } catch {
            self.logger.error("presence send failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Fire an immediate presence beacon (e.g., right after connecting).
    func sendImmediate(reason: String = "connect") {
        Task { await self.push(reason: reason) }
    }

    static func composePresenceSummary(mode: String, reason: String) -> String {
        let host = InstanceIdentity.displayName
        let ip = NetworkInterfaces.primaryIPv4Address() ?? "ip-unknown"
        let version = Self.appVersionString()
        return "Node: \(host) (\(ip)) · app \(version) · mode \(mode) · reason \(reason)"
    }

    private static func appVersionString() -> String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        if let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String {
            let trimmed = build.trimmingCharacters(in: .whitespacesAndNewlines)
            if !trimmed.isEmpty, trimmed != version {
                return "\(version) (\(trimmed))"
            }
        }
        return version
    }

    private static func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "macos \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }
}
