import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct WorkspaceProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    var openSettings: () -> Void
    var openChat: () -> Void = {}

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        self.workspaceSection
                        self.agentsSection
                        self.artifactsSection
                        self.settingsRow
                    }
                    .padding(.vertical, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationTitle("Workspace")
            .navigationBarTitleDisplayMode(.inline)
        }
    }

    private var workspaceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Canvas")
            NavigationLink {
                ScreenTab()
                    .navigationTitle("Canvas")
                    .navigationBarTitleDisplayMode(.inline)
            } label: {
                ProCard {
                    HStack(spacing: 12) {
                        ProIconBadge(systemName: "square.grid.2x2", color: .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(self.canvasTitle)
                                .font(.headline)
                            Text(self.canvasSubtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Image(systemName: "chevron.right")
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .buttonStyle(.plain)
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Agents")
            ProCard(padding: 0) {
                if self.appModel.gatewayAgents.isEmpty {
                    HStack(spacing: 12) {
                        ProIconBadge(systemName: "person.2.slash", color: .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(self.gatewayConnected ? "No agents reported" : "Agents unavailable")
                                .font(.subheadline.weight(.semibold))
                            Text(self.gatewayConnected
                                ? "The connected gateway did not return an agent list."
                                : "Connect a gateway to load the live agent roster.")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                    }
                    .padding(14)
                } else {
                    VStack(spacing: 0) {
                        let agents = self.sortedAgents
                        ForEach(agents.indices, id: \.self) { index in
                            let agent = agents[index]
                            Button {
                                self.appModel.setSelectedAgentId(agent.id)
                            } label: {
                                self.agentRow(agent)
                            }
                            .buttonStyle(.plain)
                            if index < agents.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var artifactsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Workspace Context")
            ProCard {
                VStack(spacing: 0) {
                    Button {
                        self.appModel.focusChatSession(self.appModel.chatSessionKey)
                        self.openChat()
                    } label: {
                        self.workspaceRow(
                            icon: "bubble.left.and.text.bubble.right",
                            title: "Chat session",
                            detail: self.appModel.chatSessionKey,
                            trailing: self.operatorConnected ? "open" : "offline",
                            showsChevron: self.operatorConnected)
                    }
                    .buttonStyle(.plain)
                    .disabled(!self.operatorConnected)
                    Divider().padding(.leading, 60)
                    NavigationLink {
                        ScreenTab()
                            .navigationTitle("Canvas")
                            .navigationBarTitleDisplayMode(.inline)
                    } label: {
                        self.workspaceRow(
                            icon: "folder",
                            title: "Active workspace",
                            detail: self.activeWorkspaceDetail,
                            trailing: self.activeAgentState,
                            showsChevron: true)
                    }
                    .buttonStyle(.plain)
                    if let latestShareEvent = self.latestShareEvent {
                        Divider().padding(.leading, 60)
                        self.workspaceRow(
                            icon: "doc.text",
                            title: "Latest share event",
                            detail: latestShareEvent,
                            trailing: nil)
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var settingsRow: some View {
        Button(action: self.openSettings) {
            ProCard {
                HStack {
                    Image(systemName: "gearshape")
                    Text("Settings")
                    Spacer()
                    Image(systemName: "chevron.right")
                        .foregroundStyle(.secondary)
                }
            }
        }
        .buttonStyle(.plain)
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func workspaceRow(
        icon: String,
        title: String,
        detail: String,
        trailing: String? = nil,
        showsChevron: Bool = false) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: .secondary)
            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.subheadline.weight(.medium))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            if let trailing {
                Text(trailing)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private func agentRow(_ agent: AgentSummary) -> some View {
        let isActive = agent.id == self.activeAgentID
        return HStack(spacing: 12) {
            ProIconBadge(
                systemName: isActive ? "person.fill.checkmark" : "person",
                color: isActive ? OpenClawBrand
                    .accent : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.agentName(for: agent))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.agentDetail(for: agent))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer()
            ProValuePill(value: self.agentState(for: agent), color: isActive ? OpenClawBrand.accent : .secondary)
        }
        .padding(.vertical, 12)
        .padding(.horizontal, 14)
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var operatorConnected: Bool {
        self.appModel.isOperatorGatewayConnected
    }

    private var latestShareEvent: String? {
        let trimmed = self.appModel.lastShareEventText.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed != "No share events yet." else { return nil }
        return trimmed
    }

    private var canvasTitle: String {
        self.gatewayConnected ? "\(self.appModel.activeAgentName) Canvas" : "Canvas"
    }

    private var canvasSubtitle: String {
        if self.gatewayConnected {
            return "\(self.appModel.activeAgentName) on \(self.appModel.gatewayServerName ?? "gateway")"
        }
        return "Connect to load live gateway screen and agent workspace"
    }

    private var activeAgentID: String {
        self.normalized(self.appModel.selectedAgentId)
            ?? self.normalized(self.appModel.gatewayDefaultAgentId)
            ?? ""
    }

    private var activeAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.activeAgentID }
    }

    private var activeAgentState: String {
        if self.normalized(self.appModel.selectedAgentId) != nil { return "selected" }
        if self.normalized(self.appModel.gatewayDefaultAgentId) != nil { return "default" }
        return "main"
    }

    private var activeWorkspaceDetail: String {
        if let workspace = normalized(activeAgent?.workspace) {
            return workspace
        }
        if let address = normalized(appModel.gatewayRemoteAddress) {
            return address
        }
        return self.gatewayConnected ? "Gateway workspace" : "Not connected"
    }

    private var sortedAgents: [AgentSummary] {
        self.appModel.gatewayAgents.sorted { lhs, rhs in
            let lhsActive = lhs.id == self.activeAgentID
            let rhsActive = rhs.id == self.activeAgentID
            if lhsActive != rhsActive { return lhsActive }
            return self.agentName(for: lhs)
                .localizedCaseInsensitiveCompare(self.agentName(for: rhs)) == .orderedAscending
        }
    }

    private func agentName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    private func agentDetail(for agent: AgentSummary) -> String {
        if let workspace = normalized(agent.workspace) {
            return workspace
        }
        if let model = modelLabel(for: agent) {
            return model
        }
        return agent.id
    }

    private func agentState(for agent: AgentSummary) -> String {
        if agent.id == self.activeAgentID { return self.activeAgentState }
        if agent.id == self.normalized(self.appModel.gatewayDefaultAgentId) { return "default" }
        return "available"
    }

    private func modelLabel(for agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["name", "id", "model"] {
            if let value = model[key]?.value as? String,
               let normalized = normalized(value)
            {
                return normalized
            }
        }
        return nil
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
