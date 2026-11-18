import AppKit
import Foundation
import SwiftUI

enum OnboardingProviderAuthLink {
    static func safeURL(_ rawValue: String?) -> URL? {
        guard let rawValue,
              let url = URL(string: rawValue),
              url.scheme?.lowercased() == "https",
              url.host() != nil,
              url.user() == nil,
              url.password() == nil
        else { return nil }
        return url
    }

    static func displayHost(_ rawValue: String?) -> String? {
        guard let host = safeURL(rawValue)?.host()?.lowercased() else { return nil }
        return host.hasPrefix("www.") ? String(host.dropFirst(4)) : host
    }
}

private struct OnboardingRecommendedInstallCard: View {
    let install: OnboardingAISetupModel.RecommendedInstall
    @State private var hovered = false

    var body: some View {
        Group {
            if let website = OnboardingProviderAuthLink.safeURL(self.install.website) {
                Link(destination: website) { self.content }
                    .buttonStyle(.plain)
                    .environment(\.openURL, AppActivation.shared.openURLAction)
            } else {
                self.content
            }
        }
        .onHover { self.hovered = $0 }
        .animation(.easeOut(duration: 0.12), value: self.hovered)
    }

    private var content: some View {
        HStack(alignment: .top, spacing: 10) {
            OnboardingProviderArtwork(
                icon: self.install.icon,
                brandCandidates: [self.install.brandId, self.install.id],
                fallbackSymbol: "arrow.down.circle")
            VStack(alignment: .leading, spacing: 2) {
                Text(self.install.label)
                    .font(.callout.weight(.semibold))
                Text(self.install.hint)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let host = OnboardingProviderAuthLink.displayHost(self.install.website) {
                    Text(host)
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
            }
            Spacer(minLength: 0)
            Image(systemName: "arrow.up.right")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.tertiary)
                .padding(.top, 2)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color.primary.opacity(self.hovered ? 0.085 : 0.05)))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .strokeBorder(Color.primary.opacity(0.10), lineWidth: 1))
    }
}

struct OnboardingSurface: View {
    let cornerRadius: CGFloat

    var body: some View {
        RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
            .fill(Color.primary.opacity(0.045))
            .overlay {
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
            }
    }
}

struct GatewayAuthCard: Equatable {
    let title: String
    let message: String
    let primaryTitle: String
    let secondaryTitle: String
}

struct OnboardingAISetupView: View {
    @Bindable var model: OnboardingAISetupModel
    var returnToGatewayAuthentication: () -> Void
    var retryConfiguredGatewayProbe: (OnboardingAISetupModel.SetupIntent) -> Void
    /// The picked provider. Its card replaces the list until the user chooses another.
    @State private var openRow: OnboardingAIPicker.RowID?
    @State private var showMoreProviders = false

    static func gatewayAuthCard(for issue: RemoteGatewayAuthIssue) -> GatewayAuthCard {
        GatewayAuthCard(
            title: "Gateway authentication required",
            message: issue.statusMessage,
            primaryTitle: "Back to Gateway",
            secondaryTitle: "Try again")
    }

    var body: some View {
        ScrollViewReader { scroll in
            VStack(spacing: 6) {
                ScrollView {
                    self.content
                        .padding(.vertical, 4)
                        .padding(.trailing, 12)
                }
                .scrollIndicators(.automatic)
                // Pinned below the list so it never scrolls out of sight.
                if self.showsMoreProvidersLink {
                    HStack {
                        Spacer(minLength: 0)
                        Button("More providers") {
                            withAnimation(.easeInOut(duration: 0.15)) { self.showMoreProviders.toggle() }
                            if self.showMoreProviders {
                                withAnimation { scroll.scrollTo("more-providers", anchor: .top) }
                            }
                        }
                        .buttonStyle(.link)
                    }
                    .padding(.trailing, 12)
                }
            }
            .onChange(of: self.model.manualError) { _, error in
                if error != nil {
                    withAnimation { scroll.scrollTo("manual-entry", anchor: .bottom) }
                }
            }
            // A canceled or failed sign-in goes back to the list instead of leaving an empty step.
            .onChange(of: self.model.activeAuthOption == nil) { _, ended in
                guard ended, self.model.phase != .testing, !self.model.connected,
                      let row = self.openRow.flatMap({ id in self.picker.rows.first { $0.id == id } }),
                      case .signIn = row.action
                else { return }
                withAnimation(.easeInOut(duration: 0.15)) { self.openRow = nil }
            }
        }
    }

