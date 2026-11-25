import SwiftUI

#if os(iOS)
/// A user message that is not confirmed yet. It has one place: the timestamp's, which stays
/// reserved, so nothing moves when the time takes over.
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
    /// Withdraws a message that has not left the device.
    let cancel: () -> Void

    init(phase: Phase, retry: @escaping () -> Void = {}, cancel: @escaping () -> Void = {}) {
        self.phase = phase
        self.retry = retry
        self.cancel = cancel
    }

    /// Nil once the outbox has confirmed the message (or never held it).
    @MainActor
    init?(message: OpenClawChatMessage, viewModel: OpenClawChatViewModel) {
        guard let state = viewModel.outboxState(for: message.id) else { return nil }
        switch state {
        case .queued:
            // A row about to flush reads as sending; one held behind a reply or offline says so.
            self.phase = viewModel.hasBlockingRunActivity || !viewModel.healthOK ? .queued : .sending
        case .sending:
            self.phase = message.content.contains(where: \.isInlineAttachment) ? .uploading : .sending
        case .confirming:
            self.phase = .sending
        case let .failed(reason):
            self.phase = reason == OpenClawChatSQLiteTranscriptCache.outboxUnconfirmedError
                ? .deliveryUnknown : .notSent
        }
        let id = message.id
        self.retry = { [weak viewModel] in viewModel?.retryOutboxMessage(id) }
        self.cancel = { [weak viewModel] in viewModel?.deleteOutboxMessage(id) }
    }

    var isPending: Bool {
        self.phase == .sending || self.phase == .queued || self.phase == .uploading
    }
}

/// The user message's line under the bubble: the time once the message is confirmed, a quiet word
/// while it waits, or "Not sent" with tap to retry. The time keeps its space while hidden.
struct ChatUserMessageStatus: View {
    let timestamp: Double?
    let send: ChatUserSendPresentation?

    var body: some View {
        ZStack(alignment: .trailing) {
            ChatMessageRelativeTimestamp(timestamp: self.timestamp)
                .opacity(self.send == nil ? 1 : 0)
                .accessibilityHidden(self.send != nil)
            // Keeps one caption line reserved when the message has no time yet.
            Text(verbatim: " ")
                .font(OpenClawChatTypography.caption2)
                .accessibilityHidden(true)
            if let send = self.send {
                switch send.phase {
                case .sending, .uploading:
                    EmptyView()
                case .queued:
                    Text("Queued")
                        .font(OpenClawChatTypography.caption2)
                        .foregroundStyle(.secondary)
                case .notSent, .deliveryUnknown:
                    Button(action: send.retry) {
                        Text(send.phase == .notSent ? "Not sent" : "Delivery unknown")
                            .font(OpenClawChatTypography.caption2)
                            .foregroundStyle(.primary)
                            // A 44 pt target without growing the line.
                            .padding(.vertical, 15)
                            .contentShape(Rectangle())
                            .padding(.vertical, -15)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint(Text("Tap to try again"))
                }
            }
        }
    }
}

/// An attachment of a user message on its way out: an indeterminate ring while it uploads (the
/// send is one Gateway frame, so there is no real progress to show), and a cancel button while
/// the message still waits on the device.
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
        case .queued:
            Button(action: self.send.cancel) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .foregroundStyle(Color.white)
                    .frame(width: 32, height: 32)
                    .background(Circle().fill(Color.black.opacity(0.45)))
                    .frame(width: 44, height: 44)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Cancel"))
        case .sending, .notSent, .deliveryUnknown:
            EmptyView()
        }
    }
}
#endif
