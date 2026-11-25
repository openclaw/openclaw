import SwiftUI

@MainActor
struct ChatMessageReactions: View {
    let viewModel: OpenClawChatViewModel
    let message: OpenClawChatMessage

    var body: some View {
        if let messageID = self.message.transcriptMessageID,
           !self.viewModel.messageReactions(for: self.message).isEmpty || self.viewModel
               .reactionError(for: self.message) != nil
        {
            VStack(alignment: self.message.role == "user" ? .trailing : .leading, spacing: 4) {
                if !self.viewModel.messageReactions(for: self.message).isEmpty {
                    ViewThatFits(in: .horizontal) {
                        self.chips
                        ScrollView(.horizontal) { self.chips }
                            .scrollIndicators(.hidden)
                    }
                }
                if let error = self.viewModel.reactionError(for: self.message) {
                    Text(error)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(OpenClawChatTheme.danger)
                        .accessibilityIdentifier("chat-reaction-error")
                }
            }
            .accessibilityElement(children: .contain)
            .accessibilityIdentifier("chat-message-reactions-\(messageID)")
        }
    }

    private var chips: some View {
        HStack(spacing: 6) {
            ForEach(self.viewModel.messageReactions(for: self.message), id: \.emoji) { reaction in
                let selected = reaction.identities.contains { $0.id == self.viewModel.viewerReactionUserID }
                Group {
                    if self.viewModel.canReact(to: self.message) {
                        Button {
                            Task {
                                await self.viewModel.toggleMessageReaction(message: self.message, emoji: reaction.emoji)
                            }
                        } label: {
                            self.chip(reaction, selected: selected)
                        }
                        .buttonStyle(.plain)
                        .disabled(self.viewModel.isReactionPending(for: self.message, emoji: reaction.emoji))
                    } else {
                        self.chip(reaction, selected: selected)
                    }
                }
                .accessibilityLabel(self.reactorsLabel(reaction))
                .accessibilityAddTraits(selected ? .isSelected : [])
                .accessibilityIdentifier("chat-reaction-\(reaction.emoji)")
            }
        }
    }

    private func chip(_ reaction: OpenClawChatReactionSummary, selected: Bool) -> some View {
        HStack(spacing: 4) {
            Text(verbatim: reaction.emoji).font(OpenClawChatTypography.body)
            Text(reaction.count, format: .number).font(OpenClawChatTypography.captionSemiBold)
        }
        .padding(.horizontal, 9)
        .padding(.vertical, 5)
        .foregroundStyle(selected ? OpenClawChatTheme.accent : Color.primary)
        .background(selected ? OpenClawChatTheme.accent.opacity(0.14) : Color.secondary.opacity(0.1), in: Capsule())
        .overlay(Capsule().strokeBorder(selected ? OpenClawChatTheme.accent.opacity(0.6) : Color.clear))
        .accessibilityElement(children: .ignore)
    }

    private func reactorsLabel(_ reaction: OpenClawChatReactionSummary) -> String {
        ChatReactionNames.label(reaction, viewerID: self.viewModel.viewerReactionUserID)
    }
}

#if os(iOS)
/// A message's reactions as one pill: the three most used faces, then the total once there is more
/// than one reaction. Same ranking, face limit and total as the web tab
/// (ui/src/pages/chat/components/chat-message-reaction-chips-view.tsx).
struct ChatReactionSummary: Equatable {
    static let faceLimit = 3

    let faces: [String]
    /// One per person per emoji, as the Gateway counts them.
    let total: Int

    init?(_ reactions: [OpenClawChatReactionSummary]) {
        guard !reactions.isEmpty else { return nil }
        // Ties keep arrival order, so the faces do not reshuffle when counts match.
        let ranked = reactions.enumerated()
            .sorted {
                $0.element.count != $1.element.count ? $0.element.count > $1.element.count : $0.offset < $1.offset
            }
        self.faces = ranked.prefix(Self.faceLimit).map(\.element.emoji)
        self.total = reactions.reduce(0) { $0 + $1.count }
    }
}

/// The reactions pill on both sides of the transcript: anchored on the user bubble's corner, and
/// leading the row under an agent reply. Tapping it opens the picker, which lists who reacted with
/// what and toggles your own reactions.
@MainActor
struct ChatReactionPill: View {
    let viewModel: OpenClawChatViewModel
    let message: OpenClawChatMessage
    let openPicker: () -> Void

    var body: some View {
        if let messageID = self.message.transcriptMessageID,
           let summary = ChatReactionSummary(self.viewModel.messageReactions(for: self.message))
        {
            if self.viewModel.canReact(to: self.message) {
                Button(action: self.openPicker) { ChatReactionPillLabel(summary: summary) }
                    .buttonStyle(.plain)
                    .accessibilityLabel(self.accessibilityLabel)
                    .accessibilityIdentifier("chat-message-reactions-\(messageID)")
            } else {
                ChatReactionPillLabel(summary: summary)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(self.accessibilityLabel)
                    .accessibilityIdentifier("chat-message-reactions-\(messageID)")
            }
        }
    }