    private var showsMoreProvidersLink: Bool {
        self.model.providerCatalogLoaded && self.model.configuredGatewayAuthIssue == nil &&
            (self.model.phase == .ready || self.model.phase == .testing) &&
            self.openRow == nil && self.model.activeAuthOption == nil
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 12) {
            switch self.model.phase {
            case .idle, .detecting:
                if self.model.waitingForPendingActivationDeadline {
                    self.pendingActivationView
                } else {
                    // The usual providers show while the Gateway answers; they turn on once it does.
                    self.rowList(OnboardingAIPicker.placeholderRows.map {
                        OnboardingAIPicker.Row(id: $0, action: .localModel, onThisMac: false)
                    })
                    .disabled(true)
                }
            case .ready, .testing:
                self.resultsView
            case .connected:
                EmptyView()
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var pendingActivationView: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                ProgressView()
                    .controlSize(.small)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Waiting for the previous AI test to finish…")
                        .font(.callout.weight(.semibold))
                    Text("OpenClaw checks again before it changes your AI setup.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
            }
            .padding(.vertical, 18)
            .frame(maxWidth: .infinity)

            if let failure = self.model.detectError {
                OnboardingErrorCard(
                    title: "AI setup needs verification",
                    message: failure.summary,
                    details: failure.detail,
                    docsSlug: "start/onboarding",
                    retryTitle: "Check again",
                    retry: { self.retryConfiguredGatewayProbe(.inspectOnly) })
            } else {
                Button("Check again") { self.retryConfiguredGatewayProbe(.inspectOnly) }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
            }
        }
    }

    private var picker: OnboardingAIPicker {
        OnboardingAIPicker(
            candidates: self.model.candidates,
            authOptions: self.model.authOptions,
            manualProviders: self.model.manualProviders,
            prepareOptions: self.model.prepareOptions)
    }

    @ViewBuilder
    private var resultsView: some View {
        let picker = self.picker
        if self.model.configuredGatewayAuthIssue == nil {
            // A picked provider's card stands alone, like a sign-in from More providers or a resumed setup.
            if let row = self.openRow.flatMap({ id in picker.rows.first { $0.id == id } }) {
                self.chooseAnotherLink
                self.rowStep(row)
            } else if self.model.activeAuthOption != nil {
                self.chooseAnotherLink
                self.unplacedSetupSteps
            } else {
                if !picker.rows.isEmpty {
                    self.rowList(picker.rows)
                }
                if self.model.providerCatalogLoaded, self.showMoreProviders {
                    self.moreProviders(picker)
                        .id("more-providers")
                }
            }
        }

        if let authIssue = model.configuredGatewayAuthIssue {
            let card = Self.gatewayAuthCard(for: authIssue)
            OnboardingErrorCard(
                title: card.title,
                message: card.message,
                docsSlug: "start/onboarding",
                retryTitle: card.primaryTitle,
                secondaryTitle: card.secondaryTitle,
                secondary: { self.retryConfiguredGatewayProbe(.startSetup) },
                retry: self.returnToGatewayAuthentication)
        } else if let detectError = model.detectError {
            OnboardingErrorCard(
                title: "Couldn’t check which AI you can use",
                message: detectError.summary,
                details: detectError.detail,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                if self.model.configuredGatewayProbeUnavailable {
                    self.retryConfiguredGatewayProbe(.startSetup)
                } else {
                    self.model.retryFromScratch()
                }
            }
        }

        if let providerCatalogError = model.providerCatalogError {
            OnboardingErrorCard(
                title: "Couldn’t load the full provider list",
                message: providerCatalogError,
                docsSlug: "start/onboarding",
                retryTitle: "Try again")
            {
                self.model.retryFromScratch()
            }
        }
    }

