import Foundation
import OpenClawChatUI
import OpenClawProtocol

enum AppleReviewDemoMode {
    static let setupCode = "APPLE-REVIEW-DEMO"
    static let gatewayName = "Apple Review Demo Gateway"
    static let gatewayAddress = "Local demo mode"
    static let gatewayID = "apple-review-demo"

    static func isSetupCode(_ value: String) -> Bool {
        value.trimmingCharacters(in: .whitespacesAndNewlines)
            .localizedCaseInsensitiveCompare(self.setupCode) == .orderedSame
    }
}

enum ScreenshotFixtureMode {
    static var progressBarEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-progress-bar-fixture")
    }

    static var modelSignInScenario: String? {
        let arguments = ProcessInfo.processInfo.arguments
        guard let index = arguments.firstIndex(of: "--openclaw-model-sign-in-fixture"),
              arguments.indices.contains(index + 1)
        else { return nil }
        return arguments[index + 1]
    }

    static let gatewayName = "OpenClaw Gateway"
    static let gatewayAddress = "Gateway on local network"
    static let gatewayID = "screenshot-fixture-gateway"
    static var reactionsEnabled: Bool {
        !ProcessInfo.processInfo.arguments.contains("--openclaw-no-reactions-fixture")
    }

    static var progressCardEnabled: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-progress-card-fixture")
    }
}

struct LocalChatFixture {
    let sessionKey: String
    let defaultAgentID: String
    let sessionIDPrefix: String
    let displayName: String
    let subject: String
    let modelProvider: String
    let modelID: String
    let modelName: String
    let modelSelectionTarget: String
    let additionalModels: [OpenClawChatModelChoice]
    let responsePrefix: String
    let seedMessages: [String]
    let agents: [AgentSummary]

