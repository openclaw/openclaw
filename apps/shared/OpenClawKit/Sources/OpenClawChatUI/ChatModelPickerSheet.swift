#if os(iOS)
import SwiftUI
import UIKit

/// The phone model picker: a system sheet with a list of Favorites, Recent and the providers. A provider
/// pushes its models; with one provider its models sit at the root. Search covers every provider. Provider
/// accounts, the last row, pushes the sign-in pages; the composer opens the sheet on them directly.
struct ChatModelPickerSheet: View {
    let viewModel: OpenClawChatViewModel
    /// The sheet opens on Provider accounts instead of the models.
    let opensAccounts: Bool
    let onPick: () -> Void
    let onClose: () -> Void

    @State private var detent: PresentationDetent?
    /// The root's height, taken from its content once per presentation, so everything on it, Model sign-in
    /// included, rests above the search field. It may grow once when the catalog arrives after the sheet is up,
    /// never shrinks, and holds through a push, a search and the way back.
    @State private var fittedHeight: CGFloat?
    @State private var fittedWithCatalog = false
    /// The least it rests at, for a catalog that is loading, failed or empty. It does not grow with the text
    /// size: the fitted height already does, and a scaled floor left empty space above search at large sizes.
    private static let minimumHeight: CGFloat = 456
    /// The first card sits this far below the title bar, as in the system's own sheets with a headerless first
    /// section (Reminders' New List: 8.7 pt); the list's default top inset left 33.6 pt.
    static let listTopMargin: CGFloat = 9
    /// The floating search field at the bottom does not inset the list; this lets the last row scroll clear.
    @ScaledMetric(relativeTo: .body) private var searchClearance: CGFloat = 64
    @State private var query = ""
    @State private var isSearching = false
    /// Recent's order when the sheet opened, so it does not reshuffle while it is open.
    @State private var recentOrder: [String]?
    @State private var path: [ChatModelPickerRoute] = []
    /// The sign-in flow, shared by the accounts page and each provider's page for as long as the sheet is up.
    @State private var accounts = ChatModelAccountsOwner()

    var body: some View {
        let catalog = self.viewModel.modelPickerCatalog(recentOrder: self.recentOrder)
        NavigationStack(path: self.$path) {
            Group {
                if self.opensAccounts {
                    ChatModelAccountsPage(owner: self.accounts, viewModel: self.viewModel)
                } else {
                    self.modelsRoot(catalog)
                }
            }
            .toolbar {
                OpenClawSheetCloseItem(identifier: "chat-model-picker-close", action: self.onClose)
                if self.viewModel.composerOffersEffortChoices {
                    ToolbarItem(placement: .topBarTrailing) {
                        NavigationLink(value: ChatModelPickerRoute.effort) {
                            HStack(spacing: 3) {
                                Text("Effort")
                                Image(systemName: "chevron.right")
                                    .font(.footnote.weight(.semibold))
                                    .accessibilityHidden(true)
                            }
                        }
                        .accessibilityIdentifier("chat-model-picker-effort")
                    }
                }
            }
            .navigationDestination(for: ChatModelPickerRoute.self) { route in
                switch route {
                case let .provider(providerID):
                    ChatModelPickerProviderPage(
                        viewModel: self.viewModel,
                        catalog: catalog,
                        providerID: providerID,
                        onPick: self.onPick)
                case .accounts:
                    ChatModelAccountsPage(owner: self.accounts, viewModel: self.viewModel)
                case .effort:
                    List {
                        if self.viewModel.showsThinkingPicker || self.viewModel.composerPhoneEffortLockReason != nil {
                            Section {
                                ChatEffortBar(viewModel: self.viewModel, isSheetPage: true)
                            }
                        }
                        if self.viewModel.selectedModelSupportsFastMode {
                            Section {
                                ChatEffortSpeedPicker(viewModel: self.viewModel)
                                    .pickerStyle(.menu)
                                    .font(OpenClawChatTypography.settingsBody)
                                    .tint(Color(uiColor: .secondaryLabel))
                            }
                        }
                    }
                    .listStyle(.insetGrouped)
                    .listSectionSpacing(.compact)
                    .contentMargins(.top, Self.listTopMargin, for: .scrollContent)
                    .contentMargins(.bottom, 0, for: .scrollContent)
                    .navigationTitle(Text("Effort"))
                    .navigationBarTitleDisplayMode(.inline)
                case let .account(accountID):
                    ChatModelAccountPage(
                        owner: self.accounts,
                        viewModel: self.viewModel,
                        accountID: accountID,
                        onNeedsRoom: { self.detent = .large })
                }
            }
        }
        .tint(.primary)
        .accessibilityIdentifier("chat-model-picker")
        .onAppear { self.recentOrder = self.recentOrder ?? self.viewModel.modelPickerRecentIDs }
        // All pages share the same viewport, so Back reveals the laid-out list during the native pop.
        .presentationDetents([self.restingDetent, .large], selection: Binding(
            get: { self.detent == .large ? .large : self.restingDetent },
            set: { self.detent = $0 }))
        .presentationDragIndicator(.visible)
        // Below full height iOS draws the sheet as glass, which lets the composer's red button tint it
        // and turns the grouped rows gray. One opaque grouped background, as on the Pages sheet, keeps the
        // sheet and its rows the same at every height.
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
        // A catalog that failed or came back empty loads again each time the picker opens, showing the
        // loading state rather than the old failure while it does.
        .task {
            if self.viewModel.modelChoices.isEmpty {
                await self.viewModel.retryModelCatalog()
            } else {
                // The cached or last list shows now; a fresh one replaces it quietly if it changed.
                await self.viewModel.fetchModels()
            }
        }
        .onChange(of: self.path) { previous, current in
            // The native option picker can cover the account page without popping its route.
            guard let route = previous.last, case .account = route, !current.contains(route),
                  case let .ready(model) = self.accounts.phase
            else { return }
            Task { await model.cancel() }
        }
        // Closing the sheet ends a sign-in still running, as the old sign-in sheet's Close did.
        .onDisappear { Task { await self.accounts.close() } }
    }

