import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    func agentBadge(for agent: AgentSummary) -> String {
        (agent.identity?["emoji"]?.value as? String)?.trimmedNonEmpty
            ?? AgentIdentityPresentation.initialsBadge(for: AgentIdentityPresentation.displayName(for: agent))
    }

    func agentTint(for agent: AgentSummary, state: AgentRosterState) -> Color {
        if agent.id == self.activeAgentID { return OpenClawBrand.accent }
        return state.color.opacity(0.62)
    }

    func agentDetail(for agent: AgentSummary) -> String {
        let parts = [
            AgentIdentityPresentation.modelLabel(for: agent),
            agent.id == self.appModel.gatewayDefaultAgentId ? "Default" : nil,
        ].compactMap(\.self)
        return parts.isEmpty ? agent.id : parts.joined(separator: " • ")
    }

    func agentAccessibilityLabel(
        _ agent: AgentSummary,
        isActive: Bool,
        state: AgentRosterState) -> String
    {
        let name = AgentIdentityPresentation.displayName(for: agent)
        let status = state == .online ? "Online" : "Ready"
        let selection = isActive ? "Selected" : "Not selected"
        return "\(name), \(self.agentDetail(for: agent)), \(status), \(selection)"
    }

    func agentRosterState(for agent: AgentSummary) -> AgentRosterState {
        guard self.gatewayConnected else { return .ready }
        if agent.id == self.activeAgentID { return .online }
        return .ready
    }

    @MainActor
    func refreshAgents() async {
        guard self.scenePhase == .active, self.liveGatewayConnected else { return }
        await self.appModel.refreshGatewayOverviewIfConnected()
    }
}
