import CryptoKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

/// The Mac's member join: paste an owner's invite, send the redemption, wait as pending and join
/// with the invite's role and no node; or, already a member, approve this Mac from another of the
/// member's devices. Discovery is scripted; no Keychain or app state is touched.
@MainActor
struct OnboardingOpenClawIDMemberJoinTests {
    private static let configuration = MacOpenClawIDConfiguration(
        issuer: URL(string: "https://id.example.test/api/auth")!,
        clientID: "fixture-client",
        discoveryOrigin: URL(string: "https://discovery.example.test")!)
    private nonisolated static let claw = "team-k7x2q.crabd.me"
    private nonisolated static let clawID = "2123456789abcdef0123456789abcdef"

    /// What one test observes of the service's effects.
    private final class Effects {
        var installed: [MacOpenClawIDDevice] = []
        var forgotten: [UUID] = []
        var joined: [String] = []
        var saved: OpenClawIDDiscoverySession?
        var clipboard: String?
        var now = Date(timeIntervalSince1970: 1_800_000_000)
    }

    @Test func `a pasted invite joins with its role and no node once an owner approves`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let http = MemberDiscovery()
        let effects = Effects()
        effects.clipboard = try Self.link()
        let service = Self.service(http: http, effects: effects, defaults: defaults, approveWhileWaiting: true)
        _ = try await service.perform(.signIn)
        #expect(try await service.perform(.joinWithInvite) == .inviteEntry)
        #expect(try await service.perform(.pasteInvite) == .memberRequest(
            claw: Self.claw, device: "Fixture Mac", account: "bob@example.test"))
        #expect(try await service.perform(.requestJoin) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
        let pending = try #require(MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database())
            .pendingJoin())
        #expect(pending.clawID == Self.clawID && pending.accountID == "acct_bob")
        #expect(await http.redemptions == 1)
        #expect(effects.saved?.token == "ds_member")

        let model = OnboardingOpenClawIDModel(service: service, onJoined: { effects.joined.append($0) })
        await model.perform(.retry)?.value
        for _ in 0..<200 where effects.installed.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(model.step == .memberConnected(claw: Self.claw, device: "Fixture Mac", role: "Viewer"))
        let device = try #require(effects.installed.first)
        #expect(device.memberRole == "viewer")
        #expect(device.nodeEnrollmentID == nil)
        #expect(device.approvedWith == .invite)
        #expect(device.deviceEnrollmentID == pending.deviceEnrollmentID)
        #expect(device.admission == .member)
        #expect(device.memberAccountID == "acct_bob")
        #expect(effects.joined == [Self.claw])
        #expect(MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database()).pendingJoin() == nil)
        model.cancel()
    }

    @Test func `a member approves this Mac from another of their devices, with no invite or node`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let http = MemberDiscovery(member: true)
        let effects = Effects()
        let service = Self.service(http: http, effects: effects, defaults: defaults)
        _ = try await service.perform(.signIn)
        #expect(try await service.perform(.selectClaw(Self.clawID)) == .addMemberDevice(
            claw: Self.claw, device: "Fixture Mac"))
        let compare = try await service.perform(.approveFromDevice)
        guard case let .deviceCompareCode(claw, _, code, _, false, true) = compare else {
            Issue.record("expected the member's code comparison, got \(compare)")
            return
        }
        #expect(claw == Self.claw && code.count == 7)
        _ = try await service.perform(.confirmCode(matches: true))
        #expect(try await service.perform(.checkApproval) == .memberConnected(
            claw: Self.claw, device: "Fixture Mac", role: nil))
        let device = try #require(effects.installed.first)
        #expect(device.memberRole == "operator")
        #expect(device.nodeEnrollmentID == nil)
        #expect(device.approvedWith == .device)
        #expect(device.admission == .member)
        #expect(device.memberAccountID == "acct_bob")
        // The request went to the member's own devices; nothing was redeemed or sent to the owners.
        #expect(await http.recipients.first == "self")
        #expect(await http.redemptions == 0)
        #expect(effects.forgotten.isEmpty)
    }

    @Test func `switching to an invite mid-approval forgets that attempt's keys`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let effects = Effects()
        let service = Self.service(http: MemberDiscovery(member: true), effects: effects, defaults: defaults)
        _ = try await service.perform(.signIn)
        _ = try await service.perform(.selectClaw(Self.clawID))
        _ = try await service.perform(.approveFromDevice)
        #expect(try await service.perform(.joinWithInvite) == .inviteEntry)
        for _ in 0..<200 where effects.forgotten.isEmpty {
            try await Task.sleep(for: .milliseconds(5))
        }
        #expect(effects.forgotten.count == 1)
        #expect(effects.installed.isEmpty)
    }

    @Test func `a saved request resumes for its account and cancelling forgets its keys`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let effects = Effects()
        effects.clipboard = try Self.link()
        let first = Self.service(http: MemberDiscovery(), effects: effects, defaults: defaults)
        _ = try await first.perform(.signIn)
        _ = try await first.perform(.joinWithInvite)
        _ = try await first.perform(.pasteInvite)
        _ = try await first.perform(.requestJoin)
        first.cancel()
        let pending = try #require(MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database())
            .pendingJoin())
        #expect(effects.forgotten.isEmpty)

        let reopened = Self.service(http: MemberDiscovery(), effects: effects, defaults: defaults)
        #expect(try await reopened.start(.connect) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
        // Not a member yet: cancelling leads back to joining with an invite.
        #expect(try await reopened.perform(.cancelJoin) == .problem(.notInvited(account: "bob@example.test")))
        #expect(effects.forgotten == [pending.deviceEnrollmentID])
        #expect(MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database()).pendingJoin() == nil)

        // Another account's sign-in does not pick up someone else's request.
        let store = MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database())
        store.savePendingJoin(pending)
        let other = Self.service(http: MemberDiscovery(account: "acct_other"), effects: effects, defaults: defaults)
        #expect(try await other.perform(.signIn) == .problem(.notInvited(account: "bob@example.test")))
        #expect(store.pendingJoin() == pending)
    }

    @Test func `an unanswered request expires only after admission is checked`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let effects = Effects()
        let store = MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database())
        let deviceID = UUID()
        store.savePendingJoin(.init(
            hostname: Self.claw, clawID: Self.clawID, rootFingerprint: "fp:" + String(repeating: "a", count: 64),
            discoveryOrigin: Self.configuration.discoveryOrigin, deviceEnrollmentID: deviceID, accountID: "acct_bob",
            requestedAt: effects.now.addingTimeInterval(-7 * 86400)))
        let http = MemberDiscovery()
        let service = Self.service(http: http, effects: effects, defaults: defaults)
        #expect(try await service.perform(.signIn) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
        #expect(effects.forgotten.isEmpty)
        #expect(try await service.perform(.checkApproval) == .problem(.inviteExpired(claw: Self.claw)))
        #expect(await http.claws > 0)
        #expect(effects.forgotten == [deviceID])
        #expect(store.pendingJoin() == nil)
        effects.clipboard = "https://\(Self.claw)/join#i=nope"
        #expect(try await service.perform(.pasteInvite) == .problem(.inviteInvalid))
        effects.clipboard = nil
        #expect(try await service.perform(.pasteInvite) == .problem(.inviteInvalid))
        #expect(await http.redemptions == 0)
    }

    @Test(arguments: [false, true])
    func `only Discovery's refusal forgets a request whose answer was lost`(refused: Bool) async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let effects = Effects()
        effects.clipboard = try Self.link()
        let http = MemberDiscovery(mailFailure: refused ? .refused : .lost)
        let service = Self.service(http: http, effects: effects, defaults: defaults)
        _ = try await service.perform(.signIn)
        _ = try await service.perform(.joinWithInvite)
        _ = try await service.perform(.pasteInvite)
        let store = MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database())
        if refused {
            #expect(try await service.perform(.requestJoin) == .problem(.inviteInvalid))
            #expect(store.pendingJoin() == nil)
            #expect(effects.forgotten.count == 1)
        } else {
            // Discovery may have accepted it: the screen waits on it, these keys stay, and
            // reopening resumes the same wait.
            #expect(try await service.perform(.requestJoin) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
            #expect(store.pendingJoin() != nil)
            #expect(effects.forgotten.isEmpty)
            let reopened = Self.service(http: http, effects: effects, defaults: defaults)
            #expect(try await reopened.start(.connect) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
        }
    }

    @Test func `a failed claw lookup keeps the pasted invite for another try`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let effects = Effects()
        effects.clipboard = try Self.link()
        let http = MemberDiscovery(lookupFailures: 1)
        let service = Self.service(http: http, effects: effects, defaults: defaults)
        _ = try await service.perform(.signIn)
        _ = try await service.perform(.joinWithInvite)
        _ = try await service.perform(.pasteInvite)
        await #expect(throws: URLError.self) { try await service.perform(.requestJoin) }
        #expect(MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database()).pendingJoin() == nil)
        effects.clipboard = nil
        // Ask to join again, without pasting: the same invite is sent once the lookup works.
        #expect(try await service.perform(.requestJoin) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
        #expect(await http.redemptions == 1)
    }

    @Test func `a failed device binding sends nothing and stays retryable`() async throws {
        let (defaults, suite) = try Self.defaults()
        defer { defaults.removePersistentDomain(forName: suite) }
        let effects = Effects()
        effects.clipboard = try Self.link()
        let http = MemberDiscovery(bindFailures: 1)
        let service = Self.service(http: http, effects: effects, defaults: defaults)
        _ = try await service.perform(.signIn)
        _ = try await service.perform(.joinWithInvite)
        _ = try await service.perform(.pasteInvite)
        await #expect(throws: URLError.self) { try await service.perform(.requestJoin) }
        // Nothing reached the claw: no pending request, and that attempt's keys are gone.
        #expect(MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database()).pendingJoin() == nil)
        #expect(effects.forgotten.count == 1)
        #expect(await http.redemptions == 0)
        #expect(try await service.perform(.requestJoin) == .memberPending(claw: Self.claw, device: "Fixture Mac"))
        #expect(await http.redemptions == 1)
    }

    // MARK: helpers

    private static func defaults() throws -> (UserDefaults, String) {
        let suite = "ocid-member-join-\(UUID().uuidString)"
        return try (#require(UserDefaults(suiteName: suite)), suite)
    }

    private static func database() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ocid-member-\(UUID().uuidString).sqlite")
    }

    /// The fixture claw's root key.
    private nonisolated static func root() throws -> OpenClawIDNodeIdentity {
        try OpenClawIDNodeIdentity(seed: Data(repeating: 9, count: 32))
    }

    private static func link() throws -> String {
        let fp = try OpenClawIDStatement.fingerprint(self.root().signingKey).dropFirst(3)
        let secret = OpenClawIDNodeIdentity.base64URL(Data(repeating: 7, count: 32))
        return "https://\(self.claw)/join#i=00112233445566778899aabbccddeeff.\(secret)&r=\(fp)"
    }

    private static func service(
        http: MemberDiscovery,
        effects: Effects,
        defaults: UserDefaults,
        approveWhileWaiting: Bool = false) -> OnboardingOpenClawIDSignInService
    {
        let database = self.database()
        return OnboardingOpenClawIDSignInService(
            configuration: self.configuration,
            databaseURL: database,
            nodeInvitations: OnboardingNodeInvitationService(
                databaseURL: database,
                readInvitation: { throw CocoaError(.featureUnsupported) },
                describeNode: { throw CocoaError(.featureUnsupported) },
                install: { _ in },
                isConnected: { _ in false }),
            environment: .init(
                signIn: { _ in "fixture-id-token" },
                discovery: { _ in http },
                describeNode: {
                    Issue.record("a member join never describes a node")
                    throw CocoaError(.featureUnsupported)
                },
                deviceName: { "Fixture Mac" },
                keyStore: { id, purpose in MemoryKey(id: id, purpose: purpose) },
                trustStore: { _, _ in TrustStore() },
                readKitFile: { nil },
                readInviteLink: { effects.clipboard },
                store: MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: database),
                savedSession: { effects.saved },
                saveSession: { effects.saved = $0 },
                forgetKeys: { device, _ in effects.forgotten.append(device) },
                now: { effects.now },
                sleep: { _ in
                    if approveWhileWaiting { await http.approve(role: "viewer") }
                    await Task.yield()
                },
                install: { device, _ in effects.installed.append(device) }))
    }

    /// Deterministic per-enrollment seeds, so a resumed request finds the same W.
    private struct MemoryKey: OpenClawIDNodeIdentityStore {
        let id: UUID
        let purpose: OpenClawIDKeyPurpose
        func loadOrCreateSeed() async throws -> Data {
            Data(SHA256.hash(data: Data((self.id.uuidString + self.purpose.rawValue).utf8)))
        }
    }

    private actor TrustStore: OpenClawIDNodeTrustStore {
        var observed: OpenClawIDNodeTrustState?
        func load(hostname _: String) -> OpenClawIDNodeTrustState? {
            self.observed
        }

        func observe(hostname _: String, state: OpenClawIDNodeTrustState) throws {
            self.observed = try OpenClawIDNodeTrust.mergeObservation(state, with: self.observed)
        }

        func commit(_ target: OpenClawIDNodeTrustTarget) throws {
            self.observed = target.state
        }
    }

    /// Discovery for an invitee: a join ticket names the claw, and once an owner approves, the
    /// account lists it and its snapshot names the redeemed W as a member. For an existing `member`,
    /// it also plays the member's other device approving this Mac over SAS.
    private actor MemberDiscovery: OpenClawIDNodeEnrollmentHTTP {
        private let account: String
        private let member: Bool
        private let gateway = Curve25519.Signing.PrivateKey()
        private let ephemeralE = Curve25519.KeyAgreement.PrivateKey()
        private var role: String?
        enum MailFailure { case refused, lost }

        private let mailFailure: MailFailure?
        private var peer: String?
        private var start: [String: OpenClawIDCanonicalJSON]?
        private var inbox: [OpenClawIDCanonicalJSON] = []
        private(set) var redemptions = 0
        private(set) var claws = 0
        private(set) var recipients: [String] = []

        private var lookupFailures: Int
        private var bindFailures: Int

        init(
            account: String = "acct_bob",
            member: Bool = false,
            mailFailure: MailFailure? = nil,
            lookupFailures: Int = 0,
            bindFailures: Int = 0)
        {
            self.account = account
            self.member = member
            self.mailFailure = mailFailure
            self.lookupFailures = lookupFailures
            self.bindFailures = bindFailures
        }

        func approve(role: String) {
            self.role = role
        }

        func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            let json = { (value: OpenClawIDCanonicalJSON) in
                OpenClawIDNodeEnrollmentHTTPResponse(status: 200, body: value.encoded)
            }
            let listed = self.role != nil && self.peer != nil
            switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
            case ("POST", "/v1/sessions"):
                return json(.object([
                    "session": .string("ds_member"), "account_id": .string(self.account),
                    "email": .string("bob@example.test"), "expires_at": .integer(9_999_999_999),
                ]))
            case ("GET", "/v1/claws"):
                self.claws += 1
                let claws: [OpenClawIDCanonicalJSON] = listed || self.member ? [.object([
                    "claw_id": .string(OnboardingOpenClawIDMemberJoinTests.clawID),
                    "hostname": .string(OnboardingOpenClawIDMemberJoinTests.claw),
                    "relationship": .string("member"), "role": .string(self.role ?? "operator"),
                    "online": .bool(true),
                ])] : []
                return json(.object(["claws": .array(claws)]))
            case ("POST", "/v1/join-tickets") where self.lookupFailures > 0:
                self.lookupFailures -= 1
                throw URLError(.timedOut)
            case ("POST", "/v1/join-tickets"):
                return json(.object([
                    "ticket": .string("dt_unused"), "origin": .string("https://unused.example.test"),
                    "expires_at": .integer(1), "claw_id": .string(OnboardingOpenClawIDMemberJoinTests.clawID),
                ]))
            case ("POST", "/v1/devices") where self.bindFailures > 0:
                self.bindFailures -= 1
                throw URLError(.timedOut)
            case ("POST", "/v1/devices"): return json(.object([:]))
            case let ("POST", path) where path.hasSuffix("/mailbox") && self.mailFailure == .refused:
                return .init(status: 400, body: Data(#"{"error":{"code":"invalid_statement","message":"x"}}"#.utf8))
            case let ("POST", path) where path.hasSuffix("/mailbox") && self.mailFailure == .lost:
                throw URLError(.networkConnectionLost)
            case let ("GET", path) where path.hasSuffix("/mailbox/device"):
                let messages = self.inbox
                self.inbox = []
                if messages.isEmpty { try await Task.sleep(for: .milliseconds(5)) }
                return json(.object(["messages": .array(messages), "cursor": .string("1")]))
            case let ("POST", path) where path.hasSuffix("/mailbox") && self.member:
                let mail = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data()).fields(["to", "payload"])
                try self.recipients.append(mail["to"]!.text())
                try self.approve(mail["payload"]!.fields(["kind", "request_id", "step", "data"]))
                return json(.object([:]))
            case let ("POST", path) where path.hasSuffix("/mailbox"):
                let payload = try OpenClawIDCanonicalJSON.parse(request.httpBody ?? Data())
                    .fields(["to", "payload"])["payload"]!.fields(["kind", "redemption"])
                let body = try payload["redemption"]!.fields(["v", "type", "body", "signer", "alg", "sig"])["body"]!
                let fields = try body.fields([
                    "claw_id", "invite_id", "account_id", "device_pub", "peer_key", "label", "proof", "requested_at",
                ])
                #expect(fields["label"] == .string("Fixture Mac"))
                self.peer = try fields["peer_key"]!.text()
                self.redemptions += 1
                return json(.object([:]))
            case let ("GET", path) where path.hasSuffix("/descriptor") && listed:
                return try json(.object(["descriptor": self.descriptor()]))
            case let ("GET", path) where path.hasSuffix("/snapshot") && listed:
                return try json(.object(["snapshot": self.snapshot()]))
            default:
                return .init(status: 404, body: Data())
            }
        }

        /// The member's other device E: accept the request, then add N to the account (the snapshot
        /// lists it) and seal the pin with no certificate.
        private func approve(_ payload: [String: OpenClawIDCanonicalJSON]) throws {
            guard case let .object(data) = payload["data"]! else { return }
            let requestID = try payload["request_id"]!.text()
            let approver = try OpenClawIDNodeIdentity(seed: Data(repeating: 8, count: 32))
            let reply = { (step: String, data: [String: OpenClawIDCanonicalJSON]) in
                OpenClawIDCanonicalJSON.object([
                    "message_id": .string(UUID().uuidString), "to": .string("fp:n"),
                    "payload": .object([
                        "kind": .string("enrollment"), "request_id": .string(requestID), "step": .string(step),
                        "data": .object(data),
                    ]),
                ])
            }
            switch try payload["step"]!.text() {
            case "start":
                self.start = data
                self.peer = try data["peer_key"]!.text()
                self.inbox.append(reply("accept", [
                    "eph_pub": .string(OpenClawIDNodeIdentity.hex(self.ephemeralE.publicKey.rawRepresentation)),
                    "device_pub": .string(approver.signingKey),
                ]))
            case "key":
                guard var start = self.start else { return }
                let commit = try start["commit"]!.text()
                start["commit"] = nil
                start["request_id"] = .string(requestID)
                let ephN = try OpenClawIDNodeIdentity.unhex(data["eph_pub"]!.text())
                let shared = try self.ephemeralE.sharedSecretFromKeyAgreement(with: .init(rawRepresentation: ephN))
                    .withUnsafeBytes { Data($0) }
                let transcript = Data(SHA256.hash(data: OpenClawIDCanonicalJSON.object([
                    "start": .object(start), "commit": .string(commit),
                    "eph_e": .string(OpenClawIDNodeIdentity.hex(self.ephemeralE.publicKey.rawRepresentation)),
                    "eph_n": .string(OpenClawIDNodeIdentity.hex(ephN)), "device_pub_e": .string(approver.signingKey),
                ]).encoded))
                let key = HKDF<SHA256>.deriveKey(
                    inputKeyMaterial: SymmetricKey(data: shared), salt: Data(),
                    info: Data(("openclaw/sas-mac/v1" + OpenClawIDNodeIdentity.hex(transcript)).utf8),
                    outputByteCount: 32)
                let descriptor = try self.descriptor().fields([
                    "v", "claw_id", "transport", "relay_url", "root_pub", "binding", "published_at",
                ])
                let handoff = OpenClawIDCanonicalJSON.object([
                    "root_pub": descriptor["root_pub"]!, "binding": descriptor["binding"]!, "cert": .null,
                ])
                let box = try AES.GCM.seal(handoff.encoded, using: key)
                self.role = "operator"
                self.inbox.append(reply("sealed", [
                    "nonce": .string(OpenClawIDNodeIdentity.hex(box.nonce)),
                    "ciphertext": .string(OpenClawIDNodeIdentity.hex(box.ciphertext + box.tag)),
                ]))
            default: break
            }
        }

        private func descriptor() throws -> OpenClawIDCanonicalJSON {
            let root = try OnboardingOpenClawIDMemberJoinTests.root()
            let now = Int64(Date().timeIntervalSince1970)
            let binding = try OpenClawIDStatement.sign("ServerBinding", body: .object([
                "claw_id": .string(OnboardingOpenClawIDMemberJoinTests.clawID),
                "hostname": .string(OnboardingOpenClawIDMemberJoinTests.claw),
                "k_srv": .string("iroh:" + String(repeating: "5", count: 64)),
                "k_gw": .string("ed25519:" + OpenClawIDNodeIdentity.hex(self.gateway.publicKey.rawRepresentation)),
                "binding_seq": .integer(1), "root_epoch": .integer(1), "issued_at": .integer(now),
            ]), signer: root)
            return .object([
                "v": .integer(1), "claw_id": .string(OnboardingOpenClawIDMemberJoinTests.clawID),
                "transport": .string("iroh"), "relay_url": .string("https://relay.example.test"),
                "root_pub": .string(root.signingKey), "binding": binding, "published_at": .integer(now),
            ])
        }

        private func snapshot() throws -> OpenClawIDCanonicalJSON {
            let body = OpenClawIDCanonicalJSON.object([
                "claw_id": .string(OnboardingOpenClawIDMemberJoinTests.clawID), "seq": .integer(2),
                "binding_seq": .integer(1), "issued_at": .integer(Int64(Date().timeIntervalSince1970)),
                "owner_devices": .array([]), "owner_peer_keys": .array([]), "node_peer_keys": .array([]),
                "members": .array([.object([
                    "account_id": .string(self.account), "role": .string(self.role ?? ""),
                    "peer_keys": .array([.string(self.peer ?? "")]),
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
