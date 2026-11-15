import CryptoKit
import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct OnboardingOpenClawIDSignInTests {
    private static let configuration = MacOpenClawIDConfiguration(
        issuer: URL(string: "https://id.example.test/api/auth")!,
        clientID: "fixture-client",
        discoveryOrigin: URL(string: "https://discovery.example.test")!)

    @Test func `build config selects the issuer and an empty client id disables sign in`() {
        let defaults = MacOpenClawIDConfiguration.current(info: [:])
        #expect(defaults?.issuer.absoluteString == MacOpenClawIDConfiguration.stagingIssuer)
        #expect(defaults?.clientID == MacOpenClawIDConfiguration.stagingClientID)
        #expect(MacOpenClawIDConfiguration.current(info: ["OpenClawIDClientID": ""]) == nil)
        #expect(MacOpenClawIDConfiguration.current(info: ["OpenClawIDIssuer": "http://id.example.test"]) == nil)
        let service = OnboardingOpenClawIDSignInService(
            configuration: nil, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: Self.environment(http: Discovery()))
        #expect(service.accountUnavailableReason != nil)
    }

    @Test func `callback must carry this attempt's state and issuer`() throws {
        let issuer = Self.configuration.issuer
        let good =
            try #require(URL(string: "ai.openclaw.mac:/oauth/callback?code=abc&state=s1&iss=\(issuer.absoluteString)"))
        #expect(try MacOpenClawIDSignIn.code(from: good, state: "s1", issuer: issuer) == "abc")
        #expect(throws: MacOpenClawIDSignInError.stateMismatch) {
            try MacOpenClawIDSignIn.code(from: good, state: "s2", issuer: issuer)
        }
        let foreign =
            try #require(URL(string: "ai.openclaw.mac:/oauth/callback?code=abc&state=s1&iss=https://evil.test"))
        #expect(throws: MacOpenClawIDSignInError.issuerMismatch) {
            try MacOpenClawIDSignIn.code(from: foreign, state: "s1", issuer: issuer)
        }
        let refused = try #require(URL(string: "ai.openclaw.mac:/oauth/callback?error=access_denied&state=s1"))
        #expect(throws: MacOpenClawIDSignInError.refused) {
            try MacOpenClawIDSignIn.code(from: refused, state: "s1", issuer: issuer)
        }
        let path = try #require(URL(string: "ai.openclaw.mac:/other?code=abc&state=s1"))
        #expect(throws: MacOpenClawIDSignInError.malformed) {
            try MacOpenClawIDSignIn.code(from: path, state: "s1", issuer: issuer)
        }
        let claims = MacOpenClawIDSignIn.base64URL(Data(#"{"nonce":"n1"}"#.utf8))
        #expect(MacOpenClawIDSignIn.nonce(of: "e30.\(claims).sig") == "n1")
        #expect(MacOpenClawIDSignIn.nonce(of: "not-a-jwt") == nil)
    }

    @Test func `sign in lists claws and routes each relationship`() async throws {
        let http = Discovery()
        let service = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: Self.environment(http: http))
        #expect(try await service.start(.connect) == .signIn)
        let claws = try await service.perform(.signIn)
        guard case let .claws(account, listed) = claws else {
            Issue.record("expected the claw picker, got \(claws)")
            return
        }
        #expect(account == "owner@example.test")
        #expect(listed.map(\.relationship) == ["Owner", "Owner", "Operator"])
        #expect(await http.bearers == ["fixture-id-token", "ds_fixture"])
        #expect(try await service.perform(.selectClaw(Discovery.studio)) == .chooseApproval(
            claw: "studio-k7x2q.crabd.me", device: "Fixture Mac"))
        #expect(try await service.perform(.selectClaw(Discovery.lab)) == .problem(.clawOffline(
            claw: "lab-k7x2q.crabd.me")))
        #expect(try await service.perform(.selectClaw(Discovery.team)) == .problem(.memberNeedsInvite(
            claw: "team-k7x2q.crabd.me")))
    }

    @Test func `an account without claws and a cancelled sign in`() async throws {
        let http = Discovery(empty: true)
        var environment = Self.environment(http: http)
        let service = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        #expect(try await service.perform(.signIn) == .problem(.notInvited(account: "owner@example.test")))
        environment.signIn = { _ in throw MacOpenClawIDSignInError.cancelled }
        let cancelled = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        #expect(try await cancelled.perform(.signIn) == .signIn)
        environment.signIn = { _ in throw MacOpenClawIDSignInError.stateMismatch }
        let failed = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        #expect(try await failed.perform(.signIn) == .problem(.signInFailed))
    }

    @Test func `only a fresh login asks the issuer to ignore its browser session`() throws {
        let signIn = MacOpenClawIDSignIn(configuration: Self.configuration)
        let endpoint = Self.configuration.issuer.appendingPathComponent("oauth2/authorize")
        for fresh in [false, true] {
            let url = try signIn.authorizationURL(
                endpoint: endpoint,
                verifier: "fixture-verifier",
                state: "fixture-state",
                nonce: "fixture-nonce",
                freshLogin: fresh)
            let items = try #require(URLComponents(url: url, resolvingAgainstBaseURL: false)?.queryItems)
            let query = Dictionary(items.map { ($0.name, $0.value ?? "") }, uniquingKeysWith: { first, _ in first })
            #expect(query["prompt"] == (fresh ? "login" : nil))
            #expect(query["state"] == "fixture-state")
            #expect(query["nonce"] == "fixture-nonce")
            #expect(query["code_challenge_method"] == "S256")
            #expect(query["redirect_uri"] == MacOpenClawIDConfiguration.redirectURI)
        }
    }

    @Test(arguments: [false, true])
    func `switch account clears Discovery and requests a fresh login`(empty: Bool) async throws {
        let http = Discovery(empty: empty)
        var attempts: [Bool] = []
        var environment = Self.environment(http: http)
        environment.signIn = { fresh in
            attempts.append(fresh)
            if fresh { throw MacOpenClawIDSignInError.cancelled }
            return "fixture-id-token"
        }
        let service = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration,
            databaseURL: Self.database(),
            nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        let model = OnboardingOpenClawIDModel(service: service, onJoined: { _ in })
        await model.begin(.connect)?.value
        await model.perform(.signIn)?.value
        if empty {
            #expect(model.step == .problem(.notInvited(account: "owner@example.test")))
        } else {
            guard case let .claws(account, _) = model.step else {
                Issue.record("expected the claw picker")
                return
            }
            #expect(account == "owner@example.test")
        }
        let switching = model.perform(.switchAccount)
        #expect(model.step == .signingIn)
        #expect(model.busy)
        await switching?.value
        #expect(model.step == .signIn)
        #expect(attempts == [false, true])
        // Neither Back nor an old selection can recover the discarded account after cancellation.
        #expect(try await service.perform(.back) == .signIn)
        await #expect(throws: CocoaError.self) { try await service.perform(.selectClaw(Discovery.studio)) }
        #expect(await http.bearers == ["fixture-id-token", "ds_fixture"])
        await model.perform(.signIn)?.value
        #expect(attempts == [false, true, true])
        model.cancel()
    }

    @Test func `a code that is not a recovery kit installs nothing`() async throws {
        let http = Discovery()
        var installed = false
        var environment = Self.environment(http: http)
        environment.install = { _, _ in installed = true }
        let service = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        _ = try await service.perform(.signIn)
        _ = try await service.perform(.selectClaw(Discovery.studio))
        #expect(try await service.perform(.useRecoveryKit) == .recoveryKitEntry(claw: "studio-k7x2q.crabd.me"))
        #expect(try await service.perform(.submitRecoveryKit("not a kit")) == .problem(.kitInvalid(
            claw: "studio-k7x2q.crabd.me")))
        #expect(!installed)
        #expect(await http.mailboxPosts == 0)
    }

    @Test func `the model waits for approval on its own and finishes the join`() async {
        let service = ApprovalService()
        var joined: [String] = []
        let model = OnboardingOpenClawIDModel(service: service, onJoined: { joined.append($0) })
        await model.begin(.connect)?.value
        await model.perform(.approveFromDevice)?.value
        #expect(model.step.isAwaitingApproval)
        #expect(!model.busy)
        for _ in 0..<50 where !service.waiting {
            await Task.yield()
        }
        service.approve()
        for _ in 0..<50 where joined.isEmpty {
            await Task.yield()
        }
        #expect(joined == ["studio-fixture"])
        #expect(model.step == .ownerConnected(claw: "studio-fixture", device: "Fixture Mac", approvedWith: "Approved"))
    }

    @Test func `switching to the recovery kit cancels the approval wait`() async {
        let service = ApprovalService()
        var joined: [String] = []
        let model = OnboardingOpenClawIDModel(service: service, onJoined: { joined.append($0) })
        await model.begin(.connect)?.value
        await model.perform(.approveFromDevice)?.value
        for _ in 0..<50 where !service.waiting {
            await Task.yield()
        }
        await model.perform(.useRecoveryKit)?.value
        #expect(model.step == .recoveryKitEntry(claw: "studio-fixture"))
        service.approve()
        for _ in 0..<20 {
            await Task.yield()
        }
        #expect(joined.isEmpty)
        #expect(model.step == .recoveryKitEntry(claw: "studio-fixture"))
    }

    @Test func `failed join completion retries without enrolling again`() async {
        let service = ApprovalService()
        var attempts = 0
        let model = OnboardingOpenClawIDModel(service: service, onJoined: { _ in
            attempts += 1
            if attempts == 1 { throw PrimaryGatewayControlError.persistenceFailed }
        })
        await model.perform(.submitRecoveryKit("fixture"))?.value
        #expect(model.error != nil)
        #expect(attempts == 1)
        await model.perform(.retry)?.value
        #expect(model.error == nil)
        #expect(attempts == 2)
        #expect(service.enrollments == 1)
    }

    @Test func `settings retries stored enrollment after the sign in sheet is gone`() async throws {
        let suite = "ocid-migration-retry-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: Self.database())
        let device = MacOpenClawIDDevice(
            hostname: "studio.example.test", clawID: Discovery.studio,
            discoveryOrigin: Self.configuration.discoveryOrigin, deviceEnrollmentID: UUID(),
            nodeEnrollmentID: UUID(), approvedWith: .device)
        store.save(device)
        var joined: [String] = []
        let model = OpenClawIDSettingsModel(store: store, completeJoin: { joined.append($0) })
        await model.retryPrimarySelection()?.value
        #expect(joined == [device.hostname])
        #expect(store.load() == device)
        #expect(model.error == nil)
    }

    @Test func `cancel after kit enrollment commit never installs the device`() async throws {
        let http = Discovery()
        let committed = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        let trust = CommittedTrust(committed: committed.continuation, release: release.stream)
        var environment = Self.environment(http: http)
        environment.keyStore = { _, purpose in
            MemoryKey(seed: Data(repeating: purpose == .device ? 1 : (purpose == .devicePeer ? 2 : 3), count: 32))
        }
        environment.trustStore = { _, _ in trust }
        var installed = false
        environment.install = { _, _ in installed = true }
        let service = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        _ = try await service.perform(.signIn)
        _ = try await service.perform(.selectClaw(Discovery.studio))
        let task = Task { try await service.perform(.submitRecoveryKit(Self.kitText())) }
        for await _ in committed.stream {
            break
        }
        task.cancel()
        release.continuation.yield(())
        release.continuation.finish()
        await #expect(throws: CancellationError.self) { try await task.value }
        #expect(!installed)
        #expect(await trust.commits == 2)
    }

    private actor CommittedTrust: OpenClawIDNodeTrustStore {
        let committed: AsyncStream<Void>.Continuation
        let release: AsyncStream<Void>
        private(set) var commits = 0

        init(committed: AsyncStream<Void>.Continuation, release: AsyncStream<Void>) {
            self.committed = committed
            self.release = release
        }

        func load(hostname _: String) -> OpenClawIDNodeTrustState? {
            nil
        }

        func observe(hostname _: String, state _: OpenClawIDNodeTrustState) {}
        func commit(_: OpenClawIDNodeTrustTarget) async {
            self.commits += 1
            if self.commits == 2 {
                self.committed.yield(())
                for await _ in self.release {
                    break
                }
            }
        }
    }

    private nonisolated static func kitText() -> String {
        let body = Data([1]) + Data(repeating: 7, count: 16)
        let bytes = body + Data(SHA256.hash(data: body).prefix(2))
        let alphabet = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")
        var result = "OCK1-"
        var buffer = 0
        var bits = 0
        for byte in bytes {
            buffer = (buffer << 8) | Int(byte)
            bits += 8
            while bits >= 5 {
                bits -= 5
                result.append(alphabet[(buffer >> bits) & 31])
            }
            buffer &= (1 << bits) - 1
        }
        if bits > 0 { result.append(alphabet[(buffer << (5 - bits)) & 31]) }
        return result
    }

    // MARK: helpers

    private static func database() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("ocid-\(UUID().uuidString).sqlite")
    }

    private static func nodeInvitations() -> OnboardingNodeInvitationService {
        OnboardingNodeInvitationService(
            databaseURL: self.database(),
            readInvitation: { throw CocoaError(.featureUnsupported) },
            describeNode: { throw CocoaError(.featureUnsupported) },
            install: { _ in },
            isConnected: { _ in false })
    }

    private static func environment(http: Discovery) -> OnboardingOpenClawIDSignInEnvironment {
        OnboardingOpenClawIDSignInEnvironment(
            signIn: { _ in "fixture-id-token" },
            discovery: { _ in http },
            describeNode: {
                try OpenClawIDNodeEnrollmentDescription(
                    displayName: "Fixture Mac", platform: "macos", commands: ["system.run"], caps: [])
            },
            deviceName: { "Fixture Mac" },
            keyStore: { _, _ in MemoryKey() },
            readKitFile: { nil },
            install: { _, _ in Issue.record("nothing in these tests is admitted") })
    }

    private struct MemoryKey: OpenClawIDNodeIdentityStore {
        var seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
        func loadOrCreateSeed() async throws -> Data {
            self.seed
        }
    }

    /// Discovery's account endpoints with fixture claws; mail and descriptors are never reached.
    private actor Discovery: OpenClawIDNodeEnrollmentHTTP {
        static let studio = "0123456789abcdef0123456789abcdef"
        static let lab = "1123456789abcdef0123456789abcdef"
        static let team = "2123456789abcdef0123456789abcdef"
        private let claws: Data
        private(set) var bearers: [String] = []
        private(set) var mailboxPosts = 0
        private var admitted = false

        init(empty: Bool = false) {
            let claws: [[String: Any]] = empty ? [] : [
                ["claw_id": Self.studio, "hostname": "studio-k7x2q.crabd.me", "relationship": "owner", "online": true],
                ["claw_id": Self.lab, "hostname": "lab-k7x2q.crabd.me", "relationship": "owner", "online": false],
                [
                    "claw_id": Self.team, "hostname": "team-k7x2q.crabd.me", "relationship": "member",
                    "role": "operator", "online": true,
                ],
            ]
            self.claws = (try? JSONSerialization.data(withJSONObject: ["claws": claws])) ?? Data()
        }

        func send(_ request: URLRequest) throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            let bearer = request.value(forHTTPHeaderField: "authorization")?.replacingOccurrences(
                of: "Bearer ",
                with: "")
            if let bearer, self.bearers.last != bearer { self.bearers.append(bearer) }
            let json = { (value: Any) in
                OpenClawIDNodeEnrollmentHTTPResponse(
                    status: 200, body: (try? JSONSerialization.data(withJSONObject: value)) ?? Data())
            }
            switch (request.httpMethod ?? "GET", request.url?.path ?? "") {
            case ("POST", "/v1/sessions"):
                return json([
                    "session": "ds_fixture", "account_id": "acct_fixture", "email": "owner@example.test",
                    "expires_at": 9_999_999_999,
                ])
            case ("GET", "/v1/claws"): return .init(status: 200, body: self.claws)
            case ("POST", "/v1/devices"): return json([:])
            case let ("GET", path) where path.hasSuffix("/descriptor"):
                return try self.trustResponse(descriptor: true)
            case let ("GET", path) where path.hasSuffix("/snapshot"):
                return try self.trustResponse(descriptor: false)
            case let ("POST", path) where path.hasSuffix("/mailbox"):
                self.admitted = true
                self.mailboxPosts += 1
                return json([:])
            default: return .init(status: 404, body: Data())
            }
        }

        private func trustResponse(descriptor: Bool) throws -> OpenClawIDNodeEnrollmentHTTPResponse {
            let root = try OpenClawIDRecoveryKit.root(OnboardingOpenClawIDSignInTests.kitText())
            let gateway = try OpenClawIDNodeIdentity(seed: Data(repeating: 4, count: 32))
            let device = try OpenClawIDNodeIdentity(seed: Data(repeating: 1, count: 32))
            let peer = try OpenClawIDNodeIdentity(seed: Data(repeating: 2, count: 32))
            let node = try OpenClawIDNodeIdentity(seed: Data(repeating: 3, count: 32))
            let now = Int64(Date().timeIntervalSince1970)
            let binding = try OpenClawIDStatement.sign("ServerBinding", body: .object([
                "claw_id": .string(Self.studio), "hostname": .string("studio-k7x2q.crabd.me"),
                "k_srv": .string(gateway.peerKey), "k_gw": .string(gateway.signingKey),
                "binding_seq": .integer(1), "root_epoch": .integer(1), "issued_at": .integer(now),
            ]), signer: root)
            let value: OpenClawIDCanonicalJSON
            if descriptor {
                value = .object(["descriptor": .object([
                    "v": .integer(1), "claw_id": .string(Self.studio), "transport": .string("iroh"),
                    "relay_url": .string("https://relay.example.test"), "root_pub": .string(root.signingKey),
                    "binding": binding, "published_at": .integer(now),
                ])])
            } else {
                let snapshot = try OpenClawIDStatement.sign("MembershipSnapshot", body: .object([
                    "claw_id": .string(Self.studio), "seq": .integer(self.admitted ? 2 : 1),
                    "binding_seq": .integer(1), "issued_at": .integer(now),
                    "owner_devices": .array(self.admitted ? [.object([
                        "device_pub": .string(device.signingKey), "caps": .array([]),
                    ])] : []),
                    "owner_peer_keys": .array(self.admitted ? [.string(peer.peerKey)] : []),
                    "node_peer_keys": .array(self.admitted ? [.string(node.peerKey)] : []),
                    "members": .array([]),
                    "protocols": .object(["statement": .array([.integer(1)]), "descriptor": .array([.integer(1)])]),
                ]), signer: gateway)
                value = .object(["snapshot": snapshot])
            }
            return .init(status: 200, body: value.encoded)
        }
    }

    /// Plays the service side of the approval wait: the code first, then the decision on demand.
    @MainActor
    private final class ApprovalService: OnboardingOpenClawIDService {
        let unavailableReason: String? = nil
        var enrollments = 0
        private var decision: CheckedContinuation<OnboardingOpenClawIDStep, Error>?
        var waiting: Bool {
            self.decision != nil
        }

        func approve() {
            self.decision?.resume(returning: .ownerConnected(
                claw: "studio-fixture", device: "Fixture Mac", approvedWith: "Approved"))
            self.decision = nil
        }

        func start(_: OnboardingOpenClawIDIntent) async throws -> OnboardingOpenClawIDStep {
            .signIn
        }

        func perform(_ action: OnboardingOpenClawIDAction) async throws -> OnboardingOpenClawIDStep {
            switch action {
            case .submitRecoveryKit:
                self.enrollments += 1
                return .ownerConnected(claw: "studio-fixture", device: "Fixture Mac", approvedWith: "Approved")
            case .approveFromDevice:
                return .ownerCompareCode(
                    claw: "studio-fixture",
                    device: "Fixture Mac",
                    code: "123 456",
                    approvalURL: nil,
                    confirmed: false)
            case .checkApproval:
                return try await withCheckedThrowingContinuation { self.decision = $0 }
            case .useRecoveryKit:
                return .recoveryKitEntry(claw: "studio-fixture")
            default:
                throw CocoaError(.featureUnsupported)
            }
        }

        func cancel() {}
    }
}