    private var accessibilityLabel: String {
        self.viewModel.messageReactions(for: self.message)
            .map { ChatReactionNames.label($0, viewerID: self.viewModel.viewerReactionUserID) }
            .joined(separator: "; ")
    }
}

/// One height for the single-emoji circle and the multi-emoji pill. The canvas ring separates the
/// pill from the user bubble it overlaps; on the agent side it disappears into the canvas.
struct ChatReactionPillLabel: View {
    static let ring: CGFloat = 2

    let summary: ChatReactionSummary
    @ScaledMetric(relativeTo: .footnote) private var height: CGFloat = 24

    var body: some View {
        HStack(spacing: 2) {
            ForEach(self.summary.faces, id: \.self) { face in
                Text(verbatim: face)
                    .font(OpenClawChatTypography.reactionEmoji)
            }
            if self.summary.total > 1 {
                Text(self.summary.total, format: .number.notation(.compactName))
                    .font(OpenClawChatTypography.reactionCount)
                    .monospacedDigit()
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .padding(.horizontal, 1)
            }
        }
        .lineLimit(1)
        .padding(.horizontal, self.summary.total > 1 ? 7 : 0)
        .frame(minWidth: self.height, minHeight: self.height)
        .background(OpenClawChatTheme.subtleCard, in: Capsule())
        .padding(Self.ring)
        .background { OpenClawChatTheme.background.clipShape(Capsule()) }
        .contentShape(Capsule())
        // A flexible frame takes the width it is offered; the pill never takes less than its faces.
        .fixedSize()
    }
}

/// Reaction errors stay under the message; the pill itself has no room for text.
@MainActor
struct ChatMessageReactionError: View {
    let viewModel: OpenClawChatViewModel
    let message: OpenClawChatMessage

    var body: some View {
        if let error = self.viewModel.reactionError(for: self.message) {
            Text(error)
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(OpenClawChatTheme.danger)
                .accessibilityIdentifier("chat-reaction-error")
        }
    }
}
#endif

enum ChatReactionNames {
    static func label(_ reaction: OpenClawChatReactionSummary, viewerID: String?) -> String {
        let own = reaction.identities.filter { $0.id == viewerID }
        let others = reaction.identities.filter { $0.id != viewerID }
        let names = (own + others).map {
            $0.id == viewerID ? String(localized: "You") : ($0.label ?? $0.id)
        }
        let shown = names.prefix(3).joined(separator: ", ")
        let label = names.count > 3
            ? String(format: String(localized: "%@ and %lld others"), shown, names.count - 3)
            : shown
        return String(format: String(localized: "%@ reacted with %@"), label, reaction.emoji)
    }
}

@MainActor
struct ChatMessageReactionAction: View {
    let viewModel: OpenClawChatViewModel
    let message: OpenClawChatMessage
    let openPicker: () -> Void

    var body: some View {
        if self.viewModel.canReact(to: self.message) {
            Button(action: self.openPicker) {
                Label("Add Reaction", systemImage: "face.smiling")
                    .font(OpenClawChatTypography.body)
            }
            .accessibilityIdentifier("chat-add-reaction")
        }
    }
}

@MainActor
struct ChatMessageReactionPicker: View {
    let viewModel: OpenClawChatViewModel
    let message: OpenClawChatMessage
    @Environment(\.dismiss) private var dismiss
    @State private var showsCustom = false
    @State private var emoji = ""
    @State private var invalid = false
    @FocusState private var customFocused: Bool

