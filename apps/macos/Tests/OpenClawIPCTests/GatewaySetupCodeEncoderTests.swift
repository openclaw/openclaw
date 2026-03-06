import OpenClawKit
import Testing
@testable import OpenClaw

@Suite struct GatewaySetupCodeEncoderTests {
    @Test func encodeProducesSetupCodeParsableByGatewayDeepLink() {
        let encoded = GatewaySetupCodeEncoder.encode(
            urlString: "wss://gateway.example.ts.net:443",
            token: "shared-token",
            password: nil)

        #expect(encoded != nil)
        #expect(
            encoded.flatMap(GatewayConnectDeepLink.fromSetupCode) == .init(
                host: "gateway.example.ts.net",
                port: 443,
                tls: true,
                token: "shared-token",
                password: nil))
    }

    @Test func encodeSupportsInsecureTailnetTargets() {
        let encoded = GatewaySetupCodeEncoder.encode(
            urlString: "ws://100.64.0.12:18789",
            token: "tailnet-token",
            password: nil)

        #expect(encoded != nil)
        #expect(
            encoded.flatMap(GatewayConnectDeepLink.fromSetupCode) == .init(
                host: "100.64.0.12",
                port: 18789,
                tls: false,
                token: "tailnet-token",
                password: nil))
    }
}
