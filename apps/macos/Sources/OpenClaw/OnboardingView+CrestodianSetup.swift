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
        self.refreshCrestodianSetupComplete()
        guard pageIndex == self.crestodianPageIndex else { return }
        // Local mode reaches this page only after the CLI/gateway install page,
        // so the gateway is up before the first RPC.
        guard self.state.connectionMode != .local || self.cliInstalled else { return }
        if self.crestodianChat.onAgentHandoff == nil {
            self.crestodianChat.onAgentHandoff = { [self] in
                // "talk to agent": refresh workspace state so the agent chat
                // page appears, then advance.
                self.refreshBootstrapStatus()
                self.refreshCrestodianSetupComplete()
                self.handleNext()
            }
        }
        if self.crestodianChat.onReplyReceived == nil {
            self.crestodianChat.onReplyReceived = { [self] in
                // Setup applies mid-conversation; re-check so Next unlocks.
                self.refreshCrestodianSetupComplete()
            }
        }
        Task { await self.crestodianChat.startIfNeeded() }
    }

    /// Setup is complete once the config carries authored wizard/gateway-auth
    /// state — the same signal the old step wizard used to skip itself.
    func refreshCrestodianSetupComplete() {
        let root = OpenClawConfigFile.loadDict()
        if let wizard = root["wizard"] as? [String: Any], !wizard.isEmpty {
            self.crestodianSetupComplete = true
            return
        }
        if let gateway = root["gateway"] as? [String: Any],
           let auth = gateway["auth"] as? [String: Any],
           auth["mode"] != nil || auth["token"] != nil || auth["password"] != nil
        {
            self.crestodianSetupComplete = true
            return
        }
        self.crestodianSetupComplete = false
    }
}
