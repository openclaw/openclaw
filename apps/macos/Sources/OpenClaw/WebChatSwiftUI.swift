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
private final class WebChatWindow: ExperienceWindow {
    var pinnedTitle: String?
    weak var webConversation: OpenClawWebConversation?

    override func toggleToolbarShown(_ sender: Any?) {
        guard self.webConversation?.ownsConversation != true else { return }
        super.toggleToolbarShown(sender)
    }

    override func validateUserInterfaceItem(_ item: NSValidatedUserInterfaceItem) -> Bool {
        if self.webConversation?.ownsConversation == true, item.action == #selector(NSWindow.toggleToolbarShown(_:)) {
            return false
        }
        return super.validateUserInterfaceItem(item)
    }

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
        self.fixedAgentID ?? self.routingIdentity.currentAgentID()
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
            self.defaultGlobalAgentID = WebChatRoute.normalizedAgentID(defaultGlobalAgentID)
        }

        func update(defaultGlobalAgentID: String?) {
            self.lock.withLock {
                self.defaultGlobalAgentID = WebChatRoute.normalizedAgentID(defaultGlobalAgentID)
            }
        }

        func currentAgentID() -> String? {
            self.lock.withLock { self.defaultGlobalAgentID }
        }
    }

    typealias SessionTarget = OpenClawChatSessionTarget

    let connection: GatewayConnection
    let outboxGatewayID: String?
    private let routingIdentity: RoutingIdentity
    private let fixedAgentID: String?
    private let subscriptionOwner: UUID

    init(
        connection: GatewayConnection = .shared,
        outboxGatewayID: String? = nil,
        defaultGlobalAgentID: String? = nil,
        fixedAgentID: String? = nil,
        subscriptionOwner: UUID = UUID())
    {
        self.connection = connection
        self.outboxGatewayID = outboxGatewayID
        self.routingIdentity = RoutingIdentity(defaultGlobalAgentID: defaultGlobalAgentID)
        self.fixedAgentID = WebChatRoute.normalizedAgentID(fixedAgentID)
        self.subscriptionOwner = subscriptionOwner
    }

    func updateDefaultGlobalAgentID(_ agentID: String?) {
        self.routingIdentity.update(defaultGlobalAgentID: agentID)
    }

    func scoped(toAgentID agentID: String) -> (any OpenClawChatTransport)? {
        MacGatewayChatTransport(
            connection: self.connection,
            outboxGatewayID: self.outboxGatewayID,
            fixedAgentID: agentID,
            subscriptionOwner: self.subscriptionOwner)
    }

    func setActiveSessionKey(_ sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        try await self.connection.updateNativeChatSubscription(owner: self.subscriptionOwner, target: target)
    }

    func releaseActiveSessionSubscription() async {
        try? await self.connection.updateNativeChatSubscription(owner: self.subscriptionOwner, target: nil)
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
            selectedAgentID: self.chatGatewayAgentID,
            overrideAgentID: overrideAgentID ??
                (OpenClawChatSessionKey.agentID(from: sessionKey) == nil ? self.fixedAgentID : nil),
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

    func attachmentLimits() async -> GatewayAttachmentLimits? {
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        return await self.connection.currentAttachmentLimits()
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
            request, ifCurrentServerLease: route)
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
              let agentID = agentID ?? self.chatGatewayAgentID
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
            request, ifCurrentServerLease: lease)
        return try OpenClawChatGatewayPayloadCodec.decodeModelCatalog(data)
    }

    func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease? {
        guard let lease = await self.connection.captureServerLease() else { return nil }
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
            fallbackAgentID: self.chatGatewayAgentID)
        let data: Data = if let serverLease {
            try await self.connection.request(
                request, ifCurrentServerLease: serverLease)
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
        try await self.listSessions(
            limit: limit,
            search: search,
            archived: archived,
            agentID: self.chatGatewayAgentID)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool,
        agentID: String?) async throws -> OpenClawChatSessionsListResponse
    {
        let request = self.sessionsListRequest(
            limit: limit,
            search: search,
            archived: archived,
            agentID: agentID)
        let data = try await connection.request(request)
        var decoded = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(
            data, agentID: request.params["agentId"]?.value as? String)
        let mainSessionKey = await connection.cachedMainSessionKey()
        let defaults = OpenClawChatSessionsDefaults(
            modelProvider: decoded.defaults?.modelProvider,
            model: decoded.defaults?.model,
            contextTokens: decoded.defaults?.contextTokens,
            thinkingLevels: decoded.defaults?.thinkingLevels,
            thinkingOptions: decoded.defaults?.thinkingOptions,
            thinkingDefault: decoded.defaults?.thinkingDefault,
            mainSessionKey: mainSessionKey,
            modelSelectionTarget: decoded.defaults?.modelSelectionTarget,
            agentRuntime: decoded.defaults?.agentRuntime)
        decoded.defaults = defaults
        return decoded
    }

    func sessionsListRequest(
        limit: Int?,
        search: String?,
        archived: Bool,
        agentID: String? = nil) -> OpenClawChatGatewayRequest
    {
        OpenClawChatGatewayRequests.sessionsList(
            limit: limit,
            search: search,
            archived: archived,
            agentID: agentID ?? self.chatGatewayAgentID)
    }

    func listChildSessions(parentKey: String) async throws -> OpenClawChatChildSessionsResult {
        try await self.listChildSessions(parentKey: parentKey, serverLease: nil)
    }

    private func listChildSessions(
        parentKey: String,
        serverLease: GatewayConnection.ServerLease?) async throws -> OpenClawChatChildSessionsResult
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
                    request, ifCurrentServerLease: serverLease)
            } else {
                try await self.connection.request(request)
            }
            return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        }
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
        var settingsLease = serverLease
        if settingsLease == nil, patch.requiresSessionSettingsContract || patch.requiresSessionSettingsCAS {
            guard let capturedLease = await self.connection.captureServerLease() else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            settingsLease = capturedLease
        }
        let supportsSettingsContract = if let settingsLease {
            await self.connection.supportsServerCapability(
                .sessionSettingsContract, ifCurrentServerLease: settingsLease) == true
        } else {
            false
        }
        let supportsSettingsCAS = if let settingsLease {
            await self.connection.supportsServerCapability(
                .sessionSettingsCAS, ifCurrentServerLease: settingsLease) == true
        } else {
            false
        }
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = try OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            patch: patch,
            supportsSessionSettingsContract: supportsSettingsContract,
            supportsSessionSettingsCAS: supportsSettingsCAS)
        let data: Data = if let settingsLease {
            try await self.connection.request(
                request, ifCurrentServerLease: settingsLease)
        } else {
            try await self.connection.request(request)
        }
        return try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: data)
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
        return try await self.withNativeSendOwnership(target) {
            try await self.connection.chatSend(
                sessionKey: target.sessionKey,
                agentID: target.agentID,
                message: message,
                thinking: thinking,
                idempotencyKey: idempotencyKey,
                attachments: attachments)
        }
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
        return try await self.withNativeSendOwnership(.init(
            sessionKey: target.sessionKey, agentID: agentID ?? target.agentID))
        {
            try await self.connection.chatSend(
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
    }

    private func withNativeSendOwnership(
        _ target: SessionTarget,
        send: () async throws -> OpenClawChatSendResponse) async throws -> OpenClawChatSendResponse
    {
        let scope = await self.connection.conversationOwnershipScope(
            sessionKey: target.sessionKey, agentID: target.agentID)
        let ownership = self.connection.chatSendOwnership
        // Fence renderer handoffs through send completion. Independent Quick Chat and Talk sends keep their own owner.
        guard ownership.beginNative(scope) else { throw OpenClawChatSendOwnershipError.webOwned }
        defer { ownership.endNative(scope) }
        return try await send()
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
                return try await self.withNativeSendOwnership(.init(sessionKey: sessionKey, agentID: agentID)) {
                    try await self.connection.chatSend(
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
                }
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
        let encoded = try JSONEncoder().encode(TtsSpeakParams(text: text))
        guard let params = try JSONSerialization.jsonObject(with: encoded) as? [String: Any] else {
            throw MacChatMessageSpeechError.invalidRequest
        }
        let responseData = try await self.connection.request(
            method: "tts.speak",
            params: params.mapValues(AnyCodable.init),
            timeoutMs: 60000,
            ifCurrentServerLease: serverLease)
        return try OpenClawChatGatewayPayloadCodec.decodeSpeechClip(responseData)
    }

    func loadSourceContext() async -> OpenClawChatSourceContext? {
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        return await self.connection.loadSourceContext()
    }

    func loadSourceFavicon(host: String) async -> Data? {
        guard await self.currentOutboxGatewayMatchesConnection() else { return nil }
        return await self.connection.loadSourceFavicon(host: host)
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
            ?? self.chatGatewayAgentID
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
                var previousLease: GatewayConnection.ServerLease?
                for await delivery in stream {
                    if Task.isCancelled {
                        return
                    }
                    guard delivery.isCurrent, let push = delivery.push else { continue }
                    if case .snapshot = push {
                        try? await self.connection.updateNativeChatSubscription(owner: nil, target: nil)
                        guard delivery.isCurrent else { continue }
                        if let previousLease {
                            let event = await self.snapshotTransportEvent(previousLease: previousLease)
                            guard delivery.isCurrent else { continue }
                            continuation.yield(event)
                        }
                        previousLease = delivery.serverLease
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
    case unsupportedTransport

    var errorDescription: String? {
        switch self {
        case .invalidRequest:
            "Failed to encode tts.speak request"
        case .unsupportedTransport:
            "Gateway TTS is unavailable for this chat transport"
        }
    }
}

@MainActor
private struct MacChatSurface: View {
    let windowCommands: OpenClawChatWindowCommands
    let sidebarPresence: MacGatewaySidebarPresence?
    @State private var viewModel: OpenClawChatViewModel
    @State private var appState = AppStateStore.shared
    @State private var talkController = TalkModeController.shared
    @State private var audioInputCatalog = MacChatAudioInputCatalog()
    @AppStorage(OpenClawChatWindowShell.assistantReasoningDefaultsKey, store: AppDefaults.standard)
    private var showsReasoning = WebChatTracePreferences.displayOptions().contains(.reasoning)
    @AppStorage(OpenClawChatWindowShell.assistantToolActivityDefaultsKey, store: AppDefaults.standard)
    private var showsToolActivity = WebChatTracePreferences.displayOptions().contains(.toolActivity)

    private let conversationController: NativeConversationController?
    private let approvalQueue: ExecApprovalQueueStore?
    private let usesPrimaryAppRuntime: Bool
    private let speech: OpenClawChatSpeechController
    private let voiceNoteRecorder: OpenClawVoiceNoteRecorder

    init(
        viewModel: OpenClawChatViewModel,
        windowCommands: OpenClawChatWindowCommands,
        sidebarPresence: MacGatewaySidebarPresence?,
        conversationController: NativeConversationController?,
        usesPrimaryAppRuntime: Bool,
        approvalQueue: ExecApprovalQueueStore?,
        speech: OpenClawChatSpeechController,
        voiceNoteRecorder: OpenClawVoiceNoteRecorder)
    {
        _viewModel = State(initialValue: viewModel)
        self.windowCommands = windowCommands
        self.sidebarPresence = sidebarPresence
        self.conversationController = conversationController
        self.usesPrimaryAppRuntime = usesPrimaryAppRuntime
        self.approvalQueue = approvalQueue
        self.speech = speech
        self.voiceNoteRecorder = voiceNoteRecorder
    }

    var body: some View {
        OpenClawChatWindowShell(
            viewModel: self.viewModel,
            windowCommands: self.windowCommands,
            detailHost: self.conversationController.map { AnyView(NativeConversationView(controller: $0)) },
            focusWebComposer: self.conversationController.map { controller in { controller.focusComposer() } },
            userAccent: ColorHexSupport.color(fromHex: self.appState.effectiveAccentHex),
            attentionRequests: self.approvalQueue?.attentionRequests ?? [],
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
            .defaultAppStorage(AppDefaults.standard)
            .environment(\.openClawSidebarPeople, self.sidebarPresence?.people)
            .environment(\.openClawSidebarPeopleActions, self.sidebarPresence?.actions)
            .safeAreaInset(edge: .top) {
                if !self.viewModel.usesWebConversation, let error = self.conversationController?.error {
                    Text(error).font(.callout).foregroundStyle(.secondary).padding(8)
                }
            }
            .onAppear { self.audioInputCatalog.start() }
            .task {
                self.approvalQueue?.start()
                await self.approvalQueue?.refresh()
            }
            .onChange(of: self.viewModel.hasDraftToSend) { _, _ in
                self.conversationController?.nativeDraftChanged()
            }
            .onDisappear { self.audioInputCatalog.stop() }
    }

    private var talkControl: OpenClawChatTalkControl? {
        guard self.usesPrimaryAppRuntime else { return nil }
        return OpenClawChatTalkControl(
            isEnabled: self.appState.talkEnabled,
            isListening: !self.talkController.isPaused && self.talkController.phase == .listening,
            isSpeaking: !self.talkController.isPaused && self.talkController.phase == .speaking,
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
final class WebChatSwiftUIWindowController: NSObject, NSWindowDelegate {
    private let windowCommands = OpenClawChatWindowCommands()
    private let sidebarPresence: MacGatewaySidebarPresence?
    var onResignedKey: (() -> Void)?

    var isKeyChatWindow: Bool {
        self.window?.isKeyWindow == true && self.window?.isHiddenForExperience == false
    }

    func showCommandPalette() {
        guard self.isKeyChatWindow, self.window?.attachedSheet == nil else { return }
        self.windowCommands.isCommandPalettePresented = true
    }

    private let conversationController: NativeConversationController?
    private let viewModel: OpenClawChatViewModel
    private let contentController: NSViewController
    private var routingIdentityTask: Task<Void, Never>?
    private var window: ExperienceWindow?
    var onBecameKey: (() -> Void)?

    var isWindowOpen: Bool {
        guard let window, !window.isHiddenForExperience else { return false }
        return window.isVisible || window.isMiniaturized
    }

    var onClosed: (() -> Void)?
    var onVisibilityChanged: ((Bool) -> Void)?
    /// Fires when the hosted chat switches sessions in place (sidebar,
    /// composer picker, /new) so the owner can track what this surface shows.
    var onSessionTargetChanged: ((OpenClawChatSessionTarget) -> Void)?

    convenience init(
        sessionKey: String,
        agentID: String? = nil,
        initialDraft: String? = nil,
        connection: GatewayConnection = .shared,
        gatewayID: String? = nil,
        gatewayTarget: DashboardGatewayTarget = .primary,
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
            gatewayTarget: gatewayTarget,
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
        gatewayTarget: DashboardGatewayTarget? = nil,
        cachedRoutingIdentity: OpenClawChatSessionRoutingIdentity?,
        store: OpenClawChatSQLiteTranscriptCache?,
        windowTitle: String = "OpenClaw Chat",
        windowAutosaveName: String = WebChatSwiftUILayout.windowFrameAutosaveName)
    {
        let explicitAgentID = WebChatRoute.normalizedAgentID(agentID)
        let effectiveAgentID = Self.effectiveAgentID(
            explicitAgentID: explicitAgentID,
            cachedDefaultAgentID: cachedRoutingIdentity?.defaultAgentID)
        self.init(
            sessionKey: sessionKey,
            initialDraft: initialDraft,
            transport: MacGatewayChatTransport(
                connection: connection,
                outboxGatewayID: store?.gatewayID,
                defaultGlobalAgentID: effectiveAgentID),
            gatewayTarget: gatewayTarget,
            initialActiveAgentID: effectiveAgentID,
            explicitAgentID: explicitAgentID,
            initialSessionRoutingContract: cachedRoutingIdentity?.contract,
            transcriptCache: store,
            outbox: store,
            windowTitle: windowTitle,
            windowAutosaveName: windowAutosaveName)
    }

    init(
        sessionKey: String,
        initialDraft: String? = nil,
        transport: any OpenClawChatTransport,
        gatewayTarget: DashboardGatewayTarget? = nil,
        initialActiveAgentID: String? = nil,
        explicitAgentID: String? = nil,
        initialSessionRoutingContract: String? = nil,
        transcriptCache: (any OpenClawChatTranscriptCache)? = nil,
        outbox: (any OpenClawChatCommandOutbox)? = nil,
        windowTitle: String = "OpenClaw Chat",
        windowAutosaveName: String = WebChatSwiftUILayout.windowFrameAutosaveName)
    {
        let initialActiveAgentID = WebChatRoute.normalizedAgentID(initialActiveAgentID)
        let voiceNoteRecorder = OpenClawVoiceNoteRecorder()
        voiceNoteRecorder.setCaptureAdmissionHandler {
            !AppStateStore.shared.talkEnabled
        }
        let speech = OpenClawChatSpeechController { text in
            guard let transport = transport as? MacGatewayChatTransport else {
                throw MacChatMessageSpeechError.unsupportedTransport
            }
            return try await transport.synthesizeSpeech(text: text)
        }
        let sessionKeyRelay = WebChatSessionKeyRelay()
        let conversationOwner: OpenClawWebConversation? = gatewayTarget != nil &&
            !AppDefaults.standard.bool(forKey: nativeConversationForcedKey) ? OpenClawWebConversation() : nil
        let vm = OpenClawChatViewModel(
            sessionKey: sessionKey,
            transport: transport,
            webConversation: conversationOwner,
            activeAgentId: initialActiveAgentID,
            sessionRoutingContract: initialSessionRoutingContract,
            attachmentOwnerIsActive: { voiceNoteRecorder.ownsPendingChatAttachment },
            transcriptCache: transcriptCache,
            outbox: outbox,
            modelPickerStore: ChatModelPickerStore(defaults: AppDefaults.standard),
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
        vm.enableSidebarData()
        self.viewModel = vm
        self.conversationController = if let conversationOwner, let gatewayTarget {
            NativeConversationController(
                owner: conversationOwner,
                viewModel: vm,
                target: gatewayTarget,
                connection: (transport as? MacGatewayChatTransport)?.connection ?? .shared,
                outbox: outbox)
        } else {
            nil
        }
        let explicitAgentID = WebChatRoute.normalizedAgentID(explicitAgentID)
        let gatewayTransport = transport as? MacGatewayChatTransport
        self.sidebarPresence = gatewayTransport.map {
            MacGatewaySidebarPresence(connection: $0.connection, target: gatewayTarget ?? .primary)
        }
        let usesPrimaryAppRuntime = gatewayTransport.map { $0.connection === GatewayConnection.shared } ?? false
        // Custom transports have no Gateway owner; never attach them to the primary connection.
        if let gatewayTransport {
            let chatConnection = gatewayTransport.connection
            self.routingIdentityTask = Task { @MainActor [weak vm, windowCommands = self.windowCommands] in
                let pushes = await chatConnection.subscribe()
                for await delivery in pushes {
                    guard !Task.isCancelled, let vm else { return }
                    Self.configureSessionMenus(
                        windowCommands, connection: chatConnection, target: gatewayTarget, delivery: delivery)
                    guard delivery.isCurrent, case .snapshot = delivery.push else { continue }
                    let routingIdentity = try? await chatConnection.sessionRoutingIdentity(
                        ifCurrentRoute: delivery.serverLease.route)
                    guard !Task.isCancelled else { return }
                    guard delivery.isCurrent else { continue }
                    if let routingIdentity {
                        // An explicit navigation agent owns this window; gateway
                        // default refreshes only supply the fallback route.
                        let effectiveAgentID = Self.effectiveAgentID(
                            explicitAgentID: explicitAgentID,
                            cachedDefaultAgentID: routingIdentity.defaultAgentID)
                        gatewayTransport.updateDefaultGlobalAgentID(effectiveAgentID)
                        // Keep request and cache ownership in lockstep before the
                        // persistence await can admit a roster refresh.
                        vm.syncDeliveryIdentity(
                            activeAgentId: effectiveAgentID,
                            sessionRoutingContract: routingIdentity.contract)
                        if let store = transcriptCache as? OpenClawChatSQLiteTranscriptCache,
                           !usesPrimaryAppRuntime || store.gatewayID == MacChatTranscriptCache.currentGatewayID(),
                           let persistedIdentity = OpenClawChatSessionRoutingIdentity(
                               contract: routingIdentity.contract)
                        {
                            await store.storeSessionRoutingIdentity(persistedIdentity)
                        }
                    }
                }
            }
        }
        let hosting = NSHostingController(rootView: MacChatSurface(
            viewModel: vm,
            windowCommands: self.windowCommands,
            sidebarPresence: self.sidebarPresence,
            conversationController: self.conversationController,
            usesPrimaryAppRuntime: usesPrimaryAppRuntime,
            approvalQueue: gatewayTransport?.connection.approvalQueue,
            speech: speech,
            voiceNoteRecorder: voiceNoteRecorder))
        self.contentController = hosting
        super.init()
        self.window = Self.makeWindow(
            contentViewController: self.contentController,
            title: windowTitle,
            autosaveName: windowAutosaveName,
            webConversation: conversationOwner)
        self.window?.delegate = self
        self.conversationController?.onTitleChanged = { [weak self] title in
            guard let window = self?.window as? WebChatWindow else { return }
            window.pinnedTitle = title
            window.title = title
        }
        sessionKeyRelay.onChange = { [weak self, weak vm] _ in
            guard let vm else { return }
            self?.onSessionTargetChanged?(vm.currentSessionTarget)
        }
        self.sidebarPresence?.start()
    }

    static func configureSessionMenus(
        _ commands: OpenClawChatWindowCommands,
        connection: GatewayConnection,
        target: DashboardGatewayTarget?,
        delivery: GatewayConnection.PushDelivery)
    {
        if case .disconnected = delivery.event {
            commands.setSessionMenuConnection(nil)
            return
        }
        guard let target, !Task.isCancelled, delivery.isCurrent,
              case let .snapshot(hello) = delivery.push else { return }
        let lease = delivery.serverLease
        let base = hello.controluiurl.flatMap(URL.init(string:)) ?? lease.route.url
        var menuConnection = OpenClawSessionMenuConnection(
            hello: hello,
            local: target == .local || (target == .primary && AppStateStore.shared.connectionMode == .local),
            selfProfileID: hello.snapshot.presence.first {
                $0.instanceid == InstanceIdentity.instanceId && $0.reason != "disconnect"
            }?.user?["id"]?.value as? String,
            isCurrent: { connection.serverLeaseMatchesCurrentState(lease) },
            request: { try await connection.request($0, ifCurrentServerLease: lease) },
            link: { session, preview in
                guard connection.serverLeaseMatchesCurrentState(lease) else { return nil }
                return WebChatManager.sessionLink(
                    base: base, sessionKey: session.key, agentID: session.agentId, preview: preview)
            },
            openWindow: { session in
                guard connection.serverLeaseMatchesCurrentState(lease) else { return }
                WebChatManager.shared.openGatewayWindow(
                    for: target,
                    newWindow: true,
                    route: WebChatRoute(sessionKey: session.key, agentID: session.agentId),
                    sourceIsCurrent: { connection.serverLeaseMatchesCurrentState(lease) })
            })
        menuConnection.groupDefaultsBrowser = MacGatewayGroupDefaults.browser(connection: menuConnection)
        commands.setSessionMenuConnection(menuConnection)
    }

    var acceptsNativeDraft: Bool {
        !self.viewModel.usesWebConversation
    }

    func applyDraftIfEmpty(_ draft: String?) {
        guard self.acceptsNativeDraft, self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              let draft,
              !draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
        else { return }
        self.viewModel.input = draft
    }

    func show() {
        guard let window else { return }
        self.ensureWindowSize()
        window.isHiddenForExperience = false
        window.isExcludedFromWindowsMenu = false
        if window.isMiniaturized { AppActivation.shared.deminiaturize(window: window) }
        AppActivation.shared.makeKeyAndOrderFront(window: window)
        AppActivation.shared.activate()
        self.onBecameKey?()
        self.onVisibilityChanged?(true)
        self.conversationController?.present(visible: true, active: window.isKeyWindow)
    }

    func hide() {
        guard let window else { return }
        window.isHiddenForExperience = true
        window.isExcludedFromWindowsMenu = true
        if window.isMiniaturized { AppActivation.shared.deminiaturize(window: window) }
        window.orderOut(nil)
        self.onVisibilityChanged?(false)
        self.conversationController?.present(visible: false, active: false)
    }

    func windowDidBecomeKey(_ notification: Notification) {
        guard let window, notification.object as? NSWindow === window, !window.isHiddenForExperience else { return }
        self.windowCommands.refreshSessionMenus()
        self.onBecameKey?()
        self.conversationController?.present(visible: true, active: true)
    }

    func windowDidMiniaturize(_: Notification) {
        self.conversationController?.present(visible: false, active: false)
    }

    func windowDidDeminiaturize(_: Notification) {
        self.conversationController?.present(visible: true, active: self.window?.isKeyWindow == true)
    }

    func windowDidResignKey(_ notification: Notification) {
        guard notification.object as? NSWindow === self.window else { return }
        self.onResignedKey?()
        self.conversationController?.present(visible: self.isWindowOpen, active: false)
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
        self.sidebarPresence?.stop()
        self.routingIdentityTask?.cancel()
        self.routingIdentityTask = nil
        self.windowCommands.setSessionMenuConnection(nil)
        self.conversationController?.close()
        self.viewModel.detachTransport()
        self.window = nil
        self.onVisibilityChanged?(false)
        let onClosed = self.onClosed
        self.onClosed = nil
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
        cachedDefaultAgentID: String?) -> String?
    {
        WebChatRoute.normalizedAgentID(explicitAgentID)
            ?? WebChatRoute.normalizedAgentID(cachedDefaultAgentID)
    }

    private static func makeWindow(
        contentViewController: NSViewController,
        title: String,
        autosaveName: String,
        webConversation: OpenClawWebConversation?) -> ExperienceWindow
    {
        let window = WebChatWindow(
            contentRect: NSRect(origin: .zero, size: WebChatSwiftUILayout.windowSize),
            styleMask: [.titled, .closable, .resizable, .miniaturizable, .fullSizeContentView],
            backing: .buffered,
            defer: false)
        window.title = title
        window.pinnedTitle = title
        window.webConversation = webConversation
        if webConversation != nil {
            // As in Dashboard, keep a 52pt unified titlebar even with no detail
            // items. SwiftUI still supplies the sidebar's native controls.
            window.toolbar = NSToolbar(identifier: "ConversationWindowTitlebar")
        }
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

    var _testDraft: String {
        self.viewModel.input
    }
    #endif
}
