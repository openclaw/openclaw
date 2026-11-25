import OpenClawKit
import SwiftUI

extension SettingsProTab {
    var offlineDeviceSection: some View {
        Section {
            self.settingsListRow(
                icon: "iphone",
                title: "Device Settings",
                route: .deviceSettings)
                .accessibilityIdentifier("settings-device-row")
            self.settingsListRow(
                icon: "cpu",
                title: "ESP device setup",
                route: .espSetup)
                .accessibilityIdentifier("settings-esp-setup-row")
            self.settingsListRow(
                icon: "applewatch",
                title: "Apple Watch",
                route: .appleWatch)
                .accessibilityIdentifier("settings-watch-row")
            self.settingsListRow(
                icon: "stethoscope",
                title: "Diagnostics",
                route: .diagnostics)
            self.settingsListRow(
                icon: "doc.text",
                title: "Licenses",
                route: .licenses)
                .accessibilityIdentifier("settings-licenses-row")
            self.settingsListRow(
                icon: "info.circle.fill",
                title: "About",
                route: .about)
        } header: {
            SettingsSectionTitle("Device")
        }
    }

    func settingsListRow(
        icon: String,
        title: LocalizedStringKey,
        route: SettingsRoute) -> some View
    {
        NavigationLink(value: route) {
            Label {
                Text(title).font(SettingsType.label)
            } icon: {
                NativeSettingsRowIcon(systemName: icon)
            }
        }
    }

