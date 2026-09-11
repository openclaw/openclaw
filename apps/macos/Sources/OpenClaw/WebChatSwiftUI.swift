import AppKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog
import SwiftUI

private let webChatSwiftLogger = Logger(subsystem: "ai.openclaw", category: "WebChatSwiftUI")
private let webChatThinkingLevelDefaultsKey = "openclaw.webchat.thinkingLevel"
private let webChatVerboseLevelDefaultsKey = "openclaw.webchat.verboseLevel"

private enum WebChatSwiftUILayout {
    static let windowSize = NSSize(width: 960, height: 700)
    static let windowMinSize = NSSize(width: 640, height: 420)
    static let windowFrameAutosaveName = "OpenClawChatWindow"
}

enum WebChatTracePreferences {
    static func displayOptions(defaults: UserDefaults = AppDefaults.standard) -> OpenClawChatDisplayOptions {
        if let legacyValue = defaults.object(
            forKey: OpenClawChatWindowShell.assistantTraceDefaultsKey) as? Bool
        {
            for key in [
                OpenClawChatWindowShell.assistantReasoningDefaultsKey,
                OpenClawChatWindowShell.assistantToolActivityDefaultsKey,
            ] where defaults.object(forKey: key) == nil {
                defaults.set(legacyValue, forKey: key)
            }
        }

        var options: OpenClawChatDisplayOptions = []
        if defaults.object(forKey: OpenClawChatWindowShell.assistantReasoningDefaultsKey) as? Bool ?? true {
            options.insert(.reasoning)
        }
        if defaults.object(forKey: OpenClawChatWindowShell.assistantToolActivityDefaultsKey) as? Bool ?? true {
            options.insert(.toolActivity)
        }
        return options
    }
}

/// SwiftUI's native toolbar bridge may restore visible title chrome while it
/// installs toolbar items. Keep the full-window chat's titlebar merged.
private final class WebChatWindow: NSWindow {
    var pinnedTitle: String?

    override var title: String {
        didSet {
            // SwiftUI toolbar bridging may replace the operator-facing Gateway
            // name with a session key. Keep Mission Control/window lists useful.
            if let pinnedTitle, title != pinnedTitle {
                self.title = pinnedTitle
            }
        }
    }

    override var titleVisibility: NSWindow.TitleVisibility {
        didSet {
            if self.titleVisibility != .hidden {
                self.titleVisibility = .hidden
            }
        }
    }
}

struct MacGatewayChatTransport: OpenClawChatGatewayTransport {
    var chatGatewayAgentID: String? {
        self.routingIdentity.currentAgentID()
    }

    func requestChatGateway(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        try await self.connection.request(request)
    }

    /// Shared across transport value copies so the live view model and its
    /// snapshot observer cannot diverge on the owner of the bare global alias.
    private final class RoutingIdentity: @unchecked Sendable {
        private let lock = NSLock()
        private var defaultGlobalAgentID: String?

        init(defaultGlobalAgentID: String?) {
            self.defaultGlobalAgentID = Self.normalized(defaultGlobalAgentID)
        }

        func update(defaultGlobalAgentID: String?) {
            self.lock.withLock {
                self.defaultGlobalAgentID = Self.normalized(defaultGlobalAgentID)
            }
        }

        func currentAgentID() -> String? {
            self.lock.withLock { self.defaultGlobalAgentID }
        }

        private static func normalized(_ agentID: String?) -> String? {
            let normalized = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            return normalized?.isEmpty == false ? normalized : nil
        }
    }

    typealias SessionTarget = OpenClawChatSessionTarget

    let connection: GatewayConnection
    let outboxGatewayID: String?
    private let routingIdentity: RoutingIdentity

    init(
        connection: GatewayConnection = .shared,
        outboxGatewayID: String? = nil,
        defaultGlobalAgentID: String? = nil)
    {
        self.connection = connection
        self.outboxGatewayID = outboxGatewayID
        self.routingIdentity = RoutingIdentity(defaultGlobalAgentID: defaultGlobalAgentID)
    }

    func updateDefaultGlobalAgentID(_ agentID: String?) {
        self.routingIdentity.update(defaultGlobalAgentID: agentID)
    }

    func currentOutboxGatewayMatchesConnection() async -> Bool {
        guard self.connection === GatewayConnection.shared,
              let outboxGatewayID
        else { return true }
        let currentGatewayID = await MainActor.run { MacChatTranscriptCache.currentGatewayID() }
        return currentGatewayID == outboxGatewayID
    }

    func requireCurrentOutboxGateway() async throws {
        guard await self.currentOutboxGatewayMatchesConnection() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
    }

    func sessionTarget(for sessionKey: String, overrideAgentID: String? = nil) -> SessionTarget {
        OpenClawChatSessionTarget.resolve(
            sessionKey,
            selectedAgentID: self.routingIdentity.currentAgentID(),
            overrideAgentID: overrideAgentID,
            policy: .preserveBareKeys)
    }

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        let target = self.sessionTarget(for: sessionKey)
        return try await self.connection.chatHistory(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? {
        guard let lease = await self.connection.captureServerLease() else { return nil }
        return await self.connection.supportsServerMethod(method, ifCurrentServerLease: lease)
    }

    func fetchProgressCard(sessionKey: String, agentID: String?) async throws -> ProgressCard? {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.progressCardGet(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        guard let route = await self.connection.captureServerLease() else { throw CancellationError() }
        if request.params["agentId"] != nil {
            guard let supported = await self.connection.supportsServerCapability(
                .progressCardAgentScope,
                ifCurrentServerLease: route) else { throw CancellationError() }
            guard supported else {
                throw OpenClawChatProgressCardError.ownerScopeUnavailable
            }
        }
        let data = try await self.connection.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: route)
        return try OpenClawChatGatewayPayloadCodec.decodeProgressCard(
            data,
            agentID: OpenClawChatSessionKey.agentID(from: target.sessionKey) ?? target.agentID)
    }

    func requestFullMessage(sessionKey: String, messageID: String) async throws -> OpenClawChatMessage? {
        let target = self.sessionTarget(for: sessionKey)
        let request = try Self.fullMessageRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            messageID: messageID)
        let data = try await connection.request(request)
        let result = try JSONDecoder().decode(ChatMessageGetResult.self, from: data)
        guard result.ok, let encodedMessage = result.message else { return nil }
        return try JSONDecoder().decode(
            OpenClawChatMessage.self,
            from: JSONEncoder().encode(encodedMessage))
    }

