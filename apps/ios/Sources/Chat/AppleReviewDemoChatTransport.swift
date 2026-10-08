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
    static let gatewayName = "OpenClaw Gateway"
    static let gatewayAddress = "Gateway on local network"
    static let gatewayID = "screenshot-fixture-gateway"
    static var reactionsEnabled: Bool {
        !ProcessInfo.processInfo.arguments.contains("--openclaw-no-reactions-fixture")
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
    var supportsComposerCapabilities: Bool {
        true
    }

    func loadComposerCapabilityCatalog(
        sessionKey _: String,
        agentID _: String?) async -> OpenClawChatComposerCapabilityCatalog
    {
        OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: true,
            modelMutationAvailable: true,
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

    func listModels(agentID _: String?) async throws -> [OpenClawChatModelChoice] {
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

    func history(sessionKey: String) throws -> OpenClawChatHistoryPayload {
        let normalizedSessionKey = Self.normalizedSessionKey(sessionKey, fallback: self.fixture.sessionKey)
        return try OpenClawChatHistoryPayload(
            sessionKey: normalizedSessionKey,
            sessionId: "\(self.fixture.sessionIDPrefix)-\(normalizedSessionKey)",
            messages: JSONDecoder().decode([AnyCodable].self, from: JSONEncoder().encode(self.messages)),
            thinkingLevel: self.thinkingLevel,
            sessionInfo: OpenClawChatSessionInfo(
                hasActiveRun: self.activeRunID != nil,
                activeRunIds: self.activeRunID.map { [$0] }),
            inFlightRun: self.duplicateReplaySessionKey.flatMap { _ in
                self.activeRunID.map { OpenClawChatInFlightRun(runId: $0, text: "") }
            } ?? (ProcessInfo.processInfo.arguments.contains("--openclaw-streaming-layout-fixture")
                ? self.activeRunID.map {
                    OpenClawChatInFlightRun(
                        runId: $0,
                        text: String(repeating: "Streaming layout response. ", count: 12))
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
                """.utf8)) : nil)
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
        self.eventContinuation?.yield(.sessionMessage(OpenClawSessionMessageEventPayload(
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
        self.eventContinuation?.yield(event)
    }

    private var heldInitialRun = false
    private var activeRunID: String?
    private var eventContinuation: AsyncStream<OpenClawChatTransportEvent>.Continuation?

    func setEventContinuation(_ continuation: AsyncStream<OpenClawChatTransportEvent>.Continuation) {
        self.eventContinuation = continuation
    }

    func runObservation(runId: String) -> OpenClawChatRunObservation {
        if self.activeRunID == runId,
           let sessionKey = self.duplicateReplaySessionKey,
           !self.duplicateReplayStarted,
           self.eventContinuation != nil
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
        self.eventContinuation?.yield(.chat(OpenClawChatEventPayload(
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
        self.eventContinuation?.yield(.sessionReaction(OpenClawChatReactionEvent(
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
        if ProcessInfo.processInfo.arguments.contains("--openclaw-long-chat-fixture") {
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
                    text: "OPENCLAW_LONG_CHAT_LATEST",
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

    private static func message(
        role: String,
        text: String,
        timestamp: Double,
        transcriptMessageID: String,
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
            idempotencyKey: idempotencyKey,
            stopReason: role == "assistant" ? "stop" : nil)
    }

    private static func normalizedSessionKey(_ value: String, fallback: String) -> String {
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? fallback : trimmed
    }
}

extension ScreenshotFixtureMode {
    static var holdsInitialChatRun: Bool {
        ProcessInfo.processInfo.arguments.contains("--openclaw-hold-initial-chat-run")
    }
}
