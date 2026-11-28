#if os(iOS)
import OpenClawKit
import SwiftUI

struct ChatProviderAccountFacts: View {
    let account: ChatModelAccount

    var body: some View {
        ForEach(Array(self.account.profiles.enumerated()), id: \.element.profileId) { index, profile in
            let name = profile.displayName?.trimmedNonEmpty ?? profile.email?.trimmedNonEmpty
            let usage = self.account.usage.flatMap { $0.authProfileId == profile.profileId ? $0 : nil }
            Section {
                if let name {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: name).font(OpenClawChatTypography.settingsBody.weight(.semibold))
                        if let email = profile.email?.trimmedNonEmpty, email != name {
                            Text(verbatim: email).font(OpenClawChatTypography.settingsFootnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                self.detail(Text("Access"), value: Self.access(profile.type))
                self.detail(Text("Status"), value: Self.status(profile))
                if let plan = profile.planLabel?.trimmedNonEmpty ?? usage?.plan?.trimmedNonEmpty {
                    self.detail(Text("Plan"), value: plan)
                }
                if let usage {
                    self.windows(usage)
                }
            } header: {
                let title = self.account.profiles.count == 1 ? String(localized: "Account") :
                    String(format: String(localized: "Account %lld"), Int64(index + 1))
                Text(verbatim: title).font(OpenClawChatTypography.settingsSectionHeader)
            }
        }
        if self.account.source != nil || self.account.profiles.isEmpty {
            Section {
                if let source = self.account.source {
                    let access = switch source {
                    case .providerApp: String(localized: "Sign-in on computer")
                    case .settingsKey: String(localized: "API key in OpenClaw settings")
                    case .environmentKey: String(localized: "API key from the environment")
                    }
                    self.detail(Text("Access"), value: access)
                }
                let status = self.account.notice.map(ChatModelAccountsCopy.notice) ??
                    self.sourceStatus
                self.detail(Text("Status"), value: status)
                if let plan = self.account.plan {
                    self.detail(Text("Plan"), value: plan)
                }
            } header: {
                Text(verbatim: self.account.profiles
                    .isEmpty ? String(localized: "Account") : String(localized: "Additional access"))
                    .font(OpenClawChatTypography.settingsSectionHeader)
            } footer: {
                if self.account.source == .providerApp {
                    Text(verbatim: String(
                        format: String(
                            localized: "Manage this sign-in with %@ on the computer running OpenClaw."),
                        self.account.displayTitle))
                        .font(OpenClawChatTypography.settingsFootnote)
                }
            }
        } else if self.account.notice == .failed {
            Text(verbatim: ChatModelAccountsCopy.notice(.failed))
                .font(OpenClawChatTypography.settingsBody).foregroundStyle(OpenClawChatTheme.warning)
        }
        // A provider-wide reading doesn't establish which of several accounts consumed the allowance.
        if let usage = account.usage,
           !self.account.profiles.contains(where: { $0.profileId == usage.authProfileId }),
           !usage.windows.isEmpty || (usage.plan?.trimmedNonEmpty != nil && usage.plan != self.account.plan)
        {
            Section {
                if let plan = usage.plan?.trimmedNonEmpty, plan != self.account.plan {
                    self.detail(Text("Plan"), value: plan)
                }
                self.windows(usage)
            } header: {
                Text("Provider usage").font(OpenClawChatTypography.settingsSectionHeader)
            }
        }
    }

    private var sourceStatus: String {
        guard self.account.isSignedIn else { return String(localized: "Not signed in") }
        switch self.account.source {
        case .providerApp: return String(localized: "Sign-in found")
        case .settingsKey: return String(localized: "Saved")
        case .environmentKey: return String(localized: "Available")
        case nil: return String(localized: "Configured")
        }
    }

    private static func access(_ type: String?) -> String {
        switch type {
        case "api_key": String(localized: "API key")
        case "token": String(localized: "Access token")
        case "oauth": String(localized: "Account sign-in")
        default: String(localized: "Unknown")
        }
    }

    private static func status(_ profile: ChatModelAuthStatus.Profile) -> String {
        switch profile.status {
        case "expired": ChatModelAccountsCopy.notice(.expired)
        case "expiring": ChatModelAccountsCopy
            .notice(.expiring(at: profile.expiry.map { Date(timeIntervalSince1970: $0.at / 1000) }))
        case "missing": String(localized: "Not signed in")
        case "static", "ok":
            if profile.type == "oauth" {
                String(localized: "Sign-in found")
            } else if profile.source == "saved" {
                String(localized: "Saved")
            } else {
                String(localized: "Configured")
            }
        default: String(localized: "Status unavailable")
        }
    }

    private func windows(_ usage: ChatModelAuthStatus.Usage) -> some View {
        ForEach(Array(usage.windows.enumerated()), id: \.offset) { _, window in
            VStack(alignment: .leading, spacing: 5) {
                let amount = (window.usedPercent / 100).formatted(.percent.precision(.fractionLength(0...1)))
                self.detail(
                    Text(verbatim: window.label),
                    value: window.usedPercent >= 100 ?
                        String(localized: "Limit reached") : String(format: String(localized: "%@ used"), amount))
                ProgressView(value: min(1, max(0, window.usedPercent / 100)))
                    .tint(window.usedPercent >= 100 ? OpenClawChatTheme.warning : .secondary).accessibilityHidden(true)
                if let reset = window.resetAt {
                    let date = Date(timeIntervalSince1970: reset / 1000)
                    let format = date > Date() ? String(localized: "Resets %@") :
                        String(localized: "Last reported reset: %@")
                    Text(verbatim: String(
                        format: format,
                        date.formatted(date: .abbreviated, time: .shortened)))
                        .font(OpenClawChatTypography.settingsFootnote).foregroundStyle(.secondary)
                }
            }
            .accessibilityElement(children: .combine)
        }
    }

    private func detail(_ label: Text, value: String) -> some View {
        LabeledContent {
            Text(verbatim: value).font(OpenClawChatTypography.settingsBody).multilineTextAlignment(.trailing)
        } label: {
            label.font(OpenClawChatTypography.settingsBody)
        }
    }
}

struct ChatRemoveProviderSignIn: View {
    let model: ChatModelSignInModel
    let account: ChatModelAccount
    let profile: ChatModelAuthStatus.Profile
    let index: Int
    @State private var confirming = false
    @State private var failed = false

    private var action: String {
        switch self.profile.type {
        case "token": String(localized: "Remove access token")
        case "api_key": String(localized: "Remove API key")
        default: String(localized: "Remove sign-in")
        }
    }

    private var profileHeading: String {
        String(format: String(localized: "Account %lld"), Int64(self.index + 1))
    }

    var body: some View {
        Section {
            self.removeButton
        } header: {
            if self.account.profiles.count > 1 {
                Text(verbatim: self.profileHeading).font(OpenClawChatTypography.settingsSectionHeader)
            }
        } footer: {
            if self.failed { self.recovery }
        }
    }

    private var removeButton: some View {
        Button(role: .destructive) { self.confirming = true } label: {
            Text(verbatim: self.action).font(OpenClawChatTypography.settingsBody)
        }
        .disabled(self.model.busy || self.model.sessionID != nil)
        .accessibilityIdentifier("model-auth-remove-\(self.profile.profileId)")
        .confirmationDialog(Text(verbatim: self.action), isPresented: self.$confirming, titleVisibility: .visible) {
            Button(role: .destructive) {
                Task {
                    self.failed = false
                    await self.model.removeSignIn(provider: self.account.id, profileID: self.profile.profileId)
                    self.failed = self.model.outcome == .signOutFailed
                }
            } label: {
                Text(verbatim: self.action)
            }
            .accessibilityIdentifier("model-auth-confirm-removal")
            Button("Cancel", role: .cancel) {}
        } message: {
            let identity = self.profile.displayName?.trimmedNonEmpty ?? self.profile.email?.trimmedNonEmpty
                ?? (self.account.profiles.count > 1 ? self.profileHeading : self.account.displayTitle)
            Text(verbatim: String(
                format: String(localized: "This removes the credential for %@ from OpenClaw, not from the provider."),
                identity))
        }
    }

    private var recovery: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Couldn’t confirm removal.")
                .font(OpenClawChatTypography.settingsFootnote).foregroundStyle(OpenClawChatTheme.warning)
            Button {
                Task {
                    await self.model.reload()
                    self.failed = self.model.outcome == .loadFailed || self.model.outcome == .statusNotReady
                }
            } label: {
                Text("Refresh account").font(OpenClawChatTypography.settingsBody)
            }.disabled(self.model.busy || self.model.sessionID != nil)
        }
    }
}

