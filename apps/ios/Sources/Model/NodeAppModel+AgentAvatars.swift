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

/// The last known agents of one Gateway owner, so a cold start draws the agent's name and avatar
/// from its first frame instead of a placeholder that the network answer then replaces.
struct IOSCachedAgentIdentities {
    let ownerID: String
    let agents: [OpenClawChatCachedAgentIdentity]
    let images: [String: UIImage]

    init(ownerID: String, agents: [OpenClawChatCachedAgentIdentity]) {
        self.ownerID = ownerID
        self.agents = agents
        self.images = agents.reduce(into: [:]) { images, agent in
            if let data = agent.avatar, let image = AgentIdentityPresentation.image(data: data) {
                images[agent.agentID] = image
            }
        }
    }

    var defaultAgentID: String? {
        self.agents.first(where: \.isDefault)?.agentID
    }

    func agent(_ agentID: String) -> OpenClawChatCachedAgentIdentity? {
        self.agents.first { $0.agentID == agentID }
    }
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

    /// Read on first use per Gateway owner: views ask for it while drawing the first frame.
    var cachedAgentIdentities: IOSCachedAgentIdentities {
        let ownerID = self.chatViewModelOwnerID
        if let memo = self.cachedAgentIdentitiesMemo, memo.ownerID == ownerID { return memo }
        let memo = IOSCachedAgentIdentities(
            ownerID: ownerID,
            agents: self.makeChatOfflineStore()?.loadAgentIdentities() ?? [])
        self.cachedAgentIdentitiesMemo = memo
        return memo
    }

    /// Selectable agents to draw: the live roster, or the last known one until `agents.list` answers.
    var displayAgents: [AgentSummary] {
        guard self.gatewayAgents.isEmpty else { return self.gatewayAgents.filter(\.isSelectableAgent) }
        return self.cachedAgentIdentities.agents.map { agent in
            AgentSummary(
                id: agent.agentID,
                name: agent.rosterName,
                identity: agent.emoji.map { ["emoji": AnyCodable($0)] })
        }
    }

    /// The live portrait once this connection resolved it; until then the last known one.
    func agentAvatarImage(for agentID: String) -> UIImage? {
        let live = self.loadedAgentAvatarRequest == self.agentAvatarRequest ? self.agentAvatarImages[agentID] : nil
        if live != nil || self.hasResolvedAgentAvatar(for: agentID) { return live }
        return self.cachedAgentIdentities.images[agentID]
    }

    func hasResolvedAgentAvatar(for agentID: String) -> Bool {
        let request = self.agentAvatarRequest
        return request.isConnected && self.loadedAgentAvatarRequest == request && self.resolvedAgentAvatarIDs
            .contains(agentID)
    }

    /// Whether the avatar slot can draw this agent now: resolved live, or known from the last launch.
    func knowsAgentAvatar(for agentID: String) -> Bool {
        self.hasResolvedAgentAvatar(for: agentID) || self.cachedAgentIdentities.agent(agentID) != nil
    }

    /// The resolved identity name, kept across refreshes so chat never flickers back to the
    /// roster name; another Gateway owner never sees it. Until it resolves, the last known one.
    func agentIdentityName(for agentID: String) -> String? {
        let agentID = agentID.trimmingCharacters(in: .whitespacesAndNewlines)
        if self.agentIdentitiesOwnerID == self.chatViewModelOwnerID,
           let resolved = self.agentIdentities[agentID]
        {
            return resolved.name
        }
        return self.cachedAgentIdentities.agent(agentID)?.identityName
    }

    /// web `normalizeAssistantIdentity` name, except the Gateway's placeholder ("Assistant"):
    /// it is not an identity, and the roster name or id says more.
    nonisolated static func identityChatName(_ identity: AgentIdentityResult) -> String? {
        identity.namesource == "default" ? nil : identity.name?.trimmedNonEmpty
    }

    func refreshAgentAvatars(_ request: IOSAgentAvatarRequest) async {
        guard request == self.agentAvatarRequest, !Task.isCancelled else { return }
        self.agentAvatarImages = [:]
        self.resolvedAgentAvatarIDs = []
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
        let gatewayID = self.chatTranscriptCacheGatewayID
        let route = if let gatewayID {
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
                self.resolvedAgentAvatarIDs.insert(agentID)
            }
        }
        guard !Task.isCancelled, request == self.agentAvatarRequest else { return }
        if request.isConnected, route != nil, !request.entries.isEmpty, let store = self.makeChatOfflineStore(),
           GatewayStableIdentifier.matches(store.gatewayID, gatewayID)
        {
            let previous = self.cachedAgentIdentities
            let identities = request.entries.map { entry in
                let emoji = self.gatewayAgents.first { $0.id == entry.agentID }?.identity?["emoji"]?.value as? String
                // A portrait that failed to load this time keeps its last known image.
                let source = entry.source ?? self.agentIdentities[entry.agentID]?.avatarSource
                let avatar = self.agentAvatarImages[entry.agentID]?.pngData()
                    ?? (source == nil ? nil : previous.agent(entry.agentID)?.avatar)
                return OpenClawChatCachedAgentIdentity(
                    agentID: entry.agentID,
                    rosterName: entry.rosterName,
                    identityName: self.agentIdentities[entry.agentID]?.name,
                    emoji: emoji,
                    isDefault: entry.agentID == self.gatewayDefaultAgentId,
                    avatar: avatar)
            }
            self.cachedAgentIdentitiesMemo = IOSCachedAgentIdentities(ownerID: request.ownerID, agents: identities)
            await store.storeAgentIdentities(identities)
        }
        self.chatPresentation.sync(appModel: self)
    }
}
