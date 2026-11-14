import CryptoKit
import Foundation
import Synchronization
import Testing
@testable import OpenClawKit

/// Sign-in-first owner enrollment against the TypeScript protocol vectors and a scripted Discovery.
struct OpenClawIDOwnerEnrollmentTests {
    private struct Vectors {
        let json: [String: OpenClawIDCanonicalJSON]
        let node: [String: OpenClawIDCanonicalJSON]

        init() throws {
            func load(_ name: String) throws -> [String: OpenClawIDCanonicalJSON] {
                let url = try #require(Bundle.module.url(
                    forResource: name, withExtension: "json", subdirectory: "Fixtures"))
                guard case let .object(fields) = try OpenClawIDCanonicalJSON.parse(Data(contentsOf: url)) else {
                    throw OpenClawIDNodeEnrollmentError.malformed
                }
                return fields
            }
            self.json = try load("OpenClawIDOwnerEnrollment")
            self.node = try load("OpenClawIDNodeEnrollment")
        }

        func text(_ path: String...) throws -> String {
            try self.value(path).text()
        }

        func value(_ path: [String]) throws -> OpenClawIDCanonicalJSON {
            var current = OpenClawIDCanonicalJSON.object(self.json)
            for key in path {
                guard case let .object(fields) = current, let next = fields[key] else {
                    throw OpenClawIDNodeEnrollmentError.malformed
                }
                current = next
            }
            return current
        }

        var now: Int64 {
            get throws { try self.value(["now"]).number() }
        }

        func identity(_ key: String) throws -> OpenClawIDNodeIdentity {
            try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(self.text("keys", key)))
        }

        var keys: OpenClawIDOwnerDeviceKeys {
            get throws {
                try .init(
                    device: self.identity("device_seed_hex"),
                    peer: self.identity("peer_seed_hex"),
                    node: self.identity("node_seed_hex"))
            }
        }

        var description: OpenClawIDNodeEnrollmentDescription {
            get throws {
                try .init(
                    displayName: "Example Mac", platform: "macos", commands: ["system.run", "screen.snapshot"],
                    caps: ["screen"])
            }
        }

        var claw: OpenClawIDDiscoveryClaw {
            .init(
                id: "0123456789abcdef0123456789abcdef", hostname: "studio-k7x2q.crabd.me", relationship: "owner",
                role: nil, online: true)
        }
    }

    @Test func `recovery kit and root match the TypeScript vectors`() throws {
        let vectors = try Vectors()
        let text = try vectors.text("kit", "text")
        #expect(try OpenClawIDNodeIdentity.hex(OpenClawIDRecoveryKit.decode(text)) == vectors.text("kit", "secret_hex"))
        let root = try OpenClawIDRecoveryKit.root(" " + text.lowercased().replacingOccurrences(of: "-", with: " "))
        #expect(try root.signingKey == vectors.text("kit", "root_pub"))
        #expect(try OpenClawIDStatement.fingerprint(root.signingKey) == vectors.text("kit", "root_fp"))
        var typo = Array(text)
        typo[7] = typo[7] == "1" ? "2" : "1"
        #expect(throws: OpenClawIDNodeEnrollmentError.malformed) { try OpenClawIDRecoveryKit.decode(String(typo)) }
        #expect(throws: OpenClawIDNodeEnrollmentError.malformed) {
            try OpenClawIDRecoveryKit.decode("OCK2-" + text.dropFirst(5))
        }
    }

    @Test func `SAS start commitment code and handoff match the TypeScript vectors`() throws {
        let vectors = try Vectors()
        let start = try OpenClawIDOwnerEnrollmentClient.sasStart(
            requestID: vectors.text("sas", "start", "request_id"), clawID: vectors.claw.id, keys: vectors.keys,
            label: "Example Mac", node: vectors.description)
        #expect(try start.encoded == vectors.value(["sas", "start"]).encoded)
        let attempt = try OpenClawIDSASNewDevice(
            start: start, requestID: vectors.text("sas", "start", "request_id"),
            ephemeral: Curve25519.KeyAgreement.PrivateKey(
                rawRepresentation: OpenClawIDNodeIdentity.unhex(vectors.text("sas", "eph_n_seed_hex"))))
        #expect(try attempt.commit == vectors.text("sas", "commit"))
        #expect(try attempt.ephemeralPublicHex == vectors.text("sas", "eph_n_pub_hex"))
        guard case let .object(data) = attempt.startData else { throw OpenClawIDNodeEnrollmentError.malformed }
        #expect(data["request_id"] == nil && data["commit"] == .string(attempt.commit) && data["node"] != nil)
        let accepted = try attempt.accepted(
            ephemeralE: vectors.text("sas", "eph_e_pub_hex"), devicePubE: vectors.text("keys", "approver_pub"))
        #expect(try OpenClawIDNodeIdentity.hex(accepted.transcript) == vectors.text("sas", "transcript_hex"))
        #expect(try OpenClawIDNodeIdentity.hex(accepted.sharedSecret) == vectors.text("sas", "shared_secret_hex"))
        #expect(try accepted.code == vectors.text("sas", "code"))
        let opened = try accepted.open(
            nonce: vectors.text("sas", "sealed", "nonce"), ciphertext: vectors.text("sas", "sealed", "ciphertext"))
        #expect(try opened?.encoded == vectors.value(["sas", "handoff"]).encoded)
        // Another approver's key changes the transcript: the handoff no longer opens.
        let other = try attempt.accepted(
            ephemeralE: vectors.text("sas", "eph_e_pub_hex"), devicePubE: vectors.text("keys", "device_pub"))
        #expect(try other.open(
            nonce: vectors.text("sas", "sealed", "nonce"), ciphertext: vectors.text("sas", "sealed", "ciphertext")) ==
            nil)
    }

    @Test func `kit and device statements match the TypeScript vectors`() throws {
        let vectors = try Vectors()
        let keys = try vectors.keys
        let root = try OpenClawIDRecoveryKit.root(vectors.text("kit", "text"))
        let expectedCert = try vectors.value(["kit_enrollment", "cert"])
        let cert = try OpenClawIDStatement.sign("OwnerDeviceCert", body: .object([
            "device_pub": .string(keys.device.signingKey),
            "peer_keys": .array([.string(keys.peer.peerKey)]),
            "label": .string("Example Mac"),
            "scope": .string("owner"),
            "caps": .array(OpenClawIDOwnerEnrollmentClient.ownerCapabilities.map { .string($0) }),
            "issued_at": .integer(vectors.now),
            "expires_at": .null,
            "root_epoch": .integer(1),
        ]), signer: root)
        try Self.expectSameStatement(cert, expectedCert, type: "OwnerDeviceCert")
        let change = try OpenClawIDOwnerEnrollmentClient.addOwnerDevice(
            clawID: vectors.claw.id, seq: 8, cert: expectedCert, nodeKey: keys.node, label: "Example Mac",
            node: vectors.description, issuedAt: vectors.now)
        #expect(try change.encoded == vectors.value(["kit_enrollment", "change", "body"]).encoded)
        let revocation = try OpenClawIDOwnerDeviceActions.revocation(
            clawID: vectors.claw.id, seq: 9, device: keys.device, issuedAt: vectors.now)
        try Self.expectSameStatement(revocation, vectors.value(["revocation"]), type: "Revocation")
        // The TypeScript proof verifies over the bytes this port signs, and so does this port's.
        let ts = try vectors.value(["peer_key_proof", "ts"]).number()
        let account = try vectors.text("peer_key_proof", "account_id")
        let input = Data("openclaw/peer-key-proof/v1\0".utf8) + OpenClawIDCanonicalJSON.object([
            "account_id": .string(account), "device_pub": .string(keys.device.signingKey),
            "peer_key": .string(keys.peer.peerKey), "ts": .integer(ts),
        ]).encoded
        let peerPublic = try Curve25519.Signing.PublicKey(
            rawRepresentation: OpenClawIDNodeIdentity.unhex(keys.peer.signingKey, prefix: "ed25519:"))
        #expect(try peerPublic.isValidSignature(
            OpenClawIDNodeIdentity.decodeBase64URL(vectors.text("peer_key_proof", "proof"), count: 64), for: input))
        #expect(try peerPublic.isValidSignature(
            OpenClawIDNodeIdentity.decodeBase64URL(
                OpenClawIDStatement.peerKeyProof(accountID: account, device: keys.device, peer: keys.peer, ts: ts),
                count: 64),
            for: input))
    }

    @Test func `handoff must name this claw and this device`() throws {
        let vectors = try Vectors()
        let keys = try vectors.keys
        let response = try #require(vectors.node["response"])
        let descriptor = try #require(response.fields(["descriptor", "snapshot"])["descriptor"])
        let binding = try #require(descriptor.fields([
            "v", "claw_id", "transport", "relay_url", "root_pub", "binding", "published_at",
        ])["binding"])
        let cert = try OpenClawIDStatement.sign(
            "OwnerDeviceCert",
            body: Self.certBody(keys, now: vectors.now),
            signer: keys.device)
        let handoff = try OpenClawIDCanonicalJSON.object([
            "root_pub": .string(vectors.text("kit", "root_pub")), "binding": binding, "cert": cert,
        ])
        #expect(try OpenClawIDOwnerEnrollmentClient.verifyHandoff(handoff, claw: vectors.claw, keys: keys) ==
            vectors.text("kit", "root_fp"))
        let elsewhere = OpenClawIDDiscoveryClaw(
            id: vectors.claw.id, hostname: "other-k7x2q.crabd.me", relationship: "owner", role: nil, online: true)
        #expect(throws: OpenClawIDOwnerEnrollmentError.handoffInvalid) {
            try OpenClawIDOwnerEnrollmentClient.verifyHandoff(handoff, claw: elsewhere, keys: keys)
        }
        let stranger = OpenClawIDOwnerDeviceKeys(device: keys.peer, peer: keys.device, node: nil)
        #expect(throws: OpenClawIDOwnerEnrollmentError.handoffInvalid) {
            try OpenClawIDOwnerEnrollmentClient.verifyHandoff(handoff, claw: vectors.claw, keys: stranger)
        }
    }

    @Test func `kit enrollment re-signs after seq conflict and pins only the listed device`() async throws {
        let vectors = try Vectors()
        let keys = try vectors.keys
        let discovery = try Discovery(vectors: vectors)
        let deviceStore = TrustStore()
        let nodeStore = TrustStore()
        let client = try OpenClawIDOwnerEnrollmentClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), deviceStore: deviceStore,
            nodeStore: nodeStore, http: discovery, now: { (try? vectors.now) ?? 0 }, sleep: { _ in })
        await discovery.onRootStatement { change, discovery in
            let seq = try change.fields(["v", "type", "body", "signer", "alg", "sig"])["body"]!
                .fields(["claw_id", "seq", "target", "issued_at"])["seq"]!.number()
            if seq == 3 {
                // The Gateway was at 3 already: it refuses, republishes and tells this device.
                try await discovery.publish(seq: 3, listed: false)
                try await discovery.mail(.object([
                    "message_id": .string("1"), "to": .string(OpenClawIDStatement.fingerprint(keys.device.signingKey)),
                    "payload": .object([
                        "kind": .string("notice"),
                        "event": .string("seq_conflict"),
                        "ref": .string("3"),
                    ]),
                ]))
            } else {
                try await discovery.publish(seq: seq, listed: true)
            }
        }
        let enrolled = try await client.approveWithRecoveryKit(
            vectors.text("kit", "text"), session: Self.session, claw: vectors.claw, keys: keys, label: "Example Mac",
            node: vectors.description)
        #expect(try enrolled.rootFingerprint == vectors.text("kit", "root_fp"))
        let changes = await discovery.rootStatements
        #expect(changes.count == 2)
        let root = try OpenClawIDRecoveryKit.root(vectors.text("kit", "text"))
        for (change, seq) in zip(changes, [Int64(3), 4]) {
            let body = try change.fields(["v", "type", "body", "signer", "alg", "sig"])
            #expect(body["signer"] == .string(root.signingKey))
            let fields = try #require(body["body"]).fields(["claw_id", "seq", "target", "issued_at"])
            #expect(fields["seq"] == .integer(seq))
            let target = try #require(fields["target"]).fields(["op", "cert", "node"])
            #expect(try target["node"]!.fields(["peer_key", "label", "description"])["peer_key"] ==
                .string(#require(keys.node?.peerKey)))
            _ = try OpenClawIDNodeTrust.envelope(change, type: "MembershipChange", signer: root.signingKey)
        }
        #expect(await deviceStore.saved?.peerKey == keys.peer.peerKey)
        #expect(await nodeStore.saved?.peerKey == keys.node?.peerKey)
        #expect(await discovery.bound == [keys.device.signingKey])
    }

    @Test func `kit preflight crossing the deadline sends no root statement`() async throws {
        let vectors = try Vectors()
        let clock = try Mutex(vectors.now)
        let discovery = try Discovery(vectors: vectors)
        await discovery.onBind { clock.withLock { $0 += 120 } }
        let client = try OpenClawIDOwnerEnrollmentClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), deviceStore: TrustStore(),
            nodeStore: nil, http: discovery, now: { clock.withLock { $0 } })
        await #expect(throws: OpenClawIDOwnerEnrollmentError.expired) {
            try await client.approveWithRecoveryKit(
                vectors.text("kit", "text"), session: Self.session, claw: vectors.claw,
                keys: vectors.keys, label: "Example Mac", node: nil)
        }
        #expect(await discovery.bound.count == 1)
        #expect(await discovery.rootStatements.isEmpty)
    }

    @Test func `a kit for another claw signs nothing`() async throws {
        let vectors = try Vectors()
        let discovery = try Discovery(vectors: vectors)
        let deviceStore = TrustStore()
        let client = try OpenClawIDOwnerEnrollmentClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), deviceStore: deviceStore,
            nodeStore: nil, http: discovery, now: { (try? vectors.now) ?? 0 }, sleep: { _ in })
        await #expect(throws: OpenClawIDOwnerEnrollmentError.wrongKit) {
            try await client.approveWithRecoveryKit(
                Self.kitText(Data(repeating: 7, count: 16)), session: Self.session, claw: vectors.claw,
                keys: vectors.keys, label: "Example Mac", node: nil)
        }
        await #expect(throws: OpenClawIDOwnerEnrollmentError.kitInvalid) {
            try await client.approveWithRecoveryKit(
                "OCK1-NOT-A-KIT", session: Self.session, claw: vectors.claw, keys: vectors.keys,
                label: "Example Mac", node: nil)
        }
        #expect(await discovery.rootStatements.isEmpty)
        #expect(await discovery.bound.isEmpty)
        #expect(await deviceStore.saved == nil)
    }

    /// The handoff arrives either way; only the person's match on this Mac lets it be opened and pinned.
    @Test(arguments: [true, false])
    func `SAS enrollment opens the approver's handoff only after the code is confirmed here`(
        matches: Bool) async throws
    {
        let vectors = try Vectors()
        let keys = try vectors.keys
        let discovery = try Discovery(vectors: vectors)
        let deviceStore = TrustStore()
        let client = try OpenClawIDOwnerEnrollmentClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), deviceStore: deviceStore,
            nodeStore: TrustStore(), http: discovery, now: { (try? vectors.now) ?? 0 }, sleep: { _ in })
        let approver = try vectors.identity("device_seed_hex")
        let ephemeralE = Curve25519.KeyAgreement.PrivateKey()
        await discovery.onEnrollment { step, data, requestID, discovery in
            switch step {
            case "start":
                await discovery.mail(Self.enrollment(requestID, "accept", [
                    "eph_pub": .string(OpenClawIDNodeIdentity.hex(ephemeralE.publicKey.rawRepresentation)),
                    "device_pub": .string(approver.signingKey),
                ]))
                await discovery.remember(start: data)
            case "key":
                // E: check the commitment, admit N at the Gateway, then seal.
                guard case var .object(start) = await discovery.start else { return }
                let commit = try start["commit"]!.text()
                start["commit"] = nil
                start["request_id"] = .string(requestID)
                let ephN = try OpenClawIDNodeIdentity.unhex(data["eph_pub"]!.text())
                #expect(OpenClawIDNodeIdentity
                    .hex(SHA256.hash(data: ephN + OpenClawIDCanonicalJSON.object(start).encoded)) == commit)
                let shared = try ephemeralE.sharedSecretFromKeyAgreement(
                    with: .init(rawRepresentation: ephN)).withUnsafeBytes { Data($0) }
                let transcript = Data(SHA256.hash(data: OpenClawIDCanonicalJSON.object([
                    "start": .object(start), "commit": .string(commit),
                    "eph_e": .string(OpenClawIDNodeIdentity.hex(ephemeralE.publicKey.rawRepresentation)),
                    "eph_n": .string(OpenClawIDNodeIdentity.hex(ephN)), "device_pub_e": .string(approver.signingKey),
                ]).encoded))
                let key = HKDF<SHA256>.deriveKey(
                    inputKeyMaterial: SymmetricKey(data: shared), salt: Data(),
                    info: Data(("openclaw/sas-mac/v1" + OpenClawIDNodeIdentity.hex(transcript)).utf8),
                    outputByteCount: 32)
                let binding = try vectors.node["response"]!.fields(["descriptor", "snapshot"])["descriptor"]!
                    .fields([
                        "v",
                        "claw_id",
                        "transport",
                        "relay_url",
                        "root_pub",
                        "binding",
                        "published_at",
                    ])["binding"]!
                let cert = try OpenClawIDStatement.sign(
                    "OwnerDeviceCert", body: Self.certBody(keys, now: vectors.now), signer: approver)
                let handoff = try OpenClawIDCanonicalJSON.object([
                    "root_pub": .string(vectors.text("kit", "root_pub")), "binding": binding, "cert": cert,
                ])
                let box = try AES.GCM.seal(handoff.encoded, using: key)
                try await discovery.publish(seq: 3, listed: true)
                await discovery.mail(Self.enrollment(requestID, "sealed", [
                    "nonce": .string(OpenClawIDNodeIdentity.hex(box.nonce)),
                    "ciphertext": .string(OpenClawIDNodeIdentity.hex(box.ciphertext + box.tag)),
                ]))
            default: break
            }
        }
        let codes = Codes()
        // Undecided for the first polls, while the sealed handoff is already waiting.
        let answers = Answers(pending: 3, then: matches)
        let attempt = { try await client.approveFromDevice(
            session: Self.session, claw: vectors.claw, keys: keys, label: "Example Mac",
            node: vectors.description, onCode: { await codes.append($0) }, confirmed: { await answers.next() }) }
        if matches {
            let enrolled = try await attempt()
            #expect(try enrolled.rootFingerprint == vectors.text("kit", "root_fp"))
            #expect(await deviceStore.saved?.peerKey == keys.peer.peerKey)
        } else {
            await #expect(throws: OpenClawIDOwnerEnrollmentError.denied) { try await attempt() }
            #expect(await deviceStore.saved == nil)
            #expect(await discovery.steps.last == "abort")
        }
        #expect(await codes.values.count == 1)
        #expect(await codes.values.first?.count == 6)
        #expect(await answers.asked >= 3)
    }

    @Test func `a declined SAS request ends without a pin`() async throws {
        let vectors = try Vectors()
        let discovery = try Discovery(vectors: vectors)
        let deviceStore = TrustStore()
        let client = try OpenClawIDOwnerEnrollmentClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), deviceStore: deviceStore,
            nodeStore: nil, http: discovery, now: { (try? vectors.now) ?? 0 }, sleep: { _ in })
        await discovery.onEnrollment { step, _, requestID, discovery in
            if step == "start" {
                await discovery.mail(Self.enrollment(requestID, "abort", ["reason": .string("sas_mismatch")]))
            }
        }
        await #expect(throws: OpenClawIDOwnerEnrollmentError.denied) {
            try await client.approveFromDevice(
                session: Self.session, claw: vectors.claw, keys: vectors.keys, label: "Example Mac", node: nil,
                onCode: { _ in }, confirmed: { nil })
        }
        #expect(await deviceStore.saved == nil)
    }

    // MARK: helpers

    private static let session = OpenClawIDDiscoverySession(
        token: "ds_fixture", accountID: "acct_fixture", email: "owner@example.test", expiresAt: 9_999_999_999)

    private static func certBody(_ keys: OpenClawIDOwnerDeviceKeys, now: Int64) -> OpenClawIDCanonicalJSON {
        .object([
            "device_pub": .string(keys.device.signingKey), "peer_keys": .array([.string(keys.peer.peerKey)]),
            "label": .string("Example Mac"), "scope": .string("owner"),
            "caps": .array(OpenClawIDOwnerEnrollmentClient.ownerCapabilities.map { .string($0) }),
            "issued_at": .integer(now), "expires_at": .null, "root_epoch": .integer(1),
        ])
    }

    private static func enrollment(_ requestID: String, _ step: String, _ data: [String: OpenClawIDCanonicalJSON])
        -> OpenClawIDCanonicalJSON
    {
        .object([
            "message_id": .string(UUID().uuidString), "to": .string("fp:x"),
            "payload": .object([
                "kind": .string("enrollment"), "request_id": .string(requestID), "step": .string(step),
                "data": .object(data),
            ]),
        ])
    }

    /// Encodes a kit secret as `OCK1-…` text (test-only; the app only decodes kits).
    private static func kitText(_ secret: Data) -> String {
        let body = Data([1]) + secret
        let payload = body + Data(SHA256.hash(data: body).prefix(2))
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var out = ""
        var buffer = 0
        var bits = 0
        for byte in payload {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                out.append(alphabet[(buffer >> bits) & 31])
            }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { out.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return "OCK1-" + out
    }

    private static func expectSameStatement(
        _ actual: OpenClawIDCanonicalJSON,
        _ expected: OpenClawIDCanonicalJSON,
        type: String) throws
    {
        let fields: Set = ["v", "type", "body", "signer", "alg", "sig"]
        var mine = try actual.fields(fields)
        var theirs = try expected.fields(fields)
        // CryptoKit's Ed25519 signatures are randomized; both must verify over the same bytes.
        let signer = try mine["signer"]!.text()
        _ = try OpenClawIDNodeTrust.envelope(actual, type: type, signer: signer)
        _ = try OpenClawIDNodeTrust.envelope(expected, type: type, signer: signer)
        mine["sig"] = nil
        theirs["sig"] = nil
        #expect(OpenClawIDCanonicalJSON.object(mine).encoded == OpenClawIDCanonicalJSON.object(theirs).encoded)
    }

    private actor Answers {
        private var pending: Int
        private let answer: Bool
        private(set) var asked = 0

        init(pending: Int, then answer: Bool) {
            self.pending = pending
            self.answer = answer
        }

        func next() -> Bool? {
            self.asked += 1
            guard self.pending == 0 else {
                self.pending -= 1
                return nil
            }
            return self.answer
        }
    }

    private actor Codes {
        var values: [String] = []
        func append(_ code: String) {
            self.values.append(code)
        }
    }

    private actor TrustStore: OpenClawIDNodeTrustStore {
        var saved: OpenClawIDNodeTrustTarget?
        var observed: OpenClawIDNodeTrustState?
        func load(hostname _: String) -> OpenClawIDNodeTrustState? {
            self.observed
        }

        func observe(hostname _: String, state: OpenClawIDNodeTrustState) throws {
            self.observed = try OpenClawIDNodeTrust.mergeObservation(state, with: self.observed)
        }

        func commit(_ target: OpenClawIDNodeTrustTarget) throws {
            try OpenClawIDNodeTrust.validateCommit(target.state, replacing: self.observed)
            self.observed = target.state
            self.saved = target
        }
    }

    /// A scripted Discovery: the fixture claw's descriptor, a snapshot it re-signs with the fixture
    /// K_gw, device mail, and hooks that play the Gateway and the approving device.
    private actor Discovery: OpenClawIDNodeEnrollmentHTTP {
        typealias RootHook = @Sendable (OpenClawIDCanonicalJSON, Discovery) async throws -> Void
        typealias EnrollmentHook = @Sendable (String, [String: OpenClawIDCanonicalJSON], String, Discovery) async throws
            -> Void

        private let descriptor: OpenClawIDCanonicalJSON
        private var snapshot: OpenClawIDCanonicalJSON
        private let gateway: Curve25519.Signing.PrivateKey
        private let keys: OpenClawIDOwnerDeviceKeys
        private let now: Int64
        private var inbox: [OpenClawIDCanonicalJSON] = []
        private var cursor = 0
        private var bindHook: (@Sendable () -> Void)?
        private var rootHook: RootHook?
        private var enrollmentHook: EnrollmentHook?
        private(set) var rootStatements: [OpenClawIDCanonicalJSON] = []
        private(set) var bound: [String] = []
        private(set) var start: OpenClawIDCanonicalJSON?
        private(set) var steps: [String] = []

        init(vectors: Vectors) throws {
            let response = try vectors.node["response"]!.fields(["descriptor", "snapshot"])
            self.descriptor = response["descriptor"]!
            self.snapshot = response["snapshot"]!
            self.gateway = try Curve25519.Signing.PrivateKey(
                rawRepresentation: OpenClawIDNodeIdentity.unhex(vectors.node["gateway_seed_hex"]!.text()))
            self.keys = try vectors.keys
            self.now = try vectors.now
        }

        func onBind(_ hook: @escaping @Sendable () -> Void) {
            self.bindHook = hook
        }

        func onRootStatement(_ hook: @escaping RootHook) {
            self.rootHook = hook
        }

        func onEnrollment(_ hook: @escaping EnrollmentHook) {
            self.enrollmentHook = hook
        }

        func remember(start: [String: OpenClawIDCanonicalJSON]) {
            self.start = .object(start)
        }

        func mail(_ message: OpenClawIDCanonicalJSON) {
            self.inbox.append(message)
        }

        /// Re-signs the snapshot at `seq`, listing this Mac's W and W_node when admitted.
        func publish(seq: Int64, listed: Bool) throws {
            guard case var .object(body) = try self.snapshot.fields([
                "v",
                "type",
                "body",
                "signer",
                "alg",
                "sig",
            ])["body"]!
            else { return }
            body["seq"] = .integer(seq)
            body["issued_at"] = .integer(self.now)
            if listed {
                body["owner_devices"] = try .array(body["owner_devices"]!.list() + [.object([
                    "device_pub": .string(self.keys.device.signingKey),
                    "caps": .array(OpenClawIDOwnerEnrollmentClient.ownerCapabilities.map { .string($0) }),
                ])])
                body["owner_peer_keys"] = try .array(body["owner_peer_keys"]!
                    .list() + [.string(self.keys.peer.peerKey)])
                body["node_peer_keys"] = try .array(body["node_peer_keys"]!.list() + [.string(self.keys.node!.peerKey)])
            }
            let signature = try self.gateway.signature(
                for: Data("openclaw/MembershipSnapshot/v1\0".utf8) + OpenClawIDCanonicalJSON.object(body).encoded)
            self.snapshot = .object([
                "v": .integer(1), "type": .string("MembershipSnapshot"), "body": .object(body),
                "signer": .string("ed25519:" + OpenClawIDNodeIdentity.hex(self.gateway.publicKey.rawRepresentation)),
                "alg": .string("ed25519"), "sig": .string(OpenClawIDNodeIdentity.base64URL(signature)),
            ])
        }

        func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            let path = request.url?.path ?? ""
            let ok = { (body: OpenClawIDCanonicalJSON) in OpenClawIDNodeEnrollmentHTTPResponse(
                status: 200,
                body: body.encoded) }
            switch (request.httpMethod ?? "GET", path) {
            case let ("GET", path)
                where path.hasSuffix("/descriptor"): return ok(.object(["descriptor": self.descriptor]))
            case let ("GET", path) where path.hasSuffix("/snapshot"): return ok(.object(["snapshot": self.snapshot]))
            case ("POST", "/v1/devices"):
                let body = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data())
                    .fields(["device_pub", "peer_key", "label", "ts", "peer_key_proof"])
                #expect(request.value(forHTTPHeaderField: "openclaw-signature") != nil)
                try self.bound.append(body["device_pub"]!.text())
                self.bindHook?()
                return .init(status: 201, body: Data("{}".utf8))
            case let ("POST", path) where path.hasSuffix("/mailbox"):
                let mail = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data()).fields(["to", "payload"])
                let payload = try mail["payload"]!.fields(
                    ["kind"],
                    optional: ["statements", "request_id", "step", "data"])
                switch try payload["kind"]!.text() {
                case "root_statement":
                    let change = try payload["statements"]!.list()[0]
                    self.rootStatements.append(change)
                    try await self.rootHook?(change, self)
                case "enrollment":
                    try self.steps.append(payload["step"]!.text())
                    guard case let .object(data) = payload["data"]! else { break }
                    try await self.enrollmentHook?(
                        payload["step"]!.text(), data, payload["request_id"]!.text(), self)
                default: break
                }
                return .init(status: 201, body: Data(#"{"message_id":"m","expires_at":1}"#.utf8))
            case let ("GET", path) where path.hasSuffix("/mailbox/device"):
                // A real mailbox long-polls; answering an empty poll at once would spin the client.
                if self.cursor == self.inbox.count { try await Task.sleep(for: .milliseconds(20)) }
                let pending = Array(self.inbox[self.cursor...])
                self.cursor = self.inbox.count
                return ok(.object(["messages": .array(pending), "cursor": .string(String(self.cursor))]))
            default:
                return .init(status: 404, body: Data())
            }
        }
    }
}
