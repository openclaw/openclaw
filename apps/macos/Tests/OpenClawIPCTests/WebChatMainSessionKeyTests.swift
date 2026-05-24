import Foundation
import Testing
@testable import OpenClaw
import OpenClawKit

@Suite(.serialized)
struct WebChatMainSessionKeyTests {
    @Test func `config get snapshot main key falls back to main when missing`() throws {
        let json = """
        {
          "path": "/Users/pete/.openclaw/openclaw.json",
          "exists": true,
          "raw": null,
          "parsed": {},
          "valid": true,
          "config": {},
          "issues": []
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot main key trims and uses value`() throws {
        let json = """
        {
          "path": "/Users/pete/.openclaw/openclaw.json",
          "exists": true,
          "raw": null,
          "parsed": {},
          "valid": true,
          "config": { "session": { "mainKey": "  primary  " } },
          "issues": []
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot main key falls back when empty or whitespace`() throws {
        let json = """
        {
          "config": { "session": { "mainKey": "   " } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot main key falls back when config null`() throws {
        let json = """
        {
          "config": null
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func `config get snapshot uses global scope`() throws {
        let json = """
        {
          "config": { "session": { "scope": "global" } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "global")
    }

    @Test func `node scoped session key embeds device identity`() {
        let key = GatewayConnection.nodeScopedSessionKey()
        let deviceId = DeviceIdentityStore.loadOrCreate().deviceId
        #expect(!deviceId.isEmpty)
        #expect(key == "node-\(deviceId)")
    }

    @Test @MainActor func `remote mode resolves preferred default to node scoped key`() async {
        let previous = AppStateStore.shared.connectionMode
        AppStateStore.shared.connectionMode = .remote
        defer { AppStateStore.shared.connectionMode = previous }

        let expected = "node-\(DeviceIdentityStore.loadOrCreate().deviceId)"
        let cached = await GatewayConnection.shared.cachedPreferredDefaultSessionKey()
        #expect(cached == expected)
    }

    @Test @MainActor func `local mode preferred default mirrors cached main session key`() async {
        let previous = AppStateStore.shared.connectionMode
        AppStateStore.shared.connectionMode = .local
        defer { AppStateStore.shared.connectionMode = previous }

        let cachedMain = GatewayConnection.shared.cachedMainSessionKey()
        let preferred = await GatewayConnection.shared.cachedPreferredDefaultSessionKey()
        #expect(preferred == cachedMain)
    }
}
