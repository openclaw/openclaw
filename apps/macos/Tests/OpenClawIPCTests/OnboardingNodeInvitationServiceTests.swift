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
    func `unpackaged invitation entry does not request enrollment`() {
        let service = OnboardingNodeInvitationService(
            databaseURL: URL(fileURLWithPath: "/unused-node-enrollment.sqlite"),
            unavailableReason: "Native transport is not packaged.",
            describeNode: {
                Issue.record("Unavailable enrollment must not prepare node capabilities")
                throw CocoaError(.featureUnsupported)
            },
            install: { _ in
                Issue.record("Unavailable enrollment must not install a node")
                return false
            })
        let model = OnboardingOpenClawIDModel(service: service)
        #expect(model.begin(.joinNode) == nil)
        #expect(model.step == .nodeInvitation)
        #expect(model.perform(.submitNodeInvitation(text: "openclaw-node://join#x", discoveryOrigin: "")) == nil)
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

    @Test
    func `pasted text accepts the bare link or the owner's full command`() throws {
        let link = "openclaw-node://join#i=a.b&c=c"
        let bare = try OnboardingNodeInvitationInput(" \(link)\n")
        #expect(bare.link == link && bare.discoveryOrigin == nil)
        let command = "npx -y 'openclaw@2026.11.5' node join '\(link)' --discovery-url 'https://d.example' --service"
        let full = try OnboardingNodeInvitationInput(command)
        #expect(full.link == link && full.discoveryOrigin == "https://d.example")
        #expect(try OnboardingNodeInvitationInput("openclaw node join \(link) --discovery=https://d.example")
            .discoveryOrigin == "https://d.example")
        #expect(throws: OpenClawIDNodeInvitationInputError.self) {
            try OnboardingNodeInvitationInput("openclaw node join --service")
        }
    }

    @Test(arguments: [false, true])
    func `one owner approval installs node and chat once, and cancellation rejects a late descriptor`(
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
        let operatorSeed = Data(repeating: 9, count: 32)
        let service = OnboardingNodeInvitationService(
            databaseURL: database,
            describeNode: {
                try OpenClawIDNodeEnrollmentDescription(
                    displayName: "Build node", platform: "linux", commands: ["system.run"], caps: ["system"])
            },
            identityStore: { _ in FixtureIdentity(seed: seed) },
            operatorIdentityStore: { _ in FixtureIdentity(seed: operatorSeed) },
            http: http,
            now: { fixture.now },
            install: {
                installed.append($0)
                return true
            })
        let model = OnboardingOpenClawIDModel(service: service)
        #expect(model.accountUnavailableReason != nil)
        await model.begin(.joinNode)?.value
        #expect(model.step == .nodeInvitation)
        // The owner's full command is pasted; its Discovery origin needs no separate entry.
        await model.perform(.submitNodeInvitation(
            text: "openclaw node join '\(fixture.node_invite.link)' --discovery-url https://discovery.example",
            discoveryOrigin: ""))?.value
        await model.perform(.requestNode)?.value
        let hostname = try OpenClawIDNodeEnrollmentLink(fixture.node_invite.link).hostname
        guard case let .compareCode(claw, device, code, _) = model.step else {
            Issue.record("expected the comparison code, got \(model.step)")
            return
        }
        #expect(claw == hostname && device == "Build node")
        // The code covers the requested chat key, so it differs from the node-only vector.
        #expect(code.count == 6 && code != "168017")
        // Approval is detected without a click: the model is already waiting on the descriptor.
        await http.waitForDescriptor()
        #expect(model.busy)
        #expect(installed.isEmpty)
        if cancel { model.cancel() }
        await http.release()
        while model.busy { await Task.yield() }
        #expect(installed.count == (cancel ? 0 : 1))
        if cancel {
            #expect(model.step == .signIn)
            #expect(model.error == nil)
        } else {
            #expect(model.step == .connected(claw: hostname))
            #expect(installed.count == 1)
            model.cancel()
        }
        let store = OpenClawIDNodeNativeTrustStore(
            databaseURL: database, enrollmentID: installed.first?.enrollmentID ?? UUID(), assertCurrent: {})
        let saved = try await store.savedEnrollment(hostname: hostname)
        #expect((saved != nil) == !cancel)
        if let selected = installed.first { #expect(saved?.enrollmentID == selected.enrollmentID) }
        await store.close()
        #expect(await http.requestCount == 2)
        #expect(await http.redemptionCarriesOperatorKey)
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
    private(set) var redemptionCarriesOperatorKey = false

    init(response: Data) {
        self.response = response
    }

    func send(_ request: URLRequest) async throws -> OpenClawIDNodeEnrollmentHTTPResponse {
        self.requestCount += 1
        self.usedBearer = self.usedBearer || request.value(forHTTPHeaderField: "Authorization") != nil
        if request.httpMethod == "POST" {
            let body = request.httpBody.flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] }
            let redemption = (body?["payload"] as? [String: Any])?["redemption"] as? [String: Any]
            self.redemptionCarriesOperatorKey =
                ((redemption?["body"] as? [String: Any])?["operator_peer_key"] as? String)?.hasPrefix("iroh:") == true
            return .init(status: 202, body: Data("{}".utf8))
        }
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
