import Testing
@testable import OpenClaw

struct GatewayCustomHeaderNamesTests {
    @Test func `credential recognizes service token values typed as names`() {
        let clientId = "0123456789abcdef0123456789abcdef.access"
        #expect(GatewayCustomHeaderNames.credential(named: " \(clientId.uppercased()) ") == .clientId)
        #expect(GatewayCustomHeaderNames.credential(named: String(repeating: "0123456789abcdef", count: 4)) == .secret)
        #expect(GatewayCustomHeaderNames.credential(named: "cfast_\(String(repeating: "a1", count: 24))") == .secret)
        for copied in ["'\(clientId)'", "\(clientId).", "`\(clientId)`"] {
            #expect(GatewayCustomHeaderNames.credential(named: copied) == .clientId)
        }
    }

    @Test func `credential leaves header names alone`() {
        #expect(GatewayCustomHeaderNames.credential(named: "CF-Access-Client-Id") == nil)
        #expect(GatewayCustomHeaderNames.credential(named: "CF-Access-Client-Secret") == nil)
        #expect(GatewayCustomHeaderNames.credential(named: "X-Request-Id") == nil)
        #expect(GatewayCustomHeaderNames.displayName(for: "CF-Access-Client-Id") == "CF-Access-Client-Id")
    }

    @Test func `display name does not print A saved credential`() {
        let clientId = "0123456789abcdef0123456789abcdef.access"
        #expect(!GatewayCustomHeaderNames.displayName(for: clientId).contains(clientId))
        #expect(GatewayCustomHeaderNames.displayName(for: clientId) == "Client ID saved as a header name")
    }
}
