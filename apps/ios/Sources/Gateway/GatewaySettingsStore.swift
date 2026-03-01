import Foundation
import os

enum GatewaySettingsStore {
    private static let gatewayService = "ai.openclaw.gateway"
    private static let nodeService = "ai.openclaw.node"
    private static let talkService = "ai.openclaw.talk"

    private static let instanceIdDefaultsKey = "node.instanceId"
    private static let preferredGatewayStableIDDefaultsKey = "gateway.preferredStableID"
    private static let lastDiscoveredGatewayStableIDDefaultsKey = "gateway.lastDiscoveredStableID"
    private static let manualEnabledDefaultsKey = "gateway.manual.enabled"
    private static let manualHostDefaultsKey = "gateway.manual.host"
    private static let manualPortDefaultsKey = "gateway.manual.port"
    private static let manualTlsDefaultsKey = "gateway.manual.tls"
    private static let discoveryDebugLogsDefaultsKey = "gateway.discovery.debugLogs"
    private static let lastGatewayKindDefaultsKey = "gateway.last.kind"
    private static let lastGatewayHostDefaultsKey = "gateway.last.host"
    private static let lastGatewayPortDefaultsKey = "gateway.last.port"
    private static let lastGatewayTlsDefaultsKey = "gateway.last.tls"
    private static let lastGatewayStableIDDefaultsKey = "gateway.last.stableID"
    private static let clientIdOverrideDefaultsPrefix = "gateway.clientIdOverride."
    private static let selectedAgentDefaultsPrefix = "gateway.selectedAgentId."

    private static let instanceIdAccount = "instanceId"
    private static let preferredGatewayStableIDAccount = "preferredStableID"
    private static let lastDiscoveredGatewayStableIDAccount = "lastDiscoveredStableID"
    private static let talkElevenLabsApiKeyAccount = "elevenlabs.apiKey"

    static func bootstrapPersistence() {
        self.ensureStableInstanceID()
        self.ensurePreferredGatewayStableID()
        self.ensureLastDiscoveredGatewayStableID()
    }

