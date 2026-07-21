import Foundation
import Security
import Testing
@testable import OpenClawKit

struct GatewayTLSPinningTests {
    @Test func `first use pinning requires system trust`() {
        #expect(GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: true))
        #expect(!GatewayTLSFirstUsePolicy.allowsFirstUsePin(systemTrustOk: false))
    }

    @Test func `TLS authority includes normalized host and effective port`() throws {
        let route = try #require(GatewayTLSAuthority(
            url: #require(URL(string: "wss://Gateway.Example.com/path"))))

        #expect(route == GatewayTLSAuthority(host: "gateway.example.com", port: 443))
        #expect(route != GatewayTLSAuthority(host: "redirect.example.com", port: 443))
        #expect(route != GatewayTLSAuthority(host: "gateway.example.com", port: 8443))
    }

    @Test func `matching explicit pin overrides system trust`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "expected",
            allowTOFU: false,
            required: true,
            systemTrustOk: false)

        #expect(decision == .accept(
            fingerprint: "expected",
            enforcePin: true,
            saveFirstUse: false))
    }

    @Test func `explicit pin mismatch and unavailable certificate fail closed`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: "different",
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.pinMismatch))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: "expected",
            observedFingerprint: nil,
            allowTOFU: false,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: nil,
            allowTOFU: true,
            required: true,
            systemTrustOk: true) == .reject(.certificateUnavailable))
    }

    @Test func `trusted first use is saved and enforced`() {
        let decision = GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: true)

        #expect(decision == .accept(
            fingerprint: "observed",
            enforcePin: true,
            saveFirstUse: true))
    }

    @Test func `concurrent first use sessions share one durable fingerprint`() async {
        let stableID = "test-first-use-claim-\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        let results = await withTaskGroup(of: String?.self, returning: [String?].self) { group in
            for fingerprint in ["first", "second"] {
                group.addTask {
                    GatewayTLSStore.claimFirstUseFingerprint(fingerprint, stableID: stableID)
                }
            }
            var results: [String?] = []
            for await result in group {
                results.append(result)
            }
            return results
        }
        let claimed = results.compactMap(\.self)

        #expect(claimed.count == 2)
        #expect(Set(claimed).count == 1)
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == claimed.first)
    }

    @Test func `first use claim fails closed without a storage owner`() {
        #expect(GatewayTLSStore.claimFirstUseFingerprint("observed", stableID: "") == nil)
    }

    @Test func `losing first use session adopts the shared winner`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.enforceFingerprint("winner")

        #expect(state.enforcedFingerprint == "winner")
        #expect(state.acceptedFingerprint == nil)
    }

    @Test func `pin replacement compares the stored value atomically`() {
        let stableID = "test-pin-cas-\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        GatewayTLSStore.saveFingerprint("old", stableID: stableID)

        #expect(!GatewayTLSStore.replaceFingerprint("wrong", ifCurrent: "missing", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `pin storage canonicalizes accepted fingerprint spelling`() {
        let stableID = "test-pin-canonical-spelling-\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        let uppercase = String(repeating: "AB", count: 32)
        let lowercase = uppercase.lowercased()

        GatewayTLSStore.saveFingerprint("SHA256: \(uppercase)", stableID: stableID)

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == lowercase)
        #expect(GatewayTLSStore.replaceFingerprint(
            String(repeating: "c", count: 64),
            ifCurrent: uppercase,
            stableID: stableID))
    }

    @Test func `canonical pin without comparison metadata is upgraded for replacement`() {
        let stableID = "测试-pin-canonical-migration-\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        #expect(GenericPasswordKeychainStore.saveString(
            "old",
            service: "ai.openclaw.tls-pinning",
            account: "fingerprint.v2.\(component)"))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `unreadable v2 pin blocks a new first use claim`() {
        let stableID = "test-pin-unreadable-v2-\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        let component = Data(stableID.utf8).base64EncodedString()
            .replacingOccurrences(of: "+", with: "-")
            .replacingOccurrences(of: "/", with: "_")
            .replacingOccurrences(of: "=", with: "")
        let item: [String: Any] = [
            kSecClass as String: kSecClassGenericPassword,
            kSecAttrService as String: "ai.openclaw.tls-pinning",
            kSecAttrAccount as String: "fingerprint.v2.\(component)",
            kSecValueData as String: Data([0xFF]),
            kSecAttrAccessible as String: kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly,
        ]
        #expect(SecItemAdd(item as CFDictionary, nil) == errSecSuccess)

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == nil)
        #expect(GatewayTLSStore.claimFirstUseFingerprint("new", stableID: stableID) == nil)
    }

    @Test func `legacy raw pin is migrated before conditional replacement`() {
        let stableID = "test-pin-legacy-migration-\(UUID().uuidString)"
        defer { GatewayTLSStore.clearFingerprint(stableID: stableID) }
        #expect(GenericPasswordKeychainStore.saveString(
            "old",
            service: "ai.openclaw.tls-pinning",
            account: stableID))

        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "old")
        #expect(GatewayTLSStore.replaceFingerprint("new", ifCurrent: "old", stableID: stableID))
        #expect(GatewayTLSStore.loadFingerprint(stableID: stableID) == "new")
    }

    @Test func `first use fingerprint remains enforced for reconnects`() {
        var state = GatewayTLSPinningState(expectedFingerprint: nil)

        state.recordAcceptance("first", enforcePin: true)

        #expect(state.acceptedFingerprint == "first")
        #expect(state.enforcedFingerprint == "first")
    }

    @Test func `untrusted first use is rejected`() {
        #expect(GatewayTLSValidationPolicy.decide(
            expectedFingerprint: nil,
            observedFingerprint: "observed",
            allowTOFU: true,
            required: true,
            systemTrustOk: false) == .reject(.untrustedCertificate))
    }
}
