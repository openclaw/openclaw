import Foundation
import OpenClawKit
import Testing

@Suite struct DeepLinksSecurityTests {
    @Test func gatewayDeepLinkRejectsInsecureNonLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkRejectsInsecurePrefixBypassHost() {
        let url = URL(
            string: "openclaw://gateway?host=127.attacker.example&port=18789&tls=0&token=abc")!
        #expect(DeepLinkParser.parse(url) == nil)
    }

    @Test func gatewayDeepLinkAllowsLoopbackWs() {
        let url = URL(
            string: "openclaw://gateway?host=127.0.0.1&port=18789&tls=0&token=abc")!
        #expect(
            DeepLinkParser.parse(url) == .gateway(
                .init(host: "127.0.0.1", port: 18789, tls: false, token: "abc", password: nil)))
    }

    @Test func setupCodeRejectsInsecureNonLoopbackWs() {
        let payload = #"{"url":"ws://attacker.example:18789","token":"tok"}"#
        let encoded = Data(payload.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(GatewayConnectDeepLink.fromSetupCode(encoded) == nil)
    }

    @Test func setupCodeRejectsInsecurePrefixBypassHost() {
        let payload = #"{"url":"ws://127.attacker.example:18789","token":"tok"}"#
        let encoded = Data(payload.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(GatewayConnectDeepLink.fromSetupCode(encoded) == nil)
    }

    @Test func setupCodeAllowsLoopbackWs() {
        let payload = #"{"url":"ws://127.0.0.1:18789","token":"tok"}"#
        let encoded = Data(payload.utf8)
            .base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(
            GatewayConnectDeepLink.fromSetupCode(encoded) == .init(
                host: "127.0.0.1",
                port: 18789,
                tls: false,
                token: "tok",
                password: nil))
    }
}
