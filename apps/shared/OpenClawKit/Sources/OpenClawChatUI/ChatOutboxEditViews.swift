import SwiftUI

/// Message-menu actions for a row the outbox still owns.
struct ChatOutboxMessageActions: View {
    let viewModel: OpenClawChatViewModel
    let messageID: UUID
    let state: OpenClawChatOutboxMessageState
    let onEdit: () -> Void

    var body: some View {
        if self.state.isFailed {
            Button {
                self.viewModel.retryOutboxMessage(self.messageID)
            } label: {
                chatActionLabel("Retry Send", systemImage: "arrow.clockwise")
            }
        }
        if self.viewModel.canEditOutboxMessage(self.messageID) {
            Button {
                self.viewModel.editOutboxMessage(self.messageID)
                self.onEdit()
            } label: {
                chatActionLabel("Edit", systemImage: "pencil")
            }
        }
        // In-flight sends may still reach canonical history; hiding them
        // would make a real send look as though it had been cancelled.
        if !self.state.preventsDeletion {
            Button(role: .destructive) {
                self.viewModel.deleteOutboxMessage(self.messageID)
            } label: {
                chatActionLabel("Delete", systemImage: "trash")
            }
        }
    }
}

/// Says why a rejected message is back in the composer.
struct ChatComposerRestoredNotice: View {
    let text: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 6) {
            Image(systemName: "arrow.uturn.backward.circle")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityHidden(true)
            Text(self.text)
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
        }
        .padding(.horizontal, 14)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-composer-restored-notice")
    }
}
