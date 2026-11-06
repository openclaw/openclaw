import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

struct OpenClawIDNodeEnrollmentTests {
    private struct Fixture: Decodable {
        struct Invite: Decodable { let link: String; let verification_code: String }
        struct Key: Decodable { let seed_hex: String; let iroh: String }
        let now: Int64
        let node_invite: Invite
        let node_key: Key
    }

    private func fixture() throws -> (Fixture, [String: OpenClawIDCanonicalJSON]) {
        let url = try #require(Bundle.module.url(forResource: "OpenClawIDNodeEnrollment", withExtension: "json", subdirectory: "Fixtures"))
        let data = try Data(contentsOf: url)
        let value = try OpenClawIDCanonicalJSON.parse(data)
        guard case let .object(fields) = value else { throw OpenClawIDNodeEnrollmentError.malformed }
        return (try JSONDecoder().decode(Fixture.self, from: data), fields)
    }

    private func description() throws -> OpenClawIDNodeEnrollmentDescription {
        try .init(displayName: "Build node", platform: "linux", commands: ["system.run"], caps: ["system"])
    }

    @Test func signedGoldenRedemptionAndComparisonCode() throws {
        let (fixture, json) = try fixture()
        var link = try OpenClawIDNodeEnrollmentLink(fixture.node_invite.link)
        let identity = try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(fixture.node_key.seed_hex))
        let description = try description()
        #expect(identity.peerKey == fixture.node_key.iroh)
        #expect(OpenClawIDNodeEnrollmentClient.verificationCode(link: link, peerKey: identity.peerKey,
            description: description) == "168017")
        let redemption = try OpenClawIDNodeEnrollmentClient.redemption(link: &link, identity: identity,
            description: description, now: fixture.now)
        let envelopeFields: Set<String> = ["v", "type", "body", "signer", "alg", "sig"]
        var actual = try redemption.fields(envelopeFields)
        var expected = try #require(json["redemption"]).fields(envelopeFields)
        let actualSignature = try #require(actual["sig"]).text()
        let expectedSignature = try #require(expected["sig"]).text()
        actual["sig"] = nil
        expected["sig"] = nil
        #expect(actual == expected)
        let publicKey = try Curve25519.Signing.PublicKey(rawRepresentation:
            OpenClawIDNodeIdentity.unhex(fixture.node_key.iroh, prefix: "iroh:"))
        let input = Data("openclaw/NodeRedemption/v1\0".utf8) + (try #require(expected["body"])).encoded
        // CryptoKit may randomize Ed25519 signatures. Compare every signed field exactly,
        // then verify both signatures over the golden input instead of requiring equal bytes.
        for signature in [actualSignature, expectedSignature] {
            #expect(publicKey.isValidSignature(try OpenClawIDNodeIdentity.decodeBase64URL(signature, count: 64), for: input))
        }
        let path = "/v1/claws/\(link.clawID)/node/descriptor"
        let header = try OpenClawIDNodeEnrollmentClient.discoverySignature(identity: identity, method: "GET",
            path: path, body: Data(), now: fixture.now)
        let expectedHeader = try #require(json["discovery_get_signature"]).text()
        let prefix = "keyid=\(identity.signingKey),ts=\(fixture.now),sig="
        let requestInput = Data("openclaw/discovery-request/v1\0".utf8) + OpenClawIDCanonicalJSON.object([
            "body_sha256": .string("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"),
            "method": .string("GET"), "path": .string(path), "ts": .integer(fixture.now),
        ]).encoded
        for signedHeader in [header, expectedHeader] {
            #expect(signedHeader.hasPrefix(prefix))
            let signature = try OpenClawIDNodeIdentity.decodeBase64URL(String(signedHeader.dropFirst(prefix.count)), count: 64)
            #expect(publicKey.isValidSignature(signature, for: requestInput))
        }
    }

    @Test func strictLinkOriginAndManifest() throws {
        let (fixture, _) = try fixture()
        for suffix in ["&unknown=x", "&c=0123456789abcdef0123456789abcdef", "&", "#x"] {
            #expect(throws: (any Error).self) { try OpenClawIDNodeEnrollmentLink(fixture.node_invite.link + suffix) }
        }
        for prefix in ["openclaw-node://join/", "openclaw-node://user@join", "openclaw-node://join?x=1"] {
            let bad = fixture.node_invite.link.replacingOccurrences(of: "openclaw-node://join", with: prefix)
            #expect(throws: (any Error).self) { try OpenClawIDNodeEnrollmentLink(bad) }
        }
        for origin in ["", "http://discovery.example", "https://discovery.example/path", "https://u@discovery.example", "https://discovery.example/?x"] {
            #expect(throws: (any Error).self) { try OpenClawIDNodeEnrollmentLink.discoveryOrigin(origin) }
        }
        #expect(try OpenClawIDNodeEnrollmentLink.discoveryOrigin("https://discovery.example").host == "discovery.example")
        #expect(throws: (any Error).self) { try OpenClawIDNodeEnrollmentDescription(displayName: "bad\nname", platform: "ios", commands: [], caps: []) }
        #expect(throws: (any Error).self) { try OpenClawIDNodeEnrollmentDescription(displayName: "name", platform: "ios", commands: ["x", "x"], caps: []) }
    }

    @Test func canonicalJSONRefusesAmbiguousOrUnrepresentableValues() throws {
        for bad in ["{\"a\":1,\"a\":2}", "\"\\ud800\"", "01", "1.5", "-9223372036854775808", "9007199254740992", "{\"x\":true,}"] {
            #expect(throws: (any Error).self) { try OpenClawIDCanonicalJSON.parse(Data(bad.utf8)) }
        }
        let json = try OpenClawIDCanonicalJSON.parse(Data("{\"z\":1,\"a\":\"\\u000f/\\n😀\"}".utf8))
        #expect(json.canonical == "{\"a\":\"\\u000f/\\n😀\",\"z\":1}")
        let ordering = OpenClawIDCanonicalJSON.object(["\u{E000}": .integer(1), "😀": .integer(2)])
        #expect(ordering.canonical == "{\"😀\":2,\"\u{E000}\":1}")
    }

    @Test func verifiedDescriptorRejectsRollbackStalenessAndUnknownSignedFields() throws {
        let (fixture, json) = try fixture()
        let link = try OpenClawIDNodeEnrollmentLink(fixture.node_invite.link)
        let origin = try OpenClawIDNodeEnrollmentLink.discoveryOrigin("https://discovery.example")
        let response = try #require(json["response"])
        let verify: (Data, OpenClawIDNodeTrustState?, Int64) throws -> OpenClawIDNodeTrustTarget = { data, previous, now in
            try OpenClawIDNodeTrust.assess(response: data, link: link, discoveryOrigin: origin,
                peerKey: fixture.node_key.iroh, previous: previous, now: now).verdict.get()
        }
        let target = try verify(response.encoded, nil, fixture.now)
        #expect(target.state.bindingSequence == 1)
        #expect(target.serverKey.hasPrefix("iroh:"))
        #expect(throws: OpenClawIDNodeEnrollmentError.staleSnapshot) { try verify(response.encoded, nil, fixture.now + 10_800) }
        #expect(throws: OpenClawIDNodeEnrollmentError.staleSnapshot) { try verify(response.encoded, nil, fixture.now - 4000) }
        let advanced = OpenClawIDNodeTrustState(clawID: link.clawID, rootFingerprint: link.rootFingerprint,
            bindingSequence: 2, snapshotSequence: 2, snapshotIssuedAt: fixture.now, snapshotBindingSequence: 2)
        #expect(throws: OpenClawIDNodeEnrollmentError.rollback) { try verify(response.encoded, advanced, fixture.now) }
        // Unknown fields must fail even if their signature is valid under the synthetic fixture K_gw.
        var outer = try response.fields(["descriptor", "snapshot"])
        var snapshot = try outer["snapshot"]!.fields(["v", "type", "body", "signer", "alg", "sig"])
        guard case .object(var body) = snapshot["body"]! else { throw OpenClawIDNodeEnrollmentError.malformed }
        body["unknown"] = .bool(true)
        snapshot["body"] = .object(body)
        let gateway = try Curve25519.Signing.PrivateKey(rawRepresentation:
            OpenClawIDNodeIdentity.unhex(try #require(json["gateway_seed_hex"]).text()))
        let signature = try gateway.signature(for: Data("openclaw/MembershipSnapshot/v1\0".utf8) +
            OpenClawIDCanonicalJSON.object(body).encoded)
        snapshot["sig"] = .string(OpenClawIDNodeIdentity.base64URL(signature))
        outer["snapshot"] = .object(snapshot)
        #expect(throws: OpenClawIDNodeEnrollmentError.malformed) { try verify(OpenClawIDCanonicalJSON.object(outer).encoded, nil, fixture.now) }
    }

    @Test func productionEnrollmentSendsOneMailAndCommitsOnlyVerifiedAdmission() async throws {
        let (fixture, json) = try fixture()
        let identity = try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(fixture.node_key.seed_hex))
        let transport = ScriptedHTTP(responses: [
            .init(status: 202, body: Data("{}".utf8)),
            .init(status: 403, body: Data("{\"error\":{\"retry_after\":2}}".utf8)),
            .init(status: 200, body: try #require(json["response"]).encoded),
        ])
        let store = TrustStore()
        let codes = Codes()
        let client = OpenClawIDNodeEnrollmentClient(http: transport, trustStore: store,
            now: { fixture.now }, sleep: { _ in })
        let target = try await client.enroll(joinLink: fixture.node_invite.link,
            discoveryOrigin: "https://discovery.example", identity: identity, description: description(),
            onVerificationCode: { await codes.append($0) })
        #expect(await codes.values == ["168017"])
        #expect(await store.saved?.state == target.state)
        let requests = await transport.requests
        #expect(requests.map(\.httpMethod) == ["POST", "GET", "GET"])
        #expect(requests.allSatisfy { $0.url?.host == "discovery.example" && $0.value(forHTTPHeaderField: "authorization") == nil })
        let mail = try #require(requests.first?.httpBody)
        #expect(!String(decoding: mail, as: UTF8.self).contains("KioqKioq"))
        let signed = try #require(requests.first?.value(forHTTPHeaderField: "openclaw-signature"))
        #expect(signed.hasPrefix("keyid=\(identity.signingKey),ts=\(fixture.now),sig="))
    }

    @Test func lostMailResponseRetriesIdenticalRedemption() async throws {
        let (fixture, json) = try fixture()
        let identity = try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(fixture.node_key.seed_hex))
        let http = RetriedMailHTTP(descriptor: try #require(json["response"]).encoded)
        let store = TrustStore()
        let delays = RetryDelays()
        let client = OpenClawIDNodeEnrollmentClient(http: http, trustStore: store, now: { fixture.now },
            sleep: { await delays.append($0) })
        let target = try await client.enroll(joinLink: fixture.node_invite.link,
            discoveryOrigin: "https://discovery.example", identity: identity, description: description(),
            onVerificationCode: { _ in })
        let requests = await http.requests
        #expect(requests.map(\.httpMethod) == ["POST", "POST", "POST", "POST", "GET"])
        let firstBody = try #require(requests.first?.httpBody)
        #expect(requests.prefix(4).allSatisfy { $0.httpBody == firstBody })
        #expect(await delays.values == [1_000_000_000, 3_000_000_000, 4_000_000_000])
        #expect(await store.saved?.state == target.state)

        let canceledHTTP = RetriedMailHTTP(descriptor: Data())
        let canceledStore = TrustStore()
        let canceledClient = OpenClawIDNodeEnrollmentClient(http: canceledHTTP, trustStore: canceledStore,
            now: { fixture.now }, sleep: { _ in throw CancellationError() })
        await #expect(throws: CancellationError.self) {
            try await canceledClient.enroll(joinLink: fixture.node_invite.link,
                discoveryOrigin: "https://discovery.example", identity: identity, description: description(),
                onVerificationCode: { _ in })
        }
        #expect(await canceledHTTP.requests.count == 1)
        #expect(await canceledStore.saved == nil)
    }

    private actor RetryDelays {
        var values: [UInt64] = []
        func append(_ value: UInt64) { values.append(value) }
    }

    private actor RetriedMailHTTP: OpenClawIDNodeEnrollmentHTTP {
        let descriptor: Data
        var requests: [URLRequest] = []
        init(descriptor: Data) { self.descriptor = descriptor }
        func send(_ request: URLRequest) throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            requests.append(request)
            switch requests.count {
            case 1: throw URLError(.networkConnectionLost) // The server may have accepted this mail.
            case 2: return .init(status: 429, body: Data("{\"error\":{\"retry_after\":3}}".utf8))
            case 3: return .init(status: 503, body: Data())
            case 4: return .init(status: 202, body: Data())
            default: return .init(status: 200, body: descriptor)
            }
        }
    }

    @Test func redirectsOversizeAndCancellationNeverCommit() async throws {
        let (fixture, json) = try fixture()
        let identity = try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(fixture.node_key.seed_hex))
        let description = try description()
        for bad in [OpenClawIDNodeEnrollmentHTTPResponse(status: 302, body: Data()),
                    .init(status: 200, body: Data(repeating: 32, count: 1_048_577)),
                    .init(status: 200, body: Data("{}".utf8))] {
            let store = TrustStore()
            let http = ScriptedHTTP(responses: [.init(status: 202, body: Data()), bad])
            let client = OpenClawIDNodeEnrollmentClient(http: http, trustStore: store, now: { fixture.now })
            await #expect(throws: (any Error).self) {
                try await client.enroll(joinLink: fixture.node_invite.link, discoveryOrigin: "https://discovery.example",
                    identity: identity, description: description, onVerificationCode: { _ in })
            }
            #expect(await store.saved == nil)
        }
        let store = TrustStore()
        let http = ScriptedHTTP(responses: [.init(status: 202, body: Data()),
            .init(status: 200, body: try #require(json["response"]).encoded)])
        let client = OpenClawIDNodeEnrollmentClient(http: http, trustStore: store, now: { fixture.now })
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await client.enroll(joinLink: fixture.node_invite.link, discoveryOrigin: "https://discovery.example",
                identity: identity, description: description, onVerificationCode: { _ in })
        }
        await #expect(throws: (any Error).self) { try await task.value }
        #expect(await store.saved == nil)
        #expect(await http.requests.isEmpty)
    }

    @Test func refusedVerifiedObservationsBlockLaterEnrollmentReplay() async throws {
        let (fixture, json) = try fixture()
        let identity = try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(fixture.node_key.seed_hex))
        let manifest = try description()
        let original = try #require(json["response"])
        // Each scenario uses two real enrollment attempts and one retained state owner.
        for scenario in ["higher-binding", "stale", "excluded", "future", "bad-signature"] {
            var response = try original.fields(["descriptor", "snapshot"])
            var snapshot = try response["snapshot"]!.fields(["v", "type", "body", "signer", "alg", "sig"])
            guard case .object(var body) = snapshot["body"]! else { throw OpenClawIDNodeEnrollmentError.malformed }
            body["seq"] = .integer(3)
            if scenario == "higher-binding" { body["binding_seq"] = .integer(2) }
            if scenario == "stale" { body["issued_at"] = .integer(fixture.now - 10_801) }
            if scenario == "excluded" { body["node_peer_keys"] = .array([]) }
            if scenario == "future" { body["issued_at"] = .integer(fixture.now + 301) }
            snapshot["body"] = .object(body)
            if scenario != "bad-signature" {
                let gateway = try Curve25519.Signing.PrivateKey(rawRepresentation:
                    OpenClawIDNodeIdentity.unhex(try #require(json["gateway_seed_hex"]).text()))
                let signature = try gateway.signature(for: Data("openclaw/MembershipSnapshot/v1\0".utf8) +
                    OpenClawIDCanonicalJSON.object(body).encoded)
                snapshot["sig"] = .string(OpenClawIDNodeIdentity.base64URL(signature))
            }
            response["snapshot"] = .object(snapshot)
            let store = TrustStore()
            let http = ScriptedHTTP(responses: [
                .init(status: 202, body: Data()),
                .init(status: 200, body: OpenClawIDCanonicalJSON.object(response).encoded),
                .init(status: 202, body: Data()),
                .init(status: 200, body: original.encoded),
            ])
            let client = OpenClawIDNodeEnrollmentClient(http: http, trustStore: store, now: { fixture.now })
            let attempt = {
                try await client.enroll(joinLink: fixture.node_invite.link, discoveryOrigin: "https://discovery.example",
                    identity: identity, description: manifest, onVerificationCode: { _ in })
            }
            await #expect(throws: (any Error).self) { try await attempt() }
            #expect(await store.saved == nil)
            let remembered = ["higher-binding", "stale", "excluded"].contains(scenario)
            #expect(await store.observed?.snapshotSequence == (remembered ? 3 : nil))
            if remembered {
                // This fresh-looking older snapshot was accepted before refused observations were retained.
                await #expect(throws: OpenClawIDNodeEnrollmentError.rollback) { try await attempt() }
                #expect(await store.observed?.snapshotSequence == 3)
                #expect(await store.saved == nil)
            } else {
                // Neither a future nor an unverified assertion may poison honest evidence.
                let target = try await attempt()
                #expect(target.state.snapshotSequence == 2)
                #expect(await store.saved?.state == target.state)
            }
        }
    }

    @Test func observationsMergeBySnapshotOrderAndDialCommitChecksCurrentRow() throws {
        let (fixture, _) = try fixture()
        let link = try OpenClawIDNodeEnrollmentLink(fixture.node_invite.link)
        let state: (Int64, Int64, Int64, Int64) -> OpenClawIDNodeTrustState = { pin, seq, issued, binding in
            .init(clawID: link.clawID, rootFingerprint: link.rootFingerprint, bindingSequence: pin,
                  snapshotSequence: seq, snapshotIssuedAt: issued, snapshotBindingSequence: binding)
        }
        let current = state(2, 4, 100, 3)
        // Late observers cannot overwrite a newer row or reduce its separately verified binding pin.
        #expect(try OpenClawIDNodeTrust.mergeObservation(state(1, 3, 200, 1), with: current) == current)
        let newer = try OpenClawIDNodeTrust.mergeObservation(state(1, 4, 101, 2), with: current)
        #expect(newer == state(2, 4, 101, 2))
        #expect(try OpenClawIDNodeTrust.mergeObservation(state(1, 5, 90, 2), with: current) == state(2, 5, 90, 2))
        #expect(throws: OpenClawIDNodeEnrollmentError.rollback) {
            try OpenClawIDNodeTrust.validateCommit(state(2, 4, 100, 2), replacing: current)
        }
        #expect(throws: OpenClawIDNodeEnrollmentError.rollback) {
            try OpenClawIDNodeTrust.validateCommit(state(3, 3, 200, 3), replacing: current)
        }
    }

    private actor Codes {
        var values: [String] = []
        func append(_ code: String) { values.append(code) }
    }

    private actor TrustStore: OpenClawIDNodeTrustStore {
        var saved: OpenClawIDNodeTrustTarget?
        var observed: OpenClawIDNodeTrustState?
        func load(hostname: String) -> OpenClawIDNodeTrustState? { observed }
        func observe(hostname: String, state: OpenClawIDNodeTrustState) throws {
            try Task.checkCancellation()
            observed = try OpenClawIDNodeTrust.mergeObservation(state, with: observed)
        }
        func commit(_ target: OpenClawIDNodeTrustTarget) throws {
            try Task.checkCancellation()
            try OpenClawIDNodeTrust.validateCommit(target.state, replacing: observed)
            observed = target.state
            saved = target
        }
    }

    private actor ScriptedHTTP: OpenClawIDNodeEnrollmentHTTP {
        var responses: [OpenClawIDNodeEnrollmentHTTPResponse]
        var requests: [URLRequest] = []
        init(responses: [OpenClawIDNodeEnrollmentHTTPResponse]) { self.responses = responses }
        func send(_ request: URLRequest) throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            requests.append(request)
            guard !responses.isEmpty else { throw OpenClawIDNodeEnrollmentError.unavailable }
            return responses.removeFirst()
        }
    }
}
