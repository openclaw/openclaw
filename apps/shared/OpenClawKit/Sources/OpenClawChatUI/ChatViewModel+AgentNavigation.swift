import Foundation

extension OpenClawChatViewModel {
    var agentChoices: [OpenClawChatAgentChoice] {
        self.agentCatalog?.agents ?? []
    }

    var selectedAgentID: String? {
        self.explicitSessionAgentID ?? OpenClawChatSessionKey.agentID(from: self.sessionKey)?.lowercased() ??
            self.activeAgentId ?? self.agentCatalog?.defaultId.lowercased() ??
            OpenClawChatSessionKey.agentID(from: self.resolvedMainSessionKey)?.lowercased()
    }

    var selectedAgent: OpenClawChatAgentChoice? {
        self.agentChoices.first { $0.id.lowercased() == self.selectedAgentID }
    }

    var selectedAgentMainSessionKey: String {
        guard let agentID = self.selectedAgentID else { return self.resolvedMainSessionKey }
        return self.mainSessionKey(forAgent: agentID)
    }

    func switchAgent(to agentID: String) {
        guard let agent = self.agentChoices.first(where: { $0.id.lowercased() == agentID.lowercased() }) else {
            return
        }
        self.switchSession(to: self.mainSessionKey(forAgent: agent.id))
    }

    func mainSessionKey(forAgent agentID: String) -> String {
        let routing = OpenClawChatSessionRoutingContract.parse(
            self.agentCatalog?.sessionRoutingContract ?? self.sessionRoutingContract)
        let mainKey: String
        if let routing {
            mainKey = routing.mainKey
        } else {
            let configured = self.sessionDefaults?.mainSessionKey?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            let fallback = (configured?.isEmpty == false ? configured : nil) ?? "main"
            let parts = fallback.split(separator: ":", maxSplits: 2)
            mainKey = parts.count == 3 ? String(parts[2]) : fallback
        }
        // An explicit key keeps both the transport and composer draft on the selected agent,
        // even when the Gateway's default agent changes or its session scope is global.
        return ChatSessionNavigation.primaryKey(agentID: agentID, mainKey: mainKey)
    }

    func refreshAgents() async {
        guard !self.isTransportDetached else { return }
        self.hasRequestedAgents = true
        self.agentCatalogGeneration &+= 1
        let generation = self.agentCatalogGeneration
        self.isLoadingAgents = true
        self.agentsErrorText = nil
        defer {
            if generation == self.agentCatalogGeneration {
                self.isLoadingAgents = false
            }
        }
        do {
            let catalog = try await self.transport.listAgents()
            guard generation == self.agentCatalogGeneration,
                  !self.isTransportDetached, !Task.isCancelled
            else { return }
            self.agentCatalog = catalog
        } catch {
            guard generation == self.agentCatalogGeneration,
                  !self.isTransportDetached, !Task.isCancelled
            else { return }
            self.agentsErrorText = error.localizedDescription
        }
    }

    func invalidateAgentCatalog(clear: Bool = false) {
        self.agentCatalogGeneration &+= 1
        self.isLoadingAgents = false
        if clear {
            self.agentCatalog = nil
            self.agentsErrorText = nil
        }
    }

    func refreshAgentsIfRequested() {
        guard self.hasRequestedAgents else { return }
        Task { [weak self] in await self?.refreshAgents() }
    }
}