    private func rowList(_ rows: [OnboardingAIPicker.Row]) -> some View {
        VStack(spacing: 0) {
            ForEach(Array(rows.enumerated()), id: \.element.id) { index, row in
                if index > 0 { Divider() }
                self.pickerRow(row)
            }
        }
        .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
        .background(OnboardingSurface(cornerRadius: 12))
    }

    private func pickerRow(_ row: OnboardingAIPicker.Row) -> some View {
        Button {
            self.select(row)
        } label: {
            HStack(spacing: 12) {
                self.rowHeader(row, open: false)
                Spacer(minLength: 0)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(!self.canSelect(row))
        .accessibilityIdentifier("onboarding-ai-row-\(Self.accessibilityName(for: row.id))")
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private var chooseAnotherLink: some View {
        Button {
            if self.model.activeAuthOption != nil { self.model.cancelProviderAuth() }
            withAnimation(.easeInOut(duration: 0.15)) { self.openRow = nil }
        } label: {
            Label("Choose another AI", systemImage: "chevron.left")
        }
        .buttonStyle(.link)
        .disabled(self.model.providerAuthCancellation == .requesting)
    }

    private func rowStep(_ row: OnboardingAIPicker.Row) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            self.rowHeader(row, open: true)
            self.expandedContent(row, failure: self.failure(for: row))
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OnboardingSurface(cornerRadius: 12))
    }

    private func rowHeader(_ row: OnboardingAIPicker.Row, open: Bool) -> some View {
        let failure = self.failure(for: row)
        return HStack(spacing: 12) {
            OnboardingProviderArtwork(
                icon: row.candidate?.icon,
                brandCandidates: Self.brands(for: row),
                fallbackSymbol: Self.symbol(for: row),
                wellSize: 36,
                iconSize: 20)
            VStack(alignment: .leading, spacing: 2) {
                HStack(spacing: 6) {
                    self.title(for: row)
                        .font(.callout.weight(.semibold))
                    if row.onThisMac {
                        Text("On this Mac")
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(Capsule().fill(Color.green.opacity(0.16)))
                            .foregroundStyle(Color.green)
                    }
                }
                Group {
                    if let failure {
                        Text(failure.summary)
                    } else if open, self.isConnecting {
                        Text("Connecting…")
                    } else {
                        self.subtitle(for: row, expanded: open)
                    }
                }
                .font(.caption)
                .foregroundStyle(failure == nil ? Color.secondary : Color.orange)
                .lineLimit(2)
                .multilineTextAlignment(.leading)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    @ViewBuilder
    private func expandedContent(_ row: OnboardingAIPicker.Row, failure: OnboardingAISetupModel.Failure?) -> some View {
        if self.model.activeAuthOption != nil {
            OnboardingProviderSetupSteps(model: self.model)
        } else if self.model.phase == .testing {
            self.activity(String(
                format: String(localized: "Checking that %@ replies with one short message…"),
                self.displayName(for: row)))
        } else {
            switch row.action {
            case .apiKey:
                self.keyForm(fixedProvider: row.id == .gemini)
            case .localModel:
                self.localModelChoices
            case let .candidate(kind):
                if let failure {
                    OnboardingErrorDetails(text: failure.copyText)
                    Button("Try again") { self.model.userSelect(kind: kind) }
                        .controlSize(.small)
                }
            case .signIn:
                EmptyView()
            }
        }
    }

    private var unplacedSetupSteps: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 10) {
                OnboardingProviderArtwork(
                    icon: self.model.activeAuthOption?.icon,
                    brandCandidates: [self.model.activeAuthOption?.brandId, self.model.activeAuthOption?.id],
                    fallbackSymbol: "key.fill")
                Text(self.model.activeAuthOption?.label ?? "")
                    .font(.callout.weight(.semibold))
            }
            OnboardingProviderSetupSteps(model: self.model)
        }
        .padding(14)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OnboardingSurface(cornerRadius: 12))
    }

