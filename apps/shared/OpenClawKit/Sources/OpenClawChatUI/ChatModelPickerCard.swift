#if os(iOS)
import SwiftUI
import UIKit

/// The phone model picker: a floating card with search, favorites, recents and the providers. A provider
/// opens its models inside the same card; with one provider its models sit at the root.
struct ChatModelPickerCard: View {
    let viewModel: OpenClawChatViewModel
    let agent: ChatModelPickerAgent
    let onPick: () -> Void
    let onClose: () -> Void
    let onSignIn: () -> Void

    @State private var providerID: String?
    @State private var swipeOffset: CGFloat = 0
    @State private var query = ""
    @FocusState private var searchFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        let catalog = self.viewModel.modelPickerCatalog
        GeometryReader { geometry in
            ZStack {
                VStack(spacing: 0) {
                    self.searchRow
                    ChatModelPickerScroll {
                        self.rootContent(catalog)
                    }
                }
                .accessibilityHidden(self.providerID != nil)
                if let providerID = self.providerID {
                    ChatModelPickerProviderPage(
                        viewModel: self.viewModel,
                        catalog: catalog,
                        providerID: providerID,
                        onBack: self.popProvider,
                        onPick: self.pick)
                        .background(OpenClawChatTheme.composerField)
                        .overlay(alignment: .leading) {
                            // A strip of its own, so a swipe never lands on a row as a tap.
                            Color.clear
                                .frame(width: ChatModelPickerMetrics.edgeSwipeWidth)
                                .contentShape(Rectangle())
                                .gesture(self.edgeSwipe(width: geometry.size.width))
                                .accessibilityHidden(true)
                        }
                        .offset(x: self.swipeOffset)
                        .transition(self.reduceMotion ? .opacity : .move(edge: .trailing))
                        .zIndex(1)
                }
            }
        }
        .animation(self.reduceMotion ? .easeOut(duration: 0.15) : .smooth(duration: 0.3), value: self.providerID)
        .background(OpenClawChatTheme.composerField)
        .clipShape(RoundedRectangle(cornerRadius: ChatModelPickerMetrics.cardRadius, style: .continuous))
        .overlay {
            RoundedRectangle(cornerRadius: ChatModelPickerMetrics.cardRadius, style: .continuous)
                .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 0.5)
        }
        .shadow(color: .black.opacity(0.16), radius: 24, y: 12)
        .accessibilityElement(children: .contain)
        .accessibilityAddTraits(.isModal)
        .accessibilityIdentifier("chat-model-picker")
    }

    /// Back from a provider by swiping from the card's leading edge, as a navigation stack does.
    private func edgeSwipe(width: CGFloat) -> some Gesture {
        DragGesture(minimumDistance: 8, coordinateSpace: .global)
            .onChanged { value in
                self.swipeOffset = max(0, value.translation.width)
            }
            .onEnded { value in
                if value.translation.width > width / 3 || value.predictedEndTranslation.width > width / 2 {
                    self.popProvider()
                } else {
                    withAnimation(.smooth(duration: 0.2)) { self.swipeOffset = 0 }
                }
            }
    }

    private func popProvider() {
        self.providerID = nil
        self.swipeOffset = 0
    }

    private var searchRow: some View {
        HStack(spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: "magnifyingglass")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .accessibilityHidden(true)
                TextField(text: self.$query) {
                    Text("Search models")
                        .font(OpenClawChatTypography.body)
                        .foregroundStyle(OpenClawChatTheme.muted)
                }
                .font(OpenClawChatTypography.body)
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
                .submitLabel(.search)
                .focused(self.$searchFocused)
                .accessibilityIdentifier("chat-model-picker-search")
                if !self.query.isEmpty {
                    Button {
                        self.query = ""
                    } label: {
                        Image(systemName: "xmark.circle.fill")
                            .font(.system(size: 17))
                            .foregroundStyle(OpenClawChatTheme.placeholder)
                            .frame(width: ChatModelPickerMetrics.touch, height: ChatModelPickerMetrics.touch)
                            .contentShape(Rectangle())
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Clear search"))
                }
            }
            .padding(.leading, 14)
            .padding(.trailing, self.query.isEmpty ? 14 : 0)
            .frame(minHeight: ChatModelPickerMetrics.touch)
            .background(Color.primary.opacity(0.06), in: Capsule())

            Button(action: self.onClose) {
                ChatModelPickerRoundGlyph(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .accessibilityLabel(Text("Close"))
            .accessibilityIdentifier("chat-model-picker-close")
        }
        .padding(.leading, 12)
        .padding(.trailing, 6)
        .padding(.top, 10)
        .padding(.bottom, 6)
    }

    @ViewBuilder
    private func rootContent(_ catalog: ChatModelPickerCatalog) -> some View {
        let query = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty {
            let results = catalog.search(query)
            if results.isEmpty {
                Text(verbatim: String(format: String(localized: "No results for “%@”"), query))
                    .font(OpenClawChatTypography.body)
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .multilineTextAlignment(.center)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, 24)
                    .padding(.top, 48)
                    .accessibilityIdentifier("chat-model-picker-no-results")
            } else {
                ForEach(results) { model in
                    self.modelRow(model, catalog: catalog, showsProvider: true)
                }
            }
        } else if self.viewModel.modelChoices.isEmpty {
            Group {
                if let message = self.viewModel.modelCatalogMessage {
                    Text(message)
                        .font(OpenClawChatTypography.body)
                        .foregroundStyle(OpenClawChatTheme.muted)
                        .multilineTextAlignment(.center)
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity)
            .padding(.horizontal, 24)
            .padding(.top, 48)
            self.signInRow
        } else {
            if let target = self.viewModel.modelSelectionTargetDescription {
                Text(target)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(OpenClawChatTheme.muted)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.horizontal, ChatModelPickerMetrics.headerInset)
                    .padding(.vertical, 6)
                    .accessibilityIdentifier("chat-composer-model-selection-target")
            }
            self.agentDefaultRow
            // A model can sit in two sections at once; each section keeps its own row identities.
            if !catalog.favorites.isEmpty {
                ChatModelPickerSectionHeader(title: "Favorites")
                VStack(spacing: 0) {
                    ForEach(catalog.favorites) { self.modelRow($0, catalog: catalog, showsProvider: true) }
                }
            }
            if !catalog.recents.isEmpty {
                ChatModelPickerSectionHeader(title: "Recent")
                VStack(spacing: 0) {
                    ForEach(catalog.recents) { self.modelRow($0, catalog: catalog, showsProvider: true) }
                }
            }
            if catalog.providers.count == 1, let provider = catalog.providers.first {
                ChatModelPickerSectionHeader(verbatim: provider.displayName)
                VStack(spacing: 0) {
                    ForEach(provider.models) { self.modelRow($0, catalog: catalog, showsProvider: false) }
                }
            } else {
                if !catalog.favorites.isEmpty || !catalog.recents.isEmpty {
                    ChatModelPickerSectionHeader(title: "Providers")
                }
                ForEach(catalog.providers) { provider in
                    self.providerRow(provider)
                }
            }
            self.signInRow
        }
    }

    private func modelRow(
        _ model: OpenClawChatModelChoice,
        catalog: ChatModelPickerCatalog,
        showsProvider: Bool) -> some View
    {
        let provider = catalog.provider(for: model)
        return ChatModelPickerModelRow(
            viewModel: self.viewModel,
            model: model,
            providerID: provider?.id ?? model.provider,
            providerName: showsProvider ? provider?.displayName : nil,
            onPick: self.pick)
    }

    private func providerRow(_ provider: ChatModelProviderSection) -> some View {
        let holdsCurrent = provider.models.contains { self.viewModel.isCurrentPickerModel($0) }
        return Button {
            self.searchFocused = false
            self.providerID = provider.id
        } label: {
            ChatModelPickerRowLayout(providerID: provider.id) {
                Text(verbatim: provider.displayName)
                    .font(OpenClawChatTypography.body)
                    .foregroundStyle(Color.primary)
            } trailing: {
                if holdsCurrent {
                    ChatModelPickerCheck()
                }
                Image(systemName: "chevron.right")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(OpenClawChatTheme.placeholder)
                    .accessibilityHidden(true)
            }
        }
        .buttonStyle(ChatModelPickerRowStyle(isCurrent: false))
        .accessibilityValue(holdsCurrent ? Text("Current model") : Text(verbatim: ""))
        .accessibilityIdentifier("chat-model-picker-provider-\(provider.id)")
    }

    /// The way back to the agent's own model, shown while the session uses another one.
    @ViewBuilder
    private var agentDefaultRow: some View {
        if self.viewModel.canSelectDefaultModel,
           self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID,
           !self.viewModel.isDefaultModel(selection: self.viewModel.modelSelectionID)
        {
            let name = self.agent.name.trimmedNonEmpty ?? String(localized: "Default")
            let model = self.viewModel.defaultModelShortLabel
            Button {
                self.viewModel.selectModel(OpenClawChatViewModel.defaultModelSelectionID)
                self.pick()
            } label: {
                ChatModelPickerRowLayout(leading: {
                    ChatModelPickerAgentBadge(agent: self.agent)
                }, title: {
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: name)
                            .font(OpenClawChatTypography.body(size: 17, weight: .semibold, relativeTo: .body))
                            .foregroundStyle(Color.primary)
                        if let model {
                            Text(verbatim: model)
                                .font(OpenClawChatTypography.footnote)
                                .foregroundStyle(OpenClawChatTheme.muted)
                        }
                    }
                }, trailing: {
                    Text("Use")
                        .font(OpenClawChatTypography.footnoteSemiBold)
                        .foregroundStyle(Color.primary)
                        .padding(.horizontal, 12)
                        .frame(minHeight: 32)
                        .background(Color.primary.opacity(0.06), in: Capsule())
                })
            }
            .buttonStyle(ChatModelPickerRowStyle(isCurrent: false))
            .disabled(self.viewModel.composerModelChoicesLocked)
            .accessibilityLabel(Text(verbatim: [name, model].compactMap(\.self).joined(separator: ", ")))
            .accessibilityHint(Text("Switches back to the agent's model."))
            .accessibilityIdentifier("chat-model-picker-agent-default")
        }
    }

    private var signInRow: some View {
        Button(action: self.onSignIn) {
            ChatModelPickerRowLayout(leading: {
                Image(systemName: "key")
                    .font(.system(size: 16, weight: .medium))
                    .foregroundStyle(OpenClawChatTheme.muted)
            }, title: {
                Text("Model sign-in")
                    .font(OpenClawChatTypography.body)
                    .foregroundStyle(Color.primary)
            }, trailing: { EmptyView() })
        }
        .buttonStyle(ChatModelPickerRowStyle(isCurrent: false))
        .padding(.top, 8)
        .accessibilityIdentifier("chat-model-sign-in")
    }

    private func pick() {
        self.searchFocused = false
        self.onPick()
    }
}

