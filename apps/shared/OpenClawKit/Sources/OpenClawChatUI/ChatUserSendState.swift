import SwiftUI

#if os(iOS)
/// A user message that hasn't been confirmed yet.
struct ChatUserSendPresentation {
    enum Phase: Equatable {
        /// Leaving the device (saved, sending, or waiting for history to confirm it): dimmed, no time.
        case sending
        /// Saved but held behind a running reply or a closed connection: dimmed, "Queued".
        case queued
        /// Uploading its attachments right now.
        case uploading
        case notSent
        case deliveryUnknown
    }

    let phase: Phase
    let retry: () -> Void

    init(phase: Phase, retry: @escaping () -> Void = {}) {
        self.phase = phase
        self.retry = retry
    }

    /// Nil once the outbox has confirmed the message (or never held it).
    @MainActor
    init?(message: OpenClawChatMessage, viewModel: OpenClawChatViewModel) {
        if viewModel.optimisticSendMessageID == message.id {
            // Shown at the Send tap while the send is checked, prepared and saved.
            self.phase = message.content.contains(where: \.isInlineAttachment) ? .uploading : .sending
            self.retry = {}
            return
        }
        guard let state = viewModel.outboxState(for: message.id) else { return nil }
        let pending: Phase = viewModel.outboxSendContextByMessageID[message.id]?
            .waitsForReply == true ? .queued : .sending
        switch state {
        case .queued:
            self.phase = viewModel.healthOK ? pending : .queued
        case .sending:
            self.phase = message.content.contains(where: \.isInlineAttachment) ? .uploading : pending
        case .confirming:
            self.phase = pending
        case let .failed(reason):
            self.phase = reason == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError
                ? .deliveryUnknown : .notSent
        }
        let id = message.id
        // A queued message is withdrawn or edited from its long-press menu (Edit, Delete).
        self.retry = { [weak viewModel] in viewModel?.retryOutboxMessage(id) }
    }

    var isPending: Bool {
        self.phase == .sending || self.phase == .queued || self.phase == .uploading
    }
}

/// Only actionable delivery states need a line below the bubble.
struct ChatUserMessageStatus: View {
    let send: ChatUserSendPresentation

    init?(send: ChatUserSendPresentation?) {
        guard let send, send.phase != .sending, send.phase != .uploading else { return nil }
        self.send = send
    }

    var body: some View {
        switch self.send.phase {
        case .sending, .uploading:
            EmptyView()
        case .queued:
            Text("Queued")
                .font(OpenClawChatTypography.caption2)
                .foregroundStyle(.secondary)
        case .notSent:
            self.failure(Text("Not sent"), hint: Text("Sends this message again."), retry: self.send.retry)
        case .deliveryUnknown:
            self.failure(
                Text("May not have sent"),
                hint: Text("Sends this message again. It may arrive twice if it already went through."),
                retry: self.send.retry)
        }
    }

    /// The whole line is the button; only “Try again” reads as the action.
    private func failure(_ status: Text, hint: Text, retry: @escaping () -> Void) -> some View {
        Button(action: retry) {
            HStack(spacing: 0) {
                status.foregroundStyle(.secondary)
                Text(verbatim: " · ").foregroundStyle(.secondary)
                Text("Try again").foregroundStyle(.primary)
            }
            .font(OpenClawChatTypography.caption2)
            .padding(.vertical, 16)
            .contentShape(Rectangle())
            .padding(.vertical, -16)
        }
        .buttonStyle(.plain)
        .accessibilityLabel(status + Text(verbatim: ", ") + Text("Try again"))
        .accessibilityHint(hint)
    }
}

/// An attachment of a user message on its way out: an indeterminate ring while it uploads (the
/// send is one Gateway frame, so there is no real progress to show).
struct ChatAttachmentSendOverlay: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let send: ChatUserSendPresentation
    @State private var spins = false

    var body: some View {
        switch self.send.phase {
        case .uploading:
            Circle()
                .trim(from: 0, to: 0.28)
                .stroke(Color.white, style: StrokeStyle(lineWidth: 2.5, lineCap: .round))
                .frame(width: 18, height: 18)
                .rotationEffect(.degrees(self.spins ? 360 : 0))
                .padding(7)
                .background(Circle().fill(Color.black.opacity(0.45)))
                .onAppear {
                    guard !self.reduceMotion else { return }
                    withAnimation(.linear(duration: 0.9).repeatForever(autoreverses: false)) { self.spins = true }
                }
                .accessibilityElement()
                .accessibilityLabel(Text("Uploading"))
        case .sending, .queued, .notSent, .deliveryUnknown:
            EmptyView()
        }
    }
}
#endif
