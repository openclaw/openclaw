import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct OnboardingNodeInvitationServiceTests {
    @Test
    func `production invitation availability follows native packaging`() async {
        let service = OnboardingNodeInvitationService()
        let model = OnboardingOpenClawIDModel(service: service)
        #expect((model.unavailableReason == nil) == OpenClawIDNodeNativeEndpoint.isPackaged)
        let start = model.begin(.joinNode)
        #expect((start != nil) == OpenClawIDNodeNativeEndpoint.isPackaged)
        await start?.value
        #expect(model.step == .nodeInvitation)
        model.cancel()
    }

    @Test
    func `unpackaged invitation entry does not read clipboard or request enrollment`() {
        let service = OnboardingNodeInvitationService(
            databaseURL: URL(fileURLWithPath: "/unused-node-enrollment.sqlite"),
            unavailableReason: "Native transport is not packaged.",
            readInvitation: {
                Issue.record("Unavailable enrollment must not read the clipboard")
                throw CocoaError(.featureUnsupported)
            },
            describeNode: {
                Issue.record("Unavailable enrollment must not prepare node capabilities")
                throw CocoaError(.featureUnsupported)
            },
            install: { _ in Issue.record("Unavailable enrollment must not install a node") },
            isConnected: { _ in false })
        let model = OnboardingOpenClawIDModel(service: service)
        #expect(model.begin(.joinNode) == nil)
        #expect(model.step == .nodeInvitation)
        #expect(model.perform(.pasteNodeInvitation(discoveryOrigin: "https://discovery.example")) == nil)
        #expect(model.perform(.requestNode) == nil)
        #expect(model.error == nil)
    }

    private struct Fixture: Decodable {
        struct Invite: Decodable { let link: String }
        struct Key: Decodable { let seed_hex: String }
        let now: Int64
        let node_invite: Invite
        let node_key: Key
    }

    @Test(arguments: [false, true])
    func `owner-approved invitation installs once and cancellation rejects a late descriptor`(
        cancel: Bool) async throws
    {
        let fixtureURL = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent().deletingLastPathComponent()
            .deletingLastPathComponent().deletingLastPathComponent()
            .appendingPathComponent("shared/OpenClawKit/Tests/OpenClawKitTests/Fixtures/OpenClawIDNodeEnrollment.json")
        let bytes = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(Fixture.self, from: bytes)
        let json = try #require(try JSONSerialization.jsonObject(with: bytes) as? [String: Any])
        let response = try JSONSerialization.data(withJSONObject: #require(json["response"]))
        let hex = Array(fixture.node_key.seed_hex)
        let seed = Data(stride(from: 0, to: hex.count, by: 2).compactMap {
            UInt8(String(hex[$0...($0 + 1)]), radix: 16)
        })
        #expect(seed.count == 32)
        let root = try URL(fileURLWithPath: #require(ProcessInfo.processInfo.environment["TMPDIR"]))
            .appendingPathComponent("node-invitation-\(UUID().uuidString)")
        try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: root) }
        let database = root.appendingPathComponent("node.sqlite")
        let http = DescriptorGate(response: response)
        var installed: [MacNodeOpenClawIDTarget] = []
        var connected = false
        let service = OnboardingNodeInvitationService(
            databaseURL: database,
            readInvitation: { fixture.node_invite.link },
            describeNode: {
                try OpenClawIDNodeEnrollmentDescription(
                    displayName: "Build node", platform: "linux", commands: ["system.run"], caps: ["system"])
            },
            identityStore: { _ in FixtureIdentity(seed: seed) },
            http: http,
            now: { fixture.now },
            install: { installed.append($0) },
            isConnected: { _ in connected })
        let model = OnboardingOpenClawIDModel(service: service)
        #expect(model.accountUnavailableReason != nil)
        await model.begin(.joinNode)?.value
        #expect(model.step == .nodeInvitation)
        await model.perform(.pasteNodeInvitation(discoveryOrigin: "https://discovery.example"))?.value
        await model.perform(.requestNode)?.value
        let hostname = try OpenClawIDNodeEnrollmentLink(fixture.node_invite.link).hostname
        try #require(model.step == .compareCode(claw: hostname, device: "Build node", code: "168017", approvalURL: nil))
        await http.waitForDescriptor()
        #expect(installed.isEmpty)
        let approval = model.perform(.checkApproval)
        if cancel { model.cancel() }
        await http.release()
        await approval?.value
        #expect(installed.count == (cancel ? 0 : 1))
        if cancel {
            #expect(model.step == .signIn)
            #expect(model.error == nil)
        } else {
            #expect(model.step == .nodeConnection(claw: hostname, connected: false))
            connected = true
            await model.perform(.checkApproval)?.value
            #expect(model.step == .nodeConnection(claw: hostname, connected: true))
            #expect(installed.count == 1)
            await model.perform(.requestChat)?.value
            #expect(model.error != nil)
            #expect(model.step == .nodeConnection(claw: hostname, connected: true))
            model.cancel()
        }
        let store = OpenClawIDNodeNativeTrustStore(
            databaseURL: database, enrollmentID: installed.first?.enrollmentID ?? UUID(), assertCurrent: {})
        let saved = try await store.savedEnrollment(hostname: hostname)
        #expect((saved != nil) == !cancel)
        if let selected = installed.first { #expect(saved?.enrollmentID == selected.enrollmentID) }
        await store.close()
        #expect(await http.requestCount == 2)
        #expect(await http.usedBearer == false)
    }
}

private struct FixtureIdentity: OpenClawIDNodeIdentityStore {
    let seed: Data
    func loadOrCreateSeed() async throws -> Data {
        self.seed
    }
}

private actor DescriptorGate: OpenClawIDNodeEnrollmentHTTP {
    let response: Data
    private var pending: CheckedContinuation<OpenClawIDNodeEnrollmentHTTPResponse, Never>?
    private var started: CheckedContinuation<Void, Never>?
    private(set) var requestCount = 0
    private(set) var usedBearer = false

    init(response: Data) {
        self.response = response
    }

    func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
        self.requestCount += 1
        self.usedBearer = self.usedBearer || request.value(forHTTPHeaderField: "Authorization") != nil
        if request.httpMethod == "POST" { return .init(status: 202, body: Data("{}".utf8)) }
        return await withCheckedContinuation {
            self.pending = $0
            self.started?.resume()
            self.started = nil
        }
    }

    func waitForDescriptor() async {
        if self.pending != nil { return }
        await withCheckedContinuation { self.started = $0 }
    }

    func release() {
        self.pending?.resume(returning: .init(status: 200, body: self.response))
        self.pending = nil
    }
}
