import Foundation

/// Where the row under agent replies shows: under every reply, or only under the latest one.
enum ChatAgentFooterPlacement {
    case everyReply
    case latestReply

    /// The one switch for the row; older replies keep only their reactions pill under `latestReply`.
    static let current: Self = .everyReply

    /// The reply that keeps the row under `latestReply`; nil when every reply shows it, and on
    /// platforms without the row.
    static func latestReplyID(in messages: [OpenClawChatMessage]) -> UUID? {
        #if os(iOS)
        guard self.current == .latestReply else { return nil }
        return messages.last {
            $0.role.lowercased() == "assistant" && ChatMessageVisibleText.hasVisibleText(in: $0)
        }?.id
        #else
        return nil
        #endif
    }
}

#if os(iOS)
import SwiftUI

/// Under an agent reply: its reactions pill and time, then reply, copy, react and listen. It holds
/// the actions the reply's long-press menu used to hold, so the reply's text selects in place. No
/// agent name: the row belongs to the reply above it.
@MainActor
struct ChatAgentMessageFooter: View {
    /// The row lays out this much shorter than its 44-point hit targets; the extra reach sits over
    /// the reply's own bottom padding, never over the next message.
    private static let hitOverhang: CGFloat = 12

    let viewModel: OpenClawChatViewModel
    /// The row's message, which owns the reactions.
    let message: OpenClawChatMessage
    /// The whole reply the actions act on; a rendered block of a long reply is only part of it.
    let actionMessage: OpenClawChatMessage
    let timestamp: Double?
    let showsActions: Bool
    /// Nil where the chat has no composer to reply from.
    let replySenderLabel: String?
    let speech: OpenClawChatSpeechController?
    let openFullMessage: (String) -> Void
    let openPicker: () -> Void

    var body: some View {
        let hasReactions = !self.viewModel.messageReactions(for: self.message).isEmpty
        let copyText = ChatMessageVisibleText.copyText(in: self.actionMessage)
        let showsActions = self.showsActions && !copyText.isEmpty
        if showsActions || hasReactions {
            // One line while it fits; at large text sizes the actions move under the pill and time
            // instead of squeezing them.
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 8) {
                    self.lead(hasReactions: hasReactions, showsTime: showsActions)
                    if showsActions {
                        self.actions(copyText: copyText)
                            // The first glyph sits a gap from the time, not a whole hit target away.
                                .padding(.leading, -8)
                    }
                }
                VStack(alignment: .leading, spacing: 0) {
                    HStack(alignment: .center, spacing: 8) {
                        self.lead(hasReactions: hasReactions, showsTime: showsActions)
                    }
                    .frame(minHeight: 44)
                    if showsActions {
                        self.actions(copyText: copyText)
                            .padding(.leading, -8)
                    }
                }
            }
            .frame(minHeight: 44)
            .padding(.top, showsActions ? -Self.hitOverhang : 0)
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-message-actions-row")
        }
    }

    @ViewBuilder
    private func lead(hasReactions: Bool, showsTime: Bool) -> some View {
        if hasReactions {
            ChatReactionPill(viewModel: self.viewModel, message: self.message, openPicker: self.openPicker)
                // The canvas ring is invisible here; line the pill's fill up with the text.
                    .padding(.leading, -ChatReactionPillLabel.ring)
        }
        if showsTime {
            ChatMessageRelativeTimestamp(timestamp: self.timestamp)
                .fixedSize()
        }
    }

    private func actions(copyText: String) -> some View {
        let replyText = ChatReplyQuote.targetText(ChatMessageVisibleText.visibleText(in: self.actionMessage))
        let fullMessageID = self.actionMessage.isTruncated
            ? self.actionMessage.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines) : nil
        return HStack(spacing: 0) {
            if let senderLabel = self.replySenderLabel, !replyText.isEmpty {
                self.iconButton(String(localized: "Reply"), systemImage: "arrowshape.turn.up.left") {
                    self.viewModel.setReplyTarget(
                        messageID: self.actionMessage.id,
                        text: replyText,
                        senderLabel: senderLabel)
                }
            }
            ChatCopyButton(text: copyText, label: "Copy Message")
            if self.viewModel.canReact(to: self.message) {
                self.iconButton(String(localized: "Add Reaction"), systemImage: "face.smiling", action: self.openPicker)
                    .accessibilityIdentifier("chat-add-reaction")
            }
            if let speech = self.speech {
                let active = speech.isActive(self.actionMessage.id)
                self.iconButton(
                    active ? String(localized: "Stop Listening") : String(localized: "Listen"),
                    systemImage: active ? "stop.circle" : "speaker.wave.2")
                {
                    speech.toggle(
                        messageID: self.actionMessage.id,
                        text: ChatMessageVisibleText.visibleText(in: self.actionMessage))
                }
            }
            if let fullMessageID, !fullMessageID.isEmpty {
                self.iconButton(String(localized: "Open Full Message"), systemImage: "doc.text.magnifyingglass") {
                    self.openFullMessage(fullMessageID)
                }
            }
        }
        // Glyphs follow the footnote style, so they grow with Dynamic Type beside the time.
        .font(OpenClawChatTypography.footnote)
        .foregroundStyle(OpenClawChatTheme.muted)
    }

    private func iconButton(
        _ title: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: systemImage)
                .frame(width: ChatCopyButton.controlSize, height: ChatCopyButton.controlSize)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
    }
}
#endif
