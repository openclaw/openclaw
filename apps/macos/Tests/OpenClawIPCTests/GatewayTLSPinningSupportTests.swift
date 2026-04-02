import Foundation
import Testing
@testable import OpenClaw

struct GatewayTLSPinningSupportTests {
    @Test func `store key canonicalizes trailing dot hostnames`() {
        #expect(
            GatewayTLSPinningSupport.storeKey(host: " Gateway.EXAMPLE.com. ", port: 443) ==
                "gateway.example.com:443")
    }

    @Test func `store key for URL matches canonical hostname variant`() {
        let canonical = GatewayTLSPinningSupport.storeKey(host: "gateway.example.com", port: 443)
        let url = URL(string: "wss://gateway.example.com.:443")

        #expect(GatewayTLSPinningSupport.storeKey(url: url!) == canonical)
    }
}
