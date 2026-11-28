#if os(iOS)
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Where the model sheet can go: a provider's models, the accounts page, or one provider's account.
enum ChatModelPickerRoute: Hashable {
    case provider(String)
    case accounts
    case account(String)
    case effort
}

enum ChatModelAccountsPolicy {
    /// Sign out removes saved provider credentials and is proven only on the fixture, so it stays hidden
    /// until Victor decides to offer it. The code and its unit tests stay in place.
    static let offersSignOut = false
}

/// The sign-in flow of one model sheet. It takes the connection the first time the accounts page opens and
/// keeps it, with any sign-in in progress, while the person moves between the accounts and a provider.
@MainActor
@Observable
final class ChatModelAccountsOwner {
    enum Phase {
        case connecting
        /// The server can't sign in to providers from the app.
        case unsupported
        case ready(ChatModelSignInModel)
    }

    private(set) var phase: Phase = .connecting
    private var opening = false

    func open(_ viewModel: OpenClawChatViewModel) async {
        guard case .connecting = self.phase, !self.opening else { return }
        self.opening = true
        defer { self.opening = false }
        guard let context = await viewModel.modelSignInContext() else {
            self.phase = .unsupported
            return
        }
        let model = ChatModelSignInModel(context: context) { await viewModel.refreshModelSignIn() }
        self.phase = .ready(model)
        await model.refresh()
    }

    /// The sheet is going away: a sign-in still running is cancelled on the server.
    func close() async {
        if case let .ready(model) = self.phase { await model.close() }
    }
}

/// Providers whose every model the catalog reports as sign-in failed; the status read alone can't tell.
@MainActor
func chatModelFailedProviders(_ viewModel: OpenClawChatViewModel) -> Set<String> {
    guard viewModel.modelAvailabilityIsSessionScoped else { return [] }
    return Set(viewModel.modelPickerCatalog().providers.filter { $0.signInNeed == .authFailed }.map(\.id))
}

// MARK: - Accounts

/// Every provider OpenClaw can use, then the ones it can't yet. A row says nothing more than its name unless
/// something needs attention.
struct ChatModelAccountsPage: View {
    let owner: ChatModelAccountsOwner
    let viewModel: OpenClawChatViewModel

    var body: some View {
        List {
            switch self.owner.phase {
            case .connecting:
                ChatModelAccountsLoadingSection()
            case .unsupported:
                ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.unsupported)
            case let .ready(model):
                self.content(model)
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .refreshable {
            if case let .ready(model) = self.owner.phase { await model.reload() }
        }
        .navigationTitle(Text(ChatModelAccountsCopy.title))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("model-auth-accounts")
        .task { await self.owner.open(self.viewModel) }
    }

    @ViewBuilder
    private func content(_ model: ChatModelSignInModel) -> some View {
        if let status = model.authStatus {
            let groups = ChatModelAccountGroups(
                status: status,
                failedProviders: chatModelFailedProviders(self.viewModel))
            if let problem = ChatModelAccountsCopy.loadProblem(model.outcome) {
                ChatModelAccountsMessageSection(text: problem, retry: { await model.reload() })
            }
            if groups.isEmpty {
                ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.noAccounts)
            }
            if !groups.signedIn.isEmpty {
                Section {
                    ForEach(groups.signedIn) { ChatModelAccountRow(account: $0) }
                } header: {
                    Text(ChatModelAccountsCopy.signedIn).font(OpenClawChatTypography.settingsSectionHeader)
                }
            }
            if !groups.notSignedIn.isEmpty {
                Section {
                    ForEach(groups.notSignedIn) { ChatModelAccountRow(account: $0) }
                } header: {
                    Text(ChatModelAccountsCopy.notSignedIn).font(OpenClawChatTypography.settingsSectionHeader)
                }
            }
        } else if model.outcome == .connectionChanged {
            ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.connectionChanged)
        } else if let problem = ChatModelAccountsCopy.loadProblem(model.outcome) {
            ChatModelAccountsMessageSection(text: problem, retry: { await model.reload() })
        } else {
            ChatModelAccountsLoadingSection()
        }
    }
}

/// A provider's name and mark, and a second line only when its sign-in needs attention.
private struct ChatModelAccountRow: View {
    let account: ChatModelAccount