/// One provider's models, pushed inside the card: round back, the provider's name, its models.
private struct ChatModelPickerProviderPage: View {
    let viewModel: OpenClawChatViewModel
    let catalog: ChatModelPickerCatalog
    let providerID: String
    let onBack: () -> Void
    let onPick: () -> Void

    var body: some View {
        let provider = self.catalog.providers.first { $0.id == self.providerID }
        let title = provider?.displayName ?? self.providerID
        VStack(spacing: 0) {
            ZStack {
                Text(verbatim: title)
                    .font(OpenClawChatTypography.body(size: 17, weight: .semibold, relativeTo: .headline))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .padding(.horizontal, ChatModelPickerMetrics.touch + 12)
                    .accessibilityAddTraits(.isHeader)
                HStack {
                    Button(action: self.onBack) {
                        ChatModelPickerRoundGlyph(systemName: "chevron.left")
                    }
                    .buttonStyle(.plain)
                    .accessibilityLabel(Text("Back"))
                    .accessibilityIdentifier("chat-model-picker-back")
                    Spacer(minLength: 0)
                }
            }
            .padding(.horizontal, 6)
            .padding(.top, 10)
            .padding(.bottom, 6)
            ChatModelPickerScroll {
                ForEach(provider?.models ?? []) { model in
                    ChatModelPickerModelRow(
                        viewModel: self.viewModel,
                        model: model,
                        providerID: self.providerID,
                        providerName: nil,
                        onPick: self.onPick)
                }
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityAction(.escape, self.onBack)
    }
}

/// The card's round controls: a 36 pt circle in a 44 pt target.
private struct ChatModelPickerRoundGlyph: View {
    let systemName: String

    var body: some View {
        Image(systemName: self.systemName)
            .font(.system(size: 15, weight: .semibold))
            .foregroundStyle(Color.primary)
            .frame(width: 36, height: 36)
            .background(Color.primary.opacity(0.06), in: Circle())
            .frame(width: ChatModelPickerMetrics.touch, height: ChatModelPickerMetrics.touch)
            .contentShape(Rectangle())
    }
}

private struct ChatModelPickerModelRow: View {
    let viewModel: OpenClawChatViewModel
    let model: OpenClawChatModelChoice
    let providerID: String
    let providerName: String?
    let onPick: () -> Void

    var body: some View {
        let unavailable = self.viewModel.modelUnavailableDescription(self.model)
        let isCurrent = self.viewModel.isCurrentPickerModel(self.model)
        let isFavorite = self.viewModel.modelPickerFavorites.contains(self.model.selectionID)
        let name = OpenClawChatViewModel.shortModelLabel(
            name: self.model.name,
            provider: self.model.provider,
            modelID: self.model.modelID)
        let detail = [self.providerName, unavailable].compactMap(\.self).joined(separator: " · ")
        Button {
            if !isCurrent {
                self.viewModel.selectModel(self.model.selectionID)
            }
            self.onPick()
        } label: {
            ChatModelPickerRowLayout(providerID: self.providerID) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: name)
                        .font(OpenClawChatTypography.body)
                        .foregroundStyle(unavailable == nil ? Color.primary : OpenClawChatTheme.muted)
                    if !detail.isEmpty {
                        Text(verbatim: detail)
                            .font(OpenClawChatTypography.footnote)
                            .foregroundStyle(OpenClawChatTheme.muted)
                    }
                }
            } trailing: {
                if isCurrent {
                    ChatModelPickerCheck()
                }
            }
        }
        .buttonStyle(ChatModelPickerRowStyle(isCurrent: isCurrent))
        .disabled(unavailable != nil || self.viewModel.composerModelChoicesLocked)
        .contextMenu {
            Button {
                self.viewModel.toggleModelPinned(self.model.selectionID)
            } label: {
                Label {
                    Text(isFavorite ? "Remove from Favorites" : "Add to Favorites")
                        .font(OpenClawChatTypography.body)
                } icon: {
                    Image(systemName: isFavorite ? "star.slash" : "star")
                }
            }
        }
        // The button stays the accessibility element, so VoiceOver and UI tests see it disabled.
        .accessibilityLabel(Text(verbatim: [name, detail].filter { !$0.isEmpty }.joined(separator: ", ")))
        .accessibilityAddTraits(isCurrent ? .isSelected : [])
        .accessibilityIdentifier("chat-model-picker-model-\(self.model.selectionID)")
    }
}

