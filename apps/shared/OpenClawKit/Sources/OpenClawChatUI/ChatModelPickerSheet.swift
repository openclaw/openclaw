#if os(iOS)
import SwiftUI
import UIKit

/// The phone model picker: a system sheet with a list of Favorites, Recent and the providers. A provider
/// pushes its models; with one provider its models sit at the root. Search covers every provider.
struct ChatModelPickerSheet: View {
    let viewModel: OpenClawChatViewModel
    let agent: ChatModelPickerAgent
    let onPick: () -> Void
    let onClose: () -> Void
    let onSignIn: () -> Void

    @State private var detent: PresentationDetent?
    /// Tall enough for the usual root (the agent's row, up to four providers and Model sign-in) to rest above
    /// the search field; it follows the text size and stays one height through a push.
    @ScaledMetric(relativeTo: .body) private var restingHeight: CGFloat = 560
    /// The floating search field at the bottom does not inset the list; this lets the last row scroll clear.
    @ScaledMetric(relativeTo: .body) private var searchClearance: CGFloat = 64
    @State private var query = ""
    @State private var isSearching = false

    var body: some View {
        let catalog = self.viewModel.modelPickerCatalog
        NavigationStack {
            List {
                self.rootContent(catalog)
            }
            .listStyle(.insetGrouped)
            .contentMargins(.bottom, self.searchClearance, for: .scrollContent)
            .navigationTitle(Text("Model"))
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    ChatModelPickerCloseButton(action: self.onClose)
                }
            }
            .searchable(
                text: self.$query,
                isPresented: self.$isSearching,
                prompt: Text("Search models"))
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .navigationDestination(for: String.self) { providerID in
                ChatModelPickerProviderPage(
                    viewModel: self.viewModel,
                    catalog: catalog,
                    providerID: providerID,
                    onPick: self.onPick)
            }
        }
        .tint(.primary)
        .accessibilityIdentifier("chat-model-picker")
        .presentationDetents([.height(self.restingHeight), .large], selection: Binding(
            get: { self.detent ?? .height(self.restingHeight) },
            set: { self.detent = $0 }))
        .presentationDragIndicator(.visible)
        // Below full height iOS draws the sheet as glass, which lets the composer's red button tint it
        // and turns the grouped rows gray. One opaque grouped background, as on the Pages sheet, keeps the
        // sheet and its rows the same at every height.
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
        // A medium sheet would sit under the keyboard; searching takes the full height.
        .onChange(of: self.isSearching) { _, searching in
            if searching { self.detent = .large }
        }
        // A catalog that failed or came back empty loads again each time the picker opens.
        .task {
            if self.viewModel.modelChoices.isEmpty { await self.viewModel.fetchModels() }
        }
    }

    @ViewBuilder
    private func rootContent(_ catalog: ChatModelPickerCatalog) -> some View {
        let query = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        if !query.isEmpty {
            let results = catalog.search(query)
            if results.isEmpty {
                ContentUnavailableView {
                    Label {
                        Text(verbatim: String(format: String(localized: "No results for “%@”"), query))
                            .font(OpenClawChatTypography.settingsBody)
                    } icon: {
                        Image(systemName: "magnifyingglass")
                    }
                }
                .listRowBackground(Color.clear)
                .accessibilityIdentifier("chat-model-picker-no-results")
            } else {
                Section {
                    ForEach(results) { self.modelRow($0, catalog: catalog, showsProvider: true) }
                }
            }
        } else if self.viewModel.modelChoices.isEmpty {
            Section {
                Group {
                    if let message = self.viewModel.modelCatalogMessage {
                        Text(message).font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
                    } else {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                }
                self.signInRow
            }
        } else {
            // What a pick changes, at the top where it is read before choosing.
            if let target = self.viewModel.modelSelectionTargetDescription {
                Section {} header: {
                    Text(target)
                        .font(OpenClawChatTypography.settingsFootnote)
                        .textCase(nil)
                        .accessibilityIdentifier("chat-composer-model-selection-target")
                }
            }
            if let agentRow = self.agentDefaultRow {
                Section { agentRow }
            }
            // A model can sit in two sections at once; each section keeps its own row identities.
            if !catalog.favorites.isEmpty {
                Section {
                    ForEach(catalog.favorites) { self.modelRow($0, catalog: catalog, showsProvider: true) }
                } header: {
                    Text("Favorites").font(OpenClawChatTypography.settingsSectionHeader)
                }
            }
            if !catalog.recents.isEmpty {
                Section {
                    ForEach(catalog.recents) { self.modelRow($0, catalog: catalog, showsProvider: true) }
                } header: {
                    Text("Recent").font(OpenClawChatTypography.settingsSectionHeader)
                }
            }
            Section {
                if catalog.providers.count == 1, let provider = catalog.providers.first {
                    ForEach(provider.models) { self.modelRow($0, catalog: catalog, showsProvider: false) }
                } else {
                    ForEach(catalog.providers) { self.providerRow($0) }
                }
            } header: {
                if catalog.providers.count == 1, let provider = catalog.providers.first {
                    Text(verbatim: provider.displayName).font(OpenClawChatTypography.settingsSectionHeader)
                } else if !catalog.favorites.isEmpty || !catalog.recents.isEmpty {
                    Text("Providers").font(OpenClawChatTypography.settingsSectionHeader)
                }
            }
            Section { self.signInRow }
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
            onPick: self.onPick)
    }

    private func providerRow(_ provider: ChatModelProviderSection) -> some View {
        let holdsCurrent = provider.models.contains { self.viewModel.isCurrentPickerModel($0) }
        return NavigationLink(value: provider.id) {
            HStack(spacing: 12) {
                ChatProviderMark(providerID: provider.id)
                Text(verbatim: provider.displayName)
                    .font(OpenClawChatTypography.settingsBody)
                    .frame(maxWidth: .infinity, alignment: .leading)
                if holdsCurrent {
                    ChatModelPickerCheck()
                }
            }
        }
        .accessibilityValue(holdsCurrent ? Text("Current provider") : Text(verbatim: ""))
        .accessibilityIdentifier("chat-model-picker-provider-\(provider.id)")
    }

    /// The way back to the agent's own model, shown while the session uses another one.
    private var agentDefaultRow: AnyView? {
        guard self.viewModel.canSelectDefaultModel,
              self.viewModel.modelSelectionID != OpenClawChatViewModel.defaultModelSelectionID,
              !self.viewModel.isDefaultModel(selection: self.viewModel.modelSelectionID)
        else { return nil }
        let name = self.agent.name.trimmedNonEmpty ?? String(localized: "Agent")
        let model = self.viewModel.defaultModelShortLabel
        return AnyView(Button {
            self.viewModel.selectModel(OpenClawChatViewModel.defaultModelSelectionID)
            self.onPick()
        } label: {
            HStack(spacing: 12) {
                ChatModelPickerAgentBadge(agent: self.agent)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: name)
                        .font(OpenClawChatTypography.settingsBody)
                        .fontWeight(.semibold)
                        .foregroundStyle(Color.primary)
                    if let model {
                        Text(verbatim: model).font(OpenClawChatTypography.settingsFootnote).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Text("Use").font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
            }
        }
        .disabled(self.viewModel.composerModelChoicesLocked)
        .accessibilityLabel(Text(verbatim: [name, model].compactMap(\.self).joined(separator: ", ")))
        .accessibilityHint(Text("Switches back to the agent’s model."))
        .accessibilityIdentifier("chat-model-picker-agent-default"))
    }

    private var signInRow: some View {
        Button(action: self.onSignIn) {
            Label {
                Text("Model sign-in").font(OpenClawChatTypography.settingsBody).foregroundStyle(Color.primary)
            } icon: {
                Image(systemName: "key").foregroundStyle(.secondary)
            }
        }
        .accessibilityIdentifier("chat-model-sign-in")
    }
}