    static func loadStableInstanceID() -> String? {
        if let value = KeychainStore.loadString(service: self.nodeService, account: self.instanceIdAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func saveStableInstanceID(_ instanceId: String) {
        _ = KeychainStore.saveString(instanceId, service: self.nodeService, account: self.instanceIdAccount)
    }

    static func loadPreferredGatewayStableID() -> String? {
        if let value = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func savePreferredGatewayStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.preferredGatewayStableIDAccount)
    }

    static func loadLastDiscoveredGatewayStableID() -> String? {
        if let value = KeychainStore.loadString(
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount
        )?.trimmingCharacters(in: .whitespacesAndNewlines),
            !value.isEmpty
        {
            return value
        }

        return nil
    }

    static func saveLastDiscoveredGatewayStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.gatewayService,
            account: self.lastDiscoveredGatewayStableIDAccount)
    }

    static func loadGatewayToken(instanceId: String) -> String? {
        let account = self.gatewayTokenAccount(instanceId: instanceId)
        let token = KeychainStore.loadString(service: self.gatewayService, account: account)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if token?.isEmpty == false { return token }
        return nil
    }

    static func saveGatewayToken(_ token: String, instanceId: String) {
        _ = KeychainStore.saveString(
            token,
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: instanceId))
    }

    static func loadGatewayPassword(instanceId: String) -> String? {
        KeychainStore.loadString(
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: instanceId))?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func saveGatewayPassword(_ password: String, instanceId: String) {
        _ = KeychainStore.saveString(
            password,
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: instanceId))
    }

    enum LastGatewayConnection: Equatable {
        case manual(host: String, port: Int, useTLS: Bool, stableID: String)
        case discovered(stableID: String, useTLS: Bool)

        var stableID: String {
            switch self {
            case let .manual(_, _, _, stableID):
                return stableID
            case let .discovered(stableID, _):
                return stableID
            }
        }

        var useTLS: Bool {
            switch self {
            case let .manual(_, _, useTLS, _):
                return useTLS
            case let .discovered(_, useTLS):
                return useTLS
            }
        }
    }

    private enum LastGatewayKind: String {
        case manual
        case discovered
    }

    static func loadTalkElevenLabsApiKey() -> String? {
        let value = KeychainStore.loadString(
            service: self.talkService,
            account: self.talkElevenLabsApiKeyAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func saveTalkElevenLabsApiKey(_ apiKey: String?) {
        let trimmed = apiKey?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmed.isEmpty {
            _ = KeychainStore.delete(service: self.talkService, account: self.talkElevenLabsApiKeyAccount)
            return
        }
        _ = KeychainStore.saveString(
            trimmed,
            service: self.talkService,
            account: self.talkElevenLabsApiKeyAccount)
    }

    static func saveLastGatewayConnectionManual(host: String, port: Int, useTLS: Bool, stableID: String) {
        let defaults = UserDefaults.standard
        defaults.set(LastGatewayKind.manual.rawValue, forKey: self.lastGatewayKindDefaultsKey)
        defaults.set(host, forKey: self.lastGatewayHostDefaultsKey)
        defaults.set(port, forKey: self.lastGatewayPortDefaultsKey)
        defaults.set(useTLS, forKey: self.lastGatewayTlsDefaultsKey)
        defaults.set(stableID, forKey: self.lastGatewayStableIDDefaultsKey)
    }

    static func saveLastGatewayConnectionDiscovered(stableID: String, useTLS: Bool) {
        let defaults = UserDefaults.standard
        defaults.set(LastGatewayKind.discovered.rawValue, forKey: self.lastGatewayKindDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayHostDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayPortDefaultsKey)
        defaults.set(useTLS, forKey: self.lastGatewayTlsDefaultsKey)
        defaults.set(stableID, forKey: self.lastGatewayStableIDDefaultsKey)
    }

    static func loadLastGatewayConnection() -> LastGatewayConnection? {
        let defaults = UserDefaults.standard
        let stableID = defaults.string(forKey: self.lastGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !stableID.isEmpty else { return nil }
        let useTLS = defaults.bool(forKey: self.lastGatewayTlsDefaultsKey)
        let kindRaw = defaults.string(forKey: self.lastGatewayKindDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let kind = LastGatewayKind(rawValue: kindRaw) ?? .manual

        if kind == .discovered {
            return .discovered(stableID: stableID, useTLS: useTLS)
        }

        let host = defaults.string(forKey: self.lastGatewayHostDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let port = defaults.integer(forKey: self.lastGatewayPortDefaultsKey)

        // Back-compat: older builds persisted manual-style host/port without a kind marker.
        guard !host.isEmpty, port > 0, port <= 65535 else { return nil }
        return .manual(host: host, port: port, useTLS: useTLS, stableID: stableID)
    }

    static func clearLastGatewayConnection(defaults: UserDefaults = .standard) {
        defaults.removeObject(forKey: self.lastGatewayKindDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayHostDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayPortDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayTlsDefaultsKey)
        defaults.removeObject(forKey: self.lastGatewayStableIDDefaultsKey)
    }

    static func deleteGatewayCredentials(instanceId: String) {
        let trimmed = instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayTokenAccount(instanceId: trimmed))
        _ = KeychainStore.delete(
            service: self.gatewayService,
            account: self.gatewayPasswordAccount(instanceId: trimmed))
    }

    static func loadGatewayClientIdOverride(stableID: String) -> String? {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return nil }
        let key = self.clientIdOverrideDefaultsPrefix + trimmedID
        let value = UserDefaults.standard.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func saveGatewayClientIdOverride(stableID: String, clientId: String?) {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return }
        let key = self.clientIdOverrideDefaultsPrefix + trimmedID
        let trimmedClientId = clientId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedClientId.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(trimmedClientId, forKey: key)
        }
    }

    static func loadGatewaySelectedAgentId(stableID: String) -> String? {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return nil }
        let key = self.selectedAgentDefaultsPrefix + trimmedID
        let value = UserDefaults.standard.string(forKey: key)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if value?.isEmpty == false { return value }
        return nil
    }

    static func saveGatewaySelectedAgentId(stableID: String, agentId: String?) {
        let trimmedID = stableID.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedID.isEmpty else { return }
        let key = self.selectedAgentDefaultsPrefix + trimmedID
        let trimmedAgentId = agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if trimmedAgentId.isEmpty {
            UserDefaults.standard.removeObject(forKey: key)
        } else {
            UserDefaults.standard.set(trimmedAgentId, forKey: key)
        }
    }

    private static func gatewayTokenAccount(instanceId: String) -> String {
        "gateway-token.\(instanceId)"
    }

    private static func gatewayPasswordAccount(instanceId: String) -> String {
        "gateway-password.\(instanceId)"
    }

    private static func ensureStableInstanceID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadStableInstanceID() == nil {
                self.saveStableInstanceID(existing)
            }
            return
        }

        if let stored = self.loadStableInstanceID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.instanceIdDefaultsKey)
            return
        }

        let fresh = UUID().uuidString
        self.saveStableInstanceID(fresh)
        defaults.set(fresh, forKey: self.instanceIdDefaultsKey)
    }

    private static func ensurePreferredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.preferredGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadPreferredGatewayStableID() == nil {
                self.savePreferredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadPreferredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.preferredGatewayStableIDDefaultsKey)
        }
    }

    private static func ensureLastDiscoveredGatewayStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadLastDiscoveredGatewayStableID() == nil {
                self.saveLastDiscoveredGatewayStableID(existing)
            }
            return
        }

        if let stored = self.loadLastDiscoveredGatewayStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.lastDiscoveredGatewayStableIDDefaultsKey)
        }
    }

}

