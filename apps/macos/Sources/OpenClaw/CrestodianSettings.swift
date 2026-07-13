import SwiftUI

/// Settings pane hosting the Crestodian setup/repair chat.
///
/// Crestodian answers even when no model is configured (deterministic engine
/// on the gateway), so this pane is the "always works" place to fix config,
/// switch models, connect channels, or run doctor — in plain language.
struct CrestodianSettings: View {
    let isActive: Bool
    @State private var chat = CrestodianOnboardingChatModel(
        welcomeVariant: nil,
        sessionPrefix: "mac-settings-crestodian")

    var body: some View {
        VStack(alignment: .leading, spacing: 20) {
            SettingsPageHeader(
                title: "Crestodian",
                subtitle: "Your setup helper. It can check status, fix config, switch models, " +
                    "and connect channels — even when the agent itself is not working.")

            SettingsCardGroup("Chat") {
                CrestodianOnboardingChatView(model: self.chat)
                    .frame(maxWidth: .infinity, minHeight: 320, maxHeight: .infinity)
            }
            .frame(maxHeight: .infinity)

            Text("Tip: try “status”, “doctor”, “set default model …”, or “connect telegram”.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
        .settingsDetailContent()
        .task(id: self.isActive) {
            guard self.isActive else { return }
            self.chat.onAgentHandoff = {
                AppNavigationActions.openChat()
            }
            await self.chat.startIfNeeded()
        }
    }
}