    private func activity(_ message: String) -> some View {
        HStack(spacing: 8) {
            ProgressView().controlSize(.small)
            Text(message).font(.callout)
        }
    }

    private var isConnecting: Bool {
        self.model.activeAuthOption != nil || self.model.phase == .testing || self.model.manualTesting
    }

    private func failure(for row: OnboardingAIPicker.Row) -> OnboardingAISetupModel.Failure? {
        guard case let .candidate(kind) = row.action,
              case let .failed(failure) = self.model.statuses[kind] ?? .untried
        else { return nil }
        return failure
    }

    private func canSelect(_ row: OnboardingAIPicker.Row) -> Bool {
        if case let .candidate(kind) = row.action {
            return self.model.canSelectCandidate(kind: kind)
        }
        return !self.model.isBusy && self.model.activeAuthOption == nil && !self.model.connected
    }

    private func select(_ row: OnboardingAIPicker.Row) {
        withAnimation(.easeInOut(duration: 0.15)) {
            self.openRow = row.id
            switch row.action {
            case let .candidate(kind):
                self.model.userSelect(kind: kind)
            case let .signIn(option):
                self.model.startProviderWizard(option, kind: .auth)
            case let .apiKey(providerID):
                if let providerID { self.model.manualProviderID = providerID }
            case .localModel:
                break
            }
        }
    }

    private func title(for row: OnboardingAIPicker.Row) -> Text {
        switch row.id {
        case .chatGPT: Text("ChatGPT")
        case .claude: Text("Claude")
        case .gemini: Text("Gemini")
        case .apiKey: Text("API key")
        case .localModel: Text("A model on your own computer")
        case .found: Text(verbatim: row.candidate?.label ?? "")
        }
    }

    private func displayName(for row: OnboardingAIPicker.Row) -> String {
        switch row.id {
        case .chatGPT: "ChatGPT"
        case .claude: "Claude"
        case .gemini: "Gemini"
        case .apiKey: self.model.selectedManualProvider?.label ?? String(localized: "your AI")
        case .localModel, .found: self.model.candidates.first { $0.kind == self.model.selectedKind }?.label
            ?? String(localized: "your AI")
        }
    }

    private func subtitle(for row: OnboardingAIPicker.Row, expanded: Bool) -> Text {
        switch row.id {
        case .chatGPT: Text("Use your ChatGPT plan")
        case .claude: Text("Use your Claude plan")
        case .gemini: if case .signIn = row.action {
                Text("Use your Google account")
            } else {
                Text("Use a Gemini API key")
            }
        case .apiKey: if expanded {
                Text("Paste a key from your provider’s website")
            } else {
                Text("OpenAI, Anthropic, OpenRouter and more")
            }
        case .localModel: Text("Ollama or LM Studio")
        case .found: Text(verbatim: row.candidate?.detail ?? "")
        }
    }

    private static func brands(for row: OnboardingAIPicker.Row) -> [String?] {
        switch row.id {
        case .chatGPT: ["openai"]
        case .claude: ["anthropic"]
        case .gemini: ["google"]
        case .apiKey: []
        case .localModel: ["ollama"]
        case let .found(kind): [row.candidate?.brandId, kind]
        }
    }

    private static func symbol(for row: OnboardingAIPicker.Row) -> String {
        switch row.id {
        case .apiKey: "key.fill"
        case .localModel: "desktopcomputer"
        case let .found(kind): self.symbol(for: kind)
        default: "sparkles"
        }
    }

    private static func accessibilityName(for id: OnboardingAIPicker.RowID) -> String {
        switch id {
        case .chatGPT: "chatgpt"
        case .claude: "claude"
        case .gemini: "gemini"
        case .apiKey: "api-key"
        case .localModel: "local-model"
        case let .found(kind): kind
        }
    }