    var body: some View {
        NavigationLink(value: ChatModelPickerRoute.account(self.account.id)) {
            HStack(spacing: 12) {
                ChatProviderMark(providerID: self.account.id)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: self.account.name)
                        .font(OpenClawChatTypography.settingsBody)
                        .foregroundStyle(Color.primary)
                    if let notice = self.account.notice {
                        Text(ChatModelAccountsCopy.notice(notice))
                            .font(OpenClawChatTypography.settingsFootnote)
                            .foregroundStyle(ChatModelAccountsCopy.isProblem(notice)
                                ? AnyShapeStyle(OpenClawChatTheme.warning)
                                : AnyShapeStyle(.secondary))
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
        .accessibilityIdentifier("model-auth-provider-\(self.account.id)")
    }
}

// MARK: - One provider

/// One provider: what the server reports about its sign-in, the ways to sign in, the steps of the one under
/// way, and signing out when the server can remove the sign-in.
struct ChatModelAccountPage: View {
    let owner: ChatModelAccountsOwner
    let viewModel: OpenClawChatViewModel
    let accountID: String
    let onNeedsRoom: () -> Void

    var body: some View {
        List {
            switch self.owner.phase {
            case .connecting:
                ChatModelAccountsLoadingSection()
            case .unsupported:
                ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.unsupported)
            case let .ready(model):
                self.content(model)
            }
        }
        .listStyle(.insetGrouped)
        .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
        .refreshable {
            if case let .ready(model) = self.owner.phase, model.sessionID == nil { await model.reload() }
        }
        .navigationTitle(Text(verbatim: self.title))
        .navigationBarTitleDisplayMode(.inline)
        .accessibilityIdentifier("model-auth-account")
        .task { await self.owner.open(self.viewModel) }
    }

    private var title: String {
        if case let .ready(model) = self.owner.phase, let status = model.authStatus,
           let account = ChatModelAccountGroups(status: status).account(self.accountID)
        {
            return account.name
        }
        return self.viewModel.modelPickerCatalog().providers.first { $0.id == self.accountID }?.displayName
            ?? ChatModelPickerStore.providerDisplayName(self.accountID)
    }

    @ViewBuilder
    private func content(_ model: ChatModelSignInModel) -> some View {
        if let status = model.authStatus {
            let groups = ChatModelAccountGroups(
                status: status,
                failedProviders: chatModelFailedProviders(self.viewModel))
            if let problem = ChatModelAccountsCopy.loadProblem(model.outcome) {
                ChatModelAccountsMessageSection(text: problem, retry: { await model.reload() })
            }
            if let account = groups.account(self.accountID) {
                ChatModelAccountSections(model: model, account: account, onNeedsRoom: self.onNeedsRoom)
            } else {
                ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.noOptions(self.title))
            }
        } else if model.outcome == .connectionChanged {
            ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.connectionChanged)
        } else if let problem = ChatModelAccountsCopy.loadProblem(model.outcome) {
            ChatModelAccountsMessageSection(text: problem, retry: { await model.reload() })
        } else {
            ChatModelAccountsLoadingSection()
        }
    }
}

private struct ChatModelAccountSections: View {
    let model: ChatModelSignInModel
    let account: ChatModelAccount
    let onNeedsRoom: () -> Void
    @State private var confirmsSignOut = false

    var body: some View {
        if self.account.isSignedIn {
            self.facts
        }
        if let step = self.runningStep {
            ChatModelSignInStepSection(
                model: self.model,
                step: step,
                providerName: self.account.name,
                onNeedsRoom: self.onNeedsRoom)
        } else if !self.account.options.isEmpty {
            // Every way the server offers stays reachable, as in the old sheet's single list.
            self.options
        } else if !self.account.isSignedIn {
            ChatModelAccountsMessageSection(text: ChatModelAccountsCopy.noOptions(self.account.name))
        }
        if ChatModelAccountsPolicy.offersSignOut, self.account.isSignedIn, !self.account.removableProfileIDs.isEmpty {
            self.signOut
        }
    }

    /// The step of the sign-in started on this page, while it runs.
    private var runningStep: WizardStep? {
        guard let attempt = self.model.attempt, self.account.options.contains(attempt),
              self.model.sessionID != nil
        else { return nil }
        return self.model.step ?? WizardStep.starting
    }