/// Mark, text and trailing accessory on the one row geometry every picker row shares.
private struct ChatModelPickerRowLayout<Leading: View, Title: View, Trailing: View>: View {
    @ViewBuilder let leading: () -> Leading
    @ViewBuilder let title: () -> Title
    @ViewBuilder let trailing: () -> Trailing
    @ScaledMetric(relativeTo: .body) private var minHeight: CGFloat = ChatModelPickerMetrics.rowHeight

    init(
        @ViewBuilder leading: @escaping () -> Leading,
        @ViewBuilder title: @escaping () -> Title,
        @ViewBuilder trailing: @escaping () -> Trailing)
    {
        self.leading = leading
        self.title = title
        self.trailing = trailing
    }

    var body: some View {
        HStack(spacing: 12) {
            self.leading()
                .frame(width: ChatModelPickerMetrics.markSlot)
                .accessibilityHidden(true)
            self.title()
                .frame(maxWidth: .infinity, alignment: .leading)
            self.trailing()
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 6)
        .frame(minHeight: self.minHeight)
        .contentShape(Rectangle())
    }
}

extension ChatModelPickerRowLayout where Leading == ChatProviderMark {
    init(
        providerID: String,
        @ViewBuilder title: @escaping () -> Title,
        @ViewBuilder trailing: @escaping () -> Trailing)
    {
        self.init(leading: { ChatProviderMark(providerID: providerID) }, title: title, trailing: trailing)
    }
}