enum GatewayDiagnostics {
    private static let logger = Logger(subsystem: "ai.openclaw.ios", category: "GatewayDiag")
    private static let queue = DispatchQueue(label: "ai.openclaw.gateway.diagnostics")
    private static let maxLogBytes: Int64 = 512 * 1024
    private static let keepLogBytes: Int64 = 256 * 1024
    private static let logSizeCheckEveryWrites = 50
    nonisolated(unsafe) private static var logWritesSinceCheck = 0
    private static var fileURL: URL? {
        FileManager.default.urls(for: .documentDirectory, in: .userDomainMask).first?
            .appendingPathComponent("openclaw-gateway.log")
    }

    private static func truncateLogIfNeeded(url: URL) {
        guard let attrs = try? FileManager.default.attributesOfItem(atPath: url.path),
              let sizeNumber = attrs[.size] as? NSNumber
        else { return }
        let size = sizeNumber.int64Value
        guard size > self.maxLogBytes else { return }

        do {
            let handle = try FileHandle(forReadingFrom: url)
            defer { try? handle.close() }

            let start = max(Int64(0), size - self.keepLogBytes)
            try handle.seek(toOffset: UInt64(start))
            var tail = try handle.readToEnd() ?? Data()

            // If we truncated mid-line, drop the first partial line so logs remain readable.
            if start > 0, let nl = tail.firstIndex(of: 10) {
                let next = tail.index(after: nl)
                if next < tail.endIndex {
                    tail = tail.suffix(from: next)
                } else {
                    tail = Data()
                }
            }

            try tail.write(to: url, options: .atomic)
        } catch {
            // Best-effort only.
        }
    }

    private static func appendToLog(url: URL, data: Data) {
        if FileManager.default.fileExists(atPath: url.path) {
            if let handle = try? FileHandle(forWritingTo: url) {
                defer { try? handle.close() }
                _ = try? handle.seekToEnd()
                try? handle.write(contentsOf: data)
            }
        } else {
            try? data.write(to: url, options: .atomic)
        }
    }

    static func bootstrap() {
        guard let url = fileURL else { return }
        queue.async {
            self.truncateLogIfNeeded(url: url)
            let formatter = ISO8601DateFormatter()
            formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            let timestamp = formatter.string(from: Date())
            let line = "[\(timestamp)] gateway diagnostics started\n"
            if let data = line.data(using: .utf8) {
                self.appendToLog(url: url, data: data)
            }
        }
    }

    static func log(_ message: String) {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let timestamp = formatter.string(from: Date())
        let line = "[\(timestamp)] \(message)"
        logger.info("\(line, privacy: .public)")

        guard let url = fileURL else { return }
        queue.async {
            self.logWritesSinceCheck += 1
            if self.logWritesSinceCheck >= self.logSizeCheckEveryWrites {
                self.logWritesSinceCheck = 0
                self.truncateLogIfNeeded(url: url)
            }
            let entry = line + "\n"
            if let data = entry.data(using: .utf8) {
                self.appendToLog(url: url, data: data)
            }
        }
    }

    static func reset() {
        guard let url = fileURL else { return }
        queue.async {
            try? FileManager.default.removeItem(at: url)
        }
    }
}