    @ViewBuilder
    private var localModelChoices: some View {
        let picker = self.picker
        VStack(alignment: .leading, spacing: 8) {
            ForEach(picker.localCandidates) { candidate in
                self.candidateRow(candidate)
            }
            ForEach(self.model.prepareOptions) { option in
                self.providerChoiceRow(
                    icon: option.icon,
                    brandCandidates: [option.brandId, option.id],
                    label: Text(option.label),
                    hint: self.providerHint(option.hint),
                    fallbackSymbol: "arrow.down.circle",
                    actionLabel: Text(option.actionLabel ?? String(localized: "Set up…")))
                {
                    self.model.startProviderPrepare(option)
                }
            }
            ForEach(picker.localAuthOptions) { option in
                self.providerAuthRow(option)
            }
        }
    }

    private func moreProviders(_ picker: OnboardingAIPicker) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            if self.model.nativeSessionCatalogPreferenceRequired,
               !self.model.nativeSessionCatalogs.isEmpty
            {
                Toggle(isOn: self.$model.nativeSessionCatalogsEnabled) {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Show your existing conversations")
                            .font(.callout.weight(.semibold))
                        Text(String(
                            format: String(localized: """
                            Lists your %@ conversations in the sidebar \
                            without copying them.
                            """),
                            self.model.nativeSessionCatalogSummary))
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                .toggleStyle(.checkbox)
                .padding(.bottom, 6)
            }
            ForEach(picker.moreAuthOptions) { option in
                self.providerAuthRow(option)
            }
            if self.model.manualProviders.isEmpty, self.model.authOptions.isEmpty {
                OnboardingErrorCard(
                    title: "No AI providers are available",
                    message: "Install an AI provider plugin, then check again.",
                    docsSlug: "concepts/model-providers",
                    retryTitle: "Check again")
                {
                    self.model.retryFromScratch()
                }
            }
            if !self.model.unavailableCandidates.isEmpty {
                self.unavailableCandidatesSection
            }
            if !self.model.recommendedInstalls.isEmpty {
                LazyVGrid(columns: [GridItem(.adaptive(minimum: 230), spacing: 10)], spacing: 10) {
                    ForEach(self.model.recommendedInstalls) { install in
                        OnboardingRecommendedInstallCard(install: install)
                    }
                }
            }
            Button("Check again") { self.model.retryFromScratch() }
                .buttonStyle(.bordered)
                .controlSize(.small)
                .disabled(self.model.isBusy)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(OnboardingSurface(cornerRadius: 12))
    }

    private var unavailableCandidatesSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Found, but not ready to use")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            ForEach(self.model.unavailableCandidates) { candidate in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "info.circle")
                        .foregroundStyle(.secondary)
                    VStack(alignment: .leading, spacing: 1) {
                        Text(verbatim: "\(candidate.label) — \(candidate.detail)")
                            .font(.caption.weight(.semibold))
                        Text(candidate.reason)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(.vertical, 4)
    }

