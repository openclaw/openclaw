import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import UIKit

struct IOSAgentAvatarRequest: Hashable {
    struct Entry: Hashable {
        let agentID: String
        let source: String?
        /// A roster rename can change the resolved identity, so it invalidates the cached one.
        let rosterName: String?
    }

    let ownerID: String
    let isConnected: Bool
    let authority: GatewayConnectConfig.ControlUIInputs?
    let entries: [Entry]
}

/// One `agent.identity.get` answer, kept until its roster entry changes or the agent leaves.
struct IOSResolvedAgentIdentity: Equatable {
    let entry: IOSAgentAvatarRequest.Entry
    let name: String?
    let avatarSource: String?
}

extension NodeAppModel {
    var agentAvatarRequest: IOSAgentAvatarRequest {
        IOSAgentAvatarRequest(
            ownerID: self.chatViewModelOwnerID,
            isConnected: self.isOperatorGatewayConnected,
            authority: self.activeGatewayConnectConfig?.controlUIInputs,
            entries: self.gatewayAgents.filter(\.isSelectableAgent).map { agent in
                .init(
                    agentID: agent.id,
                    source: AgentIdentityPresentation.imageSource(identity: agent.identity),
                    rosterName: agent.name)
            })
    }

    func agentAvatarImage(for agentID: String) -> UIImage? {
        guard self.loadedAgentAvatarRequest == self.agentAvatarRequest else { return nil }
        return self.agentAvatarImages[agentID]
    }

    /// The resolved identity name, kept across refreshes so chat never flickers back to the
    /// roster name; another Gateway owner never sees it.
    func agentIdentityName(for agentID: String) -> String? {
        guard self.agentIdentitiesOwnerID == self.chatViewModelOwnerID else { return nil }
        return self.agentIdentities[agentID.trimmingCharacters(in: .whitespacesAndNewlines)]?.name
    }

    /// web `normalizeAssistantIdentity` name, except the Gateway's placeholder ("Assistant"):
    /// it is not an identity, and the roster name or id says more.
    nonisolated static func identityChatName(_ identity: AgentIdentityResult) -> String? {
        identity.namesource == "default" ? nil : identity.name?.trimmedNonEmpty
    }

    func refreshAgentAvatars(_ request: IOSAgentAvatarRequest) async {
        guard request == self.agentAvatarRequest, !Task.isCancelled else { return }
        self.agentAvatarImages = [:]
        self.loadedAgentAvatarRequest = request
        // Names stay until replacements arrive; only agents that left the roster lose theirs.
        if self.agentIdentitiesOwnerID != request.ownerID {
            self.agentIdentities = [:]
            self.agentIdentitiesOwnerID = request.ownerID
        }
        let rosterIDs = Set(request.entries.map(\.agentID))
        self.agentIdentities = self.agentIdentities.filter { rosterIDs.contains($0.key) }
        let known = self.agentIdentities
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
        await withTaskGroup(of: (String, IOSResolvedAgentIdentity?, Data?).self) { group in
            for entry in request.entries {
                let cached = known[entry.agentID].flatMap { $0.entry == entry ? $0 : nil }
                group.addTask {
                    // Chat names the agent by its resolved identity, and the roster may omit
                    // workspace identity images; resolve it as desktop and web do, once per entry.
                    var resolved = cached
                    if resolved == nil, let route,
                       let data = try? await gateway.request(
                           OpenClawChatGatewayRequests.agentIdentity(agentID: entry.agentID), ifCurrentRoute: route),
                       let identity = try? JSONDecoder().decode(AgentIdentityResult.self, from: data),
                       identity.agentid == entry.agentID
                    {
                        resolved = IOSResolvedAgentIdentity(
                            entry: entry,
                            name: NodeAppModel.identityChatName(identity),
                            avatarSource: OpenClawChatAgentChoice(id: entry.agentID, avatar: identity.avatar).avatar)
                    }
                    let fresh = cached == nil ? resolved : nil
                    guard let source = entry.source ?? resolved?.avatarSource, !Task.isCancelled else {
                        return (entry.agentID, fresh, nil)
                    }
                    if let data = OpenClawSidebarAgentAvatarSource.inlineData(source) {
                        return (entry.agentID, fresh, data)
                    }
                    guard let route else { return (entry.agentID, fresh, nil) }
                    return await (entry.agentID, fresh, loader.loadAgentAvatar(source, ifCurrentRoute: route))
                }
            }
            for await (agentID, identity, data) in group {
                guard !Task.isCancelled, request == self.agentAvatarRequest else {
                    group.cancelAll()
                    return
                }
                if let identity {
                    self.agentIdentities[agentID] = identity
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