struct ChatProviderCatalogSection: View {
    let accountID: String
    let viewModel: OpenClawChatViewModel
    @State private var expanded = false

    var body: some View {
        let models = self.viewModel.modelPickerCatalog().providers.first { $0.id == self.accountID }?.models ?? []
        Section {
            if models.isEmpty {
                Text("No models listed for this provider.").font(OpenClawChatTypography.settingsBody)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(models.prefix(self.expanded ? models.count : 3)) { model in
                    VStack(alignment: .leading, spacing: 3) {
                        Text(verbatim: OpenClawChatViewModel.shortModelLabel(
                            name: model.name,
                            provider: model.provider,
                            modelID: model.modelID))
                            .font(OpenClawChatTypography.settingsBody).foregroundStyle(.primary)
                        if let reason = self.viewModel.modelUnavailableDescription(model) {
                            Text(verbatim: reason).font(OpenClawChatTypography.settingsFootnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                    .accessibilityElement(children: .combine)
                }
                if models.count > 3 {
                    Button { self.expanded.toggle() } label: {
                        Text(verbatim: self.expanded ? String(localized: "Show fewer models") :
                            String(format: String(localized: "Show all %lld models"), Int64(models.count)))
                            .font(OpenClawChatTypography.settingsBody)
                    }
                }
            }
        } header: {
            Text("Models for this chat").font(OpenClawChatTypography.settingsSectionHeader)
        }
    }
}

struct ChatProviderAccountActions: View {
    let model: ChatModelSignInModel
    let account: ChatModelAccount
    let onNeedsRoom: () -> Void
    @State private var editingKey = false
    @State private var key = ""
    @State private var message: String?
    @State private var checking = false

    var body: some View {
        let offersKey = self.model.canSetAPIKey && self.account.supportsAPIKey
        let offersCheck = self.model.canCheckConnection && self.account.isSignedIn
        if offersKey || offersCheck {
            Section {
                if offersKey {
                    if self.editingKey {
                        SecureField(text: self.$key) { Text("API key").font(OpenClawChatTypography.settingsBody) }
                            .font(OpenClawChatTypography.settingsBody).textInputAutocapitalization(.never)
                            .autocorrectionDisabled().privacySensitive().accessibilityIdentifier("provider-new-key")
                        Button { Task { await self.save() } } label: {
                            Text("Save API key").font(OpenClawChatTypography.settingsBody.weight(.semibold))
                        }.disabled(self.key.trimmedNonEmpty == nil || self.model.busy)
                        Button {
                            self.key = ""
                            self.editingKey = false
                        } label: {
                            Text("Cancel").font(OpenClawChatTypography.settingsBody)
                        }
                    } else {
                        Button {
                            self.onNeedsRoom()
                            self.message = nil
                            self.editingKey = true
                        } label: {
                            Label {
                                let hasKey = self.account.source == .settingsKey ||
                                    self.account.profiles.contains { $0.type == "api_key" }
                                Text(verbatim: hasKey ? String(localized: "Update API key") :
                                    String(localized: "Set API key"))
                                    .font(OpenClawChatTypography.settingsBody)
                            } icon: {
                                Image(systemName: "key")
                            }
                        }.accessibilityIdentifier("provider-set-key")
                    }
                }
                if offersCheck, !self.editingKey {
                    Button { Task { await self.check() } } label: {
                        HStack {
                            Label { Text("Check connection").font(OpenClawChatTypography.settingsBody) } icon: {
                                Image(systemName: "network")
                            }
                            if self.checking {
                                Spacer()
                                ProgressView()
                            }
                        }
                    }.accessibilityIdentifier("provider-check-connection")
                }
            } header: {
                Text(verbatim: offersCheck ? String(localized: "Connection") : String(localized: "API key"))
                    .font(OpenClawChatTypography.settingsSectionHeader)
            } footer: {
                if let message = self.message {
                    Text(verbatim: message).font(OpenClawChatTypography.settingsFootnote)
                } else if self.editingKey {
                    Text(verbatim: String(
                        format: String(localized: "Saves the provider key for %@ in OpenClaw."),
                        self.account.name)).font(OpenClawChatTypography.settingsFootnote)
                } else if offersCheck {
                    Text(verbatim: String(format: String(localized: "Sends a test request to %@."), self.account.name))
                        .font(OpenClawChatTypography.settingsFootnote)
                }
            }
            .disabled(self.model.busy || self.model.sessionID != nil)
            .onDisappear { self.key = ""
                self.editingKey = false
            }
        }
    }

    private func save() async {
        guard let value = key.trimmedNonEmpty else { return }
        self.key = ""
        self.editingKey = false
        self.message = String(localized: "Saving API key…")
        self.message = await self.model.setAPIKey(provider: self.account.id, key: value)
    }

    private func check() async {
        self.message = nil
        self.checking = true
        defer { self.checking = false }
        self.message = await self.model.checkConnection(provider: self.account.id)
    }
}
#endif