    var body: some View {
        NavigationStack {
            VStack(spacing: 20) {
                #if os(iOS)
                if !self.current.isEmpty {
                    self.currentReactions
                }
                #endif
                HStack(spacing: 6) {
                    ForEach(OpenClawChatReactionEmoji.quick, id: \.self) { emoji in
                        let selected = self.isSelected(emoji)
                        Button { self.apply(emoji) } label: {
                            Text(verbatim: emoji)
                                .font(OpenClawChatTypography.body(size: 26, weight: .regular, relativeTo: .title2))
                                .frame(maxWidth: .infinity, minHeight: 44)
                                .background(
                                    selected ? OpenClawChatTheme.accent.opacity(0.16) : Color.secondary.opacity(0.08),
                                    in: RoundedRectangle(cornerRadius: 12))
                        }
                        .buttonStyle(.plain)
                        .disabled(self.viewModel.isReactionPending(for: self.message, emoji: emoji))
                        .accessibilityLabel(emoji)
                        .accessibilityAddTraits(selected ? .isSelected : [])
                        .accessibilityIdentifier("chat-reaction-choice-\(emoji)")
                    }
                }
                if self.showsCustom {
                    self.customInput
                } else {
                    Button {
                        self.showsCustom = true
                        self.customFocused = true
                    } label: {
                        Text("More…").font(OpenClawChatTypography.body)
                    }
                    .accessibilityIdentifier("chat-reaction-more")
                }
                Spacer(minLength: 0)
            }
            .padding(20)
            .navigationTitle("Add Reaction")
            #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button { self.dismiss() } label: {
                        Text("Cancel").font(OpenClawChatTypography.body)
                    }
                }
            }
            .disabled(!self.viewModel.canReact(to: self.message))
        }
        .presentationDetents([.height((self.showsCustom ? 300 : 220) + self.currentReactionsHeight)])
        .accessibilityIdentifier("chat-reaction-picker")
        .onChange(of: self.viewModel.reactionContextID) { _, _ in self.dismiss() }
        .onChange(of: self.viewModel.sessionKey) { _, _ in self.dismiss() }
        .onChange(of: self.viewModel.sessionId) { _, _ in self.dismiss() }
        .onChange(of: self.viewModel.canReact(to: self.message)) { _, allowed in
            if !allowed { self.dismiss() }
        }
    }

    private var current: [OpenClawChatReactionSummary] {
        self.viewModel.messageReactions(for: self.message)
    }

    private var currentReactionsHeight: CGFloat {
        #if os(iOS)
        self.current.isEmpty ? 0 : 56
        #else
        0
        #endif
    }

    #if os(iOS)
    /// The message's reactions with their counts, as on the web picker. Tapping one adds or removes
    /// yours; VoiceOver reads who reacted.
    private var currentReactions: some View {
        ScrollView(.horizontal) {
            HStack(spacing: 8) {
                ForEach(self.current, id: \.emoji) { reaction in
                    let selected = self.isSelected(reaction.emoji)
                    Button { self.apply(reaction.emoji) } label: {
                        HStack(spacing: 4) {
                            Text(verbatim: reaction.emoji)
                                .font(OpenClawChatTypography.body)
                            Text(reaction.count, format: .number)
                                .font(OpenClawChatTypography.footnoteSemiBold)
                                .monospacedDigit()
                                .foregroundStyle(selected ? Color.primary : OpenClawChatTheme.muted)
                        }
                        .padding(.horizontal, 12)
                        .frame(minHeight: 36)
                        .background(Color.primary.opacity(selected ? 0.12 : 0.06), in: Capsule())
                        .overlay(Capsule().strokeBorder(Color.primary.opacity(selected ? 0.3 : 0), lineWidth: 1))
                    }
                    .buttonStyle(.plain)
                    .disabled(self.viewModel.isReactionPending(for: self.message, emoji: reaction.emoji))
                    .accessibilityLabel(ChatReactionNames.label(
                        reaction,
                        viewerID: self.viewModel.viewerReactionUserID))
                    .accessibilityAddTraits(selected ? .isSelected : [])
                    .accessibilityIdentifier("chat-reaction-\(reaction.emoji)")
                }
            }
        }
        .scrollIndicators(.hidden)
        .accessibilityElement(children: .contain)
        .accessibilityLabel(String(localized: "Current reactions"))
    }
    #endif

    private var customInput: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                TextField(text: self.$emoji) {
                    Text("Emoji").font(OpenClawChatTypography.body)
                }
                .font(OpenClawChatTypography.body)
                .textFieldStyle(.roundedBorder)
                .focused(self.$customFocused)
                .accessibilityLabel(Text("Emoji"))
                .accessibilityIdentifier("chat-reaction-emoji-input")
                .onSubmit { self.applyCustom() }
                .onChange(of: self.emoji) { _, _ in self.invalid = false }
                Button { self.applyCustom() } label: {
                    Text("React").font(OpenClawChatTypography.body)
                }
                .disabled(self.viewModel.isReactionPending(
                    for: self.message,
                    emoji: self.emoji.trimmingCharacters(in: .whitespacesAndNewlines)))
                .accessibilityIdentifier("chat-reaction-submit")
            }
            Text(self.invalid ? String(localized: "Enter one emoji.") : String(localized: "Type or paste one emoji."))
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(self.invalid ? OpenClawChatTheme.danger : Color.secondary)
        }
    }

    private func isSelected(_ emoji: String) -> Bool {
        self.viewModel.messageReactions(for: self.message).contains { reaction in
            reaction.emoji == emoji && reaction.identities.contains { $0.id == self.viewModel.viewerReactionUserID }
        }
    }

    private func applyCustom() {
        let value = self.emoji.trimmingCharacters(in: .whitespacesAndNewlines)
        guard OpenClawChatReactionEmoji.isValid(value) else {
            self.invalid = true
            return
        }
        self.apply(value)
    }

    private func apply(_ emoji: String) {
        guard self.viewModel.canReact(to: self.message) else { return }
        Task { await self.viewModel.toggleMessageReaction(message: self.message, emoji: emoji) }
        self.dismiss()
    }
}
