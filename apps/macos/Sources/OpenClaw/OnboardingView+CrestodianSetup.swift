import SwiftUI

extension OnboardingView {
    /// Conversational setup: the user talks to Crestodian over the gateway and
    /// it configures everything (AI detection, config, workspace). No wizard.
    func crestodianSetupPage() -> some View {
        VStack(spacing: 12) {
            Text("Talk to Crestodian")
                .font(.largeTitle.weight(.semibold))
            Text(
                "Crestodian is OpenClaw's setup custodian. It finds AI access you already have — " +
                    "a Claude Code or Codex login, or API keys — and sets everything up when you say yes. " +
                    "Just tell it what you want.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 540)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingGlassCard(padding: 4) {
                CrestodianOnboardingChatView(model: self.crestodianChat)
                    .frame(maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)
        }
        .padding(.horizontal, 28)
        .frame(width: self.pageWidth, height: self.contentHeight, alignment: .top)
    }

    func maybeStartCrestodianChat(for pageIndex: Int) {
        guard pageIndex == self.crestodianPageIndex else { return }
        // Local mode reaches this page only after the CLI/gateway install page,
        // so the gateway is up before the first RPC.
        guard self.state.connectionMode != .local || self.cliInstalled else { return }
        if self.crestodianChat.onAgentHandoff == nil {
            self.crestodianChat.onAgentHandoff = { [self] in
                // "talk to agent": refresh workspace state so the agent chat
                // page appears, then advance.
                self.refreshBootstrapStatus()
                self.handleNext()
            }
        }
        Task { await self.crestodianChat.startIfNeeded() }
    }
}
