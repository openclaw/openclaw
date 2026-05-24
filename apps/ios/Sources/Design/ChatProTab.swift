import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct ChatProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @State private var viewModel: OpenClawChatViewModel?

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                VStack(spacing: 0) {
                    self.header
                    if let viewModel {
                        OpenClawChatView(
                            viewModel: viewModel,
                            drawsBackground: false,
                            showsSessionSwitcher: true,
                            userAccent: OpenClawBrand.accent,
                            assistantName: self.agentDisplayName,
                            assistantAvatarText: self.agentBadge,
                            assistantAvatarTint: OpenClawBrand.accent,
                            talkControl: self.talkControl)
                    } else {
                        ProCard {
                            VStack(alignment: .leading, spacing: 8) {
                                Text("Chat is preparing")
                                    .font(.headline)
                                Text("The operator session will attach when the gateway is ready.")
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }
                        }
                        .padding()
                        Spacer()
                    }
                }
            }
            .navigationBarHidden(true)
        }
        .task {
            self.syncChatViewModel()
        }
        .onChange(of: self.appModel.chatSessionKey) { _, _ in
            self.syncChatViewModel()
        }
    }

    private var header: some View {
        VStack(spacing: 8) {
            HStack(spacing: 12) {
                HStack(spacing: 10) {
                    Text(self.agentBadge)
                        .font(.system(size: self.agentBadge.count > 2 ? 13 : 16, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                        .frame(width: 38, height: 38)
                        .background(
                            Circle()
                                .fill(
                                    LinearGradient(
                                        colors: [
                                            OpenClawBrand.accent,
                                            OpenClawBrand.accentHot,
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing)))
                        .overlay(Circle().strokeBorder(.white.opacity(0.18), lineWidth: 1))

                    VStack(alignment: .leading, spacing: 2) {
                        Text(self.agentDisplayName)
                            .font(.headline.weight(.semibold))
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 8)

                if !self.appModel.gatewayAgents.isEmpty {
                    self.agentMenu
                }

                if let viewModel {
                    self.sessionMenu(viewModel: viewModel)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            .padding(.top, 8)
        }
    }

    private func syncChatViewModel() {
        let sessionKey = self.appModel.chatSessionKey
        guard let viewModel else {
            self.viewModel = OpenClawChatViewModel(
                sessionKey: sessionKey,
                transport: IOSGatewayChatTransport(gateway: self.appModel.operatorSession),
                onSessionChanged: { sessionKey in
                    self.appModel.focusChatSession(sessionKey)
                },
                diagnosticsLog: { message in
                    GatewayDiagnostics.log(message)
                })
            return
        }
        guard viewModel.sessionKey != sessionKey else { return }
        viewModel.switchSession(to: sessionKey)
    }

    private var talkControl: OpenClawChatTalkControl {
        OpenClawChatTalkControl(
            isEnabled: self.appModel.talkMode.isEnabled,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isGatewayConnected: self.appModel.isOperatorGatewayConnected,
            statusText: self.appModel.talkMode.statusText,
            providerLabel: self.appModel.talkMode.gatewayTalkProviderLabel,
            toggle: { sessionKey in
                self.appModel.focusChatSession(sessionKey)
                self.appModel.setTalkEnabled(!self.appModel.talkMode.isEnabled)
            })
    }

    private var agentMenu: some View {
        Menu {
            Button {
                self.selectChatAgent(nil)
            } label: {
                Label(
                    "Default",
                    systemImage: self.normalized(self.appModel.selectedAgentId) == nil
                        ? "checkmark.circle.fill"
                        : "person")
            }
            ForEach(self.sortedAgents, id: \.id) { agent in
                Button {
                    self.selectChatAgent(agent.id)
                } label: {
                    let iconName = agent.id == self.activeAgentID
                        ? "checkmark.circle.fill"
                        : "person"
                    Label(self.agentName(for: agent), systemImage: iconName)
                }
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "person.crop.circle")
                    .font(.caption.weight(.semibold))
                Text(self.agentDisplayName)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .frame(height: 38)
            .background(.regularMaterial, in: Capsule())
        }
        .accessibilityLabel("Chat agent")
    }

    private func selectChatAgent(_ agentId: String?) {
        self.appModel.setSelectedAgentId(agentId)
        self.syncChatViewModel()
    }

    private func sessionMenu(viewModel: OpenClawChatViewModel) -> some View {
        Menu {
            ForEach(viewModel.sessionChoices, id: \.key) { session in
                Button {
                    viewModel.switchSession(to: session.key)
                } label: {
                    let iconName = session.key == viewModel.sessionKey
                        ? "checkmark.circle.fill"
                        : "bubble.left"
                    Label(self.sessionLabel(session), systemImage: iconName)
                }
            }
            Button {
                viewModel.refreshSessions(limit: 200)
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: "rectangle.stack.fill")
                    .font(.caption.weight(.semibold))
                Text(self.currentSessionLabel(viewModel: viewModel))
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 10)
            .frame(height: 38)
            .background(.regularMaterial, in: Capsule())
        }
    }

    private func currentSessionLabel(viewModel: OpenClawChatViewModel) -> String {
        let match = viewModel.sessions.first { $0.key == viewModel.sessionKey }
        return match.map(self.sessionLabel) ?? viewModel.sessionKey
    }

    private func sessionLabel(_ session: OpenClawChatSessionEntry) -> String {
        self.normalized(session.displayName)
            ?? self.normalized(session.subject)
            ?? session.key
    }

    private var activeAgentID: String {
        self.normalized(self.appModel.selectedAgentId)
            ?? self.normalized(self.appModel.gatewayDefaultAgentId)
            ?? "main"
    }

    private var sortedAgents: [AgentSummary] {
        self.appModel.gatewayAgents.sorted { lhs, rhs in
            if lhs.id == self.activeAgentID { return true }
            if rhs.id == self.activeAgentID { return false }
            return self.agentName(for: lhs)
                .localizedCaseInsensitiveCompare(self.agentName(for: rhs)) == .orderedAscending
        }
    }

    private var activeAgent: AgentSummary? {
        self.appModel.gatewayAgents.first { $0.id == self.activeAgentID }
    }

    private var agentDisplayName: String {
        self.normalized(self.activeAgent?.name) ?? self.appModel.activeAgentName
    }

    private var agentStateLabel: String {
        if self.normalized(self.appModel.selectedAgentId) != nil { return "selected" }
        if self.normalized(self.appModel.gatewayDefaultAgentId) != nil { return "default" }
        return self.appModel.isOperatorGatewayConnected ? "live" : "idle"
    }

    private var agentBadge: String {
        if let identity = self.activeAgent?.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }
        let words = self.agentDisplayName
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        if !initials.isEmpty {
            return initials.uppercased()
        }
        return "OC"
    }

    private func agentName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    private func normalized(_ value: String?) -> String? {
        guard let value else { return nil }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }
}