    @ViewBuilder
    private var facts: some View {
        let rows = ChatModelAccountsCopy.facts(self.account)
        if !rows.isEmpty {
            Section {
                ForEach(rows, id: \.self) { row in
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: row.title).font(OpenClawChatTypography.settingsBody)
                        if let detail = row.detail {
                            Text(verbatim: detail)
                                .font(OpenClawChatTypography.settingsFootnote)
                                .foregroundStyle(row.isProblem
                                    ? AnyShapeStyle(OpenClawChatTheme.warning)
                                    : AnyShapeStyle(.secondary))
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private var options: some View {
        let attempt = self.model.attempt.flatMap { self.account.options.contains($0) ? $0 : nil }
        let problem = attempt.flatMap { _ in ChatModelAccountsCopy.attemptProblem(self.model.outcome) }
        return Section {
            ForEach(self.account.options) { option in
                Button {
                    Task { await self.model.start(option) }
                } label: {
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: option.label)
                            .font(OpenClawChatTypography.settingsBody)
                            .foregroundStyle(Color.primary)
                        if let hint = option.hint?.trimmedNonEmpty {
                            Text(verbatim: hint)
                                .font(OpenClawChatTypography.settingsFootnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                    // The spinner takes the place a chevron would; the text never moves for it.
                    .padding(.trailing, ChatModelSignInMetrics.accessory)
                    .overlay(alignment: .trailing) {
                        if self.model.busy, self.model.attempt == option {
                            ProgressView().frame(width: ChatModelSignInMetrics.accessory)
                        }
                    }
                    .contentShape(Rectangle())
                }
                .disabled(self.model.busy || self.model.sessionID != nil)
                .accessibilityIdentifier("model-auth-option-\(option.id)")
            }
        } header: {
            Text(!self.account.isSignedIn ? ChatModelAccountsCopy.signInWith
                : self.account.notice == nil ? ChatModelAccountsCopy.signInOptions : ChatModelAccountsCopy.signInAgain)
                .font(OpenClawChatTypography.settingsSectionHeader)
        } footer: {
            if let problem, let attempt {
                ChatModelSignInProblem(text: problem) {
                    if self.model.outcome == .endedStatusUnknown {
                        await self.model.reload()
                    } else {
                        await self.model.start(attempt)
                    }
                }
            }
        }
    }

    private var signOut: some View {
        Section {
            Button(role: .destructive) {
                self.confirmsSignOut = true
            } label: {
                Text(ChatModelAccountsCopy.signOut)
                    .font(OpenClawChatTypography.settingsBody)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.trailing, ChatModelSignInMetrics.accessory)
                    .overlay(alignment: .trailing) {
                        if self.model.signingOut == self.account.id {
                            ProgressView().frame(width: ChatModelSignInMetrics.accessory)
                        }
                    }
            }
            .disabled(self.model.busy || self.model.sessionID != nil)
            .accessibilityIdentifier("model-auth-sign-out")
            .confirmationDialog(
                Text(verbatim: ChatModelAccountsCopy.signOutTitle(self.account.name)),
                isPresented: self.$confirmsSignOut,
                titleVisibility: .visible)
            {
                Button(role: .destructive) {
                    Task { await self.signOutNow() }
                } label: {
                    Text(ChatModelAccountsCopy.signOut).font(OpenClawChatTypography.settingsBody)
                }
            } message: {
                Text(verbatim: ChatModelAccountsCopy.signOutMessage(self.account.name))
            }
        } footer: {
            if self.model.outcome == .signOutFailed {
                ChatModelSignInProblem(text: ChatModelAccountsCopy.signOutFailed) { await self.signOutNow() }
            }
        }
    }

    private func signOutNow() async {
        await self.model.signOut(provider: self.account.id, profileIDs: self.account.removableProfileIDs)
    }
}

/// The step the server is on, in the order it sends them: what it says, a code, the sign-in page, the
/// answer it needs, then Continue and Cancel.
private struct ChatModelSignInStepSection: View {
    let model: ChatModelSignInModel
    let step: WizardStep
    let providerName: String
    let onNeedsRoom: () -> Void
    @FocusState private var fieldFocused: Bool

    var body: some View {
        @Bindable var model = self.model
        let answers = wizardStepExecutor(self.step) != "gateway" && self.step.id != WizardStep.starting.id
        Section {
            if let message = self.step.message?.trimmedNonEmpty {
                Text(verbatim: message)
                    .font(OpenClawChatTypography.settingsBody)
                    .textSelection(.enabled)
            }
            if let code = parseWizardDeviceCode(self.step.devicecode) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: code.code)
                        .font(OpenClawChatTypography.mono(size: 24, weight: .semibold, relativeTo: .title2))
                        .textSelection(.enabled)
                    if let message = code.message?.trimmedNonEmpty {
                        Text(verbatim: message)
                            .font(OpenClawChatTypography.settingsFootnote)
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityElement(children: .combine)
                .accessibilityIdentifier("model-auth-device-code")
            }
            if let rawURL = self.step.externalurl, let url = URL(string: rawURL),
               url.scheme == "https" || url.scheme == "http", url.host != nil
            {
                Link(destination: url) {
                    HStack {
                        Text(ChatModelAccountsCopy.openSignInPage).font(OpenClawChatTypography.settingsBody)
                        Spacer(minLength: 8)
                        Image(systemName: "arrow.up.forward").foregroundStyle(.secondary)
                    }
                }
                .accessibilityIdentifier("model-auth-external-url")
            }
            if answers {
                self.input(model: $model)
            }
            ChatModelSignInButtonRow(
                title: ChatModelAccountsCopy.continueTitle,
                isBusy: self.model.busy,
                // While the server waits on the provider, Continue's box says so unless the step already
                // does; it never grows for it.
                busyTitle: answers || self.step.message?.trimmedNonEmpty != nil
                    ? nil : ChatModelAccountsCopy.waiting(self.providerName),
                id: "model-auth-continue")
            {
                await self.model.answer()
            }
            .disabled(!answers || self.model.busy || self.model.cancelling)
            ChatModelSignInButtonRow(
                title: ChatModelAccountsCopy.cancel,
                isBusy: self.model.cancelling,
                id: "model-auth-cancel")
            {
                await self.model.cancel()
            }
            .disabled(self.model.cancelling)
        } header: {
            Text(verbatim: self.step.title?.trimmedNonEmpty ?? self.model.attempt?.label ?? "")
                .font(OpenClawChatTypography.settingsSectionHeader)
        } footer: {
            if let problem = ChatModelAccountsCopy.stepProblem(self.model.outcome) {
                ChatModelSignInProblem(text: problem, retry: self.retry)
            }
        }
        .onChange(of: self.fieldFocused) { _, focused in
            if focused { self.onNeedsRoom() }
        }
    }

    private var retry: (() async -> Void)? {
        switch self.model.outcome {
        case .stopped:
            // The step may be gone on the server; start the same sign-in over.
            {
                let attempt = self.model.attempt
                await self.model.cancel()
                if let attempt { await self.model.start(attempt) }
            }
        case .cancelUnconfirmed:
            { await self.model.cancel() }
        default:
            nil
        }
    }

    @ViewBuilder
    private func input(model: Bindable<ChatModelSignInModel>) -> some View {
        switch wizardStepType(self.step) {
        case "text":
            let prompt = Text(verbatim: self.step.placeholder?.trimmedNonEmpty ?? ChatModelAccountsCopy.value)
            Group {
                // The server marks keys and passwords sensitive; those never show as typed.
                if self.step.sensitive == true {
                    SecureField(text: model.text) { prompt.font(OpenClawChatTypography.settingsBody) }
                } else {
                    TextField(text: model.text) { prompt.font(OpenClawChatTypography.settingsBody) }
                }
            }
            .font(OpenClawChatTypography.settingsBody)
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .focused(self.$fieldFocused)
            .submitLabel(.continue)
            .onSubmit { Task { await self.model.answer() } }
            .accessibilityIdentifier("model-auth-field")
        case "confirm":
            Toggle(isOn: model.confirmation) {
                Text(ChatModelAccountsCopy.confirm).font(OpenClawChatTypography.settingsBody)
            }
        case "select":
            Picker(selection: model.selection) {
                ForEach(Array(parseWizardOptions(self.step.options).enumerated()), id: \.offset) { index, option in
                    Text(verbatim: option.label).font(OpenClawChatTypography.settingsBody).tag(index)
                }
            } label: {
                Text(ChatModelAccountsCopy.option).font(OpenClawChatTypography.settingsBody)
            }
            .pickerStyle(.navigationLink)
        default:
            EmptyView()
        }
    }
}

// MARK: - Shared pieces

enum ChatModelSignInMetrics {
    /// The trailing slot a busy row's spinner takes, the width of a list chevron's area.
    static let accessory: CGFloat = 22
}

/// A list button whose spinner replaces its label in the same box while it works.
struct ChatModelSignInButtonRow: View {
    let title: String
    let isBusy: Bool
    /// Said next to the spinner when the wait is someone else's, such as the provider's.
    var busyTitle: String?
    let id: String
    let action: () async -> Void

    var body: some View {
        Button {
            Task { await self.action() }
        } label: {
            ZStack(alignment: .leading) {
                Text(self.title)
                    .font(OpenClawChatTypography.settingsBody)
                    .opacity(self.isBusy ? 0 : 1)
                if self.isBusy {
                    HStack(spacing: 10) {
                        ProgressView()
                        if let busyTitle = self.busyTitle {
                            Text(verbatim: busyTitle)
                                .font(OpenClawChatTypography.settingsBody)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                    }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .accessibilityLabel(Text(verbatim: self.isBusy ? self.busyTitle ?? self.title : self.title))
        .accessibilityValue(self.isBusy ? Text(ChatModelAccountsCopy.inProgress) : Text(verbatim: ""))
        .accessibilityIdentifier(self.id)
    }
}

/// What went wrong, under the thing it went wrong in, and Try again when trying again can help.
private struct ChatModelSignInProblem: View {
    let text: String
    var retry: (() async -> Void)?

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: self.text)
                .font(OpenClawChatTypography.settingsFootnote)
                .foregroundStyle(OpenClawChatTheme.warning)
                .textSelection(.enabled)
            if let retry = self.retry {
                Button {
                    Task { await retry() }
                } label: {
                    Text(ChatModelAccountsCopy.tryAgain).font(OpenClawChatTypography.settingsFootnote.weight(.semibold))
                }
                .buttonStyle(.borderless)
                .foregroundStyle(Color.primary)
                .accessibilityIdentifier("model-auth-try-again")
            }
        }
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("model-auth-problem")
    }
}

/// A page-level state in place of the list: unsupported, failed, empty or changed connection.
private struct ChatModelAccountsMessageSection: View {
    let text: String
    var retry: (() async -> Void)?

    var body: some View {
        Section {
            Text(verbatim: self.text)
                .font(OpenClawChatTypography.settingsBody)
                .foregroundStyle(.secondary)
                .accessibilityIdentifier("model-auth-message")
            if let retry = self.retry {
                ChatModelSignInButtonRow(
                    title: ChatModelAccountsCopy.tryAgain,
                    isBusy: false,
                    id: "model-auth-try-again")
                {
                    await retry()
                }
            }
        }
    }
}

/// The first load, as the model sheet shows its own: one spinner in a card.
private struct ChatModelAccountsLoadingSection: View {
    var body: some View {
        Section {
            ProgressView().frame(maxWidth: .infinity)
                .accessibilityIdentifier("model-auth-loading")
        }
    }
}

extension WizardStep {
    /// Stands in for the first step while the server starts the sign-in.
    fileprivate static let starting = WizardStep(
        id: "openclaw.sign-in.starting",
        type: AnyCodable("progress"),
        executor: AnyCodable("gateway"))
}
#endif

#if os(iOS)
/// Every word the iPhone accounts pages show, in one place for review.
enum ChatModelAccountsCopy {
    /// The root row and the page carry the same name.
    static var title: String {
        String(localized: "Provider accounts")
    }

    static var signedIn: String {
        String(localized: "Signed in")
    }

    static var notSignedIn: String {
        String(localized: "Not signed in")
    }

    static var signIn: String {
        String(localized: "Sign in")
    }

    static var signInAgain: String {
        String(localized: "Sign in again")
    }

    static var signOut: String {
        String(localized: "Sign out")
    }

    static var openSignInPage: String {
        String(localized: "Open sign-in page")
    }

    static var continueTitle: String {
        String(localized: "Continue")
    }

    static var cancel: String {
        String(localized: "Cancel")
    }

    static var confirm: String {
        String(localized: "Confirm")
    }

    static var option: String {
        String(localized: "Option")
    }

    static var value: String {
        String(localized: "Value")
    }

    static var tryAgain: String {
        String(localized: "Try again")
    }

    static var inProgress: String {
        String(localized: "In progress")
    }

    static var signInWith: String {
        String(localized: "Sign in with")
    }

    static var signInOptions: String {
        String(localized: "Sign-in options")
    }

    static func waiting(_ provider: String) -> String {
        String(format: String(localized: "Waiting for %@…"), provider)
    }

    static var unsupported: String {
        String(localized: "Update OpenClaw to sign in from here.")
    }

    static var connectionChanged: String {
        String(localized: "The connection changed. Close this and open it again.")
    }

    static var noAccounts: String {
        String(localized: "There’s nothing to sign in to from here. Go to Settings > Models in the OpenClaw web app.")
    }

    static var signOutFailed: String {
        String(localized: "Couldn’t sign out.")
    }

    static func noOptions(_ provider: String) -> String {
        String(
            format: String(
                localized: "You can’t sign in to %@ from here. Go to Settings > Models in the OpenClaw web app."),
            provider)
    }

    static func signOutTitle(_ provider: String) -> String {
        String(format: String(localized: "Sign out of %@?"), provider)
    }

    static func signOutMessage(_ provider: String) -> String {
        String(format: String(localized: "%@ models won’t work until you sign in again."), provider)
    }

    static func notice(_ notice: ChatModelAccount.Notice) -> String {
        switch notice {
        case let .expiresSoon(date?):
            String(format: String(localized: "Sign-in expires %@"), Self.relative(date))
        case .expiresSoon(nil): String(localized: "Sign-in expires soon")
        case .expired: String(localized: "Sign-in expired")
        case .failed: String(localized: "Sign-in failed")
        case .unknown: String(localized: "Status unavailable")
        }
    }

    /// Expired and failed stop the provider's models; the rest is a heads-up.
    static func isProblem(_ notice: ChatModelAccount.Notice) -> Bool {
        notice == .expired || notice == .failed
    }

    /// A list that couldn't load or isn't ready yet. Other outcomes belong to a provider's page.
    static func loadProblem(_ outcome: ChatModelSignInOutcome?) -> String? {
        switch outcome {
        case .loadFailed: String(localized: "Couldn’t load accounts.")
        case .statusNotReady: String(localized: "OpenClaw is still getting accounts ready.")
        default: nil
        }
    }

    /// A sign-in that ended without finishing, shown under its option. Cancelling says nothing.
    static func attemptProblem(_ outcome: ChatModelSignInOutcome?) -> String? {
        switch outcome {
        case .startFailed: String(localized: "Couldn’t start signing in.")
        case let .ended(status, error):
            status == "cancelled" ? nil : error?.trimmedNonEmpty ?? String(localized: "Sign-in didn’t finish.")
        case .endedStatusUnknown: String(localized: "Sign-in ended, but OpenClaw couldn’t check the account.")
        default: nil
        }
    }

    /// A problem with the step on screen, shown under it.
    static func stepProblem(_ outcome: ChatModelSignInOutcome?) -> String? {
        switch outcome {
        case let .stepError(message): message
        case .stopped: String(localized: "Sign-in stopped. Check the connection.")
        case .cancelUnconfirmed: String(localized: "Couldn’t cancel.")
        default: nil
        }
    }

    struct Fact: Hashable {
        let title: String
        let detail: String?
        let isProblem: Bool
    }

    /// What the server reports about a signed-in account: who, how, and what is wrong with it if anything.
    static func facts(_ account: ChatModelAccount) -> [Fact] {
        var facts = account.profiles.map { profile in
            let title = profile.email?.trimmedNonEmpty ?? profile.displayName?.trimmedNonEmpty
                ?? Self.profileKind(profile.type)
            let notice: ChatModelAccount.Notice? = switch profile.status {
            case "expiring": .expiring(at: profile.expiry.map { Date(timeIntervalSince1970: $0.at / 1000) })
            case "expired": .expired
            default: nil
            }
            return Fact(title: title, detail: notice.map(Self.notice), isProblem: notice.map(Self.isProblem) ?? false)
        }
        // The provider's own notice goes on the first row unless a sign-in below already says it.
        let notice = facts.contains { $0.detail != nil } ? nil : account.notice
        if facts.isEmpty {
            let title: String? = switch account.source {
            case .settingsKey: String(localized: "API key in OpenClaw settings")
            case .environmentKey: String(localized: "API key from the environment")
            case .providerApp: String(localized: "Signed in with the provider’s app")
            // Nothing to say about an account that works: no row. A plan or a notice needs one to sit on.
            case nil: account.plan == nil && notice == nil ? nil : String(localized: "Account")
            }
            if let title { facts.append(Fact(title: title, detail: account.plan, isProblem: false)) }
        } else if let plan = account.plan {
            facts.append(Fact(title: plan, detail: nil, isProblem: false))
        }
        if let notice {
            let first = facts.removeFirst()
            facts.insert(
                Fact(title: first.title, detail: Self.notice(notice), isProblem: Self.isProblem(notice)),
                at: 0)
        }
        return facts
    }

    private static func profileKind(_ type: String?) -> String {
        switch type {
        case "api_key": String(localized: "API key")
        case "token": String(localized: "Access token")
        default: String(localized: "Account")
        }
    }

    private static func relative(_ date: Date) -> String {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter.localizedString(for: date, relativeTo: Date())
    }
}
#endif
