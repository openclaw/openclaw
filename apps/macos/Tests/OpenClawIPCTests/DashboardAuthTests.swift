import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct DashboardAuthTests {
    @Test func `dashboard browser auth uses configured shared token only`() throws {
        let config: GatewayConnection.Config = try (
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: " shared-token ",
            password: nil)

        #expect(GatewayConnection.controlUiSharedAuthToken(config: config) == "shared-token")
    }

    @Test func `dashboard browser auth ignores stored native device token`() async throws {
        try await self.withTemporaryStateDir {
            let identity = DeviceIdentityStore.loadOrCreate()
            _ = DeviceAuthStore.storeToken(
                deviceId: identity.deviceId,
                role: "operator",
                token: "native-device-token",
                scopes: ["operator.read"])
            let config: GatewayConnection.Config = try (
                url: #require(URL(string: "ws://100.64.1.8:18789")),
                token: nil,
                password: nil)

            #expect(GatewayConnection.controlUiSharedAuthToken(config: config) == nil)
        }
    }

    private func withTemporaryStateDir<T>(_ operation: () async throws -> T) async throws -> T {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }
        return try await operation()
    }
}
