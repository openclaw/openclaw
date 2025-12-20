import Foundation
import Testing
@testable import Clawdis

@Suite struct WebChatMainSessionKeyTests {
    @Test func configGetSnapshotMainKeyFallsBackToMainWhenMissing() throws {
        let json = """
        {
          "path": "/Users/pete/.clawdis/clawdis.json",
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

    @Test func configGetSnapshotMainKeyTrimsAndUsesValue() throws {
        let json = """
        {
          "path": "/Users/pete/.clawdis/clawdis.json",
          "exists": true,
          "raw": null,
          "parsed": {},
          "valid": true,
          "config": { "inbound": { "session": { "mainKey": "  primary  " } } },
          "issues": []
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "primary")
    }

    @Test func configGetSnapshotMainKeyFallsBackWhenEmptyOrWhitespace() throws {
        let json = """
        {
          "config": { "inbound": { "session": { "mainKey": "   " } } }
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }

    @Test func configGetSnapshotMainKeyFallsBackWhenConfigNull() throws {
        let json = """
        {
          "config": null
        }
        """
        let key = try GatewayConnection.mainSessionKey(fromConfigGetData: Data(json.utf8))
        #expect(key == "main")
    }
}
