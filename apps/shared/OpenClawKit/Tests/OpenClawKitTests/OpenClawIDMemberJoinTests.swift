import CryptoKit
import Foundation
import Testing
@testable import OpenClawKit

/// Member invite redemption against the TypeScript protocol vectors and a scripted Discovery.
struct OpenClawIDMemberJoinTests {
    private struct Vectors {
        let json: OpenClawIDCanonicalJSON
        let root: OpenClawIDNodeIdentity

        init() throws {
            func load(_ name: String) throws -> OpenClawIDCanonicalJSON {
                let url = try #require(Bundle.module.url(
                    forResource: name, withExtension: "json", subdirectory: "Fixtures"))
                return try OpenClawIDCanonicalJSON.parse(Data(contentsOf: url))
            }
            self.json = try load("OpenClawIDMemberJoin")
            guard case let .object(owner) = try load("OpenClawIDOwnerEnrollment"), case let .object(kit)? = owner["kit"]
            else { throw OpenClawIDNodeEnrollmentError.malformed }
            self.root = try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(kit["root_seed_hex"]!.text()))
        }

        func value(_ path: String...) throws -> OpenClawIDCanonicalJSON {
            var current = self.json
            for key in path {
                guard case let .object(fields) = current, let next = fields[key] else {
                    throw OpenClawIDNodeEnrollmentError.malformed
                }
                current = next
            }
            return current
        }

        func text(_ path: String...) throws -> String {
            var current = self.json
            for key in path {
                guard case let .object(fields) = current, let next = fields[key] else {
                    throw OpenClawIDNodeEnrollmentError.malformed
                }
                current = next
            }
            return try current.text()
        }

        func identity(_ key: String) throws -> OpenClawIDNodeIdentity {
            try OpenClawIDNodeIdentity(seed: OpenClawIDNodeIdentity.unhex(self.text("keys", key)))
        }

        var now: Int64 {
            get throws { try self.value("now").number() }
        }
    }

    private static let session = OpenClawIDDiscoverySession(
        token: "ds_fixture", accountID: "acct_bob", email: "bob@example.test", expiresAt: 9_999_999_999)

    @Test func `invite link and redemption match the TypeScript vectors`() throws {
        let vectors = try Vectors()
        var link = try OpenClawIDInviteLink(vectors.text("invite", "link"))
        #expect(try link.hostname == vectors.text("hostname"))
        #expect(try link.inviteID == vectors.text("invite", "invite_id"))
        #expect(try link.rootFingerprint == vectors.text("invite", "root_fp"))
        #expect(try OpenClawIDStatement.fingerprint(vectors.root.signingKey) == link.rootFingerprint)
        let device = try vectors.identity("device_seed_hex")
        let peer = try vectors.identity("peer_seed_hex")
        let redemption = try OpenClawIDMemberJoinClient.redemption(
            link: &link, clawID: vectors.text("claw_id"), accountID: vectors.text("account_id"), device: device,
            peer: peer, label: vectors.text("label"), now: vectors.now)
        let expected = try vectors.value("redemption")
        // CryptoKit's Ed25519 signatures are randomized: both must verify over identical bytes.
        let fields: Set = ["v", "type", "body", "signer", "alg", "sig"]
        var mine = try redemption.fields(fields)
        var theirs = try expected.fields(fields)
        _ = try OpenClawIDNodeTrust.envelope(redemption, type: "InviteRedemption", signer: device.signingKey)
        _ = try OpenClawIDNodeTrust.envelope(expected, type: "InviteRedemption", signer: device.signingKey)
        mine["sig"] = nil
        theirs["sig"] = nil
        #expect(OpenClawIDCanonicalJSON.object(mine).encoded == OpenClawIDCanonicalJSON.object(theirs).encoded)
    }

    @Test func `only a whole https join link is an invite`() throws {
        let vectors = try Vectors()
        let link = try vectors.text("invite", "link")
        let fragment = try #require(link.split(separator: "#").last)
        #expect(try OpenClawIDInviteLink("  \(link)\n").hostname == "team-k7x2q.crabd.me")
        #expect(try OpenClawIDInviteLink(link + "&x=1").inviteID == vectors.text("invite", "invite_id"))
        for bad in [
            link.replacingOccurrences(of: "https://", with: "http://"),
            link.replacingOccurrences(of: "/join#", with: "/joined#"),
            link.replacingOccurrences(of: "/join#", with: "/join?x=1#"),
            link + "&r=" + String(repeating: "0", count: 64),
            "https://team-k7x2q.crabd.me/join#" + fragment.replacingOccurrences(of: "BwcH", with: "Bw"),
            "https://team-k7x2q.crabd.me/join#" + fragment.replacingOccurrences(of: "&r=", with: "&q="),
            "openclaw-node://join#" + fragment,
        ] {
            #expect(throws: OpenClawIDNodeEnrollmentError.invalidLink) { try OpenClawIDInviteLink(bad) }
        }
    }

    @Test func `an invitee redeems through a join ticket and joins once an owner approves`() async throws {
        let vectors = try Vectors()
        let peer = try vectors.identity("peer_seed_hex")
        let discovery = try Discovery(vectors: vectors, peer: peer.peerKey)
        let trust = TrustStore()
        let client = try OpenClawIDMemberJoinClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), trustStore: trust, http: discovery,
            now: { (try? vectors.now) ?? 0 })
        var link = try OpenClawIDInviteLink(vectors.text("invite", "link"))
        let clawID = try await client.clawID(hostname: link.hostname, session: Self.session)
        #expect(try clawID == vectors.text("claw_id"))
        try await client.redeem(
            &link, clawID: clawID, session: Self.session, device: vectors.identity("device_seed_hex"), peer: peer,
            label: "Example Mac")
        let devicePub = try vectors.text("keys", "device_pub")
        #expect(await discovery.bound == [devicePub])
        let mail = try #require(await discovery.mail.first)
        #expect(mail["to"] == .string("gateway"))
        let payload = try #require(mail["payload"]).fields(["kind", "redemption"])
        #expect(payload["kind"] == .string("invite_redemption"))
        let sent = try #require(payload["redemption"]).fields(["v", "type", "body", "signer", "alg", "sig"])["body"]
        #expect(try sent?.fields([
            "claw_id", "invite_id", "account_id", "device_pub", "peer_key", "label", "proof", "requested_at",
        ])["label"] == .string("Example Mac"))
        let redemption = try #require(payload["redemption"])
        _ = try OpenClawIDNodeTrust.envelope(redemption, type: "InviteRedemption", signer: devicePub)
        // Pending: the account does not belong to the claw yet, then an approval lists W.
        let pending = try await client.admitted(
            hostname: link.hostname, clawID: clawID, rootFingerprint: link.rootFingerprint, session: Self.session,
            peer: peer)
        #expect(pending == nil)
        #expect(await trust.saved == nil)
        try await discovery.approve(role: "viewer")
        let joined = try await client.admitted(
            hostname: link.hostname, clawID: clawID, rootFingerprint: link.rootFingerprint, session: Self.session,
            peer: peer)
        #expect(joined?.role == "viewer")
        #expect(await trust.saved?.peerKey == peer.peerKey)
    }

    @Test func `a claw under another root never pins the member`() async throws {
        let vectors = try Vectors()
        let peer = try vectors.identity("peer_seed_hex")
        let discovery = try Discovery(vectors: vectors, peer: peer.peerKey)
        try await discovery.approve(role: "operator")
        let trust = TrustStore()
        let client = try OpenClawIDMemberJoinClient(
            discoveryOrigin: #require(URL(string: "https://discovery.example")), trustStore: trust, http: discovery,
            now: { (try? vectors.now) ?? 0 })
        await #expect(throws: OpenClawIDNodeEnrollmentError.rootMismatch) {
            try await client.admitted(
                hostname: vectors.text("hostname"), clawID: vectors.text("claw_id"),
                rootFingerprint: "fp:" + String(repeating: "ab", count: 32), session: Self.session, peer: peer)
        }
        #expect(await trust.saved == nil)
    }

    @Test(arguments: [OpenClawIDAdmission.member, .owner])
    func `a claw Discovery hides is a removal only for a member`(admission: OpenClawIDAdmission) async throws {
        let vectors = try Vectors()
        let trust = TrustStore()
        try await trust.observe(hostname: vectors.text("hostname"), state: .init(
            clawID: vectors.text("claw_id"), rootFingerprint: vectors.text("invite", "root_fp"), bindingSequence: 1,
            snapshotSequence: 1, snapshotIssuedAt: vectors.now, snapshotBindingSequence: 1))
        let refresh = {
            try await OpenClawIDDeviceRoute.refresh(
                hostname: vectors.text("hostname"),
                discoveryOrigin: #require(URL(string: "https://discovery.example")),
                peer: vectors.identity("peer_seed_hex"), admission: admission, node: nil, session: Self.session,
                store: trust, http: Hidden(), now: { (try? vectors.now) ?? 0 })
        }
        if admission == .member {
            await #expect(throws: OpenClawIDNodeEnrollmentError.notAdmitted) { _ = try await refresh() }
        } else {
            await #expect(throws: OpenClawIDDiscoveryAccountError(status: 404, code: "not_found")) {
                _ = try await refresh()
            }
        }
    }

    private struct Hidden: OpenClawIDNodeEnrollmentHTTP {
        func send(_: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            .init(status: 404, body: Data(#"{"error":{"code":"not_found","message":"hidden"}}"#.utf8))
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

    /// A scripted Discovery: the account reaches the claw only through a join ticket until an owner
    /// approves, then lists it and serves its descriptor and a snapshot naming this W as a member.
    private actor Discovery: OpenClawIDNodeEnrollmentHTTP {
        private let vectors: Vectors
        private let peer: String
        private let gateway = Curve25519.Signing.PrivateKey()
        private var role: String?
        private(set) var bound: [String] = []
        private(set) var mail: [[String: OpenClawIDCanonicalJSON]] = []

        init(vectors: Vectors, peer: String) throws {
            self.vectors = vectors
            self.peer = peer
        }

        func approve(role: String) throws {
            self.role = role
        }

        func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            let clawID = try self.vectors.text("claw_id")
            let hostname = try self.vectors.text("hostname")
            let ok = { (body: OpenClawIDCanonicalJSON) in
                OpenClawIDNodeEnrollmentHTTPResponse(status: 200, body: body.encoded)
            }
            let hidden = OpenClawIDNodeEnrollmentHTTPResponse(status: 404, body: Data())
            switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
            case ("GET", "/v1/claws"):
                let claws: [OpenClawIDCanonicalJSON] = self.role.map { role in [.object([
                    "claw_id": .string(clawID), "hostname": .string(hostname), "relationship": .string("member"),
                    "role": .string(role), "online": .bool(true),
                ])] } ?? []
                return ok(.object(["claws": .array(claws)]))
            case ("POST", "/v1/join-tickets"):
                let body = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data()).fields(["hostname"])
                guard body["hostname"] == .string(hostname) else { return hidden }
                return .init(status: 201, body: OpenClawIDCanonicalJSON.object([
                    "ticket": .string("dt_unused"), "origin": .string("https://\(hostname)"),
                    "expires_at": .integer(1), "claw_id": .string(clawID),
                ]).encoded)
            case ("POST", "/v1/devices"):
                #expect(request.value(forHTTPHeaderField: "openclaw-signature") != nil)
                let body = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data())
                    .fields(["device_pub", "peer_key", "label", "ts", "peer_key_proof"])
                try self.bound.append(body["device_pub"]!.text())
                return .init(status: 201, body: Data("{}".utf8))
            case let ("POST", path) where path == "/v1/claws/\(clawID)/mailbox":
                #expect(request.value(forHTTPHeaderField: "openclaw-signature") != nil)
                let mail = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data())
                try self.mail.append(mail.fields(["to", "payload"]))
                return .init(status: 201, body: Data(#"{"message_id":"m","expires_at":1}"#.utf8))
            case let ("GET", path) where path.hasSuffix("/descriptor") && self.role != nil:
                return try ok(.object(["descriptor": self.descriptor()]))
            case let ("GET", path) where path.hasSuffix("/snapshot") && self.role != nil:
                return try ok(.object(["snapshot": self.snapshot()]))
            default:
                return hidden
            }
        }

        private func descriptor() throws -> OpenClawIDCanonicalJSON {
            let now = try self.vectors.now
            let gateway = "ed25519:" + OpenClawIDNodeIdentity.hex(self.gateway.publicKey.rawRepresentation)
            let binding = try OpenClawIDStatement.sign("ServerBinding", body: .object([
                "claw_id": .string(self.vectors.text("claw_id")), "hostname": .string(self.vectors.text("hostname")),
                "k_srv": .string("iroh:" + String(repeating: "5", count: 64)), "k_gw": .string(gateway),
                "binding_seq": .integer(1), "root_epoch": .integer(1), "issued_at": .integer(now),
            ]), signer: self.vectors.root)
            return try .object([
                "v": .integer(1), "claw_id": .string(self.vectors.text("claw_id")), "transport": .string("iroh"),
                "relay_url": .string("https://relay.example.test"), "root_pub": .string(self.vectors.root.signingKey),
                "binding": binding, "published_at": .integer(now),
            ])
        }

        private func snapshot() throws -> OpenClawIDCanonicalJSON {
            let body = try OpenClawIDCanonicalJSON.object([
                "claw_id": .string(self.vectors.text("claw_id")), "seq": .integer(2), "binding_seq": .integer(1),
                "issued_at": .integer(self.vectors.now), "owner_devices": .array([]), "owner_peer_keys": .array([]),
                "node_peer_keys": .array([]),
                "members": .array([.object([
                    "account_id": .string("acct_bob"), "role": .string(self.role ?? "operator"),
                    "peer_keys": .array([.string(self.peer)]),
                ])]),
                "protocols": .object(["statement": .array([.integer(1)]), "descriptor": .array([.integer(1)])]),
            ])
            let signature = try self.gateway.signature(
                for: Data("openclaw/MembershipSnapshot/v1\0".utf8) + body.encoded)
            return .object([
                "v": .integer(1), "type": .string("MembershipSnapshot"), "body": body,
                "signer": .string("ed25519:" + OpenClawIDNodeIdentity.hex(self.gateway.publicKey.rawRepresentation)),
                "alg": .string("ed25519"), "sig": .string(OpenClawIDNodeIdentity.base64URL(signature)),
            ])
        }
    }
}
