import Foundation
import Testing
@testable import OpenClaw

struct PushRelayRegistrationStateTests {
    @Test func `July relay registration preserves its push scope`() throws {
        // v2026.7.1-beta.1 persisted every scope field; nullable diagnostics remain optional.
        let data = Data(#"""
        {
          "relayHandle": "july-relay-handle",
          "sendGrant": "july-send-grant",
          "gatewayDeviceId": "july-gateway",
          "lastAPNsTokenHashHex": "0123456789abcdef",
          "installationId": "july-installation",
          "lastTransport": "relay",
          "apnsEnvironment": "sandbox",
          "relayProfile": "simulatorSandbox",
          "proofPolicy": "internalSimulator"
        }
        """#.utf8)

        let state = try JSONDecoder().decode(PushRelayRegistrationStore.RegistrationState.self, from: data)

        #expect(state.gatewayDeviceId == "july-gateway")
        #expect(state.relayHandle == "july-relay-handle")
        #expect(state.sendGrant == "july-send-grant")
        #expect(state.apnsEnvironment == "sandbox")
        #expect(state.relayProfile == "simulatorSandbox")
        #expect(state.proofPolicy == "internalSimulator")
        #expect(state.relayOrigin == nil)
        #expect(state.relayHandleExpiresAtMs == nil)
        #expect(state.tokenDebugSuffix == nil)
    }
}