    static let appleReviewDemo = LocalChatFixture(
        sessionKey: "main",
        defaultAgentID: "main",
        sessionIDPrefix: "apple-review-demo",
        displayName: "Apple Review Demo",
        subject: "Gateway review flow",
        modelProvider: "demo",
        modelID: "local-demo",
        modelName: "Apple Review Demo",
        modelSelectionTarget: "session",
        additionalModels: [],
        responsePrefix: "Demo mode is active.",
        seedMessages: [
            """
            Apple Review demo mode is active. This local chat transport lets reviewers inspect the iOS app \
            without a private Gateway.
            """,
        ],
        agents: [
            AgentSummary(
                id: "main",
                name: "Main",
                identity: ["emoji": AnyCodable("OC")],
                workspace: "Apple Review Demo",
                workspacegit: false,
                model: ["provider": AnyCodable("demo"), "model": AnyCodable("local-demo")],
                agentruntime: ["kind": AnyCodable("local")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium"],
                thinkingdefault: "auto"),
        ])

    static let appScreenshots = LocalChatFixture(
        sessionKey: "main",
        defaultAgentID: "main",
        sessionIDPrefix: "screenshot-fixture",
        displayName: "Molty",
        subject: "Mobile command center",
        modelProvider: "openai",
        modelID: "gpt-5.6-sol",
        modelName: "GPT-5.6",
        modelSelectionTarget: "global",
        additionalModels: [
            OpenClawChatModelChoice(
                modelID: "claude-opus-4-1",
                name: "Claude Opus 4.1",
                provider: "anthropic",
                contextWindow: 200_000),
        ],
        responsePrefix: "OpenClaw is connected to your gateway.",
        seedMessages: ProcessInfo.processInfo.arguments.contains("--openclaw-empty-chat-fixture")
            ? []
            : ["Ready when you are. I can check a project, coordinate an agent, or prepare the next step."],
        agents: [
            AgentSummary(
                id: "main",
                name: "Molty",
                identity: ["emoji": AnyCodable("M")],
                workspace: "OpenClaw",
                workspacegit: false,
                model: ["provider": AnyCodable("openai"), "model": AnyCodable("gpt-5.6-sol")],
                agentruntime: ["kind": AnyCodable("gateway")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium", "high"],
                thinkingdefault: "auto"),
            AgentSummary(
                id: "research",
                name: "Research",
                identity: ["emoji": AnyCodable("RS")],
                workspace: "OpenClaw",
                workspacegit: false,
                model: ["provider": AnyCodable("openai"), "model": AnyCodable("gpt-5.6-sol")],
                agentruntime: ["kind": AnyCodable("gateway")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium", "high"],
                thinkingdefault: "medium"),
            AgentSummary(
                id: "automation",
                name: "Automation",
                identity: ["emoji": AnyCodable("AU")],
                workspace: "OpenClaw",
                workspacegit: false,
                model: ["provider": AnyCodable("openai"), "model": AnyCodable("gpt-5.6-sol")],
                agentruntime: ["kind": AnyCodable("gateway")],
                thinkinglevels: nil,
                thinkingoptions: ["auto", "low", "medium", "high"],
                thinkingdefault: "auto"),
        ])
}

struct LocalFixtureChatTransport: OpenClawChatTransport {
    func loadMediaArtifact(
        sessionKey _: String,
        artifactId _: String,
        kind: OpenClawChatMediaKind,
        playback _: OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?
    {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-audit-fixture") else { return nil }
        // swiftlint:disable line_length
        let encoded = kind == .image ?
            "iVBORw0KGgoAAAANSUhEUgAAAoAAAADwCAIAAAAfEkKcAAAGtElEQVR4nO3VQQ2AQAADQbSgA00YwefpwEM/TZNJRsPudX8HGHXeBxh11QsCxOoFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiP2e5OyS3rtABAAAAAElFTkSuQmCC" :
            "UklGRqQMAABXQVZFZm10IBAAAAABAAEAgD4AAAB9AAACABAAZGF0YYAMAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=="
        // swiftlint:enable line_length
        guard let data = Data(base64Encoded: encoded) else { return nil }
        return .data(OpenClawChatMediaData(data: data, mimeType: kind == .image ? "image/png" : "audio/wav"))
    }

    var supportsComposerCapabilities: Bool {
        true
    }

    func loadComposerCapabilityCatalog(
        sessionKey _: String,
        agentID _: String?) async -> OpenClawChatComposerCapabilityCatalog
    {
        OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: true,
            modelMutationAvailable: ScreenshotFixtureMode.modelSignInScenario != "read-only",
            effortMutationAvailable: true,
            webSearchBaseEnabled: true,
            webSearchAvailable: true,
            skills: [
                OpenClawChatComposerSkill(
                    key: "autoreview",
                    name: "Auto Review",
                    baseEnabled: true,
                    missingDependencies: false,
                    blocked: false),
                OpenClawChatComposerSkill(
                    key: "release",
                    name: "Release OpenClaw",
                    baseEnabled: true,
                    missingDependencies: false,
                    blocked: false),
                OpenClawChatComposerSkill(
                    key: "disabled-fixture",
                    name: "Disabled Skill",
                    baseEnabled: false,
                    missingDependencies: false,
                    blocked: false),
            ],
            connectors: [
                OpenClawChatComposerConnector(
                    name: "GitHub",
                    baseEnabled: true,
                    tools: [
                        OpenClawChatComposerTool(name: "search_code", label: "Search code"),
                        OpenClawChatComposerTool(name: "create_issue", label: "Create issue"),
                    ]),
                OpenClawChatComposerConnector(
                    name: "Linear",
                    baseEnabled: true,
                    tools: [
                        OpenClawChatComposerTool(name: "search_issues", label: "Search issues"),
                    ]),
            ],
            skillsAvailable: true,
            connectorsAvailable: true,
            toolAccessAvailable: true,
            permissionMutationAvailable: true,
            toolOverrideMutationAvailable: true,
            canSelectFullPermission: true)
    }

    private let fixture: LocalChatFixture
    private let store: LocalFixtureChatStore
    private let reactionsRouteID = UUID()

    init(fixture: LocalChatFixture) {
        self.fixture = fixture
        self.store = LocalFixtureChatStore(fixture: fixture)
    }

    func createSession(
        key: String,
        label _: String?,
        parentSessionKey _: String?,
        worktree _: Bool?) async throws -> OpenClawChatCreateSessionResponse
    {
        await self.store.createSession(key: key)
    }

    func createSession(
        key: String,
        label _: String?,
        agentID: String?,
        parentSessionKey _: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        let normalizedAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        let requestedAgentID = normalizedAgentID?.isEmpty == false
            ? normalizedAgentID
            : self.fixture.defaultAgentID
        guard self.fixture.agents.contains(where: { $0.id.lowercased() == requestedAgentID }) else {
            throw Self.newSessionOptionsError("The selected fixture agent is unavailable.")
        }
        // Fixtures advertise no Git workspaces. Reject advanced inputs instead
        // of reporting a session that ignored the selected worktree contract.
        guard worktree != true, worktreeBaseRef == nil else {
            throw Self.newSessionOptionsError("Worktree sessions are unavailable in local fixture mode.")
        }
        return await self.store.createSession(key: key)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.store.history(sessionKey: sessionKey)
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? {
        guard ScreenshotFixtureMode.progressCardEnabled,
              ["progressCard.get", "progressCard.refresh"].contains(method)
        else { return nil }
        return true
    }

    func fetchProgressCard(sessionKey: String, agentID _: String?) async throws -> ProgressCard? {
        guard ScreenshotFixtureMode.progressCardEnabled || ScreenshotFixtureMode.progressBarEnabled else { return nil }
        return ProgressCard(
            sessionkey: sessionKey,
            revision: 1,
            updatedat: 0,
            markdown: ScreenshotFixtureMode.progressCardEnabled ? nil : """
            <progress aria-label="Sample tasks · 3/5" value="3" max="5"></progress>

            Now: reading the sample diff.
            """,
            steps: ScreenshotFixtureMode.progressCardEnabled ? [
                ProgressCardStep(step: "Collect the sample data", status: .completed),
                ProgressCardStep(step: "Draft the summary", status: .inProgress),
                ProgressCardStep(step: "Share the result", status: .pending),
            ] : [])
    }

    func acquireReactionsRouteLease() async -> OpenClawChatReactionsRouteLease? {
        guard ScreenshotFixtureMode.reactionsEnabled else { return nil }
        let store = self.store
        return OpenClawChatReactionsRouteLease(
            routeID: self.reactionsRouteID,
            access: OpenClawChatReactionAccess(
                role: "operator",
                scopes: ["operator.admin"],
                sessionCap: "write",
                methods: ["session.reactions.list", "session.reactions.set"],
                userID: "fixture-you"),
            isCurrent: { true },
            list: { sessionKey, _ in
                await store.listReactions(sessionKey: sessionKey)
            },
            set: { sessionKey, agentID, messageID, emoji, remove in
                try await store.setReaction(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    messageID: messageID,
                    emoji: emoji,
                    remove: remove)
            })
    }

    func requestHistoryPage(sessionKey: String, offset: Int) async throws -> OpenClawChatHistoryPayload {
        try await self.store.history(sessionKey: sessionKey, offset: offset)
    }

    func acquireModelSignInContext(agentID: String?) async -> OpenClawChatModelSignInContext? {
        guard self.fixture.sessionIDPrefix == "screenshot-fixture",
              ScreenshotFixtureMode.modelSignInScenario != nil
        else { return nil }
        return OpenClawChatModelSignInContext(
            agentID: agentID ?? self.fixture.defaultAgentID,
            request: { method, _ in
                guard method == "models.authStatus" else { throw CancellationError() }
                return Data(#"{"providers":[],"providerCapabilities":[]}"#.utf8)
            },
            isCurrent: { true })
    }

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
        if ScreenshotFixtureMode.modelSignInScenario == "empty" { return [] }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-delayed-metadata-fixture") {
            try await Task.sleep(for: .seconds(20))
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-unavailable-model-fixture") {
            return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(#"""
            {"models":[
              {"id":"gpt-5.6-sol","name":"GPT-5.6","provider":"openai",
               "available":true,"contextWindow":128000},
              {"id":"claude-opus-4-1","name":"Claude Opus 4.1","provider":"anthropic",
               "available":false,"unavailableReason":"missing-auth","contextWindow":200000}
            ]}
            """#.utf8))
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-selected-model-auth-failure-fixture") {
            return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(Data(#"""
            {"models":[
              {"id":"gpt-5.6-sol","name":"GPT-5.6","provider":"openai",
               "available":false,"unavailableReason":"auth-failed","contextWindow":128000},
              {"id":"claude-opus-4-1","name":"Claude Opus 4.1","provider":"anthropic",
               "available":true,"contextWindow":200000}
            ]}
            """#.utf8))
        }
        return [
            OpenClawChatModelChoice(
                modelID: self.fixture.modelID,
                name: self.fixture.modelName,
                provider: self.fixture.modelProvider,
                contextWindow: 128_000,
                supportsFastMode: true),
        ] + self.fixture.additionalModels
    }

    func loadModelCatalog(
        sessionKey _: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        let choices = try await self.listModels(agentID: agentID)
        return OpenClawChatModelCatalogSnapshot(
            choices: choices,
            availabilityIsSessionScoped: true)
    }

    func isSwarmEnabled(sessionKey _: String) async throws -> Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-swarm-chat-fixture")
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking _: String,
        idempotencyKey: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        await self.store.sendMessage(
            sessionKey: sessionKey,
            message: message,
            runId: idempotencyKey)
    }

    func abortRun(sessionKey: String, runId: String) async throws {
        await self.store.abortRun(sessionKey: sessionKey, runId: runId)
    }

    func listSessions(
        limit _: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let response = try await store.sessions()
        var sessions = response.sessions
        if self.fixture.sessionIDPrefix == "screenshot-fixture",
           ProcessInfo.processInfo.arguments.contains("--openclaw-subagent-wait-fixture")
        {
            sessions[0].hasActiveSubagentRun = true
            sessions.append(OpenClawChatSessionEntry(
                key: "agent:main:subagent:fixture-helper",
                displayName: "Project helper",
                parentSessionKey: self.fixture.sessionKey,
                status: "running",
                hasActiveRun: true))
        }
        if archived {
            sessions = []
        }
        if let search {
            sessions = OpenClawChatSessionListOrganizer.filter(sessions, search: search)
        }
        return OpenClawChatSessionsListResponse(
            ts: response.ts,
            path: response.path,
            count: sessions.count,
            defaults: response.defaults,
            sessions: sessions)
    }

    func loadAgents(onUpdate: @escaping OpenClawChatAgentCatalogUpdate) async throws {
        await onUpdate(OpenClawChatAgentsListResponse(
            defaultId: self.fixture.defaultAgentID,
            agents: self.fixture.agents.map {
                OpenClawChatAgentChoice(
                    id: $0.id,
                    name: $0.name,
                    workspaceGit: $0.workspacegit)
            }))
    }

    func listChildSessions(parentKey: String) async throws -> OpenClawChatChildSessionsResult {
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-swarm-chat-fixture") else {
            return OpenClawChatChildSessionsResult(rows: [], isComplete: true)
        }
        let groupID = "swarm:\(parentKey):research"
        return OpenClawChatChildSessionsResult(rows: [
            self.swarmChild("polling", "National polling", status: "done", groupID: groupID, parentKey: parentKey),
            self.swarmChild("work", "Work and labor", status: "running", groupID: groupID, parentKey: parentKey),
            self.swarmChild("health", "Health", status: "running", groupID: groupID, parentKey: parentKey),
            self.swarmChild(
                "trust",
                "Governance and trust",
                status: nil,
                groupID: groupID,
                parentKey: parentKey,
                queued: true),
            self.swarmChild("media", "Media signals", status: "failed", groupID: groupID, parentKey: parentKey),
        ], isComplete: true)
    }

    private func swarmChild(
        _ key: String,
        _ label: String,
        status: String?,
        groupID: String,
        parentKey: String,
        queued: Bool = false) -> OpenClawChatSessionEntry
    {
        OpenClawChatSessionEntry(
            key: "agent:main:subagent:\(key)",
            kind: "direct",
            displayName: label,
            updatedAt: 1,
            modelProvider: self.fixture.modelProvider,
            model: self.fixture.modelID,
            contextTokens: 128_000,
            parentSessionKey: parentKey,
            spawnedBy: parentKey,
            status: status,
            hasActiveRun: status == "running",
            subagentRunState: queued ? "active" : nil,
            swarmGroupId: groupID,
            swarmPhase: "Research",
            swarmPhaseRank: 0,
            swarmLog: "Comparing labor, education, health, trust, and media signals.")
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        _ = try await self.store.patchSessionSettings(
            sessionKey: sessionKey,
            patch: OpenClawChatSessionSettingsPatch(model: .some(model)))
    }

    func setSessionThinking(sessionKey: String, thinkingLevel: String) async throws {
        _ = try await self.store.patchSessionSettings(
            sessionKey: sessionKey,
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(thinkingLevel)))
    }

    func patchSessionSettings(
        sessionKey: String,
        agentID _: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.store.patchSessionSettings(sessionKey: sessionKey, patch: patch)
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    /// The held screenshot run resolves only when the real composer aborts it.
    func waitForRunCompletion(runId: String, timeoutMs _: Int) async -> OpenClawChatRunObservation {
        await self.store.runObservation(runId: runId)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            continuation.yield(.health(ok: true))
            Task {
                await self.store.setEventContinuation(continuation)
            }
        }
    }

    func resetSession(sessionKey _: String) async throws {
        await self.store.reset()
    }

    func compactSession(sessionKey _: String) async throws {}

    private static func newSessionOptionsError(_ description: String) -> NSError {
        NSError(
            domain: "LocalFixtureChatTransport",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: description])
    }
}

private actor LocalFixtureChatStore {
    private let fixture: LocalChatFixture
    private var messages: [OpenClawChatMessage]
    private var modelID: String
    private var thinkingLevel = "auto"
    private var fastMode: OpenClawChatFastMode?
    private var verboseLevel: String?
    private var permissionMode: OpenClawChatPermissionMode? = .guarded
    private var toolOverrides: OpenClawChatSessionToolOverrides?
    private var reactionOverrides: [String: [OpenClawChatReactionSummary]] = [:]

    init(fixture: LocalChatFixture) {
        self.fixture = fixture
        self.messages = Self.seedMessages(fixture: fixture)
        self.modelID = fixture.modelID
    }

    func createSession(key: String) -> OpenClawChatCreateSessionResponse {
        OpenClawChatCreateSessionResponse(ok: true, key: key, sessionId: "\(self.fixture.sessionIDPrefix)-\(key)")
    }

    func history(sessionKey: String, offset: Int = 0) async throws -> OpenClawChatHistoryPayload {
        if ProcessInfo.processInfo.arguments.contains("--openclaw-disclosure-prepend-fixture") {
            return try await self.disclosurePrependHistory(sessionKey: sessionKey, offset: offset)
        }
        let owner = ScreenshotFixtureMode.progressCardEnabled || ScreenshotFixtureMode.progressBarEnabled
            ? self.fixture.defaultAgentID : nil
        let normalizedSessionKey = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        var startupSnapshot: OpenClawChatInFlightRun?
        if ProcessInfo.processInfo.arguments.contains("--openclaw-startup-status-fixture"),
           let runID = self.activeRunID
        {
            let wire = try JSONSerialization.data(withJSONObject: [[
                "runId": runID,
                "seq": 1,
                "stream": "run_status",
                "data": ["phase": "starting_model"],
            ]])
            let events = try JSONDecoder().decode([OpenClawAgentEventPayload].self, from: wire)
            startupSnapshot = OpenClawChatInFlightRun(runId: runID, text: "", events: events)
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-external-run-fixture"),
           let runID = self.activeRunID
        {
            startupSnapshot = OpenClawChatInFlightRun(runId: runID, text: "", events: self.externalRunEvents)
        }
        let fixtureMessages: [OpenClawChatMessage] = if self.fixture.sessionIDPrefix == "screenshot-fixture",
                                                        ProcessInfo.processInfo.arguments
                                                            .contains("--openclaw-subagent-wait-fixture"),
                                                            normalizedSessionKey == "agent:main:subagent:fixture-helper"
        {
            [Self.message(
                role: "assistant",
                text: "OPENCLAW_HELPER_SESSION",
                timestamp: 1,
                transcriptMessageID: "fixture-helper-answer")]
        } else {
            self.messages
        }
        let longAnchorFixture = ProcessInfo.processInfo.arguments.contains("--openclaw-long-history-anchor-fixture")
        let anchorFixture = longAnchorFixture ||
            ProcessInfo.processInfo.arguments.contains("--openclaw-history-anchor-fixture")
        if anchorFixture, offset > 0 {
            let slow = ProcessInfo.processInfo.arguments.contains("--openclaw-history-page-delay-fixture")
            try await Task.sleep(for: .seconds(slow ? 5 : 2))
        }
        // Older pages much taller than the first one, like tool output and code in real history.
        let uneven = ProcessInfo.processInfo.arguments.contains("--openclaw-history-uneven-fixture")
        let messages = anchorFixture ? (0..<(longAnchorFixture ? 600 : 18)).map { index in
            Self.message(
                role: index.isMultiple(of: 2) ? "user" : "assistant",
                text: "HISTORY_ANCHOR_\(index): " + String(
                    repeating: "A readable history paragraph.\n\n",
                    count: uneven && index < 499 && index % 3 == 0 ? 40 : longAnchorFixture ? 1 + index % 4 : 4),
                timestamp: Double(index + 1),
                transcriptMessageID: longAnchorFixture ? "long-history-\(index)" : nil,
                transcriptRunID: longAnchorFixture ? "long-history-run-\(index / 2)" : nil)
        } : fixtureMessages
        let shortPage = ProcessInfo.processInfo.arguments.contains("--openclaw-paged-history-short-fixture")
        let isPaged = anchorFixture || shortPage ||
            ProcessInfo.processInfo.arguments.contains("--openclaw-paged-history-fixture")
        let end = max(0, messages.count - offset)
        let pageSize = anchorFixture ? (longAnchorFixture ? 101 : 6) : (shortPage && offset == 0 ? 1 : 49)
        let start = isPaged ? max(0, end - pageSize) : 0
        let emptyPage = shortPage && offset == 1 &&
            ProcessInfo.processInfo.arguments.contains("--openclaw-empty-history-page-fixture")
        return try OpenClawChatHistoryPayload(
            sessionKey: normalizedSessionKey,
            sessionId: "\(self.fixture.sessionIDPrefix)-\(normalizedSessionKey)",
            messages: JSONDecoder().decode(
                [AnyCodable].self,
                from: JSONEncoder().encode(emptyPage ? [] : (isPaged ? Array(messages[start..<end]) : messages))),
            thinkingLevel: self.thinkingLevel,
            // The progress card is read only for a session whose owner the history names.
            sessionInfo: OpenClawChatSessionInfo(
                hasActiveRun: self.activeRunID != nil,
                activeRunIds: self.activeRunID.map { [$0] },
                key: owner.map { "agent:\($0):\(normalizedSessionKey)" },
                agentId: owner),
            inFlightRun: startupSnapshot ?? self.duplicateReplaySessionKey.flatMap { _ in
                self.activeRunID.map { OpenClawChatInFlightRun(runId: $0, text: "") }
            } ?? ((ProcessInfo.processInfo.arguments.contains("--openclaw-streaming-layout-fixture") ||
                    ProcessInfo.processInfo.arguments.contains("--openclaw-reader-tool-churn-fixture"))
                ? self.activeRunID.map {
                    OpenClawChatInFlightRun(
                        runId: $0,
                        text: self.layoutStreamingText)
                } : nil),
            activity: ProcessInfo.processInfo.arguments.contains("--openclaw-step-labels-fixture")
                ? JSONDecoder().decode([OpenClawChatHistoryActivity].self, from: Data("""
                [{"messageId":"fixture-step-call","items":[
                  {"itemId":"tool:fixture-exec","toolCallId":"fixture-exec","kind":"tool","phase":"end",
                   "title":"Exec — outcome unknown","name":"exec"},
                  {"itemId":"tool:fixture-no-result","toolCallId":"fixture-no-result","kind":"tool","phase":"end",
                   "title":"Exec — outcome unknown","name":"exec"},
                  {"itemId":"tool:fixture-success","toolCallId":"fixture-success","kind":"tool","phase":"end",
                   "title":"Exec","name":"exec","status":"completed"}
                ]}]
                """.utf8)) : nil,
            offset: isPaged ? offset : nil,
            nextOffset: emptyPage ? 2 : (isPaged && start > 0 ? offset + end - start : nil),
            hasMore: isPaged ? start > 0 : nil,
            totalMessages: isPaged ? messages.count : nil)
    }

    private func disclosurePrependHistory(sessionKey: String, offset: Int) async throws -> OpenClawChatHistoryPayload {
        let more = ProcessInfo.processInfo.arguments.contains("--openclaw-disclosure-more-history-fixture")
        if offset > 0 { try await Task.sleep(for: .seconds(offset == 6 ? 2 : 4)) }
        let page: [OpenClawChatMessage] = if offset == 0 {
            (0..<6).map { index in
                Self.message(
                    role: index.isMultiple(of: 2) ? "assistant" : "user",
                    text: "DISCLOSURE_READING_\(index): " + String(
                        repeating: "A readable history paragraph.\n\n", count: 4),
                    timestamp: Double(index + 3) * 1000,
                    transcriptMessageID: "disclosure-reading-\(index)")
            }
        } else if offset == 6 {
            [OpenClawChatMessage(
                role: "assistant",
                content: [.init(type: "text", text: "Checking the reading answer")],
                timestamp: 1000,
                transcriptMessageID: "disclosure-commentary",
                phase: "commentary")]
        } else {
            [Self.message(
                role: "user",
                text: "DISCLOSURE_OLDER: Earlier question",
                timestamp: 500,
                transcriptMessageID: "disclosure-older")]
        }
        return try OpenClawChatHistoryPayload(
            sessionKey: sessionKey,
            sessionId: "\(self.fixture.sessionIDPrefix)-\(sessionKey)",
            messages: JSONDecoder().decode([AnyCodable].self, from: JSONEncoder().encode(page)),
            thinkingLevel: self.thinkingLevel,
            offset: offset,
            nextOffset: offset == 0 ? 6 : (offset == 6 && more ? 7 : nil),
            hasMore: offset == 0 || (offset == 6 && more),
            totalMessages: more ? 8 : 7)
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        runId: String) -> OpenClawChatSendResponse
    {
        let now = Date().timeIntervalSince1970 * 1000
        let userMessage = Self.message(
            role: "user",
            text: message,
            timestamp: now,
            transcriptMessageID: "\(runId):user",
            idempotencyKey: "\(runId):user")
        self.messages.append(userMessage)
        self.publishReactions(for: userMessage, sessionKey: sessionKey)
        if ProcessInfo.processInfo.arguments.contains("--openclaw-dup-filter-fixture"),
           self.fixture.sessionIDPrefix == "screenshot-fixture"
        {
            self.activeRunID = runId
            self.duplicateReplaySessionKey = sessionKey
            self.duplicateReplayStarted = false
            return OpenClawChatSendResponse(runId: runId, status: "pending")
        }
        let trimmed = message.trimmingCharacters(in: .whitespacesAndNewlines)
        let subject = trimmed.isEmpty ? "that request" : "\"\(trimmed)\""
        if ScreenshotFixtureMode.holdsInitialChatRun,
           self.fixture.sessionIDPrefix == "screenshot-fixture",
           !self.heldInitialRun
        {
            self.heldInitialRun = true
            self.activeRunID = runId
            if ProcessInfo.processInfo.arguments.contains("--openclaw-startup-status-fixture") {
                let wire = try? JSONSerialization.data(withJSONObject: [
                    "runId": runId,
                    "sessionKey": sessionKey,
                    "state": "status",
                    "phase": "starting_model",
                    "seq": 1,
                ])
                if let wire, let event = try? JSONDecoder().decode(OpenClawChatEventPayload.self, from: wire) {
                    self.publish(.chat(event))
                }
            } else if ProcessInfo.processInfo.arguments.contains("--openclaw-reader-tool-churn-fixture") {
                self.layoutStreamingText = ""
                Task { await self.emitReaderToolChurn(runId: runId) }
            } else if ProcessInfo.processInfo.arguments.contains("--openclaw-growing-stream-fixture") {
                self.layoutStreamingText = ""
                Task { await self.emitGrowingLayoutReply(runId: runId) }
            }
            return OpenClawChatSendResponse(runId: runId, status: "started")
        }
        let assistantMessage = Self.message(
            role: "assistant",
            text: """
            \(self.fixture.responsePrefix) I can help with \(subject), summarize current project context, \
            prepare agent actions, and keep the mobile workflow connected to the gateway.
            """,
            timestamp: now + 1,
            transcriptMessageID: "\(runId):assistant")
        self.messages.append(assistantMessage)
        self.publishReactions(for: assistantMessage, sessionKey: sessionKey)
        return OpenClawChatSendResponse(runId: runId, status: "ok")
    }

    private var duplicateReplaySessionKey: String?
    private var duplicateReplayStarted = false

    /// Replay begins from the run owner, after the send acknowledgment/history refresh.
    /// History carries no live text: only the assistant event can supply the second copy.
    private func replayDuplicateReply(sessionKey: String, runId: String, timestamp: Double) {
        let text = "The cobalt lighthouse is ready."
        let saved = Self.message(
            role: "assistant",
            text: text,
            timestamp: timestamp + 1,
            transcriptMessageID: "\(runId):assistant")
        self.messages.append(saved)
        self.publish(.sessionMessage(OpenClawSessionMessageEventPayload(
            sessionKey: sessionKey, message: saved, messageId: saved.transcriptMessageID, messageSeq: nil)))
        self.emitDuplicateAgentEvent(
            runId: runId,
            seq: 1,
            stream: "assistant",
            timestamp: timestamp + 2,
            data: ["text": text])
        self.emitDuplicateAgentEvent(
            runId: runId,
            seq: 2,
            stream: "tool",
            timestamp: timestamp + 3,
            data: [
                "phase": "start", "name": "read", "toolCallId": "dup-filter-receipt",
                "args": ["path": "dup-filter-inputs-received"],
            ])
        self.emitDuplicateAgentEvent(
            runId: runId,
            seq: 3,
            stream: "usage",
            timestamp: timestamp + 4,
            data: ["outputTokens": 485])
        self.emitDuplicateAgentEvent(
            runId: runId,
            seq: 4,
            stream: "run_status",
            timestamp: timestamp + 5,
            data: ["phase": "retrying", "attempt": 2, "maxAttempts": 3])
    }

    private func emitDuplicateAgentEvent(
        runId: String,
        seq: Int,
        stream: String,
        timestamp: Double,
        data: [String: Any])
    {
        let frame = EventFrame(
            type: "event",
            event: "agent",
            payload: AnyCodable([
                "runId": runId, "seq": seq, "stream": stream, "ts": Int(timestamp), "data": data,
            ]))
        guard let event = OpenClawChatGatewayPayloadCodec.event(from: frame) else {
            preconditionFailure("Invalid duplicate reply fixture event")
        }
        self.publish(event)
    }

    private var layoutStreamingText = String(repeating: "Streaming layout response. ", count: 12)

    private func emitGrowingLayoutReply(runId: String) async {
        for chunk in 1...12 {
            try? await Task.sleep(for: .milliseconds(350))
            guard self.activeRunID == runId else { return }
            self.layoutStreamingText = String(repeating: "Streaming layout response.\n\n", count: chunk * 8) +
                "GROWING_LIVE_TAIL_\(chunk)"
            let message: [String: Any] = [
                "role": "assistant", "content": [["type": "text", "text": self.layoutStreamingText]],
            ]
            self.publish(.chat(OpenClawChatEventPayload(
                runId: runId, sessionKey: nil, state: "delta", message: AnyCodable(message), errorMessage: nil)))
        }
    }

    private func emitReaderToolChurn(runId: String) async {
        try? await Task.sleep(for: .seconds(10))
        for tick in 1...20 {
            guard self.activeRunID == runId else { return }
            self.emitReaderEvent(
                runId: runId,
                seq: tick * 2 - 1,
                stream: "tool",
                data: [
                    "phase": AnyCodable("start"),
                    "name": AnyCodable("read"),
                    "toolCallId": AnyCodable("reader-tool-\(tick)"),
                    "args": AnyCodable(["file_path": "reader-step-\(tick).md"]),
                ])
            self.layoutStreamingText = String(repeating: "Tool stream output paragraph.\n\n", count: tick * 2) +
                "TOOL_CHURN_STEP_\(tick)"
            self.emitReaderEvent(
                runId: runId,
                seq: tick * 2,
                stream: "assistant",
                data: ["text": AnyCodable(self.layoutStreamingText)])
            try? await Task.sleep(for: .seconds(1))
        }
    }

    private func emitReaderEvent(runId: String, seq: Int, stream: String, data: [String: AnyCodable]) {
        let payload = ReaderEventPayload(
            runId: runId,
            seq: seq,
            stream: stream,
            ts: Int(Date().timeIntervalSince1970 * 1000),
            data: data)
        do {
            let event = try Self.decode(payload, as: OpenClawAgentEventPayload.self)
            self.publish(.agent(event))
        } catch {
            assertionFailure("Invalid reader fixture event: \(error)")
        }
    }

    private var heldInitialRun = false
    private var activeRunID: String?
    private var eventContinuations: [UUID: AsyncStream<OpenClawChatTransportEvent>.Continuation] = [:]

    func setEventContinuation(_ continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation) {
        // Chat and its session sidebar independently subscribe to the fixture transport.
        let id = UUID()
        self.eventContinuations[id] = continuation
        if self.fixture.sessionIDPrefix == "screenshot-fixture",
           ProcessInfo.processInfo.arguments.contains("--openclaw-external-run-fixture"),
           !self.externalRunStarted
        {
            self.externalRunStarted = true
            Task {
                try? await Task.sleep(for: .seconds(4))
                self.publishExternalRunStatus()
                try? await Task.sleep(for: .seconds(8))
                self.publishExternalRunTool()
            }
        }
        continuation.onTermination = { [weak self] _ in
            Task { await self?.removeEventContinuation(id) }
        }
    }

    private var externalRunStarted = false
    private var externalRunEvents: [OpenClawAgentEventPayload] = []

    private func publishExternalRunStatus() {
        self.activeRunID = "fixture-external-run"
        let wire = Data(#"""
        {"runId":"fixture-external-run","sessionKey":"main","state":"status",
         "phase":"starting_model","seq":1}
        """#.utf8)
        if let event = try? JSONDecoder().decode(OpenClawChatEventPayload.self, from: wire) {
            let statusWire = Data(#"""
            {"runId":"fixture-external-run","seq":1,"stream":"run_status","data":{"phase":"starting_model"}}
            """#.utf8)
            if let status = try? JSONDecoder().decode(OpenClawAgentEventPayload.self, from: statusWire) {
                self.externalRunEvents.append(status)
            }
            self.publish(.chat(event))
        }
    }

    private func publishExternalRunTool() {
        let wire = Data(#"""
        {"runId":"fixture-external-run","seq":2,"stream":"tool",
         "data":{"phase":"start","name":"read","toolCallId":"external-read",
                 "args":{"path":"external-fixture.txt"}}}
        """#.utf8)
        if let event = try? JSONDecoder().decode(OpenClawAgentEventPayload.self, from: wire) {
            self.externalRunEvents.append(event)
            self.publish(.agent(event))
        }
    }

    private func removeEventContinuation(_ id: UUID) {
        self.eventContinuations[id] = nil
    }

    private func publish(_ event: OpenClawChatTransportEvent) {
        for continuation in self.eventContinuations.values {
            continuation.yield(event)
        }
    }

    func runObservation(runId: String) -> OpenClawChatRunObservation {
        if self.activeRunID == runId,
           let sessionKey = self.duplicateReplaySessionKey,
           !self.duplicateReplayStarted,
           !self.eventContinuations.isEmpty
        {
            self.duplicateReplayStarted = true
            self.replayDuplicateReply(
                sessionKey: sessionKey, runId: runId, timestamp: Date().timeIntervalSince1970 * 1000)
        }
        return self.activeRunID == runId ? .checkAgain : .terminal(.completed)
    }

    func abortRun(sessionKey: String, runId: String) {
        guard self.activeRunID == runId else { return }
        self.activeRunID = nil
        self.duplicateReplaySessionKey = nil
        self.duplicateReplayStarted = false
        self.publish(.chat(OpenClawChatEventPayload(
            runId: runId,
            sessionKey: sessionKey,
            state: "aborted",
            message: nil,
            errorMessage: nil)))
    }

    func sessions() throws -> OpenClawChatSessionsListResponse {
        var entry = OpenClawChatSessionEntry(
            key: fixture.sessionKey,
            kind: "chat",
            displayName: self.fixture.displayName,
            surface: "ios",
            subject: self.fixture.subject,
            updatedAt: Date().timeIntervalSince1970 * 1000,
            sessionId: "\(self.fixture.sessionIDPrefix)-\(self.fixture.sessionKey)",
            systemSent: true,
            abortedLastRun: false,
            thinkingLevel: self.thinkingLevel,
            verboseLevel: self.verboseLevel,
            totalTokens: 24000,
            totalTokensFresh: true,
            modelProvider: self.fixture.modelProvider,
            model: self.modelID,
            contextTokens: 128_000,
            thinkingLevels: Self.thinkingLevels,
            thinkingOptions: Self.thinkingOptions,
            thinkingDefault: "auto",
            fastMode: self.fastMode,
            effectiveFastMode: self.fastMode,
            permissionMode: self.permissionMode,
            toolOverrides: self.toolOverrides)
        entry.visibility = .shared
        entry.sharingRole = .owner
        return OpenClawChatSessionsListResponse(
            ts: Date().timeIntervalSince1970 * 1000,
            path: nil,
            count: 1,
            defaults: OpenClawChatSessionsDefaults(
                modelProvider: self.fixture.modelProvider,
                model: self.fixture.modelID,
                contextTokens: 128_000,
                thinkingLevels: Self.thinkingLevels,
                thinkingOptions: Self.thinkingOptions,
                thinkingDefault: "auto",
                mainSessionKey: self.fixture.sessionKey,
                modelSelectionTarget: self.fixtureModelSelectionTarget),
            sessions: [entry])
    }

    private var fixtureModelSelectionTarget: String {
        let arguments = ProcessInfo.processInfo.arguments
        switch arguments.drop(while: { $0 != "--openclaw-model-selection-target" }).dropFirst().first {
        case let value? where ["session", "agent", "global"].contains(value): return value
        default: return self.fixture.modelSelectionTarget
        }
    }

    func reset() {
        self.duplicateReplaySessionKey = nil
        self.duplicateReplayStarted = false
        self.messages = Self.seedMessages(fixture: self.fixture)
        self.reactionOverrides.removeAll()
        self.modelID = self.fixture.modelID
        self.thinkingLevel = "auto"
        self.fastMode = nil
        self.verboseLevel = nil
        self.permissionMode = .guarded
        self.toolOverrides = nil
    }

    func patchSessionSettings(
        sessionKey: String,
        patch: OpenClawChatSessionSettingsPatch) throws -> OpenClawChatModelPatchResult
    {
        let key = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        let sessionID = "\(self.fixture.sessionIDPrefix)-\(key)"
        if let expectedSessionID = patch.expectedSessionID, expectedSessionID != sessionID {
            throw NSError(
                domain: "LocalFixtureChatTransport",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "The fixture session changed before the update."])
        }
        if let model = patch.model {
            self.modelID = model ?? self.fixture.modelID
        }
        if let thinkingLevel = patch.thinkingLevel {
            self.thinkingLevel = thinkingLevel ?? "auto"
        }
        if let fastMode = patch.fastMode {
            self.fastMode = fastMode
        }
        if let verboseLevel = patch.verboseLevel {
            self.verboseLevel = verboseLevel
        }
        if let permissionMode = patch.permissionMode {
            self.permissionMode = permissionMode
        }
        if let toolOverrides = patch.toolOverrides {
            self.toolOverrides = toolOverrides
        }
        return OpenClawChatModelPatchResult(
            key: key,
            modelProvider: self.fixture.modelProvider,
            model: self.modelID,
            thinkingLevel: self.thinkingLevel,
            thinkingLevels: Self.thinkingLevels,
            fastMode: self.fastMode,
            effectiveFastMode: self.fastMode,
            verboseLevel: self.verboseLevel,
            permissionMode: self.permissionMode,
            toolOverrides: self.toolOverrides)
    }

    func listReactions(sessionKey: String) -> OpenClawChatReactionsListResult {
        let key = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        var reactions: [String: [OpenClawChatReactionSummary]] = [:]
        for message in self.messages {
            guard let messageID = message.transcriptMessageID else { continue }
            reactions[messageID] = self.reactions(for: message)
        }
        return OpenClawChatReactionsListResult(
            sessionID: "\(self.fixture.sessionIDPrefix)-\(key)",
            reactions: reactions)
    }

    func setReaction(
        sessionKey: String,
        agentID: String?,
        messageID: String,
        emoji: String,
        remove: Bool) throws -> OpenClawChatReactionsSetResult
    {
        guard let message = self.messages.first(where: { $0.transcriptMessageID == messageID }) else {
            throw NSError(
                domain: "LocalFixtureChatTransport",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: String(localized: "The saved fixture message is unavailable.")])
        }
        let viewer = OpenClawChatReactionIdentity(id: "fixture-you", label: "Alex")
        var reactions = self.reactions(for: message)
        let index = reactions.firstIndex(where: { $0.emoji == emoji })
        var identities = index.map { reactions[$0].identities } ?? []
        identities.removeAll { $0.id == viewer.id }
        if !remove {
            identities.append(viewer)
        }
        if let index {
            reactions.remove(at: index)
        }
        if !identities.isEmpty {
            reactions.insert(
                OpenClawChatReactionSummary(emoji: emoji, count: identities.count, identities: identities),
                at: index ?? reactions.count)
        }
        self.reactionOverrides[messageID] = reactions
        self.publishReactions(for: message, sessionKey: sessionKey, agentID: agentID)
        return OpenClawChatReactionsSetResult(messageID: messageID, reactions: reactions)
    }

    private func publishReactions(for message: OpenClawChatMessage, sessionKey: String, agentID: String? = nil) {
        guard ScreenshotFixtureMode.reactionsEnabled, let messageID = message.transcriptMessageID else { return }
        let key = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        self.publish(.sessionReaction(OpenClawChatReactionEvent(
            sessionKey: key,
            agentID: agentID ?? self.fixture.defaultAgentID,
            sessionID: "\(self.fixture.sessionIDPrefix)-\(key)",
            messageID: messageID,
            reactions: self.reactions(for: message))))
    }

    private func reactions(for message: OpenClawChatMessage) -> [OpenClawChatReactionSummary] {
        if let messageID = message.transcriptMessageID, let reactions = self.reactionOverrides[messageID] {
            return reactions
        }
        let casey = OpenClawChatReactionIdentity(id: "fixture-casey", label: "Casey")
        if message.role == "user" {
            return [
                OpenClawChatReactionSummary(emoji: "👍", count: 2, identities: [
                    OpenClawChatReactionIdentity(id: "fixture-you", label: "Alex"), casey,
                ]),
                OpenClawChatReactionSummary(emoji: "🚀", count: 1, identities: [
                    OpenClawChatReactionIdentity(id: "fixture-morgan", label: "Morgan"),
                ]),
            ]
        }
        return [OpenClawChatReactionSummary(emoji: "🎉", count: 1, identities: [casey])]
    }

    private static var thinkingOptions: [String] {
        ["auto", "low", "medium", "high"]
    }

    private static var thinkingLevels: [OpenClawChatThinkingLevelOption] {
        [
            OpenClawChatThinkingLevelOption(id: "auto", label: "Auto"),
            OpenClawChatThinkingLevelOption(id: "low", label: "Low"),
            OpenClawChatThinkingLevelOption(id: "medium", label: "Medium"),
            OpenClawChatThinkingLevelOption(id: "high", label: "High"),
        ]
    }

    private static func seedMessages(fixture: LocalChatFixture) -> [OpenClawChatMessage] {
        let now = Date().timeIntervalSince1970 * 1000
        if ProcessInfo.processInfo.arguments.contains("--openclaw-external-run-fixture") {
            return [Self.message(
                role: "user",
                text: "Read external-fixture.txt. Sent from another client.",
                timestamp: now,
                transcriptMessageID: "fixture-external-user")]
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-system-notices-fixture") {
            return [
                OpenClawChatMessage(
                    role: "user",
                    content: [OpenClawChatMessageContent(type: "text", text: """
                    CONTEXT_START: A synthetic continuation summary.
                    The earlier question asked for a release checklist.
                    The changelog is ready; screenshot review remains open.
                    No private session or Gateway is used by this fixture.
                    CONTEXT_END: Keep the full summary available on request.
                    """)],
                    timestamp: now,
                    provenance: OpenClawChatInputProvenance(
                        kind: "internal_system", sourceTool: "cli_harness_context")),
                OpenClawChatMessage(
                    role: "user",
                    content: [OpenClawChatMessageContent(type: "text", text: """
                    TASK_START: A synthetic background task finished.
                    The screenshot checklist was checked without changing files.
                    TASK_END: The complete task result remains available.
                    """)],
                    timestamp: now + 1,
                    provenance: OpenClawChatInputProvenance(
                        kind: "internal_system", sourceTool: "claude_cli_task_notification")),
                self.message(
                    role: "assistant",
                    text: "Notice fixture ready.",
                    timestamp: now + 2,
                    transcriptMessageID: "fixture-notice-answer"),
            ]
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-voice-consult-rows-fixture") {
            // Persisted realtime-voice renditions beside consult answers, in both arrival orders.
            let voice = OpenClawChatInputProvenance(kind: "realtime_voice", sourceChannel: "talk")
            func row(_ text: String, at offset: Double, spoken: Bool) -> OpenClawChatMessage {
                OpenClawChatMessage(
                    role: "assistant",
                    content: [OpenClawChatMessageContent(type: "text", text: text)],
                    timestamp: now + offset,
                    model: spoken ? "realtime-voice" : "consult-model",
                    stopReason: "stop",
                    provenance: spoken ? voice : nil,
                    phase: spoken ? nil : "final_answer")
            }
            return [
                self.message(
                    role: "user",
                    text: "Which build is on my phone?",
                    timestamp: now,
                    transcriptMessageID: "fixture-voice-prompt-1"),
                row("VOICE_SPOKEN_FIRST: The latest build is on your phone.", at: 1, spoken: true),
                row("CONSULT_AFTER: The build went on at about 14:15.", at: 2, spoken: false),
                self.message(
                    role: "user",
                    text: "And the one before?",
                    timestamp: now + 3,
                    transcriptMessageID: "fixture-voice-prompt-2"),
                row("CONSULT_FIRST: The previous build went on yesterday.", at: 4, spoken: false),
                row("VOICE_SPOKEN_AFTER: The one before went on yesterday.", at: 5, spoken: true),
            ]
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-step-labels-fixture") {
            return [
                self.message(
                    role: "user",
                    text: "Check local readiness.",
                    timestamp: now,
                    transcriptMessageID: "fixture-step-prompt"),
                OpenClawChatMessage(
                    role: "assistant",
                    content: [
                        OpenClawChatMessageContent(
                            type: "toolCall",
                            id: "fixture-exec",
                            name: "exec",
                            arguments: AnyCodable(["command": "printf ready"])),
                        OpenClawChatMessageContent(
                            type: "toolCall",
                            id: "fixture-no-result",
                            name: "exec",
                            arguments: AnyCodable(["command": "printf missing"])),
                        OpenClawChatMessageContent(
                            type: "toolCall",
                            id: "fixture-success",
                            name: "exec",
                            arguments: AnyCodable(["command": "printf complete"])),
                    ],
                    timestamp: now + 1,
                    transcriptMessageID: "fixture-step-call",
                    stopReason: "toolUse"),
                OpenClawChatMessage(
                    role: "toolResult",
                    content: [OpenClawChatMessageContent(type: "text", text: "ready")],
                    timestamp: now + 2,
                    transcriptMessageID: "fixture-step-result",
                    toolCallId: "fixture-exec",
                    toolName: "exec"),
                OpenClawChatMessage(
                    role: "toolResult",
                    content: [OpenClawChatMessageContent(type: "text", text: "complete")],
                    timestamp: now + 3,
                    transcriptMessageID: "fixture-success-result",
                    toolCallId: "fixture-success",
                    toolName: "exec"),
                self.message(
                    role: "assistant",
                    text: "Local readiness checked.",
                    timestamp: now + 4,
                    transcriptMessageID: "fixture-step-answer"),
            ]
        }
        if let messages = self.readerFixtureMessages(now: now) { return messages }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-long-chat-fixture") {
            let latestText = ProcessInfo.processInfo.arguments.contains("--openclaw-tall-reply-fixture")
                ? String(repeating: "Historical reply paragraph.\n\n", count: 40) + "OPENCLAW_LONG_CHAT_LATEST"
                : "OPENCLAW_LONG_CHAT_LATEST"
            return [
                self.message(
                    role: "user",
                    text: "Prepare a detailed project review.",
                    timestamp: now,
                    transcriptMessageID: "fixture-long-prompt"),
                self.message(
                    role: "assistant",
                    text: String(repeating: "Earlier response context. ", count: 120),
                    timestamp: now + 1,
                    transcriptMessageID: "fixture-long-answer"),
                self.message(
                    role: "assistant",
                    text: latestText,
                    timestamp: now + 2,
                    transcriptMessageID: "fixture-long-latest"),
            ]
        }
        return fixture.seedMessages.enumerated().map { index, text in
            self.message(
                role: "assistant",
                text: text,
                timestamp: now + Double(index),
                transcriptMessageID: "\(fixture.sessionIDPrefix)-seed-\(index)")
        }
    }

    /// Audit and scroll transcripts for the reading-position UI tests.
    private static func readerFixtureMessages(now: Double) -> [OpenClawChatMessage]? {
        if ProcessInfo.processInfo.arguments.contains("--openclaw-audit-fixture") {
            // swiftlint:disable line_length
            let json = #"""
            [{"role": "user", "timestamp": 1, "content": [{"type": "text", "text": "Audit this transcript: markdown, code, tools, image, voice and long output."}]}, {"role": "assistant", "timestamp": 2, "content": [{"type": "toolCall", "id": "audit-read", "name": "read", "arguments": {"path": "fixture.md"}}]}, {"role": "toolResult", "toolCallId": "audit-read", "toolName": "read", "timestamp": 3, "content": [{"type": "text", "text": "Audit fixture tool result. No network request was made."}]}, {"role": "assistant", "timestamp": 4, "content": [{"type": "text", "text": "# Audit Markdown\n\n**Bold**, *italic*, ~~strike~~ and [a link](https://example.com).\n\n- First task\n- Second task\n\n> A blockquote with enough words to wrap on an iPhone.\n\n```swift\nlet unusuallyLongIdentifier = \"a deliberately long code line to exercise horizontal scrolling without wrapping or truncating its copy contents\"\nprint(unusuallyLongIdentifier)\n```\n\n| Name | Result |\n| --- | --- |\n| Audit | Ready |\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\nLong review paragraph with inline **emphasis** and readable text.\n\n"}]}, {"role": "user", "timestamp": 5, "content": [{"type": "text", "text": "AUDIT_IMAGE_ROW"}, {"type": "image", "mimeType": "image/png", "fileName": "audit-chart.png", "content": "iVBORw0KGgoAAAANSUhEUgAAAoAAAADwCAIAAAAfEkKcAAAGtElEQVR4nO3VQQ2AQAADQbSgA00YwefpwEM/TZNJRsPudX8HGHXeBxh11QsCxOoFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiBgzD6gUBYgYMw+oFAWIGDMPqBQFiP2e5OyS3rtABAAAAAElFTkSuQmCC", "artifactId": "artifact_managed_image_11111111-1111-4111-8111-111111111111"}]}, {"role": "user", "timestamp": 6, "content": [{"type": "text", "text": "AUDIT_VOICE_QUESTION: can you repeat the result?"}, {"type": "audio", "mimeType": "audio/wav", "fileName": "audit-voice.wav", "durationSeconds": 0.1, "artifactId": "artifact_managed_media_22222222-2222-4222-8222-222222222222"}], "__openclaw": {"id": "voice:audit:1"}}, {"role": "assistant", "timestamp": 7, "content": [{"type": "text", "text": "AUDIT_FINAL: The fixture covers long text, markdown, code, tool activity, image and a persisted voice turn."}]}]
            """#
            // swiftlint:enable line_length
            var data = Data(json.utf8)
            if ProcessInfo.processInfo.arguments.contains("--openclaw-audit-long-fixture"),
               let rows = try? JSONSerialization.jsonObject(with: data) as? [[String: Any]]
            {
                var expanded: [[String: Any]] = []
                for turn in 0..<30 {
                    for (index, row) in rows.enumerated() {
                        var row = row
                        row["timestamp"] = Double(turn * 1000 + index + 1)
                        if let id = row["toolCallId"] as? String { row["toolCallId"] = "\(id)-\(turn)" }
                        if let metadata = row["__openclaw"] as? [String: Any], let id = metadata["id"] as? String {
                            row["__openclaw"] = ["id": "\(id)-\(turn)"]
                        }
                        if let blocks = row["content"] as? [[String: Any]] {
                            row["content"] = blocks.map { block in
                                var block = block
                                if let id = block["id"] as? String { block["id"] = "\(id)-\(turn)" }
                                if var text = block["text"] as? String {
                                    if turn == 0, index == 0 { text = "AUDIT_OLDEST_HISTORY_QUESTION: " + text }
                                    if turn == 25 {
                                        text = "AUDIT_LAZY_PREFIX: \n\n" + text.replacingOccurrences(
                                            of: "Long review paragraph",
                                            with: "AUDIT_LAZY_PREFIX: Long review paragraph")
                                    }
                                    if turn < 29 {
                                        text = text.replacingOccurrences(
                                            of: "AUDIT_FINAL:", with: "AUDIT_PREVIOUS_FINAL_\(turn):")
                                    }
                                    block["text"] = text
                                }
                                return block
                            }
                        }
                        expanded.append(row)
                    }
                }
                data = (try? JSONSerialization.data(withJSONObject: expanded)) ?? data
            }
            let messages = (try? JSONDecoder().decode([OpenClawChatMessage].self, from: data)) ?? []
            if ProcessInfo.processInfo.arguments.contains("--openclaw-audit-code-page") {
                return [self.message(
                    role: "assistant",
                    text: """
                    # Markdown and code
                    **Bold**, *italic*, ~~strike~~ and a list:
                    - First
                    - Second
                    ```swift
                    let unusuallyLongIdentifier = "a deliberately long code line to exercise horizontal scrolling"
                    print(unusuallyLongIdentifier)
                    ```
                    | Name | Result |
                    | --- | --- |
                    | Audit | Ready |
                    """,
                    timestamp: now)]
            }
            return messages
        }
        if ProcessInfo.processInfo.arguments.contains("--openclaw-scroll-stress-fixture") {
            let paragraph = "A measured response with **formatted text**, links and several readable paragraphs."
            let replyBody = String(repeating: paragraph + "\n\n", count: 8)
            var messages: [OpenClawChatMessage] = []
            for turn in 0..<60 {
                let timestamp = now + Double(turn * 2)
                let replyText = "SCROLL_REPLY_\(turn)\n\n" + replyBody
                messages.append(self.message(role: "user", text: "SCROLL_QUESTION_\(turn)", timestamp: timestamp))
                messages.append(self.message(role: "assistant", text: replyText, timestamp: timestamp + 1))
            }
            return messages
        }
        return nil
    }

    private static func message(
        role: String,
        text: String,
        timestamp: Double,
        transcriptMessageID: String? = nil,
        transcriptRunID: String? = nil,
        idempotencyKey: String? = nil) -> OpenClawChatMessage
    {
        OpenClawChatMessage(
            role: role,
            content: [
                OpenClawChatMessageContent(
                    type: "text",
                    text: text),
            ],
            timestamp: timestamp,
            transcriptMessageID: transcriptMessageID,
            transcriptRunID: transcriptRunID,
            idempotencyKey: idempotencyKey,
            stopReason: role == "assistant" ? "stop" : nil)
    }

    private static func normalizedSessionKey(_ value: String, fallback: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }

    private static func decode<T: Decodable>(_ value: some Encodable, as type: T.Type) throws -> T {
        let data = try JSONEncoder().encode(value)
        return try JSONDecoder().decode(type, from: data)
    }

    private struct ReaderEventPayload: Encodable {
        let runId: String
        let seq: Int
        let stream: String
        let ts: Int
        let data: [String: AnyCodable]
    }
}

extension ScreenshotFixtureMode {
    static var holdsInitialChatRun: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-hold-initial-chat-run")
    }
}
