import AppKit
import OpenClawChatUI
import OpenClawProtocol
import SwiftUI

private actor SidebarFixtureTransport: OpenClawChatTransport {
    let stream: AsyncStream<OpenClawChatTransportEvent>
    private let continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation
    let startedAt: Int
    private var questionRecords: [QuestionRecord]

    init() {
        (self.stream, self.continuation) = AsyncStream.makeStream()
        let startedAt = Int(Date().timeIntervalSince1970 * 1000)
        self.startedAt = startedAt
        self.questionRecords = [
            Self.question(
                id: "question-oldest", text: "Which launch headline should we use?", age: 30000, startedAt: startedAt),
            Self.question(
                id: "question-next", text: "Should the preview include the pricing section?",
                age: 20000, startedAt: startedAt),
        ]
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        self.stream
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    func gatewayAdvertisesMethod(_: String) async -> Bool? {
        true
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        .init(
            sessionKey: sessionKey, sessionId: "synthetic-conversation", messages: [], thinkingLevel: nil)
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw URLError(.unsupportedURL)
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        .init(defaultId: "main", agents: [
            .init(id: "main", name: "Assistant", emoji: "🦞"),
            .init(id: "research", name: "Research", emoji: "🔎"),
        ])
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        [.init(
            modelID: "assistant",
            name: "Assistant",
            provider: "fixture",
            available: true,
            manualSelectionAllowed: true,
            contextWindow: 128_000)]
    }

    func loadModelCatalog(
        sessionKey _: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        try await .init(choices: self.listModels(agentID: agentID), availabilityIsSessionScoped: true)
    }

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("""
        {"defaults":{"modelProvider":"fixture","model":"assistant","contextTokens":128000,
                     "modelSelectionTarget":"session"},"sessions":[
          {"key":"agent:main:main","agentId":"main","displayName":"Today","updatedAt":\(self.startedAt)},
          {"key":"agent:main:site","agentId":"main","displayName":"Website refresh","category":"Projects",
           "updatedAt":\(self.startedAt - 60000),"childSessions":["agent:main:copy"]},
          {"key":"agent:main:copy","agentId":"main","displayName":"Review launch copy","category":"Projects",
           "parentSessionKey":"agent:main:site","updatedAt":\(self.startedAt - 120_000)},
          {"key":"agent:main:deploy","agentId":"main","displayName":"Preview deployment","category":"Projects",
           "updatedAt":\(self.startedAt - 180_000)},
          {"key":"agent:research:main","agentId":"research","displayName":"Source review",
           "updatedAt":\(self.startedAt - 240_000)}
        ]}
        """.utf8))
    }

    func listSessionGroups() async throws -> OpenClawChatSessionGroupsResponse? {
        try JSONDecoder().decode(
            OpenClawChatSessionGroupsResponse.self,
            from: Data(#"{"groups":[{"name":"Projects","position":0}]}"#.utf8))
    }

    func listQuestions() async throws -> [QuestionRecord] {
        self.questionRecords.filter { $0.status == .pending }
    }

    func getQuestion(id: String) async throws -> QuestionRecord {
        guard let record = self.questionRecords.first(where: { $0.id == id }) else {
            throw URLError(.resourceUnavailable)
        }
        return record
    }

    func resolveQuestion(
        id: String,
        answers: [String: [String]],
        secretStoreAllowedHosts _: [String]?) async throws -> QuestionAnswers
    {
        guard let index = self.questionRecords.firstIndex(where: { $0.id == id }) else {
            throw URLError(.resourceUnavailable)
        }
        let record = self.questionRecords[index]
        if let answered = record.answers { return answered }
        let answered = QuestionAnswers(answers: answers.mapValues { AnyCodable($0) })
        self.questionRecords[index] = QuestionRecord(
            id: record.id,
            questions: record.questions,
            agentid: record.agentid,
            sessionkey: record.sessionkey,
            createdatms: record.createdatms,
            expiresatms: record.expiresatms,
            status: .answered,
            answers: answered)
        self.continuation.yield(.questionResolved(.init(id: record.id, status: .answered, answers: answered)))
        return answered
    }

    private static func question(id: String, text: String, age: Int, startedAt: Int) -> QuestionRecord {
        .init(
            id: id,
            questions: [.init(
                questionid: "choice", header: "Launch review", question: text,
                options: [.init(label: "First version"), .init(label: "Second version")])],
            agentid: "main", sessionkey: "agent:main:copy",
            createdatms: startedAt - age, expiresatms: startedAt + 3_600_000, status: .pending)
    }
}

@MainActor
private struct SidebarFixtureView: View {
    let transport: SidebarFixtureTransport
    let defaults: UserDefaults
    @State private var viewModel: OpenClawChatViewModel
    #if !ATTENTION_BASELINE
    @State private var approvals: [OpenClawChatAttentionRequest]
    #endif

    init(defaults: UserDefaults) {
        let transport = SidebarFixtureTransport()
        self.transport = transport
        self.defaults = defaults
        _viewModel = State(initialValue: OpenClawChatViewModel(
            sessionKey: "agent:main:main", transport: transport, activeAgentId: "main",
            modelPickerStore: ChatModelPickerStore(defaults: defaults)))
        #if !ATTENTION_BASELINE
        let now = Double(transport.startedAt)
        _approvals = State(initialValue: [
            .init(
                id: "exec-command", kind: .approval, sessionKey: "agent:main:deploy", agentID: "main",
                createdAtMs: now - 50000, expiresAtMs: now + 3_600_000,
                preview: "Run npm run preview to verify the staged site"),
            .init(
                id: "plugin-publish", kind: .approval, sessionKey: "agent:main:deploy", agentID: "main",
                createdAtMs: now - 40000, expiresAtMs: now + 3_600_000,
                preview: "Publish preview\n\nUpload the staged site to the preview environment."),
            .init(
                id: "system-change", kind: .approval, sessionKey: "agent:research:main", agentID: "research",
                createdAtMs: now - 10000, expiresAtMs: now + 3_600_000,
                preview: "Review agent update\n\nApply the proposed research instructions."),
        ])
        #endif
    }

    var body: some View {
        #if ATTENTION_BASELINE
        OpenClawChatWindowShell(viewModel: self.viewModel)
            .defaultAppStorage(self.defaults)
        #else
        OpenClawChatWindowShell(viewModel: self.viewModel, attentionRequests: self.approvals)
            .defaultAppStorage(self.defaults)
            .toolbar {
                ToolbarItemGroup(placement: .automatic) {
                    Button("Resolve oldest question") {
                        Task {
                            _ = try? await self.transport.resolveQuestion(
                                id: "question-oldest", answers: ["choice": ["First version"]],
                                secretStoreAllowedHosts: nil)
                        }
                    }
                    Button("Clear approvals") { self.approvals = [] }
                }
            }
        #endif
    }
}

@main
private struct SidebarAttentionFixture: App {
    private let suite = "ai.openclaw.sidebar-attention-fixture.\(UUID().uuidString)"
    private let defaults: UserDefaults

    init() {
        self.defaults = UserDefaults(suiteName: self.suite)!
        // A private suite keeps disclosure, theme, and model preferences out of the operator's defaults.
        self.defaults.set("Projects", forKey: "openclaw.chat.collapsedSessionGroups")
    }

    var body: some Scene {
        WindowGroup("OpenClaw Sidebar Preview") {
            SidebarFixtureView(defaults: self.defaults)
                .frame(minWidth: 1040, minHeight: 700)
                .onReceive(NotificationCenter.default.publisher(for: NSApplication.willTerminateNotification)) { _ in
                    self.defaults.removePersistentDomain(forName: self.suite)
                }
        }
        .defaultSize(width: 1120, height: 740)
    }
}
