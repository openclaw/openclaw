import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
struct LobbyTests {
    @Test func `component conversations create empty independent histories using the Gateway reference`() async throws {
        let parent = "agent:main:lobby-11111111-1111-4111-8111-111111111111"
        var keys: [String] = []
        for name in ["plan", "report"] {
            let key = "\(parent):component:\(name):\(String(repeating: name == "plan" ? "a" : "b", count: 32))"
            var calls: [(String, [String: AnyCodable])] = []
            let reference = try await LobbyComponentConversationPreparation.prepare(
                parentKey: parent, agentID: "main", selection: .init(name: name, instanceID: "current-frame"),
                request: { method, params in
                    calls.append((method, params))
                    if method == "board.widget.conversation" {
                        return try JSONSerialization.data(withJSONObject: ["key": key, "title": name])
                    }
                    return try JSONEncoder().encode(OpenClawChatCreateSessionResponse(
                        ok: true,
                        key: key,
                        sessionId: name))
                }, isCurrent: { true })
            #expect(calls.map(\.0) == ["board.widget.conversation", "sessions.create"])
            #expect(calls[1].1["parentSessionKey"]?.value as? String == parent)
            #expect(calls[1].1["fork"]?.value as? Bool == false)
            #expect(calls[1].1["task"] == nil)
            #expect(calls[1].1["message"] == nil)
            #expect(reference.key == key)
            keys.append(reference.key)
        }
        #expect(keys[0] != keys[1])
    }

    @Test func `component reference cannot cross a Gateway change or select another component`() async throws {
        let parent = "agent:main:lobby-11111111-1111-4111-8111-111111111111"
        for changeAuthority in [true, false] {
            var current = true
            var calls: [String] = []
            do {
                _ = try await LobbyComponentConversationPreparation.prepare(
                    parentKey: parent, agentID: "main", selection: .init(name: "plan", instanceID: "frame"),
                    request: { method, _ in
                        calls.append(method)
                        if changeAuthority { current = false }
                        return try JSONSerialization.data(withJSONObject: [
                            "key": "\(parent):component:other:\(String(repeating: "a", count: 32))", "title": "Other",
                        ])
                    }, isCurrent: { current })
                Issue.record("Changed authority or a different component must be rejected")
            } catch {
                #expect(calls == ["board.widget.conversation"])
            }
        }
    }

    @Test func `component prompt cannot consume an unsent attachment or text draft`() {
        let app = NodeAppModel(audioAdmissionInitiallyAllowed: false)
        let transport = IOSGatewayChatTransport(gateway: app.operatorSession, globalAgentId: "main")
        let viewModel = OpenClawChatViewModel(sessionKey: "agent:main:lobby-fixture", transport: transport)
        let attachment = OpenClawPendingAttachment(
            url: nil, data: Data("private draft".utf8), fileName: "draft.txt", mimeType: "text/plain", preview: nil)
        viewModel.attachments = [attachment]
        #expect(!LobbyModel.sendComponentPrompt("Compare plans", to: viewModel))
        #expect(viewModel.input.isEmpty)
        #expect(viewModel.attachments.map(\.id) == [attachment.id])
        #expect(!viewModel.isSubmittingDraft)
        viewModel.attachments = []
        viewModel.input = "Unsent authoring request"
        #expect(!LobbyModel.sendComponentPrompt("Compare plans", to: viewModel))
        #expect(viewModel.input == "Unsent authoring request")
        #expect(!viewModel.isSubmittingDraft)
    }

    private func withStore(_ body: (LobbySessionReferenceStore) throws -> Void) throws {
        let name = "LobbyTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: name))
        defer { defaults.removePersistentDomain(forName: name) }
        try body(LobbySessionReferenceStore(defaults: defaults))
    }

    @Test func `opening an empty Lobby does not reserve a session`() throws {
        try self.withStore { store in
            #expect(store.existing(scope: "gateway-a") == nil)
            #expect(!store.isConfirmed(scope: "gateway-a"))
        }
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw", "--openclaw-initial-tab", "lobby"]) == .lobby)
        #expect(RootTabs.initialDestination(arguments: ["OpenClaw"]) == .chat)
    }

