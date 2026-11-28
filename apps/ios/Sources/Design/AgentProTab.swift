import OpenClawKit
import SwiftUI

struct AgentWorkspaceFilesTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase

    let headerSidebarAction: OpenClawSidebarHeaderAction?

    var body: some View {
        let connected = GatewayStatusBuilder.buildChat(appModel: self.appModel) == .connected
        AgentWorkspaceFilesScreen(agentId: self.activeAgentID, headerSidebarAction: self.headerSidebarAction)
            .modifier(OpenClawSidebarRevealToolbarVisibility(action: self.headerSidebarAction) { isRevealShown in
                isRevealShown ? .hidden : .visible
            })
            .task(id: [
                self.appModel.connectedGatewayID,
                self.activeAgentID,
                connected ? "connected" : "offline",
                self.scenePhase == .active ? "active" : nil,
            ]) {
                guard self.scenePhase == .active, !self.appModel.isLocalGatewayFixtureEnabled, connected else { return }
                await self.appModel.refreshGatewayOverviewIfConnected()
            }
    }

    private var activeAgentID: String {
        self.appModel.selectedAgentId?.trimmedNonEmpty
            ?? self.appModel.gatewayDefaultAgentId?.trimmedNonEmpty
            ?? "main"
    }
}
