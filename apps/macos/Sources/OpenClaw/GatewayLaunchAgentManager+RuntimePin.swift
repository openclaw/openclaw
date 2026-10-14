import CryptoKit
import Foundation
import OpenClawNativeState

extension GatewayLaunchAgentManager {
    nonisolated static func runtimePinKey(profile: AppProfile, configPath: String) throws -> String {
        // Keep the external store key aligned with daemon/runtime-pin-state.ts's resolveScope.
        let scope = ["gateway", "darwin", profile.gatewayLaunchAgentLabel, configPath]
        let bytes = try JSONSerialization.data(withJSONObject: scope, options: [.withoutEscapingSlashes])
        let hash = SHA256.hash(data: bytes).map { String(format: "%02x", $0) }.joined()
        return "daemon-runtime-pin:" + hash
    }

    nonisolated static func hasRuntimePin(stateDirectory: URL, profile: AppProfile) async throws -> Bool {
        try await self.runtimePinRecord(stateDirectory: stateDirectory, profile: profile) != nil
    }

    nonisolated static func runtimePinRecord(
        stateDirectory: URL,
        profile: AppProfile) async throws -> OpenClawNativeStateConfigValue?
    {
        try await Task.detached {
            let databaseURL = stateDirectory.appendingPathComponent("state/openclaw.sqlite")
            do {
                _ = try FileManager.default.attributesOfItem(atPath: databaseURL.path)
            } catch let error as NSError where error.domain == NSCocoaErrorDomain &&
                (error.code == NSFileReadNoSuchFileError || error.code == NSFileNoSuchFileError)
            {
                return nil
            }
            let key = try self.runtimePinKey(
                profile: profile, configPath: stateDirectory.appendingPathComponent("openclaw.json").path)
            let database = try OpenClawNativeStateSQLite(
                databaseURL: databaseURL, createIfMissing: false, readOnly: true)
            // Presence is operator intent even for app-tools Node. Malformed or stale records
            // must not be treated as an unpinned service by pause or migration.
            return try database.configMachineStateValue(key: key)
        }.value
    }
}
