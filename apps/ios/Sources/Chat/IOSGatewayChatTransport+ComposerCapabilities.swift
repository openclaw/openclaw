import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

extension IOSGatewayChatTransport {
    var supportsComposerCapabilities: Bool {
        true
    }

    func loadComposerCapabilityCatalog(
        sessionKey: String,
        agentID: String?) async -> OpenClawChatComposerCapabilityCatalog
    {
        guard let route = await self.currentSessionMutationRoute() else {
            return OpenClawChatComposerCapabilityCatalog()
        }
        async let operatorScopes = self.gateway.currentOperatorScopes(ifCurrentRoute: route)
        async let patchMethodAdvertised = self.gateway.supportsServerMethod(
            "sessions.patch",
            ifCurrentRoute: route)
        async let settingsSupportRequest = self.sessionSettingsSupport(ifCurrentRoute: route)
        let scopes = await operatorScopes ?? []
        let canAdmin = scopes.contains("operator.admin")
        let canWrite = canAdmin || scopes.contains("operator.write")
        let canRead = canWrite || scopes.contains("operator.read")
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let targetAgentID = Self.composerAgentID(for: target)

        async let configRequest = self.composerResponse(
            OpenClawChatGatewayRequests.composerConfigGet(),
            method: "config.get",
            canRead: canRead,
            route: route)
        async let skillsRequest = self.composerResponse(
            OpenClawChatGatewayRequests.composerSkillsStatus(agentID: targetAgentID),
            method: "skills.status",
            canRead: canRead,
            route: route)
        async let toolsRequest = self.composerResponse(
            OpenClawChatGatewayRequests.composerToolsEffective(
                sessionKey: target.sessionKey,
                agentID: target.agentID),
            method: "tools.effective",
            canRead: canRead,
            route: route)
        let (
            configResponse,
            skillsResponse,
            toolsResponse,
            patchCapability,
            settingsSupport) = await (
            configRequest,
            skillsRequest,
            toolsRequest,
            patchMethodAdvertised,
            settingsSupportRequest)
        let patchAdvertised = patchCapability == true
        let sessionSettingsAvailable = settingsSupport.settingsContract && patchAdvertised

        guard await self.gateway.currentRoute() == route else {
            return OpenClawChatComposerCapabilityCatalog()
        }
        let configSurface = Self.decodeComposerResponse(configResponse, as: ComposerConfigSnapshot.self)
        let skillsSurface = Self.decodeComposerResponse(skillsResponse, as: SkillsStatusReport.self)
        let toolsSurface = Self.decodeComposerResponse(toolsResponse, as: ToolsEffectiveResult.self)
        let config = configSurface.value
        let skillsReport = skillsSurface.value
        let effectiveTools = toolsSurface.value
        let toolsByServer = Self.composerToolsByServer(effectiveTools)
        let noticesByServer = Self.composerNoticesByServer(effectiveTools)
        let configuredServers = config?.runtimeConfig.mcp?.servers ?? [:]
        let connectorNames = Set(configuredServers.keys).union(toolsByServer.keys).sorted()
        let failedSurfaces = [
            configSurface.failed ? String(localized: "Web Search and Connectors") : nil,
            skillsSurface.failed ? String(localized: "Skills") : nil,
            toolsSurface.failed ? String(localized: "Tool Access") : nil,
        ].compactMap(\.self)
        let failureMessage = failedSurfaces.isEmpty
            ? nil
            : String(
                format: String(localized: "Could not load: %@. Retry."),
                failedSurfaces.joined(separator: ", "))

        return OpenClawChatComposerCapabilityCatalog(
            sessionSettingsAvailable: sessionSettingsAvailable,
            modelMutationAvailable: Self.composerMutationAvailable(
                methodSupport: patchCapability,
                allowedByScope: canWrite),
            effortMutationAvailable: Self.composerMutationAvailable(
                methodSupport: patchCapability,
                allowedByScope: canAdmin),
            webSearchBaseEnabled: config?.runtimeConfig.tools?.web?.search?.enabled != false,
            webSearchAvailable: configSurface.loaded,
            skills: (skillsReport?.skills ?? []).map(Self.composerSkill).sorted { $0.name < $1.name },
            connectors: connectorNames.map { name in
                OpenClawChatComposerConnector(
                    name: name,
                    baseEnabled: configuredServers[name]?.enabled != false,
                    tools: toolsByServer[name] ?? [],
                    notice: noticesByServer[name])
            },
            skillsAvailable: skillsSurface.loaded,
            connectorsAvailable: configSurface.loaded,
            toolAccessAvailable: toolsSurface.loaded,
            permissionMutationAvailable: sessionSettingsAvailable && settingsSupport.settingsCAS &&
                patchAdvertised && canWrite,
            sessionSettingsCASAvailable: settingsSupport.settingsCAS,
            toolOverrideMutationAvailable: sessionSettingsAvailable && patchAdvertised &&
                settingsSupport.settingsCAS && canAdmin,
            toolOverrideMutationRequiresGatewayUpgrade: sessionSettingsAvailable &&
                !settingsSupport.settingsCAS,
            canSelectFullPermission: sessionSettingsAvailable && settingsSupport.settingsCAS &&
                patchAdvertised && canAdmin,
            loadFailureMessage: failureMessage)
    }

