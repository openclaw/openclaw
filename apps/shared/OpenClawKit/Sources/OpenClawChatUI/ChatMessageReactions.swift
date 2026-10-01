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
        let own = reaction.identities.filter { $0.id == self.viewModel.viewerReactionUserID }
        let others = reaction.identities.filter { $0.id != self.viewModel.viewerReactionUserID }
        let names = (own + others).map {
            $0.id == self.viewModel.viewerReactionUserID ? String(localized: "You") : ($0.label ?? $0.id)
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
        .presentationDetents([.height(self.showsCustom ? 300 : 220)])
        .accessibilityIdentifier("chat-reaction-picker")
        .onChange(of: self.viewModel.reactionContextID) { _, _ in self.dismiss() }
        .onChange(of: self.viewModel.sessionKey) { _, _ in self.dismiss() }
        .onChange(of: self.viewModel.sessionId) { _, _ in self.dismiss() }
        .onChange(of: self.viewModel.canReact(to: self.message)) { _, allowed in
            if !allowed { self.dismiss() }
        }
    }

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
