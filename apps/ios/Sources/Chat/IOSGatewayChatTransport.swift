import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

struct IOSGatewayChatTransport: OpenClawChatGatewayTransport {
    typealias RunActivityObservation = (
        binding: IOSNativeActionBinding,
        accepted: @MainActor @Sendable (_ runID: String, _ sessionID: String?) -> Void)
    typealias RunActivityCapture = @MainActor @Sendable (
        OpenClawChatSessionTarget, GatewayNodeSessionRoute) async throws -> RunActivityObservation?

    var chatGatewayAgentID: String? {
        self.globalAgentId
    }

    func requestChatGateway(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        try await self.requestChatGateway(request, ifCurrentRoute: nil)
    }

    func requestChatGateway(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?,
        distinguishPreDispatchRouteChange: Bool = false,
        completionPolicy: GatewayRequestCompletionPolicy = .requireCurrentRoute) async throws -> Data
    {
        if let nativeBinding {
            guard expectedRoute == nil || expectedRoute == nativeBinding.route else {
                throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
            }
            return try await nativeBinding.request(request, completionPolicy: completionPolicy)
        }
        return try await self.gateway.request(
            request,
            ifCurrentRoute: expectedRoute,
            distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange,
            completionPolicy: completionPolicy)
    }

    static let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "ios.chat.transport")
    let gateway: GatewayNodeSession
    private let widgetGateway: GatewayNodeSession?
    let globalAgentId: String?
    let outboxGatewayID: String?
    let nativeBinding: IOSNativeActionBinding?
    let captureRunActivity: RunActivityCapture?
    private let mediaArtifactLoader: IOSMediaArtifactLoader?

    var outboxRequiresSessionRoutingContract: Bool {
        true
    }

    init(
        gateway: GatewayNodeSession,
        widgetGateway: GatewayNodeSession? = nil,
        globalAgentId: String? = nil,
        outboxGatewayID: String? = nil,
        mediaArtifactLoader: IOSMediaArtifactLoader? = nil,
        nativeBinding: IOSNativeActionBinding? = nil,
        captureRunActivity: RunActivityCapture? = nil)
    {
        self.gateway = nativeBinding?.gateway ?? gateway
        self.widgetGateway = nativeBinding == nil ? widgetGateway : nil
        let normalized = globalAgentId?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        self.globalAgentId = nativeBinding?.session.agentID ?? (normalized?.isEmpty == false ? normalized : nil)
        self.outboxGatewayID = nativeBinding?.session.owner.gatewayID ?? GatewayStableIdentifier.exact(outboxGatewayID)
        self.mediaArtifactLoader = mediaArtifactLoader
        self.nativeBinding = nativeBinding
        self.captureRunActivity = captureRunActivity
    }

    static func captureRunActivityBinding(
        gateway: GatewayNodeSession,
        route: GatewayNodeSessionRoute,
        target: SessionTarget,
        nativeBinding: IOSNativeActionBinding? = nil) async throws -> IOSNativeActionBinding?
    {
        try Task.checkCancellation()
        guard await gateway.currentRoute() == route else {
            throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
        }
        let profileBinding = await gateway.supportsServerCapability(.profileBinding, ifCurrentRoute: route)
        let activitySupported = await gateway.supportsServerMethod("push.liveActivity.prepare", ifCurrentRoute: route)
        let gatewayID = await gateway.currentGatewayID(ifCurrentRoute: route)
        try Task.checkCancellation()
        guard await gateway.currentRoute() == route else {
            throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
        }
        let agentID = Self.composerAgentID(for: target)
        if let nativeBinding {
            guard nativeBinding.gateway === gateway, nativeBinding.route == route,
                  gatewayID?.utf8.elementsEqual(nativeBinding.session.owner.gatewayID.utf8) == true,
                  agentID?.utf8.elementsEqual(nativeBinding.session.agentID.utf8) == true,
                  nativeBinding.session.sessionKey.utf8.elementsEqual(target.sessionKey.utf8)
            else { throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch }
        }
        guard profileBinding == true, activitySupported == true,
              let gatewayID, let agentID
        else { return nil }
        let ownerGateway = OpenClawChatNativeActionGateway(
            gatewayID: gatewayID,
            gatewayName: gatewayID,
            supportsProfileBinding: {
                await gateway.supportsServerCapability(.profileBinding, ifCurrentRoute: route) == true
            },
            request: { request, expectedProfileId in
                try await gateway.request(
                    request,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true,
                    expectedProfileId: expectedProfileId)
            },
            isCurrent: { await gateway.currentRoute(ifGatewayID: gatewayID) == route })
        let owner = try await ownerGateway.owner(expected: nativeBinding?.session.owner)
        try Task.checkCancellation()
        // Capture only the send owner. The broader native capture also loads
        // roster/media state, neither of which belongs on this dispatch path.
        return IOSNativeActionBinding(
            session: .init(owner: owner, agentID: agentID, sessionKey: target.sessionKey),
            gateway: gateway,
            route: route,
            sessionRoutingContract: nativeBinding?.sessionRoutingContract)
    }

    func acquireOutboxRouteLease() async -> OpenClawChatTransportRouteLeaseResult {
        guard self.outboxGatewayID != nil,
              let route = await self.currentSessionMutationRoute()
        else { return .unavailable(reason: nil) }
        return await self.acquireOutboxRouteLease(ifCurrentRoute: route)
    }

    func acquireOutboxRouteLease(
        ifCurrentRoute route: GatewayNodeSessionRoute) async -> OpenClawChatTransportRouteLeaseResult
    {
        if let nativeBinding {
            do {
                guard route == nativeBinding.route else {
                    return .unavailable(reason: IOSNativeActionBinding.unavailableReason)
                }
                try await nativeBinding.requireAvailable()
            } catch is GatewayNodeSessionRequestError {
                return .unavailable(reason: IOSNativeActionBinding.unavailableReason)
            } catch {
                return .unavailable(reason: error.localizedDescription)
            }
        }
        guard let outboxGatewayID, await gateway.currentRoute(ifGatewayID: outboxGatewayID) == route else {
            return .unavailable(reason: "The selected Gateway connection changed.")
        }
        guard let supportsRoutingContract = await gateway.supportsServerCapability(
            .chatSendRoutingContract,
            ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        guard supportsRoutingContract else {
            return .unavailable(
                reason: OpenClawChatTransportUpgradeMessage.routingContract,
                allowsLiveSend: true)
        }
        let supportsSettingsCAS = await gateway.supportsServerCapability(
            .sessionSettingsCAS,
            ifCurrentRoute: route) == true
        let transport = self
        guard let routingContract = try? await transport.sessionRoutingContract(ifCurrentRoute: route)
        else { return .unavailable(reason: nil) }
        return .available(OpenClawChatTransportRouteLease(
            sendTargetedMessageWithSettings: { key, agent, settings, text, thinking, id, attachments in
                try await transport.sendMessage(
                    sessionKey: key,
                    agentID: agent,
                    expectedSessionRoutingContract: routingContract,
                    expectedSessionSettings: settings,
                    message: text,
                    thinking: thinking,
                    idempotencyKey: id,
                    attachments: attachments,
                    ifCurrentRoute: route,
                    distinguishPreDispatchRouteChange: true)
            },
            requestTargetedHistory: { sessionKey, agentID in
                try await transport.requestHistory(
                    sessionKey: sessionKey,
                    agentID: agentID,
                    ifCurrentRoute: route)
            },
            sessionRoutingContract: routingContract,
            supportsSessionSettingsCAS: supportsSettingsCAS))
    }

    func acquireSwarmRouteLease() async -> OpenClawChatSwarmRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        return OpenClawChatSwarmRouteLease(
            isEnabled: { sessionKey in
                try await transport.isSwarmEnabled(sessionKey: sessionKey, ifCurrentRoute: route)
            },
            listChildSessions: { parentKey in
                try await transport.listChildSessions(parentKey: parentKey, ifCurrentRoute: route)
            })
    }

    func acquireSessionSettingsRouteLease() async -> OpenClawChatSessionSettingsRouteLease? {
        let route = await currentSessionMutationRoute()
        guard let route else { return nil }
        let transport = self
        return OpenClawChatSessionSettingsRouteLease { sessionKey, agentID, patch in
            try await transport.patchSessionSettings(
                sessionKey: sessionKey,
                agentID: agentID,
                patch: patch,
                ifCurrentRoute: route)
        }
    }

    func acquireSessionMutationRouteLease() async -> OpenClawChatSessionMutationRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let unreadAckContract = await gateway.supportsServerCapability(
            .sessionUnreadAckContract,
            ifCurrentRoute: route)
        let transport = self
        return OpenClawChatSessionMutationRouteLease(
            sessionTarget: { transport.sessionTarget(for: $0) },
            unreadAckContract: unreadAckContract,
            request: { request in
                try await transport.requestSessionMutation(request, ifCurrentRoute: route)
            })
    }

    func acquireNewSessionRouteLease() async -> OpenClawChatNewSessionRouteLease? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        let transport = self
        let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data = { request in
            try await transport.requestSessionMutation(request, ifCurrentRoute: route)
        }
        return OpenClawChatNewSessionRouteLease(
            listAgents: {
                let data = try await request(OpenClawChatGatewayRequests.agentsList())
                return try OpenClawChatGatewayPayloadCodec.decodeAgentsList(data)
            },
            createSession: { key, label, agentID, parentSessionKey, worktree, worktreeBaseRef in
                let createRequest = transport.createSessionRequest(
                    key: key,
                    label: label,
                    agentID: agentID,
                    parentSessionKey: parentSessionKey,
                    worktree: worktree,
                    worktreeBaseRef: worktreeBaseRef)
                let data = try await request(createRequest)
                return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: data)
            })
    }

    func currentSessionMutationRoute() async -> GatewayNodeSessionRoute? {
        if let nativeBinding {
            return await nativeBinding.isCurrent() ? nativeBinding.route : nil
        }
        if let outboxGatewayID {
            return await self.gateway.currentRoute(ifGatewayID: outboxGatewayID)
        }
        return await self.gateway.currentRoute()
    }

    private func sessionRoutingContract(
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> String
    {
        let data = try await self.requestChatGateway(
            OpenClawChatGatewayRequests.agentsList(),
            ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeSessionRoutingIdentity(data).contract
    }

    typealias SessionTarget = OpenClawChatSessionTarget

    static func sessionTarget(
        for rawSessionKey: String,
        selectedAgentID: String?,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        OpenClawChatSessionTarget.resolve(
            rawSessionKey,
            selectedAgentID: selectedAgentID,
            overrideAgentID: overrideAgentID,
            policy: .scopeBareKeysToSelectedAgent)
    }

    func sessionTarget(
        for sessionKey: String,
        overrideAgentID: String? = nil) -> SessionTarget
    {
        if let nativeBinding, sessionKey.utf8.elementsEqual(nativeBinding.session.sessionKey.utf8) {
            return SessionTarget(sessionKey: sessionKey, agentID: overrideAgentID ?? nativeBinding.session.agentID)
        }
        return Self.sessionTarget(
            for: sessionKey,
            selectedAgentID: self.globalAgentId,
            overrideAgentID: overrideAgentID)
    }

    private func requestSessionMutation(
        _ request: OpenClawChatGatewayRequest,
        ifCurrentRoute route: GatewayNodeSessionRoute) async throws -> Data
    {
        try await self.requestChatGateway(
            request,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func createSession(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) async throws -> OpenClawChatCreateSessionResponse
    {
        let request = self.createSessionRequest(
            key: key,
            label: label,
            agentID: agentID,
            parentSessionKey: parentSessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
        let res = try await self.requestChatGateway(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: res)
    }

    private func createSessionRequest(
        key: String,
        label: String?,
        agentID: String?,
        parentSessionKey: String?,
        worktree: Bool?,
        worktreeBaseRef: String?) -> OpenClawChatGatewayRequest
    {
        let target = self.sessionTarget(for: key, overrideAgentID: agentID)
        let parentTarget = parentSessionKey.map { self.sessionTarget(for: $0) }
        let explicitAgentID = agentID?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased()
        return OpenClawChatGatewayRequests.createSession(
            key: target.sessionKey,
            agentID: explicitAgentID?.isEmpty == false
                ? explicitAgentID
                : target.agentID ?? parentTarget?.agentID,
            label: label,
            parentSessionKey: parentTarget?.sessionKey,
            worktree: worktree,
            worktreeBaseRef: worktreeBaseRef)
    }

    func listSessions(
        limit: Int?,
        search: String?,
        archived: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        let request = OpenClawChatGatewayRequests.sessionsList(
            limit: limit,
            search: search,
            archived: archived,
            agentID: self.globalAgentId)
        let res = try await self.requestChatGateway(request)
        return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: res)
    }

    func listChildSessions(parentKey: String) async throws -> [OpenClawChatSessionEntry] {
        try await self.listChildSessions(parentKey: parentKey, ifCurrentRoute: nil)
    }

    private func listChildSessions(
        parentKey: String,
        ifCurrentRoute route: GatewayNodeSessionRoute?) async throws -> [OpenClawChatSessionEntry]
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
            let data = try await self.requestChatGateway(request, ifCurrentRoute: route)
            return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)
        }
    }

    func listModels(agentID: String?) async throws -> [OpenClawChatModelChoice] {
        let response = try await self.requestChatGateway(OpenClawChatGatewayRequests.modelsList(agentID: agentID))
        return try OpenClawChatGatewayPayloadCodec.decodeModelChoices(response)
    }

    func loadModelCatalog(
        sessionKey: String,
        agentID: String?) async throws -> OpenClawChatModelCatalogSnapshot
    {
        guard let route = await self.currentSessionMutationRoute() else {
            throw CancellationError()
        }
        let sessionScoped = await self.gateway.supportsServerCapability(
            .sessionScopedChatMetadata,
            ifCurrentRoute: route) == true
        let request = if sessionScoped {
            OpenClawChatGatewayRequests.chatMetadata(
                sessionKey: sessionKey,
                fallbackAgentID: agentID ?? self.globalAgentId,
                includeSessionKey: true)
        } else {
            OpenClawChatGatewayRequests.modelsList(agentID: agentID)
        }
        let response = try await self.requestChatGateway(request, ifCurrentRoute: route)
        let choices = try sessionScoped
            ? OpenClawChatGatewayPayloadCodec.decodeChatMetadataModelChoices(response)
            : OpenClawChatGatewayPayloadCodec.decodeModelChoices(response)
        return OpenClawChatModelCatalogSnapshot(
            choices: choices,
            availabilityIsSessionScoped: sessionScoped)
    }

    func isSwarmEnabled(sessionKey: String) async throws -> Bool {
        try await self.isSwarmEnabled(sessionKey: sessionKey, ifCurrentRoute: nil)
    }

    private func isSwarmEnabled(
        sessionKey: String,
        ifCurrentRoute route: GatewayNodeSessionRoute?) async throws -> Bool
    {
        let request = OpenClawChatGatewayRequests.chatMetadata(
            sessionKey: sessionKey,
            fallbackAgentID: self.globalAgentId)
        let response = try await self.requestChatGateway(request, ifCurrentRoute: route)
        return try JSONDecoder().decode(OpenClawChatMetadataCapabilities.self, from: response).swarmEnabled
    }

    func setSessionModel(sessionKey: String, model: String?) async throws {
        _ = try await self.patchSessionModel(sessionKey: sessionKey, agentID: nil, model: model)
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
            ifCurrentRoute: nil)
    }

    private func patchSessionSettings(
        sessionKey: String,
        agentID: String?,
        patch: OpenClawChatSessionSettingsPatch,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatModelPatchResult?
    {
        let requiresSettingsContract = patch.expectedSessionID != nil ||
            patch.permissionMode != nil || patch.toolOverrides != nil
        let requiresSettingsCAS = patch.expectedPermissionMode != nil ||
            patch.expectedToolOverrides != nil || patch.permissionMode != nil || patch.toolOverrides != nil
        let fallbackRoute: GatewayNodeSessionRoute? = if requiresSettingsContract, expectedRoute == nil {
            await self.currentSessionMutationRoute()
        } else {
            nil
        }
        let settingsRoute = expectedRoute ?? fallbackRoute
        let settingsSupport = if let settingsRoute {
            await sessionSettingsSupport(ifCurrentRoute: settingsRoute)
        } else {
            (settingsContract: false, settingsCAS: false)
        }
        guard !requiresSettingsContract || settingsSupport.settingsContract else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        guard !requiresSettingsCAS || settingsSupport.settingsCAS else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.patchSessionSettings(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            expectedSessionID: patch.expectedSessionID,
            expectedPermissionMode: patch.expectedPermissionMode,
            expectedToolOverrides: patch.expectedToolOverrides,
            model: patch.model,
            thinkingLevel: patch.thinkingLevel,
            fastMode: patch.fastMode,
            verboseLevel: patch.verboseLevel,
            permissionMode: patch.permissionMode,
            toolOverrides: patch.toolOverrides,
            supportsSessionSettingsContract: settingsSupport.settingsContract,
            supportsSessionSettingsCAS: settingsSupport.settingsCAS)
        let response = if let settingsRoute {
            try await self.requestChatGateway(
                request,
                ifCurrentRoute: settingsRoute,
                distinguishPreDispatchRouteChange: true)
        } else {
            try await self.requestChatGateway(request)
        }
        return try Self.decodeModelPatchResult(response)
    }

    static func decodeModelPatchResult(_ data: Data) throws -> OpenClawChatModelPatchResult {
        try JSONDecoder().decode(OpenClawChatModelPatchResult.self, from: data)
    }

    func patchSession(
        key: String,
        expectedSessionID: String? = nil,
        label: String?? = nil,
        category: String?? = nil,
        color: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil) async throws
    {
        guard let routeLease = await acquireSessionMutationRouteLease() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try await routeLease.patchSession(
            key: key,
            expectedSessionID: expectedSessionID,
            label: label,
            category: category,
            color: color,
            pinned: pinned,
            archived: archived,
            unread: unread)
    }

    func forkSession(parentKey: String) async throws -> String {
        try await self.forkSession(parentKey: parentKey, fromLastCompleted: false)
    }

    func forkSession(parentKey: String, fromLastCompleted: Bool) async throws -> String {
        let target = self.sessionTarget(for: parentKey)
        let childAgentID = target.agentID ?? OpenClawChatSessionKey.agentID(from: target.sessionKey)
        let request = OpenClawChatGatewayRequests.forkSession(
            parentSessionKey: target.sessionKey,
            agentID: childAgentID,
            fromLastCompleted: fromLastCompleted)
        let response = try await self.requestChatGateway(request)
        return try JSONDecoder().decode(OpenClawChatCreateSessionResponse.self, from: response).key
    }

    func compactSession(sessionKey: String) async throws {
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.compactSession(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        let response = try await self.requestChatGateway(request)
        try OpenClawSessionsCompactResponse.requireSuccess(from: response)
    }

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        try await self.requestHistory(sessionKey: sessionKey, agentID: nil, ifCurrentRoute: nil)
    }

    func gatewayAdvertisesMethod(_ method: String) async -> Bool? {
        guard let route = await currentSessionMutationRoute() else { return nil }
        return await self.gateway.supportsServerMethod(method, ifCurrentRoute: route)
    }

    func fetchProgressCard(sessionKey: String, agentID: String?) async throws -> ProgressCard? {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.progressCardGet(
            sessionKey: target.sessionKey,
            agentID: target.agentID)
        guard let route = await self.currentSessionMutationRoute() else { throw CancellationError() }
        if request.params["agentId"] != nil {
            guard let supported = await self.gateway.supportsServerCapability(
                .progressCardAgentScope,
                ifCurrentRoute: route) else { throw CancellationError() }
            guard supported else {
                throw OpenClawChatProgressCardError.ownerScopeUnavailable
            }
        }
        let data = try await self.requestChatGateway(request, ifCurrentRoute: route)
        return try OpenClawChatGatewayPayloadCodec.decodeProgressCard(
            data,
            agentID: OpenClawChatSessionKey.agentID(from: target.sessionKey) ?? target.agentID)
    }

    func resolveInlineWidgetResource(
        path: String,
        replacing failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource?
    {
        let gateway = self.gateway
        let widgetGateway = self.widgetGateway
        let nativeBinding = self.nativeBinding
        if let nativeBinding {
            do {
                try await nativeBinding.requireAvailable()
            } catch {
                return nil
            }
        }
        let refreshOperatorSurface: @Sendable (GatewayCanvasHostRoute?) async -> GatewayCanvasHostRoute? = { observed in
            await gateway.refreshCanvasHostRoute(
                replacing: observed?.url,
                ifCurrentRoute: nativeBinding?.route,
                expectedProfileId: nativeBinding?.expectedProfileId)
        }
        let resource = await OpenClawChatWidgetURLResolver.resolveResource(
            target: path,
            replacing: failedResource,
            currentSurfaceRoutes: {
                let node = await widgetGateway?.currentCanvasHostRoute()
                var operatorSurface = if let nativeBinding {
                    await gateway.currentCanvasHostRoute(
                        ifCurrentRoute: nativeBinding.route,
                        expectedProfileId: nativeBinding.expectedProfileId)
                } else {
                    await gateway.currentCanvasHostRoute()
                }
                // Initial resolution only reads this callback. Acquire when its
                // owner has no cache; recovery's final read must not retry a denial.
                if failedResource == nil, node == nil, operatorSurface == nil {
                    operatorSurface = await refreshOperatorSurface(nil)
                }
                return (node: node, operatorSurface: operatorSurface)
            },
            // Prefer the device's node route; operator rotation covers clients
            // whose node role is unavailable or intentionally disabled.
            refreshNodeSurfaceRoute: { observed in
                await widgetGateway?.refreshCanvasHostRoute(replacing: observed?.url)
            },
            refreshOperatorSurfaceRoute: refreshOperatorSurface)
        guard !Task.isCancelled else { return nil }
        if let nativeBinding, await !nativeBinding.isCurrent() { return nil }
        return resource
    }

    func loadMediaArtifact(
        sessionKey: String,
        artifactId: String,
        kind: OpenClawChatMediaKind,
        playback: OpenClawChatPlaybackMode?) async throws -> OpenClawChatLoadedMedia?
    {
        guard kind.acceptsManagedArtifactID(artifactId),
              let mediaArtifactLoader,
              let route = await self.currentSessionMutationRoute(),
              let gatewayID = await gateway.currentGatewayID(ifCurrentRoute: route)
        else { return nil }
        let target = self.sessionTarget(for: sessionKey)
        let request = OpenClawChatGatewayRequests.artifactDownload(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            artifactId: artifactId)
        let data = try await self.requestChatGateway(request, ifCurrentRoute: route)
        let response = try JSONDecoder().decode(ArtifactsDownloadResult.self, from: data)
        guard await self.gateway.currentRoute() == route else { throw CancellationError() }
        let loaded = try await mediaArtifactLoader.load(
            response: response,
            kind: kind,
            playback: playback,
            expectedGatewayID: gatewayID)
        guard await self.gateway.currentRoute() == route else { throw CancellationError() }
        return loaded
    }

    func resolveInlineWidgetURL(path: String, replacing failedURL: URL?) async -> URL? {
        await self.resolveInlineWidgetResource(
            path: path,
            replacing: failedURL.map { OpenClawChatWidgetResource(url: $0) })?.url
    }

    func requestHistory(
        sessionKey: String,
        agentID: String? = nil,
        inputRunIDs: [String]? = nil,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async throws -> OpenClawChatHistoryPayload
    {
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let request = OpenClawChatGatewayRequests.history(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            inputRunIDs: inputRunIDs)
        let res = try await self.requestChatGateway(
            request,
            ifCurrentRoute: expectedRoute)
        let history = try JSONDecoder().decode(OpenClawChatHistoryPayload.self, from: res)
        if let nativeBinding {
            try OpenClawChatNativeRunInspection.requireSession(
                history,
                session: .init(
                    owner: nativeBinding.session.owner,
                    agentID: target.agentID ?? OpenClawChatSessionKey.agentID(from: target.sessionKey) ??
                        nativeBinding.session.agentID,
                    sessionKey: target.sessionKey))
        }
        return history
    }

    static func isUnsupportedHistoryInputRunIDsError(_ error: any Error) -> Bool {
        // Gateways through v2026.8.1 reject this optional field without a capability bit.
        // Remove this wire-contract fallback once the minimum Gateway is v2026.8.2;
        // local doctor cannot upgrade a remote Gateway.
        guard let error = error as? GatewayResponseError,
              error.method == "chat.history",
              error.code == "INVALID_REQUEST"
        else { return false }
        return error.message == "invalid chat.history params: at root: unexpected property 'inputRunIds'"
    }

    var supportsSlashCommandCatalog: Bool {
        true
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int) async -> OpenClawChatRunObservation
    {
        let route = await self.currentSessionMutationRoute()
        return await self.waitForRunCompletion(
            runId: rawRunId,
            timeoutMs: timeoutMs,
            ifCurrentRoute: route)
    }

    func waitForRunCompletion(
        runId rawRunId: String,
        timeoutMs: Int,
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?) async -> OpenClawChatRunObservation
    {
        let runId = rawRunId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !runId.isEmpty, let expectedRoute else { return .unavailable }

        do {
            let request = OpenClawChatGatewayRequests.agentWait(runID: runId, timeoutMs: timeoutMs)
            GatewayDiagnostics.log("agent.wait start runId=\(runId)")
            let res = try await self.requestChatGateway(
                request,
                ifCurrentRoute: expectedRoute)
            let observation = try OpenClawChatGatewayPayloadCodec.decodeAgentWaitObservation(res)
            GatewayDiagnostics.log("agent.wait completed runId=\(runId) observation=\(observation)")
            return observation
        } catch {
            Self.logger.warning("agent.wait failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("agent.wait failed runId=\(runId) error=\(error.localizedDescription)")
            return .unavailable
        }
    }

    func requestHealth(timeoutMs: Int) async throws -> Bool {
        let res = try await self.requestChatGateway(OpenClawChatGatewayRequests.health(timeoutMs: timeoutMs))
        return (try? JSONDecoder().decode(OpenClawGatewayHealthOK.self, from: res))?.ok ?? true
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { continuation in
            let task = Task {
                let subscription = await self.gateway.makeServerEventSubscription()
                defer {
                    subscription.cancel()
                    continuation.finish()
                }
                if let nativeBinding {
                    do {
                        try await nativeBinding.requireAvailable()
                    } catch is GatewayNodeSessionRequestError {
                        continuation.yield(.routeUnavailable(reason: IOSNativeActionBinding.unavailableReason))
                        return
                    } catch {
                        continuation.yield(.routeUnavailable(reason: error.localizedDescription))
                        return
                    }
                }
                for await evt in subscription.events {
                    if Task.isCancelled {
                        return
                    }
                    if let nativeBinding, await !(nativeBinding.accepts(evt)) {
                        continuation.yield(.routeUnavailable(reason: IOSNativeActionBinding.unavailableReason))
                        return
                    }
                    if let mapped = OpenClawChatGatewayPayloadCodec.event(from: evt) {
                        continuation.yield(mapped)
                    }
                }
            }

            continuation.onTermination = { @Sendable _ in
                task.cancel()
            }
        }
    }
}