private struct ChatModelPickerRowStyle: ButtonStyle {
    let isCurrent: Bool
    @Environment(\.isEnabled) private var isEnabled

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .background {
                if self.isCurrent || configuration.isPressed {
                    RoundedRectangle(cornerRadius: ChatModelPickerMetrics.rowRadius, style: .continuous)
                        .fill(Color.primary.opacity(configuration.isPressed ? 0.1 : 0.06))
                }
            }
            .opacity(self.isEnabled ? 1 : 0.7)
            .padding(.horizontal, ChatModelPickerMetrics.rowInset)
    }
}

private struct ChatModelPickerScroll<Content: View>: View {
    @ViewBuilder let content: () -> Content

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 0) {
                self.content()
            }
            .padding(.bottom, 10)
        }
        .scrollIndicators(.automatic)
        .scrollBounceBehavior(.basedOnSize)
    }
}

private struct ChatModelPickerSectionHeader: View {
    let text: Text

    init(title: LocalizedStringKey) {
        self.text = Text(title)
    }

    init(verbatim: String) {
        self.text = Text(verbatim: verbatim)
    }

    var body: some View {
        self.text
            .font(OpenClawChatTypography.footnoteSemiBold)
            .foregroundStyle(OpenClawChatTheme.muted)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, ChatModelPickerMetrics.headerInset)
            .padding(.top, 12)
            .padding(.bottom, 4)
            .accessibilityAddTraits(.isHeader)
    }
}

private struct ChatModelPickerCheck: View {
    var body: some View {
        Image(systemName: "checkmark")
            .font(.system(size: 17, weight: .semibold))
            .foregroundStyle(Color.primary)
            .accessibilityHidden(true)
    }
}

/// The agent whose own model the picker offers to go back to.
struct ChatModelPickerAgent {
    let name: String
    let avatar: UIImage?
}

private struct ChatModelPickerAgentBadge: View {
    let agent: ChatModelPickerAgent

    var body: some View {
        Group {
            if let avatar = self.agent.avatar {
                Image(uiImage: avatar).resizable().scaledToFill()
            } else {
                Image(systemName: "person.crop.circle")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(OpenClawChatTheme.muted)
            }
        }
        .frame(width: 28, height: 28)
        .clipShape(Circle())
    }
}

enum ChatModelPickerMetrics {
    static let cardRadius: CGFloat = 30
    static let rowHeight: CGFloat = 52
    static let rowRadius: CGFloat = 16
    static let rowInset: CGFloat = 4
    static let headerInset: CGFloat = 20
    static let markSlot: CGFloat = 30
    static let touch: CGFloat = 44
    static let edgeSwipeWidth: CGFloat = 20
}
#endif