    func destination(for route: SettingsRoute) -> some View {
        Group {
            if route == .deviceSettings {
                LocalDeviceSettingsScreen()
            } else if route == .espSetup {
                ESPDeviceSetupScreen()
            } else {
                List {
                    switch route {
                    case .deviceSettings, .voiceAndTalk, .permissions, .accessories,
                         .chatPreferences, .storage, .sidebarPages, .skills, .plugins, .advanced:
                        EmptyView()
                    case .gateway:
                        self.gatewayDestination
                    case .gatewayDetails:
                        self.gatewayDetailsDestination
                    case .appleWatch:
                        self.appleWatchDestination
                    case .espSetup:
                        EmptyView()
                    case .approvals:
                        self.approvalsDestination
                    case .diagnostics:
                        self.diagnosticsDestination
                    case .about:
                        self.aboutDestination
                    case .licenses:
                        self.licensesDestination
                    }
                }
                .listStyle(.insetGrouped)
            }
        }
        .font(OpenClawType.body)
        .navigationTitle(title(for: route))
        .navigationBarTitleDisplayMode(.inline)
        .task(id: route) {
            guard route == .appleWatch else { return }
            await self.appModel.refreshWatchMessagingStatus()
        }
        .toolbar {
            ToolbarItem(placement: .principal) {
                Text(title(for: route))
                    .font(OpenClawType.headline)
                    .foregroundStyle(.primary)
            }
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    var gatewayDestination: some View {
        Group {
            if !self.appModel.isLocalGatewayFixtureEnabled, !self.gatewayRegistry.entries.isEmpty {
                self.pairedGatewaysCard
            }
            if !self.appModel.isOperatorGatewayConnected, !self.gatewayRegistry.entries.isEmpty {
                Section {
                    self.gatewayActionButton(
                        title: "Reconnect",
                        isBusy: self.isReconnectingGateway,
                        isDisabled: self.appModel.isAppleReviewDemoModeEnabled)
                    {
                        Task { await self.reconnectGateway() }
                    }
                }
            }

            self.gatewaySetupCard

            Section {
                self.gatewayNavigationRow("Connection details", route: .gatewayDetails)
                self.gatewayNavigationRow("Diagnostics", route: .diagnostics)
            } header: {
                SettingsSectionTitle("Connection")
            } footer: {
                self.gatewayActionStatusView
            }
        }
    }

    private var gatewayDetailsDestination: some View {
        Group {
            Section {
                SettingsDetailRow("Address", value: .verbatim(self.gatewayAddress))
                SettingsDetailRow("Server", value: .verbatim(self.gatewayServer))
            } header: {
                SettingsSectionTitle("Gateway")
            }
            self.deviceIdentityCard
            if !self.appModel.isLocalGatewayFixtureEnabled {
                self.manualGatewayCard
            }
            self.gatewayAdvancedCard
        }
    }

    /// Icons mark the Settings root only; rows on pages below it carry no icon.
    private func gatewayNavigationRow(_ title: LocalizedStringKey, route: SettingsRoute) -> some View {
        NavigationLink(value: route) {
            Text(title).font(SettingsType.label)
        }
    }

    var approvalsDestination: some View {
        Group {
            self.detailStatusCard(
                title: "Approvals",
                detail: .verbatim(self.notificationPresentation.needsAttention
                    ? String(localized: "Out-of-app approval alerts need notification permission.")
                    : (self.appModel.pendingExecApprovalCount == 0
                        ? String(localized: "No actions are waiting for review.")
                        : String(localized: "Review pending actions."))),
                value: self.notificationPresentation.needsAttention
                    ? .verbatim(String(localized: "Alerts Off"))
                    : (self.appModel.pendingExecApprovalCount == 0
                        ? .verbatim(String(localized: "Clear"))
                        : .verbatim(self.approvalWaitingText)),
                header: "Status")

            if self.notificationPresentation.needsAttention {
                self.approvalNotificationsWarningCard
            }

            self.approvalsReviewCard
        }
    }

    var appleWatchDestination: some View {
        Group {
            let watchStatus = self.appModel.watchMessagingStatus
            Section {
                SettingsDescriptionRow(
                    "Apple Watch",
                    description: .verbatim(watchStatus.appInstalled
                        ? String(localized: """
                        iPhone relay still works. \
                        Direct mode connects your watch straight to OpenClaw.
                        """)
                        : String(
                            localized: "Install the OpenClaw watch app before enabling direct mode.")),
                    value: .verbatim(
                        watchStatus.reachable
                            ? String(localized: "Reachable")
                            : (watchStatus.appInstalled
                                ? String(localized: "Installed")
                                : String(localized: "Unavailable"))))
                NavigationLink {
                    WatchMessageJournalView()
                } label: {
                    Text("Message Delivery").font(SettingsType.label)
                }
            } header: {
                SettingsSectionTitle("Status")
            }

            Section {
                SettingsDetailRow("Device", value: "Info and status")
                SettingsDetailRow("Notifications", value: "While app is active")
            } header: {
                SettingsSectionTitle("Direct mode")
            }

            Section {
                Button {
                    Task { await self.sendDirectWatchSetup() }
                } label: {
                    Text("Connect Apple Watch").font(SettingsType.label)
                }
                .disabled(
                    self.isSendingWatchDirectSetup
                        || !self.appModel.isOperatorGatewayConnected
                        || !self.appModel.hasOperatorAdminScope
                        || !watchStatus.appInstalled)
            } footer: {
                VStack(alignment: .leading, spacing: 8) {
                    if let statusText = self.watchDirectSetupStatusText {
                        SettingsFootnote(verbatim: statusText)
                    }
                    Text(
                        """
                        Your watch gets a one-time pairing code and its own credentials, \
                        with read and Talk access (no admin access). \
                        The microphone only starts when you tap Start on the watch. \
                        Away from your iPhone, OpenClaw needs a secure address the watch can reach.
                        """)
                        .font(SettingsType.footnote)
                }
            }
        }
    }

    var approvalNotificationsWarningCard: some View {
        Section {
            SettingsDescriptionRow(
                "Notifications are off",
                description: "Turn on notifications to get approval alerts when OpenClaw isn’t open.") {}
            Button {
                self.openNotificationsRouteFromApprovals()
            } label: {
                Text("Open Notifications").font(SettingsType.label)
            }
        }
    }

    @ViewBuilder
    var approvalsReviewCard: some View {
        if !self.appModel.pendingExecApprovalInboxItems.isEmpty {
            Section {
                ForEach(self.appModel.pendingExecApprovalInboxItems) { item in
                    Button {
                        self.appModel.presentPendingExecApprovalFromInbox(item.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.prompt.commandPreview ?? item.prompt.commandText)
                                .font(SettingsType.label)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(item.prompt.gatewayStableID)
                                .font(SettingsType.description)
                                .foregroundStyle(SettingsInk.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityLabel(item.prompt.kind == "exec"
                        ? String(localized: "Review exec approval")
                        : String(localized: "Review approval"))
                    .accessibilityValue(item.prompt.commandPreview ?? item.prompt.commandText)
                }
            } header: {
                SettingsSectionTitle("Pending approvals")
            }
        }

        if let pendingApproval = self.appModel.pendingExecApprovalPrompt {
            Section {
                ForEach(self.approvalItems, id: \.id) { item in
                    SettingsApprovalRow(item: item)
                }
                if let warningText = pendingApproval.warningText {
                    Text(warningText)
                        .font(SettingsType.description)
                        .foregroundStyle(OpenClawBrand.warn)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let errorText = self.appModel.pendingExecApprovalPromptErrorText {
                    Text(errorText)
                        .font(SettingsType.description)
                        .foregroundStyle(OpenClawBrand.danger)
                }
                if let resolvedText = self.appModel.pendingExecApprovalPromptResolvedText {
                    Text(resolvedText)
                        .font(SettingsType.description)
                        .foregroundStyle(self.approvalOutcomeColor)
                    Button {
                        self.appModel.dismissPendingExecApprovalPrompt()
                    } label: {
                        Text("Dismiss")
                            .font(SettingsType.label)
                    }
                } else {
                    if pendingApproval.kind == "system-agent" {
                        ApprovalDashboardReviewButton(prompt: pendingApproval)
                    }
                    if pendingApproval.allowsAllowOnce {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Text("Allow Once")
                                .font(SettingsType.label)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsAllowAlways {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always") }
                        } label: {
                            Text("Allow Always")
                                .font(SettingsType.label)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsDeny {
                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Text("Deny")
                                .font(SettingsType.label)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if self.appModel.pendingExecApprovalPromptResolving,
                       self.appModel.pendingExecApprovalPromptCanDismiss
                    {
                        Button(role: .cancel) {
                            self.appModel.dismissPendingExecApprovalPrompt()
                        } label: {
                            Text("Dismiss")
                                .font(SettingsType.label)
                        }
                    }
                }
            } header: {
                SettingsSectionTitle("Reviewing")
            }
        } else if self.appModel.pendingExecApprovalCount == 0 {
            Section {
                SettingsDescriptionRow(
                    "No approvals waiting",
                    description: .verbatim(self.approvalEmptyDetail)) {}
            }
        }
    }

    private var approvalOutcomeColor: Color {
        switch self.appModel.pendingExecApprovalPromptOutcome?.tone {
        case .success:
            OpenClawBrand.ok
        case .danger:
            OpenClawBrand.danger
        case .warning:
            OpenClawBrand.warn
        case .neutral, nil:
            .secondary
        }
    }

    var diagnosticsDestination: some View {
        Group {
            self.diagnosticChecksCard

            Section {
                self.gatewayActionButton(title: "Run Diagnostics", isBusy: self.isRefreshingGateway) {
                    Task { await self.runDiagnostics() }
                }
            } footer: {
                SettingsFootnote(
                    "Checks connection, discovery, Talk, and notifications without changing your settings.")
            }

            Section {
                SettingsDetailRow("Device", value: .verbatim(InstanceIdentity.deviceFamily))
                SettingsDetailRow(
                    "Platform",
                    value: .verbatim(DeviceInfoHelper.platformStringForDisplay()))
                SettingsDetailRow(
                    "App",
                    value: .verbatim(DeviceInfoHelper.openClawVersionString()))
                SettingsDetailRow("Model", value: .verbatim(DeviceInfoHelper.modelIdentifier()))
            } header: {
                SettingsSectionTitle("Device")
            }

            self.diagnosticsAdvancedCard
        }
    }

    @ViewBuilder
    var gatewayActionStatusView: some View {
        if let gatewayActionStatusText {
            SettingsFootnote(verbatim: gatewayActionStatusText)
        }
    }

    @ViewBuilder var licensesDestination: some View {
        let documents = LicenseDocumentLoader.bundledDocuments()
        if documents.isEmpty {
            ContentUnavailableView(
                "No Licenses Bundled",
                systemImage: "doc.text",
                description: Text("License files aren’t available in this build."))
                .font(OpenClawType.body)
        } else {
            Section {
                ForEach(documents) { document in
                    NavigationLink {
                        LicenseDocumentDetailView(document: document)
                    } label: {
                        Text(document.title).font(SettingsType.label)
                    }
                }
            } footer: {
                SettingsFootnote("OpenClaw appreciates its partners in the open-source community.")
            }
            .accessibilityIdentifier("settings-licenses-list")
        }
    }

    /// Action row: the label in the row-label style, no icon, a spinner while it runs.
    func gatewayActionButton(
        title: LocalizedStringKey,
        isBusy: Bool,
        isDisabled: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack {
                Text(title).font(SettingsType.label)
                Spacer()
                if isBusy {
                    ProgressView().controlSize(.small)
                }
            }
            .contentShape(Rectangle())
        }
        // The list's own button style, so a disabled action dims like every other action row.
        .disabled(isBusy || isDisabled)
        .accessibilityLabel(Text(title))
    }

    var aboutDestination: some View {
        Group {
            Section {
                VStack(spacing: 12) {
                    OpenClawProMark(size: 96, shadowRadius: 18, interactive: true)
                        .accessibilityHidden(true)
                    VStack(spacing: 2) {
                        Text("OpenClaw")
                            .font(OpenClawType.title2SemiBold)
                        Text("Personal AI on your devices")
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                        SettingsBuildMetadataStrip(metadata: DeviceInfoHelper.buildMetadata())
                            .padding(.top, 8)
                    }
                }
                .frame(maxWidth: .infinity)
                .padding(.top, 4)
                .accessibilityElement(children: .contain)
                .listRowBackground(Color.clear)
                .listRowSeparator(.hidden)
            }

            // Concise public details only; deep hardware identifiers live in Diagnostics.
            Section {
                SettingsDetailRow("Device", value: .verbatim(InstanceIdentity.deviceFamily))
                SettingsDetailRow(
                    "iOS",
                    value: .verbatim(DeviceInfoHelper.iOSVersionStringForDisplay()))
                NavigationLink(value: SettingsRoute.diagnostics) {
                    Text("Diagnostics").font(SettingsType.label)
                }
            } header: {
                SettingsSectionTitle("Device")
            }

            Section {
                self.aboutLinkRow(title: "Support", url: URL(string: "https://community.openclaw.ai/")!)
                self.aboutLinkRow(title: "Website", url: URL(string: "https://openclaw.ai")!)
                self.aboutLinkRow(title: "Docs", url: URL(string: "https://docs.openclaw.ai")!)
                self.aboutLinkRow(title: "GitHub", url: URL(string: "https://github.com/openclaw/openclaw")!)
                self.aboutLinkRow(
                    title: "Discord",
                    url: URL(string: "https://openclaw.ai/discord?from=openclaw-app-ios-settings")!)
                NavigationLink(value: SettingsRoute.licenses) {
                    Text("Licenses").font(SettingsType.label)
                }
            } header: {
                SettingsSectionTitle("Resources")
            } footer: {
                SettingsFootnote("© 2026 OpenClaw Foundation. MIT License.")
            }
        }
    }

    /// About link row with explicit branded label; shorthand `Link("Title", ...)`
    /// would bypass the typography audit and OpenClawType styling. The trailing arrow says the
    /// row leaves the app, where a chevron would say it pushes a page.
    func aboutLinkRow(title: LocalizedStringKey, url: URL) -> some View {
        Link(destination: url) {
            HStack {
                Text(title)
                    .font(SettingsType.label)
                    .foregroundStyle(.primary)
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(OpenClawType.footnoteSemiBold)
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            .contentShape(Rectangle())
        }
        .accessibilityLabel(Text(title))
    }

    var gatewaySetupCard: some View {
        let limited = appModel.isOperatorGatewayConnected && !appModel.hasOperatorAdminScope
        return Section {
            if self.stagedGatewaySetupLink != nil {
                self.gatewayActionButton(
                    title: "Connect",
                    isBusy: self.setupAttemptID != nil,
                    isDisabled: self.connectingGateway != nil)
                {
                    Task { await self.applySetupCodeAndConnect() }
                }
            } else {
                Button {
                    self.openGatewayQRScanner()
                } label: {
                    Text(limited ? "Upgrade access" : "Add Gateway")
                        .font(SettingsType.label)
                }
                .disabled(self.connectingGateway != nil)
                .accessibilityIdentifier("SettingsHub.PairGateway")
            }
        } footer: {
            if let status = self.setupStatusLine, self.setupStatusText != nil {
                SettingsFootnote(verbatim: status)
            } else if limited {
                SettingsFootnote("Pair again with a full-access setup code.")
            }
        }
    }

    var pairedGatewaysCard: some View {
        Section {
            if self.gatewayRegistry.entries.isEmpty {
                Text("Pair a Gateway to see it here.")
                    .font(SettingsType.label)
                    .foregroundStyle(SettingsInk.secondary)
            } else {
                ForEach(self.gatewayRegistry.entries) { entry in
                    self.pairedGatewayRow(entry)
                }
            }
        } header: {
            SettingsSectionTitle("Saved Gateways")
        }
    }

    func pairedGatewayRow(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> some View {
        let isActive = GatewayStableIdentifier.matches(
            entry.stableID,
            self.gatewayRegistry.activeStableID)
        let keepsConnected = self.gatewayRegistry.connectedStableIDs.contains {
            GatewayStableIdentifier.matches($0, entry.stableID)
        }
        let endpoint = self.gatewayEndpointSummary(entry)
        return HStack(spacing: 12) {
            Button {
                guard !isActive else { return }
                Task { await self.switchGateway(to: entry) }
            } label: {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: entry.name)
                        .font(SettingsType.label)
                    if entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
                        .caseInsensitiveCompare(endpoint) != .orderedSame
                    {
                        Text(verbatim: endpoint)
                            .font(SettingsType.description)
                            .foregroundStyle(SettingsInk.secondary)
                    }
                }
                Spacer(minLength: 8)
            }
            .buttonStyle(.plain)
            .disabled(self.connectingGateway != nil)

            if self.connectingGateway == .gateway(entry.id) {
                ProgressView()
                    .controlSize(.small)
            } else if isActive {
                Image(systemName: "checkmark")
                    .font(SettingsType.label.weight(.semibold))
                    .foregroundStyle(.primary)
                    .accessibilityLabel("Focused Gateway")
            } else {
                Button {
                    if self.gatewayController.setGatewayConnectionEnabled(
                        stableID: entry.stableID,
                        enabled: !keepsConnected)
                    {
                        self.refreshGatewayRegistry()
                    }
                } label: {
                    Image(systemName: keepsConnected ? "bolt.horizontal.circle.fill" : "bolt.horizontal.circle")
                        .font(SettingsType.label)
                        .foregroundStyle(keepsConnected ? .primary : .secondary)
                }
                .buttonStyle(.plain)
                .accessibilityLabel(keepsConnected ? "Disconnect Gateway" : "Keep Gateway Connected")
            }
        }
        .contentShape(Rectangle())
        .swipeActions {
            Button(role: .destructive) {
                self.pendingForgetGateway = entry
            } label: {
                Label {
                    Text("Forget")
                        .font(OpenClawType.captionSemiBold)
                } icon: {
                    Image(systemName: "trash")
                }
            }
        }
        .contextMenu {
            Button(role: .destructive) {
                self.pendingForgetGateway = entry
            } label: {
                Label {
                    Text("Forget Gateway")
                        .font(OpenClawType.body)
                } icon: {
                    Image(systemName: "trash")
                }
            }
        }
    }

    func discoveredGatewayRow(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> some View {
        let availability = self.gatewayController.discoveredGatewayConnectionAvailability(gateway)
        return VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: gateway.name)
                        .font(SettingsType.label)
                    Text(verbatim: self.gatewayDetailLines(gateway).joined(separator: " • "))
                        .font(SettingsType.description)
                        .foregroundStyle(SettingsInk.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                if availability.canConnect {
                    Button {
                        Task { await self.connect(gateway) }
                    } label: {
                        if self.connectingGateway == .gateway(gateway.id) {
                            ProgressView().controlSize(.small)
                        } else {
                            Text(availability.actionTitle)
                                .font(OpenClawType.captionSemiBold)
                        }
                    }
                    .font(OpenClawType.captionSemiBold)
                    .buttonStyle(.bordered)
                    .disabled(self.connectingGateway != nil)
                } else {
                    Text(availability.actionTitle)
                        .font(SettingsType.value)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }

            if let guidanceText = availability.guidanceText {
                Text(guidanceText)
                    .font(SettingsType.description)
                    .foregroundStyle(SettingsInk.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Connect is the group's action row: the label style, no icon, gray only while disabled.
    var manualGatewayCard: some View {
        Section {
            self.settingsToggle("Use Manual Gateway", isOn: self.manualGatewayEnabledBinding)
            SettingsInputRow("Host") {
                TextField(text: self.manualHostBinding, prompt: Text(verbatim: "—").font(SettingsType.value)) {
                    Text("Host").font(SettingsType.label)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            SettingsInputRow("Port") {
                TextField(text: self.manualPortBinding, prompt: Text(verbatim: "—").font(SettingsType.value)) {
                    Text("Port").font(SettingsType.label)
                }
                .keyboardType(.numberPad)
            }
            ManualGatewaySecurityRows(
                presentation: self.manualGatewayTransport,
                useTLS: self.manualGatewayTLSBinding,
                showsHelperRow: false)
            self.gatewayActionButton(
                title: "Connect",
                isBusy: self.connectingGateway == .manual,
                isDisabled: self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || self.manualGatewayHostIssue != nil
                    || !self.manualPortIsValid)
            {
                Task { await self.connectManual() }
            }
            .accessibilityIdentifier("SettingsHub.ManualConnect")
        } header: {
            SettingsSectionTitle("Manual setup")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                if let hostIssue = self.manualGatewayHostIssue {
                    Text(hostIssue)
                        .font(SettingsType.footnote)
                        .foregroundStyle(OpenClawBrand.warn)
                }
                if let helperText = self.manualGatewayTransport.helperText {
                    SettingsFootnote(verbatim: helperText)
                }
            }
        }
        .disabled(self.setupAttemptID != nil)
    }

    private var manualGatewayHostIssue: String? {
        GatewayConnectionController.manualHostValidationMessage(host: self.manualGatewayHost)
    }

    private var manualGatewayTransport: GatewayManualTransportPresentation {
        GatewayConnectionController.manualTransportPresentation(
            host: self.manualGatewayHost,
            requestedTLS: self.manualGatewayTLS)
    }

    private var manualGatewayTLSBinding: Binding<Bool> {
        Binding(
            get: { self.manualGatewayTransport.effectiveTLS },
            set: { enabled in
                guard !self.manualGatewayTransport.requiresTLS else { return }
                self.manualGatewayContextPath = nil
                self.manualGatewayTLS = enabled
            })
    }

    @ViewBuilder
    var gatewayAdvancedCard: some View {
        Section {
            self.settingsToggle("Auto-connect on launch", isOn: self.$gatewayAutoConnect)
            // Fixtures never load the saved manual Gateway, so a credential edit would overwrite
            // its pair with blank fields and headers would target the wrong identity.
            if !self.appModel.isLocalGatewayFixtureEnabled {
                self.gatewaySecureField("Gateway Auth Token", text: self.gatewayCredentialBinding(\.token))
                self.gatewaySecureField("Gateway Password", text: self.gatewayCredentialBinding(\.password))
                if let headersStableID = self.gatewayCustomHeadersTargetStableID {
                    NavigationLink {
                        GatewayCustomHeadersSettingsView(gatewayStableID: headersStableID)
                    } label: {
                        Text("Custom Headers")
                            .font(SettingsType.label)
                    }
                }
            }
            if !self.appModel.isLocalGatewayFixtureEnabled,
               let attention = Self.gatewayAccessAttention(
                   in: self.gatewayRegistry, ingress: self.gatewayController.ingress)
            {
                Text(attention.message)
                    .font(SettingsType.description)
                    .foregroundStyle(SettingsInk.secondary)
                if self.gatewayController.ingress.signingIn {
                    Button {
                        self.gatewayController.ingress.cancelSignIn()
                    } label: {
                        Text("Cancel sign-in").font(SettingsType.label)
                    }
                } else if attention.canSignIn {
                    Button {
                        Task { await self.reconnectGateway(ingressAttention: attention) }
                    } label: {
                        Text("Sign in to Cloudflare Access").font(SettingsType.label)
                    }
                    .disabled(self.isReconnectingGateway)
                }
            }
            if !self.appModel.isLocalGatewayFixtureEnabled,
               let target = Self.gatewayAccessSessionTarget(
                   in: self.gatewayRegistry, ingress: self.gatewayController.ingress)
            {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Access Host")
                        .font(SettingsType.label)
                    Text(verbatim: target.origin.url.absoluteString)
                        .font(SettingsType.description)
                        .foregroundStyle(SettingsInk.secondary)
                        .lineLimit(nil)
                        .fixedSize(horizontal: false, vertical: true)
                        .textSelection(.enabled)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                Button {
                    Task {
                        await self.gatewayController.ingress.signOut(
                            stableID: target.stableID, expectedOrigin: target.origin)
                    }
                } label: {
                    Text("Sign out of Cloudflare Access").font(SettingsType.label)
                }
                Text("Signs out Gateways using this host’s Access session. Your browser may stay signed in.")
                    .font(SettingsType.description)
                    .foregroundStyle(SettingsInk.secondary)
            }
        } header: {
            SettingsSectionTitle("Advanced")
        }
        Section {
            Button(role: .destructive) {
                self.showResetOnboardingAlert = true
            } label: {
                // The destructive role's system red, as Clear Cache uses.
                Text("Reset Onboarding")
                    .font(SettingsType.label)
            }
        }
    }

    func gatewaySecureField(
        _ title: LocalizedStringKey,
        text: Binding<String>) -> some View
    {
        SettingsInputRow(title) {
            SecureField(text: text, prompt: Text(verbatim: "—").font(SettingsType.value)) {
                Text(title).font(SettingsType.label)
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(Text(title))
        }
    }

    var diagnosticsAdvancedCard: some View {
        Section {
            self.settingsToggle("Debug logs", isOn: self.$discoveryDebugLogsEnabled) { enabled in
                self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
            }
            // The discovery status is the Discovery check's description above; this row only opens the log.
            NavigationLink {
                GatewayDiscoveryDebugLogView()
            } label: {
                Text("Logs").font(SettingsType.label)
            }
        } header: {
            SettingsSectionTitle("Discovery")
        }
    }

    var deviceIdentityCard: some View {
        Section {
            SettingsInputRow("Device Name") {
                TextField(text: self.$displayName, prompt: Text(verbatim: "—").font(SettingsType.value)) {
                    Text("Device Name").font(SettingsType.label)
                }
            }
            // A value, so it sits at the trailing edge; the full ID stays selectable.
            SettingsDetailRow("Instance ID", value: .verbatim(self.instanceId))
                .textSelection(.enabled)
        } header: {
            SettingsSectionTitle("Device")
        }
    }

    func settingsToggle(
        _ title: LocalizedStringKey,
        isOn: Binding<Bool>,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        // Native Toggle rows can ignore visible-row taps on iOS 26; reuse the shared indicator row.
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack {
                Text(title)
                    .font(SettingsType.label)
                Spacer(minLength: 8)
                // Like the system switch, the indicator overhangs the text line instead of
                // making the row taller than a row with a native Toggle.
                OpenClawToggleIndicator(isOn: isOn.wrappedValue).padding(.vertical, -4)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(title))
        .accessibilityValue(isOn.wrappedValue
            ? String(localized: "On")
            : String(localized: "Off"))
        .onChange(of: isOn.wrappedValue) { _, enabled in
            onChange?(enabled)
        }
    }
}