    @Test func `reserved conversation survives retry and relaunch without changing its agent`() throws {
        try self.withStore { store in
            let id = try #require(UUID(uuidString: "7DD38AE0-CA9B-4F82-9F8A-A1F52D88BCC1"))
            let key = store.reserve(scope: "gateway-a", agentID: "research", makeID: { id })
            #expect(key == "agent:research:lobby-7dd38ae0-ca9b-4f82-9f8a-a1f52d88bcc1")
            #expect(!store.isConfirmed(scope: "gateway-a"))
            let relaunched = LobbySessionReferenceStore(defaults: store.defaults)
            #expect(relaunched.reserve(scope: "gateway-a", agentID: "another") == key)
            store.confirm(scope: "gateway-a")
            #expect(relaunched.isConfirmed(scope: "gateway-a"))
            #expect(relaunched.existing(scope: "gateway-b") == nil)
        }
    }

    @Test func `Gateway and authenticated context isolate local references`() {
        let first = LobbySessionReferenceStore.scope(
            gatewayID: "gateway-a", principal: nil, credential: "first", deviceProfile: "operator")
        let gateway = LobbySessionReferenceStore.scope(
            gatewayID: "gateway-b", principal: nil, credential: "first", deviceProfile: "operator")
        let credential = LobbySessionReferenceStore.scope(
            gatewayID: "gateway-a", principal: nil, credential: "second", deviceProfile: "operator")
        #expect(first != gateway)
        #expect(first != credential)
        #expect(!first.contains("first"))
        let verified = LobbySessionReferenceStore.scope(
            gatewayID: "gateway-a", principal: "verified-subject", credential: "old", deviceProfile: "operator")
        let renewed = LobbySessionReferenceStore.scope(
            gatewayID: "gateway-a", principal: "verified-subject", credential: "new", deviceProfile: "operator")
        #expect(verified == renewed)
    }

    @Test func `first send prepares only its explicit private dashboard conversation`() async throws {
        let key = "agent:research:lobby-unique"
        var calls: [(String, [String: AnyCodable])] = []
        try await LobbySessionPreparation.prepare(
            key: key,
            agentID: "research",
            request: { method, params in
                calls.append((method, params))
                return try JSONEncoder().encode(OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: "own"))
            },
            isCurrent: { true })
        #expect(calls.map(\.0) == ["sessions.create", "sessions.patch"])
        #expect(calls.allSatisfy { $0.1["key"]?.value as? String == key })
        // Decode the captured request against the generated Gateway contract, including its visibility enum.
        let creation = try JSONDecoder().decode(
            SessionsCreateParams.self,
            from: JSONEncoder().encode(calls[0].1))
        #expect(creation.agentid == "research")
        #expect(creation.visibility == .draft)
        #expect(creation.task == nil)
        #expect(creation.message == nil)
        #expect(calls[1].1["boardFace"]?.value as? String == "dashboard")
        #expect(calls[1].1["boardPresentation"]?.value as? String == "expanded")
    }

    @Test func `changed authority does not publish presentation after session creation`() async throws {
        var current = true
        var methods: [String] = []
        do {
            try await LobbySessionPreparation.prepare(
                key: "agent:main:lobby-unique",
                agentID: "main",
                request: { method, _ in
                    methods.append(method)
                    current = false
                    return Data(#"{"key":"agent:main:lobby-unique"}"#.utf8)
                },
                isCurrent: { current })
            Issue.record("A changed connection must cancel preparation")
        } catch is CancellationError {
            #expect(methods == ["sessions.create"])
        }
    }

    @Test func `a different returned session cannot become the Lobby`() async throws {
        var methods: [String] = []
        do {
            try await LobbySessionPreparation.prepare(
                key: "agent:main:lobby-unique",
                agentID: "main",
                request: { method, _ in
                    methods.append(method)
                    return Data(#"{"key":"agent:main:main"}"#.utf8)
                },
                isCurrent: { true })
            Issue.record("Unexpected session must be rejected")
        } catch {
            #expect(methods == ["sessions.create"])
        }
    }
}