    static func fullMessageRequest(
        sessionKey: String,
        agentID: String?,
        messageID: String) throws -> OpenClawChatGatewayRequest
    {
        let params = ChatMessageGetParams(
            sessionkey: sessionKey,
            agentid: agentID,
            messageid: messageID,
            maxchars: 500_000)
        let encoded = try JSONEncoder().encode(params)
        return try OpenClawChatGatewayRequest(
            method: "chat.message.get",
            params: JSONDecoder().decode([String: AnyCodable].self, from: encoded),
            timeoutMs: 15000)
    }

    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    {
        // Node mode may still own a different Gateway; widgets follow this chat connection.
        await OpenClawChatWidgetURLResolver.resolveResource(
            target: path,
            replacing: failedResource,
            currentSurfaceRoutes: {
                await (node: nil, operatorSurface: self.connection.canvasPluginSurfaceRoute())
            },
            refreshNodeSurfaceRoute: { _ in nil },
            refreshOperatorSurfaceRoute: { observed in
                await self.connection.refreshCanvasPluginSurfaceRoute(replacing: observed?.url)
            })
    }

    func resolveInlineWidgetURL(path: String, replacing failedURL: URL?) async -> URL? {
        await self.resolveInlineWidgetResource(
            path: path,
            replacing: failedURL.map { OpenClawChatWidgetResource(url: $0) })?.url
    }

    func listModels(agentID: String?) async throws -> [OpenClawChatModelChoice] {
        do {
            let data = try await connection.request(OpenClawChatGatewayRequests.modelsList(agentID: agentID))
            return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(data)
        } catch {
            webChatSwiftLogger.warning(
                "models.list failed; hiding model picker: \(error.localizedDescription, privacy: .public)")
            return []
        }
    }

    func acquireModelSignInContext(agentID: String?) async -> OpenClawChatModelSignInContext? {
        guard let lease = await self.connection.captureServerLease(),
              await self.connection.supportsServerMethod("models.authLogin", ifCurrentServerLease: lease) == true,
              let agentID = agentID ?? self.routingIdentity.currentAgentID()
        else { return nil }
        let connection = self.connection
        return OpenClawChatModelSignInContext(
            agentID: agentID,
            request: { method, params in
                try await connection.request(
                    method: method, params: params, timeoutMs: 26 * 60 * 1000, ifCurrentServerLease: lease)
            },
            isCurrent: { await connection.isCurrentServerLease(lease) })
    }

    func loadModelCatalog(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        let lease = try await self.connection.acquireServerLease()
        guard await self.connection.supportsServerCapability(
            .publishedModelCatalog, ifCurrentServerLease: lease) == true
        else {
            return OpenClawChatModelCatalogSnapshot(choices: [], availabilityIsSessionScoped: false)
        }
        let request = OpenClawChatGatewayRequests.modelsList(agentID: agentID, sessionKey: sessionKey)
        let data = try await self.connection.request(
            method: request.method,
            params: request.params,
            timeoutMs: request.timeoutMs,
            ifCurrentServerLease: lease)
        return try OpenClawChatGatewayPayloadCodec.decodeModelCatalog(data)
    }

    func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease? {
        guard let lease = await connection.captureServerLease() else { return nil }
        let transport = self
        return OpenClawChatSwarmRouteLease(
            isEnabled: { sessionKey in
                try await transport.isSwarmEnabled(sessionKey: sessionKey, serverLease: lease)
            },
            listChildSessions: { parentKey in
                try await transport.listChildSessions(parentKey: parentKey, serverLease: lease)
            })
    }

    func isSwarmEnabled(sessionKey: String) async throws -> Bool {
        try await self.isSwarmEnabled(sessionKey: sessionKey, serverLease: nil)
    }

    private func isSwarmEnabled(
        sessionKey: String,
        serverLease: GatewayConnection.ServerLease?) async throws -> Bool
    {
        let request = OpenClawChatGatewayRequests.chatMetadata(
            sessionKey: sessionKey,
            fallbackAgentID: self.routingIdentity.currentAgentID())
        let data: Data = if let serverLease {
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        } else {
            try await self.connection.request(request)
        }
        return try JSONDecoder().decode(OpenClawChatMetadataCapabilities.self, from: data).swarmEnabled
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let request = self.sessionsListRequest(
            limit: limit,
            search: search,
            archived: archived)
        let data = try await connection.request(request)
        let decoded = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        let mainSessionKey = await connection.cachedMainSessionKey()
        let defaults = decoded.defaults.map {
            OpenClawChatSessionsDefaults(
                modelProvider: $0.modelProvider,
                model: $0.model,
                contextTokens: $0.contextTokens,
                thinkingLevels: $0.thinkingLevels,
                thinkingOptions: $0.thinkingOptions,
                thinkingDefault: $0.thinkingDefault,
                mainSessionKey: mainSessionKey)
        } ?? OpenClawChatSessionsDefaults(
            model: nil,
            contextTokens: nil,
            mainSessionKey: mainSessionKey)
        return OpenClawChatSessionsListResponse(
            ts: decoded.ts,
            path: decoded.path,
            count: decoded.count,
            totalCount: decoded.totalCount,
            offset: decoded.offset,
            nextOffset: decoded.nextOffset,
            hasMore: decoded.hasMore,
            defaults: defaults,
            sessions: decoded.sessions)
    }

    func sessionsListRequest(
        limit: Int?,
        search: String?,
        archived: Bool) -> OpenClawChatGatewayRequest
    {
        OpenClawChatGatewayRequests.sessionsList(
            limit: limit,
            search: search,
            archived: archived,
            agentID: self.routingIdentity.currentAgentID())
    }

