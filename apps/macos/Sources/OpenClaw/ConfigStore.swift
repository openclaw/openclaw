import Foundation
import OpenClawProtocol

enum ConfigStore {
    struct Overrides {
        var isRemoteMode: (@Sendable () async -> Bool)?
        var loadLocal: (@MainActor @Sendable () -> [String: Any])?
        var saveLocal: (@MainActor @Sendable ([String: Any]) -> Void)?
        var loadRemote: (@MainActor @Sendable () async -> [String: Any])?
        var saveRemote: (@MainActor @Sendable ([String: Any]) async throws -> Void)?
        var saveGateway: (@MainActor @Sendable ([String: Any]) async throws -> Void)?
    }

    private actor OverrideStore {
        var overrides = Overrides()

        func setOverride(_ overrides: Overrides) {
            self.overrides = overrides
        }
    }

    private static let overrideStore = OverrideStore()
    @MainActor private static var lastHash: String?

    private static func isRemoteMode() async -> Bool {
        let overrides = await self.overrideStore.overrides
        if let override = overrides.isRemoteMode {
            return await override()
        }
        return await MainActor.run { AppStateStore.shared.connectionMode == .remote }
    }

    @MainActor
    static func load() async -> [String: Any] {
        let overrides = await self.overrideStore.overrides
        if await self.isRemoteMode() {
            if let override = overrides.loadRemote {
                return await override()
            }
            return await self.loadFromGateway() ?? [:]
        }
        if let override = overrides.loadLocal {
            return override()
        }
        if let gateway = await self.loadFromGateway() {
            return gateway
        }
        return OpenClawConfigFile.loadDict()
    }

    @MainActor
    static func save(
        _ root: sending [String: Any],
        allowGatewayAuthMutation: Bool = false) async throws
    {
        let overrides = await self.overrideStore.overrides
        if await self.isRemoteMode() {
            if let override = overrides.saveRemote {
                try await override(root)
            } else {
                try await self.saveToGateway(root)
            }
        } else {
            if let override = overrides.saveLocal {
                override(root)
            } else {
                do {
                    try await self.saveToGateway(root)
                } catch {
                    guard self.shouldFallbackToLocalWrite(afterGatewaySaveError: error) else {
                        self.lastHash = nil
                        throw error
                    }
                    guard OpenClawConfigFile.saveDict(
                        root,
                        preserveExistingKeys: true,
                        allowGatewayAuthMutation: allowGatewayAuthMutation)
                    else {
                        throw NSError(domain: "ConfigStore", code: 2, userInfo: [
                            NSLocalizedDescriptionKey: "Local config write rejected to protect gateway auth/mode.",
                        ])
                    }
                }
            }
        }
    }

    @MainActor
    private static func loadFromGateway() async -> [String: Any]? {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 8000)
            self.lastHash = snap.hash
            return snap.config?.mapValues { $0.foundationValue } ?? [:]
        } catch {
            return nil
        }
    }

    private static func shouldFallbackToLocalWrite(afterGatewaySaveError error: Error) -> Bool {
        let nsError = error as NSError
        let message = "\(nsError.domain) \(nsError.localizedDescription)".lowercased()
        let blockedFragments = [
            "invalid_request",
            "invalid request",
            "invalid config",
            "config changed since last load",
            "base hash",
            "basehash",
            "unauthorized",
            "token mismatch",
            "auth",
        ]
        return !blockedFragments.contains { message.contains($0) }
    }

    @MainActor
    private static func saveToGateway(_ root: [String: Any]) async throws {
        let overrides = await self.overrideStore.overrides
        if let saveGateway = overrides.saveGateway {
            try await saveGateway(root)
            return
        }
        if self.lastHash == nil {
            _ = await self.loadFromGateway()
        }
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "ConfigStore", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode config.",
            ])
        }
        var params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
        if let baseHash = self.lastHash {
            params["baseHash"] = AnyCodable(baseHash)
        }
        _ = try await GatewayConnection.shared.requestRaw(
            method: .configSet,
            params: params,
            timeoutMs: 10000)
        _ = await self.loadFromGateway()
    }

    /// Profile name used for the "Browser Control: My Browser" extension-driver mode.
    static let myBrowserProfileName = "mybrowser"

    /// Reads whether the "My Browser" extension-driver profile is currently the
    /// default browser profile, i.e. whether My Browser mode is active.
    @MainActor
    static func loadMyBrowserEnabled() async -> Bool {
        let root = await self.load()
        let browser = root["browser"] as? [String: Any]
        return (browser?["defaultProfile"] as? String) == self.myBrowserProfileName
    }

    /// Enables or disables "My Browser" mode (the agent drives the user's real
    /// Chrome via the bundled extension), mirroring `buildAndSaveBrowserEnabled`.
    ///
    /// When enabled: ensures an `extension`-driver profile named `mybrowser`
    /// exists, makes it the default profile, and enables the browser.
    /// When disabled: reverts the default profile to the previously selected
    /// profile (or `chrome`) without deleting the `mybrowser` profile.
    @MainActor
    static func buildAndSaveMyBrowserEnabled(_ enabled: Bool) async -> Bool {
        var root = await self.load()
        var browser = root["browser"] as? [String: Any] ?? [:]

        if enabled {
            // Remember the prior default so we can restore it when turning off.
            if let priorDefault = browser["defaultProfile"] as? String,
               priorDefault != self.myBrowserProfileName
            {
                browser["priorDefaultProfile"] = priorDefault
            }
            var profiles = browser["profiles"] as? [String: Any] ?? [:]
            profiles[self.myBrowserProfileName] = ["driver": "extension-bridge", "color": "#FF5A36"]
            browser["profiles"] = profiles
            browser["defaultProfile"] = self.myBrowserProfileName
            browser["enabled"] = true
        } else {
            // Revert to the prior default (or "chrome") but keep the profile.
            let restored = (browser["priorDefaultProfile"] as? String) ?? "chrome"
            browser["defaultProfile"] = restored
            browser.removeValue(forKey: "priorDefaultProfile")
        }

        root["browser"] = browser
        do {
            try await self.save(root)
            return true
        } catch {
            return false
        }
    }

    #if DEBUG
    static func _testSetOverrides(_ overrides: Overrides) async {
        await self.overrideStore.setOverride(overrides)
    }

    static func _testClearOverrides() async {
        await self.overrideStore.setOverride(.init())
    }
    #endif
}
