import MullusiChatUI
import MullusiKit
import SwiftUI

struct ChatSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: MullusiChatViewModel
    private let userAccent: Color?
    private let agentName: String?

    init(gateway: GatewayNodeSession, sessionKey: String, agentName: String? = nil, userAccent: Color? = nil) {
        let transport = IOSGatewayChatTransport(gateway: gateway)
        self._viewModel = State(
            initialValue: MullusiChatViewModel(
                sessionKey: sessionKey,
                transport: transport))
        self.userAccent = userAccent
        self.agentName = agentName
    }

    var body: some View {
        NavigationStack {
            MullusiChatView(
                viewModel: self.viewModel,
                showsSessionSwitcher: true,
                userAccent: self.userAccent)
                .navigationTitle(self.chatTitle)
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button {
                            self.dismiss()
                        } label: {
                            Image(systemName: "xmark")
                        }
                        .accessibilityLabel("Close")
                    }
                }
        }
    }

    private var chatTitle: String {
        let trimmed = (self.agentName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty { return "Chat" }
        return "Chat (\(trimmed))"
    }
}