    private func modelsRoot(_ catalog: ChatModelPickerCatalog) -> some View {
        List {
            self.rootContent(catalog)
        }
        .listStyle(.insetGrouped)
        .contentMargins(.bottom, self.searchClearance, for: .scrollContent)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .onScrollGeometryChange(for: CGFloat.self) {
            // Nothing to fit until the list has laid out its rows.
            $0.contentSize.height > 0 ? $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom : 0
        } action: { _, height in
            // The system's bottom inset already holds the search field; the extra margin is only there so
            // the last row can scroll clear at large, and the resting height does not need it.
            self.fitRestingHeight(to: height > 0 ? height - self.searchClearance : 0)
        }
        .navigationTitle(Text("Model"))
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: self.$query,
            isPresented: self.$isSearching,
            prompt: Text("Search models"))
        .textInputAutocapitalization(.never)
        .autocorrectionDisabled()
    }

    private var restingDetent: PresentationDetent {
        // Above the large detent the system rests at large, and the list scrolls.
        .height(max(Self.minimumHeight, self.fittedHeight ?? 0))
    }

    private func fitRestingHeight(to height: CGFloat) {
        // Search results are not the root; the first fit holds.
        guard self.query.isEmpty, height > 0 else { return }
        let hasCatalog = !self.viewModel.modelChoices.isEmpty
        if self.fittedHeight == nil {
            self.fittedHeight = height
            self.fittedWithCatalog = hasCatalog
        } else if !self.fittedWithCatalog, hasCatalog {
            // The catalog arrived after the sheet was up: grow once, in the frame the list fills.
            self.fittedHeight = max(self.fittedHeight ?? 0, height)
            self.fittedWithCatalog = true
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
                if let message = self.viewModel.modelCatalogMessage {
                    Text(message).font(OpenClawChatTypography.settingsBody).foregroundStyle(.secondary)
                        .accessibilityIdentifier("chat-model-picker-message")
                    // As on the accounts page: the failure and the way to try again in one card.
                    ChatModelSignInButtonRow(
                        title: ChatModelAccountsCopy.tryAgain,
                        isBusy: false,
                        id: "chat-model-picker-try-again")
                    {
                        await self.viewModel.retryModelCatalog()
                    }
                } else {
                    ProgressView().frame(maxWidth: .infinity)
                }
            }
            Section { self.signInRow }
        } else {
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
            if catalog.providers.count == 1, let provider = catalog.providers.first,
               let need = self.signInNeed(provider)
            {
                ChatModelPickerSignInSection(providerID: provider.id, need: need)
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

    /// A plain drill-in row. The current model carries the check on the root and on its provider's page. A
    /// second line appears only when none of its models can be used until someone signs in.
    private func providerRow(_ provider: ChatModelProviderSection) -> some View {
        let need = self.signInNeed(provider)
        return NavigationLink(value: ChatModelPickerRoute.provider(provider.id)) {
            HStack(spacing: 12) {
                ChatProviderMark(providerID: provider.id)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: provider.displayName)
                        .font(OpenClawChatTypography.settingsBody)
                    if let need {
                        Text(verbatim: need.pickerDescription)
                            .font(OpenClawChatTypography.settingsFootnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityIdentifier("chat-model-picker-provider-\(provider.id)")
    }

    /// Model rows only say why they can't be used when the catalog reports it for this chat; so does this.
    private func signInNeed(_ provider: ChatModelProviderSection) -> OpenClawChatModelUnavailableReason? {
        self.viewModel.modelAvailabilityIsSessionScoped ? provider.signInNeed : nil
    }

    private var signInRow: some View {
        NavigationLink(value: ChatModelPickerRoute.accounts) {
            Text(ChatModelAccountsCopy.title).font(OpenClawChatTypography.settingsBody)
        }
        .accessibilityIdentifier("chat-model-sign-in")
    }
}

/// Leads a provider whose models all wait on a sign-in to that provider's account.
private struct ChatModelPickerSignInSection: View {
    let providerID: String
    let need: OpenClawChatModelUnavailableReason

    var body: some View {
        Section {
            NavigationLink(value: ChatModelPickerRoute.account(self.providerID)) {
                Text(self.need == .authFailed ? ChatModelAccountsCopy.signInAgain : ChatModelAccountsCopy.signIn)
                    .font(OpenClawChatTypography.settingsBody)
            }
            .accessibilityIdentifier("chat-model-picker-sign-in-\(self.providerID)")
        }
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
            if let provider, self.viewModel.modelAvailabilityIsSessionScoped, let need = provider.signInNeed {
                ChatModelPickerSignInSection(providerID: provider.id, need: need)
            }
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
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
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
                    ChatSelectionCheck()
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

/// The mark for the selected row in a selection list. Its weight matches the row's regular body text, as SF
/// Symbols are drawn to, so it reads as a mark rather than a bold glyph; it takes the list's tint.
struct ChatSelectionCheck: View {
    var body: some View {
        Image(systemName: "checkmark")
            .font(.body.weight(.regular))
            .foregroundStyle(.tint)
            .accessibilityHidden(true)
    }
}
#endif
