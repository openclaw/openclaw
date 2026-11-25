import Foundation

extension GatewayConnection {
    struct ConfigGetSnapshot: Decodable {
        struct SnapshotConfig: Decodable {
            struct Session: Decodable {
                let mainKey: String?
                let scope: String?
            }

            let session: Session?
        }

        let config: SnapshotConfig?
    }

    static func mainSessionKey(fromConfigGetData data: Data) throws -> String {
        let snapshot = try JSONDecoder().decode(ConfigGetSnapshot.self, from: data)
        let scope = snapshot.config?.session?.scope?.trimmingCharacters(in: .whitespacesAndNewlines)
        if scope == "global" {
            return "global"
        }
        return "main"
    }

    func mainSessionKey(timeoutMs: Double = 15000) async -> String {
        if let cached = cachedMainSessionKey() {
            return cached
        }
        return await self.refreshMainSessionKey(timeoutMs: timeoutMs)
    }

    /// The resolved key belongs to this hello's physical socket. Callers must
    /// recheck the lease synchronously when presenting it outside this actor.
    func mainSessionKey(ifCurrentServerLease lease: ServerLease, timeoutMs: Double = 15000) async throws -> String {
        guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
        if let cached = self.cachedMainSessionKey() { return cached }
        do {
            let data = try await self.request(
                method: "config.get", params: nil, timeoutMs: timeoutMs, ifCurrentServerLease: lease)
            return try Self.mainSessionKey(fromConfigGetData: data)
        } catch {
            try Task.checkCancellation()
            guard await self.isCurrentServerLease(lease) else { throw CancellationError() }
            return "main"
        }
    }

    func refreshMainSessionKey(timeoutMs: Double = 15000) async -> String {
        do {
            let data = try await request(method: "config.get", params: nil, timeoutMs: timeoutMs)
            return try Self.mainSessionKey(fromConfigGetData: data)
        } catch {
            return "main"
        }
    }
}