    func sessionSettingsSupport(
        ifCurrentRoute route: GatewayNodeSessionRoute) async -> (
        settingsContract: Bool,
        settingsCAS: Bool)
    {
        async let settingsContract = self.gateway.supportsServerCapability(
            .sessionSettingsContract,
            ifCurrentRoute: route)
        async let settingsCAS = self.gateway.supportsServerCapability(
            .sessionSettingsCAS,
            ifCurrentRoute: route)
        return await (settingsContract == true, settingsCAS == true)
    }

    static func composerMutationAvailable(methodSupport: Bool?, allowedByScope: Bool) -> Bool {
        methodSupport == nil || (methodSupport == true && allowedByScope)
    }

    static func composerAgentID(for target: OpenClawChatSessionTarget) -> String? {
        target.agentID ?? OpenClawChatSessionKey.agentID(from: target.sessionKey)
    }

    private func composerResponse(
        _ request: OpenClawChatGatewayRequest,
        method: String,
        canRead: Bool,
        route: GatewayNodeSessionRoute) async -> ComposerResponse
    {
        guard canRead,
              await self.gateway.supportsServerMethod(method, ifCurrentRoute: route) == true
        else { return .unavailable }
        do {
            let data = try await self.requestChatGateway(
                request,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            return .loaded(data)
        } catch {
            return .failed
        }
    }

    private static func decodeComposerResponse<T: Decodable>(
        _ response: ComposerResponse,
        as type: T.Type) -> ComposerSurface<T>
    {
        switch response {
        case let .loaded(data):
            do {
                let value = try JSONDecoder().decode(type, from: data)
                return .init(value: value, loaded: true, failed: false)
            } catch {
                return .init(value: nil, loaded: false, failed: true)
            }
        case .failed:
            return .init(value: nil, loaded: false, failed: true)
        case .unavailable:
            return .init(value: nil, loaded: false, failed: false)
        }
    }

    static func composerSkill(_ skill: SkillStatus) -> OpenClawChatComposerSkill {
        let missing = skill.missing
        let missingDependencies = !missing.bins.isEmpty || !missing.anyBins.isEmpty ||
            !missing.env.isEmpty || !missing.config.isEmpty || !missing.os.isEmpty
        return OpenClawChatComposerSkill(
            key: skill.skillKey,
            name: skill.name,
            baseEnabled: !skill.disabled,
            missingDependencies: missingDependencies,
            blocked: skill.blockedByAllowlist == true || skill.platformIncompatible == true,
            agentFiltered: skill.blockedByAgentFilter == true)
    }

    static func composerToolsByServer(
        _ result: ToolsEffectiveResult?) -> [String: [OpenClawChatComposerTool]]
    {
        var tools: [String: [OpenClawChatComposerTool]] = [:]
        for entry in result?.groups.flatMap(\.tools) ?? [] {
            guard (entry.source.value as? String) == "mcp",
                  let server = entry.mcpserver?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !server.isEmpty,
                  let name = entry.mcptoolname?.trimmingCharacters(in: .whitespacesAndNewlines),
                  !name.isEmpty
            else { continue }
            tools[server, default: []].append(OpenClawChatComposerTool(
                name: name,
                label: entry.label.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    ? name
                    : entry.label,
                baseEnabled: true,
                sessionDenied: entry.deniedbysession == true))
        }
        return tools.mapValues { values in
            Dictionary(grouping: values, by: \.name).values.compactMap(\.first).sorted { $0.name < $1.name }
        }
    }

    private static func composerNoticesByServer(_ result: ToolsEffectiveResult?) -> [String: String] {
        var notices: [String: String] = [:]
        for notice in result?.notices ?? [] {
            for server in notice.servers ?? [] where notices[server] == nil {
                notices[server] = notice.message
            }
        }
        return notices
    }

    func sendMessage(
        sessionKey: String,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: nil,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: nil)
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
        try await self.sendMessage(
            sessionKey: sessionKey,
            target: OpenClawChatSendTarget(
                agentID: agentID,
                expectedSessionRoutingContract: expectedSessionRoutingContract,
                expectedSessionSettings: nil),
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
    }

    func sendMessage(
        sessionKey: String,
        target: OpenClawChatSendTarget,
        message: String,
        thinking: String,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        let route = await self.currentSessionMutationRoute()
        guard let route,
              let supportsRoutingContract = await gateway.supportsServerCapability(
                  .chatSendRoutingContract,
                  ifCurrentRoute: route)
        else { throw OpenClawChatTransportSendError.notDispatched }
        let guardedContract = OpenClawChatSessionRoutingContract.expectedValue(
            target.expectedSessionRoutingContract,
            serverSupportsGuard: supportsRoutingContract)
        return try await self.sendMessage(
            sessionKey: sessionKey,
            agentID: target.agentID,
            expectedSessionRoutingContract: guardedContract,
            expectedSessionSettings: target.expectedSessionSettings,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments,
            ifCurrentRoute: route,
            distinguishPreDispatchRouteChange: true)
    }

    func sendMessage(
        sessionKey: String,
        agentID: String? = nil,
        expectedSessionRoutingContract: String? = nil,
        expectedSessionSettings: OpenClawChatSessionSettingsExpectation? = nil,
        message: String,
        thinking: String?,
        idempotencyKey: String,
        attachments: [OpenClawChatAttachmentPayload],
        ifCurrentRoute expectedRoute: GatewayNodeSessionRoute?,
        distinguishPreDispatchRouteChange: Bool = false) async throws -> OpenClawChatSendResponse
    {
        var requestRoute = expectedRoute ?? self.nativeBinding?.route
        let target = self.sessionTarget(for: sessionKey, overrideAgentID: agentID)
        let activityObservation: RunActivityObservation?
        do {
            if let captureRunActivity {
                if requestRoute == nil {
                    requestRoute = await self.currentSessionMutationRoute()
                }
                guard let requestRoute else {
                    throw GatewayNodeSessionRequestError.routeChangedBeforeDispatch
                }
                try Task.checkCancellation()
                activityObservation = try await captureRunActivity(target, requestRoute)
                try Task.checkCancellation()
            } else {
                activityObservation = nil
            }
        } catch {
            // Only observer preparation is safe to retry: chat.send has not
            // dispatched. Its response and native receipt policy stay outside.
            throw OpenClawChatTransportSendError.notDispatched
        }
        let supportsSettingsCAS = if let requestRoute {
            await self.gateway.supportsServerCapability(
                .sessionSettingsCAS,
                ifCurrentRoute: requestRoute) == true
        } else {
            false
        }
        guard expectedSessionSettings == nil || supportsSettingsCAS else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        let startLogMessage =
            "chat.send start sessionKey=\(target.sessionKey) "
                + "len=\(message.count) attachments=\(attachments.count)"
        Self.logger.info("\(startLogMessage, privacy: .public)")
        GatewayDiagnostics.log(startLogMessage)
        let request = OpenClawChatGatewayRequests.sendMessage(
            sessionKey: target.sessionKey,
            agentID: target.agentID,
            expectedSessionRoutingContract: expectedSessionRoutingContract,
            expectedSessionSettings: expectedSessionSettings,
            supportsSessionSettingsCAS: supportsSettingsCAS,
            message: message,
            thinking: thinking,
            idempotencyKey: idempotencyKey,
            attachments: attachments)
        do {
            let completionPolicy: GatewayRequestCompletionPolicy = self.nativeBinding == nil
                ? .requireCurrentRoute : .preserveChatSendSuccess
            let res = if let activityObservation {
                try await activityObservation.binding.request(request, completionPolicy: completionPolicy)
            } else {
                try await self.requestChatGateway(
                    request,
                    ifCurrentRoute: requestRoute,
                    distinguishPreDispatchRouteChange: distinguishPreDispatchRouteChange,
                    completionPolicy: completionPolicy)
            }
            var decoded: OpenClawChatSendResponse
            do {
                decoded = try JSONDecoder().decode(OpenClawChatSendResponse.self, from: res)
            } catch {
                // Malformed successes are not receipts. This is post-dispatch:
                // never turn lost authority into a safe-to-retry admission error.
                let isCurrent = await self.nativeBinding?.isCurrent() ?? true
                try Task.checkCancellation()
                guard isCurrent else { throw CancellationError() }
                throw error
            }
            if let activityObservation {
                let runID = decoded.runId
                decoded.onAcceptedRun = { sessionID in
                    activityObservation.accepted(runID, sessionID)
                }
            }
            Self.logger.info("chat.send ok runId=\(decoded.runId, privacy: .public)")
            GatewayDiagnostics.log("chat.send ok runId=\(decoded.runId) status=\(decoded.status)")
            return decoded
        } catch is GatewayNodeSessionRequestError {
            Self.logger.info("chat.send skipped because the captured route changed before dispatch")
            GatewayDiagnostics.log("chat.send skipped before dispatch: route changed")
            throw OpenClawChatTransportSendError.notDispatched
        } catch {
            Self.logger.error("chat.send failed \(error.localizedDescription, privacy: .public)")
            GatewayDiagnostics.log("chat.send failed error=\(error.localizedDescription)")
            throw error
        }
    }
}

private enum ComposerResponse {
    case unavailable
    case failed
    case loaded(Data)
}

private struct ComposerSurface<Value> {
    let value: Value?
    let loaded: Bool
    let failed: Bool
}

private struct ComposerConfigSnapshot: Decodable {
    let runtimeConfig: ComposerRuntimeConfig
}

private struct ComposerRuntimeConfig: Decodable {
    let mcp: ComposerMCPConfig?
    let tools: ComposerToolsConfig?
}

private struct ComposerMCPConfig: Decodable {
    let servers: [String: ComposerMCPServer]

    init(from decoder: Decoder) throws {
        let container = try decoder.container(keyedBy: CodingKeys.self)
        self.servers = try container.decodeIfPresent(
            [String: ComposerMCPServer].self,
            forKey: .servers) ?? [:]
    }

    private enum CodingKeys: String, CodingKey { case servers }
}

private struct ComposerMCPServer: Decodable {
    let enabled: Bool?
}

private struct ComposerToolsConfig: Decodable {
    let web: ComposerWebToolsConfig?
}

private struct ComposerWebToolsConfig: Decodable {
    let search: ComposerWebSearchConfig?
}

private struct ComposerWebSearchConfig: Decodable {
    let enabled: Bool?
}
