import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
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

    @Test func `pinned fingerprint migrates legacy trailing dot store key`() {
        let host = "gateway-migration-\(UUID().uuidString).example.com"
        let legacyStoreKey = "\(host).:443"
        let canonicalStoreKey = "\(host):443"
        let url = URL(string: "wss://\(host).:443")!
        defer {
            _ = GatewayTLSStore.clearFingerprint(stableID: legacyStoreKey)
            _ = GatewayTLSStore.clearFingerprint(stableID: canonicalStoreKey)
        }

        GatewayTLSStore.saveFingerprint("legacy-fingerprint", stableID: legacyStoreKey)

        #expect(GatewayTLSPinningSupport.pinnedFingerprint(url: url) == "legacy-fingerprint")
        #expect(GatewayTLSStore.loadFingerprint(stableID: canonicalStoreKey) == "legacy-fingerprint")
        #expect(GatewayTLSStore.loadFingerprint(stableID: legacyStoreKey) == nil)
    }
}