/// One provider's models, pushed with the system back button and edge swipe.
private struct ChatModelPickerProviderPage: View {
    let viewModel: OpenClawChatViewModel
    let catalog: ChatModelPickerCatalog
    let providerID: String
    let onPick: () -> Void
    @ScaledMetric(relativeTo: .body) private var searchClearance: CGFloat = 64

    var body: some View {
        let provider = self.catalog.providers.first { $0.id == self.providerID }
        List {
            Section {
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
        .listStyle(.insetGrouped)
        .contentMargins(.bottom, self.searchClearance, for: .scrollContent)
        .navigationTitle(Text(verbatim: provider?.displayName ?? self.providerID))
        .navigationBarTitleDisplayMode(.inline)
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
            HStack(spacing: 12) {
                ChatProviderMark(providerID: self.providerID)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: name).font(OpenClawChatTypography.settingsBody).foregroundStyle(Color.primary)
                    if !detail.isEmpty {
                        Text(verbatim: detail).font(OpenClawChatTypography.settingsFootnote).foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                if isCurrent {
                    ChatModelPickerCheck()
                }
            }
        }
        .disabled(unavailable != nil || self.viewModel.composerModelChoicesLocked)
        .contextMenu {
            Button {
                self.viewModel.toggleModelPinned(self.model.selectionID)
            } label: {
                Label {
                    Text(isFavorite ? "Remove from Favorites" : "Add to Favorites")
                        .font(OpenClawChatTypography.settingsBody)
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

/// The system close button in the sheet's top bar.
private struct ChatModelPickerCloseButton: View {
    let action: () -> Void

    var body: some View {
        if #available(iOS 26.0, *) {
            Button(role: .close, action: self.action)
                .accessibilityIdentifier("chat-model-picker-close")
        } else {
            Button(action: self.action) {
                Image(systemName: "xmark")
            }
            .accessibilityLabel(Text("Close"))
            .accessibilityIdentifier("chat-model-picker-close")
        }
    }
}

private struct ChatModelPickerCheck: View {
    var body: some View {
        Image(systemName: "checkmark")
            .font(.body.weight(.semibold))
            .foregroundStyle(.tint)
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
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 28

    var body: some View {
        Group {
            if let avatar = self.agent.avatar {
                Image(uiImage: avatar).resizable().scaledToFill()
            } else {
                Image(systemName: "person.crop.circle")
                    .resizable()
                    .scaledToFit()
                    .foregroundStyle(.secondary)
            }
        }
        .frame(width: self.size, height: self.size)
        .clipShape(Circle())
        .accessibilityHidden(true)
    }
}
#endif
