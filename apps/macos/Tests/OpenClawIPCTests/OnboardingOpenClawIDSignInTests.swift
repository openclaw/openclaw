import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

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
        environment.signIn = { throw MacOpenClawIDSignInError.cancelled }
        let cancelled = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        #expect(try await cancelled.perform(.signIn) == .signIn)
        environment.signIn = { throw MacOpenClawIDSignInError.stateMismatch }
        let failed = OnboardingOpenClawIDSignInService(
            configuration: Self.configuration, databaseURL: Self.database(), nodeInvitations: Self.nodeInvitations(),
            environment: environment)
        #expect(try await failed.perform(.signIn) == .problem(.signInFailed))
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
            signIn: { "fixture-id-token" },
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
        let seed = Data((0..<32).map { _ in UInt8.random(in: 0...255) })
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
            case let ("POST", path) where path.hasSuffix("/mailbox"):
                self.mailboxPosts += 1
                return json([:])
            default: return .init(status: 404, body: Data())
            }
        }
    }

    /// Plays the service side of the approval wait: the code first, then the decision on demand.
    @MainActor
    private final class ApprovalService: OnboardingOpenClawIDService {
        let unavailableReason: String? = nil
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
