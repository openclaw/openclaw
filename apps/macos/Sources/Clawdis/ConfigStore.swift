import Foundation

enum ConfigStore {
    private static func isRemoteMode() async -> Bool {
        await MainActor.run { AppStateStore.shared.connectionMode == .remote }
    }

    static func load() async -> [String: Any] {
        if await self.isRemoteMode() {
            return await self.loadFromGateway()
        }
        return ClawdisConfigFile.loadDict()
    }

    static func save(_ root: [String: Any]) async throws {
        if await self.isRemoteMode() {
            try await self.saveToGateway(root)
        } else {
            ClawdisConfigFile.saveDict(root)
        }
    }

    private static func loadFromGateway() async -> [String: Any] {
        do {
            let snap: ConfigSnapshot = try await GatewayConnection.shared.requestDecoded(
                method: .configGet,
                params: nil,
                timeoutMs: 8000)
            return snap.config?.mapValues { $0.foundationValue } ?? [:]
        } catch {
            return [:]
        }
    }

    private static func saveToGateway(_ root: [String: Any]) async throws {
        let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw NSError(domain: "ConfigStore", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "Failed to encode config."
            ])
        }
        let params: [String: AnyCodable] = ["raw": AnyCodable(raw)]
        _ = try await GatewayConnection.shared.requestRaw(
            method: .configSet,
            params: params,
            timeoutMs: 10000)
    }
}