    private func candidateRow(_ candidate: OnboardingAISetupModel.Candidate) -> some View {
        let status = self.model.statuses[candidate.kind] ?? .untried
        let selected = self.model.selectedKind == candidate.kind
        return VStack(alignment: .leading, spacing: 0) {
            Button {
                self.model.userSelect(kind: candidate.kind)
            } label: {
                HStack(alignment: .center, spacing: 12) {
                    OnboardingProviderArtwork(
                        icon: candidate.icon,
                        brandCandidates: [candidate.brandId, candidate.kind],
                        fallbackSymbol: Self.symbol(for: candidate.kind))
                    VStack(alignment: .leading, spacing: 2) {
                        Text(candidate.label)
                            .font(.callout.weight(.semibold))
                        if candidate.modelTarget == .utility {
                            Text("Setup & utility")
                                .font(.caption.weight(.medium))
                                .foregroundStyle(.secondary)
                        }
                        Text(self.subtitle(for: candidate, status: status))
                            .font(.caption)
                            .foregroundStyle(Self.isFailed(status) ? Color.orange : Color.secondary)
                            .lineLimit(2)
                            .multilineTextAlignment(.leading)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    Spacer(minLength: 0)
                    if candidate.modelTarget == .utility, status == .untried {
                        Text("Use for setup")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(Color.accentColor)
                    }
                    self.trailingIndicator(status: status, selected: selected)
                }
                // Plain buttons hit-test only opaque label pixels; without this the
                // row's blank stretch (between texts, over the Spacer) ignores clicks
                // and a mid-testing candidate pick silently does nothing.
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .disabled(!self.model.canSelectCandidate(kind: candidate.kind))

            if case let .failed(failure) = status {
                OnboardingErrorDetails(text: failure.copyText)
                    .padding(.leading, 38)
                    .padding(.top, 6)
            }
        }
        .openClawSelectableRowChrome(
            selected: selected && !Self.isFailed(status),
            enabled: self.model.canSelectCandidate(kind: candidate.kind))
    }

    private func subtitle(
        for candidate: OnboardingAISetupModel.Candidate,
        status: OnboardingAISetupModel.CandidateStatus) -> String
    {
        switch status {
        case .testing:
            String(
                format: String(localized: "Checking that %@ replies with one short message…"),
                candidate.label)
        case let .failed(failure):
            failure.summary
        case .untried:
            candidate.detail
        }
    }

    @ViewBuilder
    private func trailingIndicator(
        status: OnboardingAISetupModel.CandidateStatus,
        selected: Bool) -> some View
    {
        switch status {
        case .testing:
            ProgressView()
                .controlSize(.small)
        case .failed:
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        case .untried:
            SelectionStateIndicator(selected: selected)
        }
    }

    private static func symbol(for kind: String) -> String {
        switch kind {
        case "claude-cli": "sparkle"
        case "codex-cli": "chevron.left.forwardslash.chevron.right"
        case "gemini-cli": "diamond"
        case "existing-model": "checkmark.seal"
        default: "key.fill"
        }
    }

    private static func isFailed(_ status: OnboardingAISetupModel.CandidateStatus) -> Bool {
        if case .failed = status {
            return true
        }
        return false
    }

    private func providerAuthRow(_ option: OnboardingAISetupModel.AuthOption) -> some View {
        let (fallbackSymbol, actionLabel): (String, LocalizedStringKey) = switch option.kind {
        case "device-code": ("link.badge.plus", "Pair")
        case "install": ("puzzlepiece.extension", "Set up…")
        case "custom": ("point.3.connected.trianglepath.dotted", "Configure…")
        default: ("person.crop.circle.badge.checkmark", "Sign in")
        }
        return self.providerChoiceRow(
            icon: option.icon,
            brandCandidates: [option.brandId, option.id],
            label: Text(option.label),
            hint: self.providerHint(option.hint),
            fallbackSymbol: fallbackSymbol,
            actionLabel: Text(actionLabel))
        {
            self.model.startProviderWizard(option, kind: .auth)
        }
    }

    @ViewBuilder
    private func providerHint(_ hint: String?) -> some View {
        if let hint, !hint.isEmpty {
            Text(hint).multilineTextAlignment(.leading)
        }
    }

    private func providerChoiceRow(
        icon: String?,
        brandCandidates: [String?],
        label: Text,
        hint: some View,
        fallbackSymbol: String,
        actionLabel: Text,
        selected: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 10) {
                OnboardingProviderArtwork(
                    icon: icon,
                    brandCandidates: brandCandidates,
                    fallbackSymbol: fallbackSymbol)
                VStack(alignment: .leading, spacing: 2) {
                    label.font(.callout.weight(.semibold))
                    hint.font(.caption).foregroundStyle(.secondary)
                }
                Spacer(minLength: 0)
                actionLabel
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.accentColor)
            }
            .openClawSelectableRowChrome(selected: selected)
        }
        .buttonStyle(.plain)
        .disabled(self.model.isBusy)
    }

    private func keyForm(fixedProvider: Bool) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                if !fixedProvider {
                    Picker("Provider", selection: self.$model.manualProviderID) {
                        ForEach(self.model.manualProviders) { provider in
                            Text(provider.label).tag(provider.id)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 170)
                }

                SecureField("API key", text: self.$model.manualKey)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { self.model.submitManualKey() }

                Button {
                    self.model.submitManualKey()
                } label: {
                    if self.model.manualTesting {
                        ProgressView()
                            .controlSize(.small)
                            .frame(minWidth: 64)
                    } else {
                        Text("Connect")
                            .frame(minWidth: 64)
                    }
                }
                .buttonStyle(.borderedProminent)
                // isBusy, not just manualTesting: submitManualKey drops the tap
                // while another test runs, so an enabled button would be a
                // silent no-op.
                .disabled(self.model.isBusy ||
                    self.model.manualKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            if let website = OnboardingProviderAuthLink.safeURL(self.model.selectedManualProvider?.website) {
                Link("Where do I find my key?", destination: website)
                    .font(.caption)
                    .environment(\.openURL, AppActivation.shared.openURLAction)
            }
            if let manualError = model.manualError {
                OnboardingErrorCard(
                    title: "That key didn’t work",
                    message: manualError.summary,
                    details: manualError.detail,
                    docsSlug: "concepts/model-providers",
                    retryTitle: nil,
                    retry: nil)
            }
        }
        .id("manual-entry")
    }
}

