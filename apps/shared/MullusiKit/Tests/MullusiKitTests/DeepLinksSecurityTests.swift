import Foundation
import MullusiKit
import Testing

@Suite struct DeepLinksSecurityTests {
    @Test func gatewayDeepLinkRejectsInsecureNonLoopbackWs() {
        let url = URL(
            string: "mullusi://gateway?host=attacker.example&port=18790&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkRejectsInsecurePrefixBypassHost() {
        let url = URL(
            string: "mullusi://gateway?host=127.attacker.example&port=18790&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkAllowsLoopbackWs() {
        let url = URL(
            string: "mullusi://gateway?host=127.0.0.1&port=18790&tls=0&token=abc")!
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(
                    host: "127.0.0.1",
                    port: 18790,
                    tls: false,
                    bootstrapToken: nil,
                    token: "abc",
                    password: nil)))
    }

    @Test func setupCodeRejectsInsecureNonLoopbackWs() {
        let payload = #"{"url":"ws://attacker.example:18790","bootstrapToken":"tok"}"#
        let encoded = Data(payload.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(GatewayConnectDeepLink.fromSetupCode(encoded) == nil)
    }

    @Test func setupCodeRejectsInsecurePrefixBypassHost() {
        let payload = #"{"url":"ws://127.attacker.example:18790","bootstrapToken":"tok"}"#
        let encoded = Data(payload.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(GatewayConnectDeepLink.fromSetupCode(encoded) == nil)
    }

    @Test func setupCodeAllowsLoopbackWs() {
        let payload = #"{"url":"ws://127.0.0.1:18790","bootstrapToken":"tok"}"#
        let encoded = Data(payload.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(
            GatewayConnectDeepLink.fromSetupCode(encoded) == .init(
                host: "127.0.0.1",
                port: 18790,
                tls: false,
                bootstrapToken: "tok",
                token: nil,
                password: nil))
    }
}
