import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import UIKit

struct IOSAgentAvatarRequest: Hashable {
    struct Entry: Hashable {
        let agentID: String
        let source: String?
    }

    let ownerID: String
    let isConnected: Bool
    let authority: GatewayConnectConfig.ControlUIInputs?
    let entries: [Entry]
}

extension NodeAppModel {
    var agentAvatarRequest: IOSAgentAvatarRequest {
        IOSAgentAvatarRequest(
            ownerID: self.chatViewModelOwnerID,
            isConnected: self.isOperatorGatewayConnected,
            authority: self.activeGatewayConnectConfig?.controlUIInputs,
            entries: self.gatewayAgents.filter(\.isSelectableAgent).map { agent in
                .init(agentID: agent.id, source: AgentIdentityPresentation.imageSource(identity: agent.identity))
            })
    }

    func agentAvatarImage(for agentID: String) -> UIImage? {
        guard self.loadedAgentAvatarRequest == self.agentAvatarRequest else { return nil }
        return self.agentAvatarImages[agentID]
    }

    func refreshAgentAvatars(_ request: IOSAgentAvatarRequest) async {
        guard request == self.agentAvatarRequest, !Task.isCancelled else { return }
        self.agentAvatarImages = [:]
        self.loadedAgentAvatarRequest = request
        let loader = IOSSourceResourceLoader(gateway: self.operatorSession) { [weak self] in
            guard let config = self?.activeGatewayConnectConfig else { return nil }
            return IOSMediaArtifactLoader.Connection(
                config: config,
                gatewayID: config.nodeOptions.deviceAuthGatewayID ?? config.effectiveStableID,
                customHeaders: GatewaySettingsStore.loadGatewayCustomHeaders(
                    gatewayStableID: config.effectiveStableID))
        }
        let route = if let gatewayID = self.chatTranscriptCacheGatewayID {
            await self.operatorSession.currentRoute(ifGatewayID: gatewayID)
        } else {
            nil as GatewayNodeSessionRoute?
        }
        let gateway = self.operatorSession
        await withTaskGroup(of: (String, Data?).self) { group in
            for entry in request.entries {
                group.addTask {
                    var source = entry.source
                    // The roster may omit workspace identity images. Resolve that
                    // same identity as desktop before falling back to initials.
                    if source == nil, let route,
                       let data = try? await gateway.request(
                           OpenClawChatGatewayRequests.agentIdentity(agentID: entry.agentID), ifCurrentRoute: route),
                       let identity = try? JSONDecoder().decode(AgentIdentityResult.self, from: data),
                       identity.agentid == entry.agentID
                    {
                        source = OpenClawChatAgentChoice(id: entry.agentID, avatar: identity.avatar).avatar
                    }
                    guard let source, !Task.isCancelled else { return (entry.agentID, nil) }
                    if let data = OpenClawSidebarAgentAvatarSource.inlineData(source) {
                        return (entry.agentID, data)
                    }
                    guard let route else { return (entry.agentID, nil) }
                    return await (entry.agentID, loader.loadAgentAvatar(source, ifCurrentRoute: route))
                }
            }
            for await (agentID, data) in group {
                guard !Task.isCancelled, request == self.agentAvatarRequest else {
                    group.cancelAll()
                    return
                }
                if let data, let image = AgentIdentityPresentation.image(data: data) {
                    self.agentAvatarImages[agentID] = image
                }
            }
        }
        guard !Task.isCancelled, request == self.agentAvatarRequest else { return }
        self.chatPresentation.sync(appModel: self)
    }
}
