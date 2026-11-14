#if os(iOS)
import SwiftUI

/// The top-of-transcript control for older history. Scrolling near the top reads pages on its own;
/// this covers chats too short to scroll and assistive navigation, which reaches it as a button.
struct ChatEarlierMessagesRow: View {
    let viewModel: OpenClawChatViewModel
    let load: @MainActor () -> Void

    var body: some View {
        Button(action: self.load) {
            HStack(spacing: 6) {
                if self.viewModel.historyPageLoading == .older {
                    ProgressView()
                        .controlSize(.mini)
                }
                if self.viewModel.historyPageFailed {
                    Text("Retry earlier messages")
                        .font(OpenClawChatTypography.caption)
                } else {
                    Text("Show earlier messages")
                        .font(OpenClawChatTypography.caption)
                }
            }
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-show-earlier-messages")
    }
}
#endif