    func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry] {
        try await self.listChildSessions(parentKey: parentKey, serverLease: nil)
    }

    private func listChildSessions(
        parentKey: String,
        serverLease: GatewayConnection.ServerLease?) async throws -> [OpenClawChatSessionEntry]
    {
        try await OpenClawChatChildSessionPager.collect { offset in
            let request = OpenClawChatGatewayRequests.sessionsList(
                limit: 10000,
                search: nil,
                archived: false,
                includeGlobal: false,
                spawnedBy: parentKey,
                offset: offset,
                configuredAgentsOnly: true)
            let data: Data = if let serverLease {
                try await self.connection.request(
                    method: request.method,
                    params: request.params,
                    timeoutMs: request.timeoutMs,
                    ifCurrentServerLease: serverLease)
            } else {
                try await self.connection.request(request)
            }
            return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        }
    }

    func listAgents() async throws -> OpenClawChatAgentsListResponse? {
        guard let route = await connection.captureRoute() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let data = try await connection.request(
            OpenClawChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
    }

    func listSessionGroups() async throws -> OpenClawChatSessionGroupsResponse? {
        let data = try await connection.request(OpenClawChatGatewayRequests.sessionGroupsList())
        return try JSONDecoder().decode(OpenClawChatSessionGroupsResponse.self, from: data)
    }

    func putSessionGroups(names: [String]) async throws -> OpenClawChatSessionGroupsMutationResponse {
        let request = OpenClawChatGatewayRequests.sessionGroupsPut(names: names)
        let data = try await connection.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
    }

    func renameSessionGroup(
        name: String,
        to: String) async throws -> OpenClawChatSessionGroupsMutationResponse
    {
        let request = OpenClawChatGatewayRequests.sessionGroupsRename(name: name, to: to)
        let data = try await connection.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
    }

    func deleteSessionGroup(name: String) async throws -> OpenClawChatSessionGroupsMutationResponse {
        let request = OpenClawChatGatewayRequests.sessionGroupsDelete(name: name)
        let data = try await connection.request(request)
        return try JSONDecoder().decode(OpenClawChatSessionGroupsMutationResponse.self, from: data)
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        let target = self.sessionTarget(for: sessionKey)
        _ = try await self.patchSessionModel(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            model: model)
    }

    func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) async throws -> OpenClawChatModelPatchResult?
    {
        try await self.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            patch: patch,
            serverLease: nil)
    }

    private func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch,
        serverLease: GatewayConnection.ServerLease?) async throws -> OpenClawChatModelPatchResult?
    {
        let target = OpenClawChatSessionTarget.resolve(
            sessionKey,
            selectedAgentID: self.routingIdentity.currentAgentID(),
            overrideAgentID: agentID,
            policy: .preserveBareKeys)
        let request = Self.sessionSettingsRequest(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: patch)
        let data: Data = if let serverLease {
            try await self.connection.request(
                method: request.method,
                params: request.params,
                timeoutMs: request.timeoutMs,
                ifCurrentServerLease: serverLease)
        } else {
            try await self.connection.request(request)
        }
        return try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: data)
    }

    static func sessionSettingsRequest(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch) -> OpenClawChatGatewayRequest
    {
        OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: sessionKey,
            agentID: agentID,
            model: patch.model,
            thinkingLevel: patch.thinkingLevel,
            fastMode: patch.fastMode,
            verboseLevel: patch.verboseLevel)
    }

    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        guard let serverLease = await connection.captureServerLease() else { return nil }
        let transport = self
        return OpenClawChatSessionSettingsRouteLease { sessionKey, agentID, patch in
            try await transport.requireCurrentOutboxGateway()
            return try await transport.patchSessionSettings(
                sessionKey: sessionKey,
                agentID: agentID,
                patch: patch,
                serverLease: serverLease)
        }
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        return try await self.connection.chatSend(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendTargetedMessage(
            sessionKey: sessionKey,
            agentID: agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func sendTargetedMessage(
        sessionKey: String,
        agentID: String?,
        expectedSessionRoutingContract: String?,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let target = self.sessionTarget(for: sessionKey)
        try await self.requireCurrentOutboxGateway()
        guard let route = await connection.captureRoute(),
              let supportsRoutingContract = await connection.supportsServerCapability(
                  .chatSendRoutingContract,
                  ifCurrentRoute: route)
        else { throw OpenClawChatTransportSendError.notDispatched }
        // Outbox replay is capability-gated in acquireOutboxRouteLease. A
        // live send keeps its captured route on older gateways and omits the
        // unsupported atomic routing field.
        let guardedContract = OpenClawChatSessionRoutingContract.expectedValue(
            expectedSessionRoutingContract,
            serverSupportsGuard: supportsRoutingContract)
        return try await self.connection.chatSend(
            sessionKey: target.sessionKey,
            agentID: agentID ?? target.agentID,
            expectedSessionRoutingContract: guardedContract,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        guard self.outboxGatewayID != nil,
              await self.currentOutboxGatewayMatchesConnection()
        else { return .unavailable(reason: nil) }
        guard let route = await connection.captureRoute() else { return .unavailable(reason: nil) }
        guard let supportsRoutingContract = await connection.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(
                reason: OpenClawChatTransportUpgradeMessage.routingContract,
                allowsLiveSend: true)
        }
        let supportsSettingsCAS = await connection.supportsServerCapability(
            .sessionSettingsCAS,
            ifCurrentRoute: route) == true
        guard let routingIdentity = try? await connection.sessionRoutingIdentity(
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        let routingContract = routingIdentity.contract
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessageWithSettings: { sessionKey, agentID, settings, message, thinking, id, attachments in
                try await self.requireCurrentOutboxGateway()
                return try await self.connection.chatSend(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    expectedSessionRoutingContract: routingContract,
                    expectedSessionSettings: settings,
                    message: message,
                    thinking: thinking,
                    idempotencyKey: id,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await self.requireCurrentOutboxGateway()
                return try await self.connection.chatHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract,
            supportsSessionSettingsCAS: supportsSettingsCAS))
    }

    func synthesizeSpeech(text: String) async throws -> OpenClawChatSpeechClip {
        // Capture the lease before validating the pinned gateway: a gateway
        // switch after validation then fails the request via the lease guard
        // instead of re-routing the text to the newly selected gateway.
        guard let serverLease = await connection.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await self.requireCurrentOutboxGateway()
        return try await MacChatMessageSpeechClient.synthesize(
            text: text,
            serverLease: serverLease,
            connection: self.connection)
    }

    func loadMediaArtifact(
        sessionKey: String,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?
    {
        guard let serverLease = await connection.captureServerLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let target = self.sessionTarget(for: sessionKey)
        return try await self.connection.loadMediaArtifact(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            artifactId: artifactId,
            kind: kind,
            playback: playback,
            ifCurrentServerLease: serverLease)
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func createSession(
        key: String,
        label: String?,
        agentID explicitAgentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        let agentID = explicitAgentID
            ?? OpenClawChatSessionKey.agentID(from: key)
            ?? parentSessionKey.flatMap { OpenClawChatSessionKey.agentID(from: $0) }
            ?? self.routingIdentity.currentAgentID()
        let request = OpenClawChatGatewayRequests.createSession(
            key: key,
            agentID: agentID,
            label: label,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
        let data = try await connection.request(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
    }

    func patchSession(
        key: String,
        expectedSessionID: String? = nil,
        label: String??,
        category: String??,
        color: String?? = nil,
        pinned: Bool?,
        archived: Bool?,
        unread: Bool?) async throws
    {
        if let routeLease = await self.acquireSessionMutationRouteLease() {
            try await routeLease.patchSession(
                key: key,
                expectedSessionID: expectedSessionID,
                label: label,
                category: category,
                color: color,
                pinned: pinned,
                archived: archived,
                unread: unread)
            return
        }
        throw OpenClawChatTransportSendError.notDispatched
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        try await self.connection.healthOK(timeoutMs: timeoutMs)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int) async -> OpenClawChatRunObservation
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty,
              let route = await connection.captureRoute()
        else { return .unavailable }
        do {
            let request = OpenClawChatGatewayRequests.agentWait(runID: runId, timeoutMs: timeoutMs)
            let data = try await connection.request(
                request,
                ifCurrentRoute: route)
            return try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(data)
        } catch {
            webChatSwiftLogger.warning(
                "agent.wait failed runId=\(runId, privacy: .public) "
                    + "error=\(error.localizedDescription, privacy: .public)")
            return .unavailable
        }
    }

    func compactSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.compactSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await connection.request(request, retryTransportFailures: false)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                do {
                    try await self.connection.refresh()
                } catch {
                    webChatSwiftLogger.error("gateway refresh failed \(error.localizedDescription, privacy: .public)")
                }

                let stream = await self.connection.subscribe()
                var hasSeenSnapshot = false
                for await delivery in stream {
                    if Task.isCancelled {
                        return
                    }
                    guard delivery.isCurrent else { continue }
                    // A current disconnect retires chat health too; otherwise
                    // attachment capture mistakes the offline route for a healthy one.
                    guard let push = delivery.push else {
                        continuation.yield(.health(ok: false))
                        continue
                    }
                    if case .snapshot = push {
                        if hasSeenSnapshot {
                            continuation.yield(.routeChanged)
                        }
                        hasSeenSnapshot = true
                    }
                    if let evt = Self.mapPushToTransportEvent(push) {
                        continuation.yield(evt)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }

    static func mapPushToTransportEvent(_ push: GatewayPush) -> OpenClawChatTransportEvent? {
        switch push {
        case let .snapshot(hello):
            let ok = (try? JSONDecoder().decode(
                OpenClawGatewayHealthOK.self,
                from: JSONEncoder().encode(hello.snapshot.health)))?.ok ?? true
            return .health(ok: ok)

        case let .event(evt):
            return OpenClawChatGatewayPayloadCodec.event(from: evt)

        case .seqGap:
            return .seqGap
        }
    }
}

// MARK: - Window controller

private enum MacChatMessageSpeechError: LocalizedError {
    case invalidRequest
    case emptyAudio
    case unsupportedTransport

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Failed to encode tts.speak request"
        case .emptyAudio:
            "Gateway tts.speak returned empty audio"
        case .unsupportedTransport:
            "Gateway TTS is unavailable for this chat transport"
        }
    }
}

private enum MacChatMessageSpeechClient {
    private static let requestTimeoutMs: Double = 60000

    static func synthesize(
        text: String,
        serverLease: GatewayConnection.ServerLease,
        connection: GatewayConnection) async throws -> OpenClawChatSpeechClip
    {
        let encoded = try JSONEncoder().encode(TtsSpeakParams(text: text))
        guard let params = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw MacChatMessageSpeechError.invalidRequest
        }
        let responseData = try await connection.request(
            method: "tts.speak",
            params: params.mapValues(AnyCodable.init),
            timeoutMs: self.requestTimeoutMs,
            ifCurrentServerLease: serverLease)
        let response = try JSONDecoder().decode(TtsSpeakResult.self, from: responseData)
        guard let audioData = Data(base64Encoded: response.audiobase64), !audioData.isEmpty else {
            throw MacChatMessageSpeechError.emptyAudio
        }
        return OpenClawChatSpeechClip(
            data: audioData,
            outputFormat: response.outputformat,
            mimeType: response.mimetype,
            fileExtension: response.fileextension)
    }
}

@MainActor
private struct MacChatSurface: View {
    @State private var viewModel: OpenClawChatViewModel
    @State private var appState = AppStateStore.shared
    @State private var talkController = TalkModeController.shared
    @State private var audioInputCatalog = MacChatAudioInputCatalog()
    @State private var selectableAgents: [OpenClawChatAgentChoice] = []
    @State private var agentSelectionError: String?
    @State private var isLoadingSelectableAgents = false
    @AppStorage(OpenClawChatWindowShell.assistantReasoningDefaultsKey, store: AppDefaults.standard)
    private var showsReasoning = WebChatTracePreferences.displayOptions().contains(.reasoning)
    @AppStorage(OpenClawChatWindowShell.assistantToolActivityDefaultsKey, store: AppDefaults.standard)
    private var showsToolActivity = WebChatTracePreferences.displayOptions().contains(.toolActivity)

    private let usesPrimaryAppRuntime: Bool
    private let speech: OpenClawChatSpeechController
    private let voiceNoteRecorder: OpenClawVoiceNoteRecorder
    private let selectAgent: (String) -> Void
    private let applyRoutingIdentity: @MainActor (OpenClawChatSessionRoutingIdentity) async -> Void

    init(
        viewModel: OpenClawChatViewModel,
        usesPrimaryAppRuntime: Bool,
        speech: OpenClawChatSpeechController,
        voiceNoteRecorder: OpenClawVoiceNoteRecorder,
        selectAgent: @escaping (String) -> Void,
        applyRoutingIdentity: @escaping @MainActor (OpenClawChatSessionRoutingIdentity) async -> Void)
    {
        _viewModel = State(initialValue: viewModel)
        self.usesPrimaryAppRuntime = usesPrimaryAppRuntime
        self.speech = speech
        self.voiceNoteRecorder = voiceNoteRecorder
        self.selectAgent = selectAgent
        self.applyRoutingIdentity = applyRoutingIdentity
    }

    var body: some View {
        OpenClawChatWindowShell(
            viewModel: self.viewModel,
            userAccent: ColorHexSupport.color(fromHex: self.appState.effectiveAccentHex),
            displayOptions: self.displayOptions,
            emptyAssistantIntro: Self.emptyAssistantIntro,
            emptyAssistantPrompts: Self.emptyAssistantPrompts,
            talkControl: self.talkControl,
            voiceNoteControl: self.voiceNoteControl,
            speech: self.speech,
            mediaPlaybackAllowed: {
                !AppStateStore.shared.talkEnabled &&
                    !self.voiceNoteRecorder.ownsPendingChatAttachment
            })
            .safeAreaInset(edge: .top, spacing: 0) {
                self.agentSelectionBanner
            }
            .onAppear { self.audioInputCatalog.start() }
            .onDisappear { self.audioInputCatalog.stop() }
            .task(id: [
                self.viewModel.requiresExplicitAgentSelection ? "required" : "owned",
                self.viewModel.sessionRoutingContract ?? "",
                self.viewModel.healthOK ? "online" : "offline",
            ]) {
                await self.loadSelectableAgentsIfNeeded(force: true)
            }
    }

    @ViewBuilder
    private var agentSelectionBanner: some View {
        if self.viewModel.requiresExplicitAgentSelection {
            VStack(spacing: 0) {
                HStack(spacing: 10) {
                    Image(systemName: "person.crop.circle.badge.questionmark")
                        .foregroundStyle(.secondary)
                    Text("Choose an agent before sending this message.")
                        .font(.callout)
                    Spacer(minLength: 12)
                    if self.isLoadingSelectableAgents {
                        ProgressView()
                            .controlSize(.small)
                    } else if self.selectableAgents.isEmpty {
                        Button("Retry") {
                            Task { await self.loadSelectableAgentsIfNeeded(force: true) }
                        }
                    } else {
                        Menu("Choose Agent") {
                            ForEach(self.selectableAgents) { agent in
                                Button(agent.displayName) {
                                    self.selectAgent(agent.id)
                                    self.agentSelectionError = nil
                                }
                            }
                        }
                        .accessibilityIdentifier("chat-agent-selection-menu")
                    }
                }
                .padding(.horizontal, 12)
                .padding(.vertical, 8)
                if let agentSelectionError {
                    Text(agentSelectionError)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 6)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                Divider()
            }
            .background(.regularMaterial)
        }
    }

    private func loadSelectableAgentsIfNeeded(force: Bool = false) async {
        guard self.viewModel.requiresExplicitAgentSelection else {
            self.selectableAgents = []
            self.agentSelectionError = nil
            return
        }
        guard force || self.selectableAgents.isEmpty else { return }
        self.selectableAgents = []
        self.isLoadingSelectableAgents = true
        defer { self.isLoadingSelectableAgents = false }
        do {
            guard let response = try await self.viewModel.availableAgentsForSelection(),
                  let routingIdentity = response.routingIdentity
            else {
                self.selectableAgents = []
                self.agentSelectionError = String(localized: "No agents are available on this gateway.")
                return
            }
            try Task.checkCancellation()
            await self.applyRoutingIdentity(routingIdentity)
            try Task.checkCancellation()
            guard self.viewModel.sessionRoutingContract == routingIdentity.contract else { return }
            self.selectableAgents = response.agents
            self.agentSelectionError = self.selectableAgents.isEmpty
                ? String(localized: "No agents are available on this gateway.")
                : nil
        } catch {
            guard !Task.isCancelled else { return }
            self.agentSelectionError = error.localizedDescription
        }
    }

    private var talkControl: OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: self.usesPrimaryAppRuntime && self.appState.talkEnabled,
            isListening: self.usesPrimaryAppRuntime &&
                !self.talkController.isPaused && self.talkController.phase == .listening,
            isSpeaking: self.usesPrimaryAppRuntime &&
                !self.talkController.isPaused && self.talkController.phase == .speaking,
            isGatewayConnected: self.viewModel.healthOK,
            statusText: self.talkStatusText,
            // macOS exposes live phase but not the runtime's resolved TTS provider.
            // An empty label avoids presenting stale config as current state.
            providerLabel: "",
            level: self.talkController.level,
            partialTranscript: self.talkController.partialTranscript,
            recentTranscript: self.talkController.recentTranscripts,
            inputDevices: self.audioInputCatalog.chatDevices,
            selectedInputDeviceID: self.appState.voiceWakeMicID.isEmpty ? nil : self.appState.voiceWakeMicID,
            selectInputDevice: { deviceID in
                self.audioInputCatalog.select(deviceID, state: self.appState)
            },
            toggle: { sessionKey in
                guard self.usesPrimaryAppRuntime else { return }
                WebChatManager.shared.recordActiveSessionKey(sessionKey)
                Task {
                    await AppStateStore.shared.setTalkEnabled(!AppStateStore.shared.talkEnabled)
                }
            })
    }

    private var displayOptions: OpenClawChatDisplayOptions {
        var options: OpenClawChatDisplayOptions = []
        if self.showsReasoning {
            options.insert(.reasoning)
        }
        if self.showsToolActivity {
            options.insert(.toolActivity)
        }
        return options
    }

    private var voiceNoteControl: OpenClawChatVoiceNoteControl {
        OpenClawChatVoiceNoteControl(
            recorder: self.voiceNoteRecorder,
            // Enabled Talk Mode owns microphone admission through teardown,
            // even while its visible phase is thinking or speaking.
            isTalkActive: self.appState.talkEnabled)
    }

    private var talkStatusText: String {
        guard self.usesPrimaryAppRuntime else {
            return String(localized: "Talk mode uses the primary Gateway window")
        }
        guard self.appState.talkEnabled else { return String(localized: "Talk mode off") }
        if self.talkController.isPaused {
            return String(localized: "Talk mode paused")
        }
        return switch self.talkController.phase {
        case .idle: String(localized: "Talk mode ready")
        case .listening: String(localized: "Listening")
        case .thinking: String(localized: "Thinking")
        case .speaking: String(localized: "Speaking")
        }
    }

    private static let emptyAssistantIntro = String(localized: "What would you like to work on?")
    private static let emptyAssistantPrompts: [OpenClawChatView.StarterPrompt] = [
        .init(
            id: "check-status",
            title: String(localized: "Check OpenClaw status"),
            prompt: String(localized: "Summarize the current OpenClaw status and tell me what needs attention.")),
        .init(
            id: "show-capabilities",
            title: String(localized: "What can you do?"),
            prompt: String(localized: "Show me what you can help with on this Mac right now.")),
        .init(
            id: "catch-up",
            title: String(localized: "Catch me up"),
            prompt: String(localized: "Summarize what happened in my threads since yesterday.")),
    ]
}

/// Bridges the view model's session switches out of the controller. The view
/// model is constructed before `self`, so the closure targets this box and the
/// controller re-points it after initialization.
@MainActor
private final class WebChatSessionKeyRelay {
    var onChange: ((String) -> Void)?
}

@MainActor
private final class WebChatAgentSelectionRelay {
    private(set) var selectedAgentID: String?
    private(set) var routingIdentity: OpenClawChatSessionRoutingIdentity?
    var onSelection: ((String) -> Bool)?

    init(
        selectedAgentID: String?,
        routingIdentity: OpenClawChatSessionRoutingIdentity?)
    {
        self.selectedAgentID = WebChatRoute.normalizedAgentID(selectedAgentID)
        self.routingIdentity = routingIdentity
    }

    func updateRoutingIdentity(_ identity: OpenClawChatSessionRoutingIdentity) {
        self.routingIdentity = identity
    }

    func adoptSessionOwner(_ sessionKey: String) {
        if let agentID = OpenClawChatSessionKey.agentID(from: sessionKey) {
            self.selectedAgentID = agentID
        }
    }

    func select(_ agentID: String) {
        guard self.routingIdentity != nil,
              let normalized = WebChatRoute.normalizedAgentID(agentID)
        else { return }
        guard self.onSelection?(normalized) != false else { return }
        self.selectedAgentID = normalized
    }
}

@MainActor
final class WebChatSwiftUIWindowController: NSObject, NSWindowDelegate {
    private let sessionKey: String
    let viewModel: OpenClawChatViewModel
    private let contentController: NSViewController
    private let sessionKeyRelay: WebChatSessionKeyRelay
    private let agentSelectionRelay: WebChatAgentSelectionRelay
    private let speech: OpenClawChatSpeechController
    private let voiceNoteRecorder: OpenClawVoiceNoteRecorder
    private var routingIdentityTask: Task<Void, Never>?
    private var window: NSWindow?
    var onClosed: (() -> Void)?
    var onAgentIDChanged: ((String) -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?
    /// Fires when the hosted chat switches sessions in place (sidebar,
    /// composer picker, /new) so the owner can track what this surface shows.
    var onSessionKeyChanged: ((String) -> Void)?

    convenience init(
        sessionKey: String,
        agentID: String? = nil,
        initialDraft: String? = nil,
        connection: GatewayConnection = .shared,
        gatewayID: String? = nil,
        windowTitle: String = "OpenClaw Chat",
        windowAutosaveName: String = WebChatSwiftUILayout.windowFrameAutosaveName)
    {
        // Primary route changes retire the owning window synchronously,
        // so binding the cache identity at construction stays correct. One
        // store instance backs both the transcript cache and the offline
        // command outbox.
        let context: MacChatTranscriptCache.Context? = if let gatewayID {
            MacChatTranscriptCache.makeContext(gatewayID: gatewayID)
        } else {
            MacChatTranscriptCache.makeContext()
        }
        self.init(
            sessionKey: sessionKey,
            agentID: agentID,
            initialDraft: initialDraft,
            connection: connection,
            cachedRoutingIdentity: context?.routingIdentity,
            store: context?.store,
            windowTitle: windowTitle,
            windowAutosaveName: windowAutosaveName)
    }

    convenience init(
        sessionKey: String,
        agentID: String?,
        initialDraft: String? = nil,
        connection: GatewayConnection = .shared,
        cachedRoutingIdentity: OpenClawChatSessionRoutingIdentity?,
        store: OpenClawChatSQLiteTranscriptCache?,
        windowTitle: String = "OpenClaw Chat",
        windowAutosaveName: String = WebChatSwiftUILayout.windowFrameAutosaveName)
    {
        let explicitAgentID = WebChatRoute.normalizedAgentID(agentID)
        let initialSelectionRequired = cachedRoutingIdentity?.selectionRequired ?? (
            explicitAgentID == nil && OpenClawChatSessionKey.agentID(from: sessionKey) == nil)
        let effectiveAgentID = Self.effectiveAgentID(
            explicitAgentID: explicitAgentID,
            cachedDefaultAgentID: cachedRoutingIdentity?.defaultAgentID,
            selectionRequired: initialSelectionRequired)
        self.init(
            sessionKey: sessionKey,
            initialDraft: initialDraft,
            transport: MacGatewayChatTransport(
                connection: connection,
                outboxGatewayID: store?.gatewayID,
                defaultGlobalAgentID: effectiveAgentID),
            initialActiveAgentID: effectiveAgentID,
            explicitAgentID: explicitAgentID,
            initialRoutingIdentity: cachedRoutingIdentity,
            initialAgentSelectionRequired: initialSelectionRequired,
            transcriptCache: store,
            outbox: store,
            windowTitle: windowTitle,
            windowAutosaveName: windowAutosaveName)
    }

    init(
        sessionKey: String,
        initialDraft: String? = nil,
        transport: any OpenClawChatTransport,
        initialActiveAgentID: String? = nil,
        explicitAgentID: String? = nil,
        initialRoutingIdentity: OpenClawChatSessionRoutingIdentity? = nil,
        initialAgentSelectionRequired: Bool = false,
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil,
        windowTitle: String = "OpenClaw Chat",
        windowAutosaveName: String = WebChatSwiftUILayout.windowFrameAutosaveName)
    {
        self.sessionKey = sessionKey
        let initialActiveAgentID = OpenClawChatSessionKey.agentID(from: sessionKey)
            ?? WebChatRoute.normalizedAgentID(initialActiveAgentID)
        let voiceNoteRecorder = OpenClawVoiceNoteRecorder()
        voiceNoteRecorder.setCaptureAdmissionHandler {
            !AppStateStore.shared.talkEnabled
        }
        self.voiceNoteRecorder = voiceNoteRecorder
        let speech = OpenClawChatSpeechController { text in
            guard let transport = transport as? MacGatewayChatTransport else {
                throw MacChatMessageSpeechError.unsupportedTransport
            }
            return try await transport.synthesizeSpeech(text: text)
        }
        self.speech = speech
        let sessionKeyRelay = WebChatSessionKeyRelay()
        self.sessionKeyRelay = sessionKeyRelay
        let explicitAgentID = WebChatRoute.normalizedAgentID(explicitAgentID)
        let agentSelectionRelay = WebChatAgentSelectionRelay(
            selectedAgentID: OpenClawChatSessionKey.agentID(from: sessionKey) ?? explicitAgentID,
            routingIdentity: initialRoutingIdentity)
        self.agentSelectionRelay = agentSelectionRelay
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            activeAgentId: initialActiveAgentID,
            sessionRoutingContract: initialRoutingIdentity?.contract,
            agentSelectionRequired: initialAgentSelectionRequired,
            attachmentOwnerIsActive: { voiceNoteRecorder.ownsPendingChatAttachment },
            transcriptCache: transcriptCache,
            outbox: outbox,
            initialThinkingLevel: Self.persistedThinkingLevel(),
            initialVerboseLevel: Self.persistedVerboseLevel(),
            onSessionChanged: { key in
                sessionKeyRelay.onChange?(key)
            },
            onThinkingPreferenceChanged: { level in
                if let level {
                    AppDefaults.standard.set(level, forKey: webChatThinkingLevelDefaultsKey)
                } else {
                    AppDefaults.standard.removeObject(forKey: webChatThinkingLevelDefaultsKey)
                }
            },
            onVerbosePreferenceChanged: { level in
                Self.persistVerbosePreference(level)
            })
        if let initialDraft,
           !initialDraft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        {
            vm.input = initialDraft
        }
        self.viewModel = vm
        let gatewayTransport = transport as? MacGatewayChatTransport
        let usesPrimaryAppRuntime = gatewayTransport.map { $0.connection === GatewayConnection.shared } ?? false
        let applyRoutingIdentity: @MainActor @Sendable (OpenClawChatSessionRoutingIdentity) async
            -> Void = { [weak vm] identity in
                guard let vm else { return }
                let effectiveAgentID = Self.applyRefreshedRoutingIdentity(
                    routingIdentity: identity,
                    selectionRelay: agentSelectionRelay,
                    viewModel: vm)
                gatewayTransport?.updateDefaultGlobalAgentID(effectiveAgentID)
                if let store = transcriptCache as? OpenClawChatSQLiteTranscriptCache,
                   !usesPrimaryAppRuntime || store.gatewayID == MacChatTranscriptCache.currentGatewayID()
                {
                    await store.storeSessionRoutingIdentity(identity)
                }
            }
        // Custom transports have no Gateway owner; never attach them to the primary connection.
        if let gatewayTransport {
            let chatConnection = gatewayTransport.connection
            self.routingIdentityTask = Task { @MainActor [weak vm] in
                let pushes = await chatConnection.subscribe()
                for await delivery in pushes {
                    guard !Task.isCancelled, vm != nil else { return }
                    guard delivery.isCurrent, case .snapshot = delivery.push else { continue }
                    let routingIdentity = try? await chatConnection.sessionRoutingIdentity(
                        ifCurrentRoute: delivery.serverLease.route)
                    guard !Task.isCancelled else { return }
                    guard delivery.isCurrent else { continue }
                    if let routingIdentity {
                        await applyRoutingIdentity(routingIdentity)
                    }
                }
            }
        }
        // Full window: native split-view shell with sessions sidebar and
        // toolbar pickers bridged into the NSToolbar.
        let hosting = NSHostingController(rootView: MacChatSurface(
            viewModel: vm,
            usesPrimaryAppRuntime: usesPrimaryAppRuntime,
            speech: speech,
            voiceNoteRecorder: voiceNoteRecorder,
            selectAgent: { agentSelectionRelay.select($0) },
            applyRoutingIdentity: applyRoutingIdentity))
        self.contentController = hosting
        super.init()
        agentSelectionRelay.onSelection = { [weak self, weak vm] agentID in
            guard let self,
                  let vm,
                  let routingIdentity = self.agentSelectionRelay.routingIdentity
            else { return false }
            let selectedSessionKey = Self.sessionKey(
                afterSelecting: agentID,
                from: vm.sessionKey,
                sessionScope: routingIdentity.scope,
                mainSessionKey: routingIdentity.mainSessionKey,
                selectionRequired: routingIdentity.selectionRequired)
            if selectedSessionKey != vm.sessionKey {
                let draft = vm.input
                vm.switchSession(to: selectedSessionKey)
                guard vm.sessionKey == selectedSessionKey else { return false }
                vm.input = draft
            }
            (transport as? MacGatewayChatTransport)?.updateDefaultGlobalAgentID(agentID)
            vm.syncDeliveryIdentity(
                activeAgentId: agentID,
                sessionRoutingContract: routingIdentity.contract,
                agentSelectionRequired: routingIdentity.selectionRequired)
            vm.errorText = nil
            if self.agentSelectionRelay.selectedAgentID != agentID {
                self.onAgentIDChanged?(agentID)
            }
            return true
        }
        self.window = Self.makeWindow(
            contentViewController: self.contentController,
            title: windowTitle,
            autosaveName: windowAutosaveName)
        self.window?.delegate = self
        sessionKeyRelay.onChange = { [weak self, weak vm] key in
            // New Thread Options adopts through the view model, not the agent menu.
            // Record its canonical owner before a later snapshot refreshes the alias identity.
            agentSelectionRelay.adoptSessionOwner(key)
            if let agentID = OpenClawChatSessionKey.agentID(from: key) {
                vm?.syncActiveAgentId(agentID)
                (transport as? MacGatewayChatTransport)?.updateDefaultGlobalAgentID(agentID)
                self?.onAgentIDChanged?(agentID)
            }
            self?.onSessionKeyChanged?(key)
        }
    }

    func applyDraftIfEmpty(_ draft: String?) {
        guard self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let draft,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        self.viewModel.input = draft
    }

    func show() {
        guard let window else { return }
        self.ensureWindowSize()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.onVisibilityChanged?(true)
    }

    func cascade(from source: WebChatSwiftUIWindowController?) {
        guard let window,
              let sourceWindow = source?.window,
              sourceWindow !== window
        else { return }
        let bounds = sourceWindow.screen?.visibleFrame ?? NSScreen.main?.visibleFrame ?? .zero
        window.setFrame(
            WindowPlacement.cascadedFrame(from: sourceWindow.frame, in: bounds),
            display: false)
    }

    func close() {
        self.window?.close()
    }

    func windowWillClose(_ notification: Notification) {
        guard notification.object as? NSWindow === self.window else { return }
        self.routingIdentityTask?.cancel()
        self.routingIdentityTask = nil
        self.viewModel.detachTransport()
        self.onVisibilityChanged?(false)
        let onClosed = self.onClosed
        self.onClosed = nil
        self.window = nil
        onClosed?()
    }

    static func persistedThinkingLevel(defaults: UserDefaults = AppDefaults.standard) -> String? {
        let stored = defaults.string(forKey: webChatThinkingLevelDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        guard let stored,
              ["off", "minimal", "low", "medium", "high", "xhigh", "adaptive", "max", "ultra"].contains(stored)
        else {
            return nil
        }
        return stored
    }

    static func persistedVerboseLevel(defaults: UserDefaults = AppDefaults.standard) -> String? {
        let stored = defaults.string(forKey: webChatVerboseLevelDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return OpenClawChatViewModel.verboseLevelOptions.contains(stored ?? "") ? stored : nil
    }

    static func persistVerbosePreference(_ level: String?, defaults: UserDefaults = AppDefaults.standard) {
        if let level {
            defaults.set(level, forKey: webChatVerboseLevelDefaultsKey)
        } else {
            defaults.removeObject(forKey: webChatVerboseLevelDefaultsKey)
        }
    }

    static func effectiveAgentID(
        explicitAgentID: String?,
        cachedDefaultAgentID: String?,
        selectionRequired: Bool = false) -> String?
    {
        if let explicitAgentID = WebChatRoute.normalizedAgentID(explicitAgentID) {
            return explicitAgentID
        }
        guard !selectionRequired else { return nil }
        return WebChatRoute.normalizedAgentID(cachedDefaultAgentID)
    }

    private static func applyRefreshedRoutingIdentity(
        routingIdentity: OpenClawChatSessionRoutingIdentity,
        selectionRelay: WebChatAgentSelectionRelay,
        viewModel: OpenClawChatViewModel) -> String?
    {
        // Metadata refresh never retargets a conversation or moves its composer.
        // Canonical session ownership wins over any earlier banner selection.
        selectionRelay.adoptSessionOwner(viewModel.sessionKey)
        selectionRelay.updateRoutingIdentity(routingIdentity)
        let effectiveAgentID = Self.effectiveAgentID(
            explicitAgentID: selectionRelay.selectedAgentID,
            cachedDefaultAgentID: routingIdentity.defaultAgentID,
            selectionRequired: routingIdentity.selectionRequired)
        viewModel.syncDeliveryIdentity(
            activeAgentId: effectiveAgentID,
            sessionRoutingContract: routingIdentity.contract,
            agentSelectionRequired: routingIdentity.selectionRequired)
        return effectiveAgentID
    }

    static func sessionKey(
        afterSelecting agentID: String,
        from currentSessionKey: String,
        sessionScope: String?,
        mainSessionKey: String?,
        selectionRequired: Bool) -> String
    {
        guard let normalizedAgentID = WebChatRoute.normalizedAgentID(agentID),
              selectionRequired,
              sessionScope?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() != "global",
              let mainSessionKey = mainSessionKey?.trimmingCharacters(in: .whitespacesAndNewlines),
              !mainSessionKey.isEmpty
        else { return currentSessionKey }

        let current = currentSessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = current.lowercased()
        guard !current.isEmpty else { return currentSessionKey }

        if OpenClawChatSessionKey.agentID(from: current) != nil {
            let parts = current.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)
            guard parts.count == 3, !parts[2].isEmpty else { return currentSessionKey }
            return "agent:\(normalizedAgentID):\(parts[2])"
        }

        guard !lowercased.hasPrefix("agent:"),
              lowercased != "global",
              lowercased != "unknown"
        else { return currentSessionKey }

        let baseKey = lowercased == "main" ? mainSessionKey : current
        return "agent:\(normalizedAgentID):\(baseKey)"
    }

    private static func makeWindow(
        contentViewController: NSViewController,
        title: String,
        autosaveName: String) -> NSWindow
    {
        let window = WebChatWindow(
            contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.title = title
        window.pinnedTitle = title
        window.contentViewController = contentViewController
        // Attaching an NSHostingController resets scene bridging to `.all`;
        // opt back into toolbar items only so SwiftUI cannot restore the title.
        (contentViewController as? NSHostingController<MacChatSurface>)?
            .sceneBridgingOptions = [.toolbars]
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        // Keep the SwiftUI toolbar controls, but merge their unified row
        // with the traffic lights instead of stacking it below a title band.
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.isMovableByWindowBackground = true
        window.center()
        window.setFrameAutosaveName(autosaveName)
        WindowPlacement.ensureOnScreen(window: window, defaultSize: WebChatSwiftUILayout.windowSize)
        window.minSize = WebChatSwiftUILayout.windowMinSize
        return window
    }

    private func ensureWindowSize() {
        guard let window else { return }
        let current = window.frame.size
        let min = WebChatSwiftUILayout.windowMinSize
        if current.width < min.width || current.height < min.height {
            let frame = WindowPlacement.centeredFrame(size: WebChatSwiftUILayout.windowSize)
            window.setFrame(frame, display: false)
        }
    }

    #if DEBUG
    var _testWindow: NSWindow? {
        self.window
    }

    var _testSceneBridgingOptions: NSHostingSceneBridgingOptions? {
        (self.contentController as? NSHostingController<MacChatSurface>)?.sceneBridgingOptions
    }

    var _testSelectedAgentID: String? {
        self.agentSelectionRelay.selectedAgentID
    }

    func _testSelectAgent(_ agentID: String) {
        self.agentSelectionRelay.select(agentID)
    }

    func _testApplyRoutingIdentity(_ routingIdentity: OpenClawChatSessionRoutingIdentity) {
        _ = Self.applyRefreshedRoutingIdentity(
            routingIdentity: routingIdentity,
            selectionRelay: self.agentSelectionRelay,
            viewModel: self.viewModel)
    }
    #endif
}
