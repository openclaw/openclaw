import ClawdisChatUI
import SwiftUI

struct ChatSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var viewModel: ClawdisChatViewModel

    init(bridge: BridgeSession, sessionKey: String = "main") {
        let transport = IOSBridgeChatTransport(bridge: bridge)
        self._viewModel = State(
            initialValue: ClawdisChatViewModel(
                sessionKey: sessionKey,
                transport: transport))
    }

    var body: some View {
        NavigationStack {
            ClawdisChatView(viewModel: self.viewModel)
                .navigationTitle("Chat")
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
}