/// Friendly error presentation with a consistent docs escape hatch.
/// Every onboarding failure points at a docs.openclaw.ai page so people are
/// never stuck staring at a raw error string.
struct OnboardingErrorCard: View {
    let title: String
    let message: String
    var details: String?
    let docsSlug: String
    var retryTitle: String?
    var retry: (() -> Void)?
    var secondaryTitle: String?
    var secondary: (() -> Void)?

    /// Keep retry required so Swift binds a lone trailing closure to the primary
    /// action instead of the defaulted secondary action.
    init(
        title: String,
        message: String,
        details: String? = nil,
        docsSlug: String,
        retryTitle: String? = nil,
        secondaryTitle: String? = nil,
        secondary: (() -> Void)? = nil,
        retry: (() -> Void)?)
    {
        self.title = title
        self.message = message
        self.details = details
        self.docsSlug = docsSlug
        self.retryTitle = retryTitle
        self.retry = retry
        self.secondaryTitle = secondaryTitle
        self.secondary = secondary
    }

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .padding(.top, 1)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.callout.weight(.semibold))
                Text(self.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .fixedSize(horizontal: false, vertical: true)
                if let details {
                    OnboardingErrorDetails(text: details)
                }
                HStack(spacing: 14) {
                    if let retryTitle, let retry {
                        Button(retryTitle, action: retry)
                            .buttonStyle(.borderedProminent)
                            .controlSize(.small)
                    }
                    if let secondaryTitle, let secondary {
                        Button(secondaryTitle, action: secondary)
                            .buttonStyle(.bordered)
                            .controlSize(.small)
                    }
                    Button("Open help…") {
                        if let url = URL(string: "https://docs.openclaw.ai/\(docsSlug)") {
                            AppActivation.shared.open(url)
                        }
                    }
                    .buttonStyle(.link)
                    .font(.caption)
                    if details == nil {
                        Button("Copy error") {
                            OnboardingErrorDetails.copy(self.message)
                        }
                        .buttonStyle(.link)
                        .font(.caption)
                    }
                }
                .padding(.top, 2)
            }
            Spacer(minLength: 0)
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.orange.opacity(0.10)))
    }
}

private struct OnboardingErrorDetails: View {
    let text: String
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Button {
                withAnimation(.easeInOut(duration: 0.15)) {
                    self.expanded.toggle()
                }
            } label: {
                Label(
                    self.expanded ? "Hide details" : "Show details",
                    systemImage: self.expanded ? "chevron.down" : "chevron.right")
            }
            .buttonStyle(.link)
            .font(.caption)

            if self.expanded {
                ScrollView(.vertical) {
                    Text(self.text)
                        .font(.system(.caption, design: .monospaced))
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                        .fixedSize(horizontal: false, vertical: true)
                        .padding(8)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 180)
                .background(
                    RoundedRectangle(cornerRadius: 6, style: .continuous)
                        .fill(Color.primary.opacity(0.05)))
                Button {
                    Self.copy(self.text)
                } label: {
                    Label("Copy error", systemImage: "doc.on.doc")
                }
                .buttonStyle(.link)
                .font(.caption)
            }
        }
    }

    static func copy(_ text: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
    }
}
