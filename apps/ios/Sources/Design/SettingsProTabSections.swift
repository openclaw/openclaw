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
            Text("Device")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
        }
    }

    func settingsListRow(
        icon: String,
        title: LocalizedStringKey,
        route: SettingsRoute) -> some View
    {
        NavigationLink(value: route) {
            Label {
                Text(title).font(OpenClawType.body)
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
                        Section {
                            self.gatewayNavigationRow("Diagnostics", icon: "stethoscope", route: .diagnostics)
                            self.gatewayNavigationRow("Licenses", icon: "doc.text", route: .licenses)
                        }
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
                    Button {
                        Task { await self.reconnectGateway() }
                    } label: {
                        Label {
                            Text("Reconnect").font(OpenClawType.body)
                        } icon: {
                            NativeSettingsRowIcon(systemName: "arrow.clockwise")
                        }
                    }
                    .disabled(self.isReconnectingGateway || self.appModel.isAppleReviewDemoModeEnabled)
                }
            }

            self.gatewaySetupCard

            Section {
                self.gatewayNavigationRow("Diagnostics", icon: "stethoscope", route: .diagnostics)
                self.gatewayNavigationRow("Connection details", icon: "info.circle", route: .gatewayDetails)
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
            }
            self.deviceIdentityCard
            if !self.appModel.isLocalGatewayFixtureEnabled {
                self.manualGatewayCard
            }
            self.gatewayAdvancedCard
        }
    }

    private func gatewayNavigationRow(
        _ title: LocalizedStringKey, icon: String, route: SettingsRoute) -> some View
    {
        NavigationLink(value: route) {
            Label {
                Text(title).font(OpenClawType.body)
            } icon: {
                NativeSettingsRowIcon(systemName: icon)
            }
        }
    }

    var approvalsDestination: some View {
        Group {
            self.detailStatusCard(
                icon: "checkmark.shield.fill",
                title: "Approvals",
                detail: .verbatim(self.notificationPresentation.needsAttention
                    ? String(localized: "Out-of-app approval alerts need notification permission.")
                    : (self.appModel.pendingExecApprovalCount == 0
                        ? String(localized: "No gateway actions are waiting for review.")
                        : String(localized: "Review pending gateway actions."))),
                value: self.notificationPresentation.needsAttention
                    ? .verbatim(String(localized: "Alerts Off"))
                    : (self.appModel.pendingExecApprovalCount == 0
                        ? .verbatim(String(localized: "clear"))
                        : .verbatim(self.approvalWaitingText)),
                color: self.notificationPresentation.needsAttention ? OpenClawBrand.warn :
                    (self.appModel.pendingExecApprovalCount == 0 ? OpenClawBrand.ok : OpenClawBrand.warn))

            if self.notificationPresentation.needsAttention {
                self.approvalNotificationsWarningCard
            }

            self.approvalsReviewCard
        }
    }

    var appleWatchDestination: some View {
        Group {
            let watchStatus = self.appModel.watchMessagingStatus
            self.detailStatusCard(
                icon: "applewatch",
                title: "Apple Watch",
                detail: .verbatim(watchStatus.appInstalled
                    ? String(
                        localized: "Relay remains available; direct mode adds an independent Gateway node.")
                    : String(
                        localized: "Install the OpenClaw watch app before enabling direct mode.")),
                value: .verbatim(
                    watchStatus.reachable
                        ? String(localized: "Reachable")
                        : (watchStatus.appInstalled
                            ? String(localized: "Installed")
                            : String(localized: "Unavailable"))),
                color: watchStatus.appInstalled ? OpenClawBrand.ok : OpenClawBrand.warn)

            Section {
                NavigationLink {
                    WatchMessageJournalView()
                } label: {
                    Label("Message Delivery", systemImage: "bubble.left.and.text.bubble.right")
                        .font(OpenClawType.body)
                }
            }

            Section {
                Button {
                    Task { await self.sendDirectWatchSetup() }
                } label: {
                    Label {
                        Text("Connect Apple Watch")
                            .font(OpenClawType.body)
                    } icon: {
                        Image(systemName: "applewatch")
                    }
                }
                .disabled(
                    self.isSendingWatchDirectSetup
                        || !self.appModel.isOperatorGatewayConnected
                        || !self.appModel.hasOperatorAdminScope
                        || !watchStatus.appInstalled)

                if let statusText = self.watchDirectSetupStatusText {
                    Text(statusText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            } footer: {
                Text(
                    """
                    The watch receives a one-time pairing code and its own device credentials. \
                    Voice is included with read and Talk access, without admin access. \
                    The microphone starts only when you tap Start on the watch. \
                    A reachable secure Gateway URL is required away from the iPhone.
                    """)
                    .font(OpenClawType.footnote)
            }

            Section("Direct node features") {
                SettingsDetailRow("Device", value: "Info and status")
                SettingsDetailRow("Notifications", value: "While app is active")
            }
        }
    }

    var approvalNotificationsWarningCard: some View {
        Section {
            VStack(alignment: .leading, spacing: 4) {
                Text("Notifications are off")
                    .font(OpenClawType.subheadSemiBold)
                Text("Enable Notifications to receive approval alerts while OpenClaw is not open.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button {
                self.openNotificationsRouteFromApprovals()
            } label: {
                Label("Open Notifications", systemImage: "bell.badge")
                    .font(OpenClawType.body)
            }
        }
    }

    @ViewBuilder
    var approvalsReviewCard: some View {
        if !self.appModel.pendingExecApprovalInboxItems.isEmpty {
            Section("Pending approvals") {
                ForEach(self.appModel.pendingExecApprovalInboxItems) { item in
                    Button {
                        self.appModel.presentPendingExecApprovalFromInbox(item.id)
                    } label: {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(item.prompt.commandPreview ?? item.prompt.commandText)
                                .font(OpenClawType.body)
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(item.prompt.gatewayStableID)
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(1)
                        }
                        .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .accessibilityLabel(item.prompt.kind == "exec"
                        ? String(localized: "Review exec approval")
                        : String(localized: "Review approval"))
                    .accessibilityValue(item.prompt.commandPreview ?? item.prompt.commandText)
                }
            }
        }

        if let pendingApproval = self.appModel.pendingExecApprovalPrompt {
            Section("Reviewing") {
                ForEach(self.approvalItems, id: \.id) { item in
                    SettingsApprovalRow(item: item)
                }
                if let warningText = pendingApproval.warningText {
                    Label {
                        Text(warningText)
                            .font(OpenClawType.caption)
                    } icon: {
                        Image(systemName: "exclamationmark.triangle.fill")
                    }
                    .foregroundStyle(OpenClawBrand.warn)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let errorText = self.appModel.pendingExecApprovalPromptErrorText {
                    Text(errorText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(OpenClawBrand.danger)
                }
                if let resolvedText = self.appModel.pendingExecApprovalPromptResolvedText {
                    Text(resolvedText)
                        .font(OpenClawType.caption)
                        .foregroundStyle(self.approvalOutcomeColor)
                    Button {
                        self.appModel.dismissPendingExecApprovalPrompt()
                    } label: {
                        Label("Dismiss", systemImage: "xmark")
                            .font(OpenClawType.body)
                    }
                } else {
                    if pendingApproval.kind == "system-agent" {
                        ApprovalDashboardReviewButton(prompt: pendingApproval)
                    }
                    if pendingApproval.allowsAllowOnce {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Label("Allow Once", systemImage: "checkmark")
                                .font(OpenClawType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsAllowAlways {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always") }
                        } label: {
                            Label("Allow Always", systemImage: "checkmark.shield")
                                .font(OpenClawType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if pendingApproval.allowsDeny {
                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Label("Deny", systemImage: "xmark")
                                .font(OpenClawType.body)
                        }
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)
                    }
                    if self.appModel.pendingExecApprovalPromptResolving,
                       self.appModel.pendingExecApprovalPromptCanDismiss
                    {
                        Button(role: .cancel) {
                            self.appModel.dismissPendingExecApprovalPrompt()
                        } label: {
                            Label("Dismiss", systemImage: "xmark")
                                .font(OpenClawType.body)
                        }
                    }
                }
            }
        } else if self.appModel.pendingExecApprovalCount == 0 {
            Section {
                Label {
                    VStack(alignment: .leading, spacing: 2) {
                        Text("No approvals waiting")
                            .font(OpenClawType.subheadSemiBold)
                        Text(self.approvalEmptyDetail)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                    }
                } icon: {
                    Image(systemName: "checkmark.shield.fill")
                        .foregroundStyle(OpenClawBrand.ok)
                }
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
            self.detailStatusCard(
                icon: "checklist.checked",
                title: "Health Check",
                detail: "Run app, permission, and gateway-adjacent checks without editing setup.",
                value: .verbatim(self.diagnosticsHealthValue),
                color: self.gatewayDiagnosticConnected ? OpenClawBrand.ok : OpenClawBrand.warn)

            Section {
                Button {
                    Task { await self.runDiagnostics() }
                } label: {
                    Label("Run Diagnostics", systemImage: "cross.case")
                        .font(OpenClawType.body)
                }
                .disabled(self.isRefreshingGateway)
            }

            self.diagnosticChecksCard

            Section {
                SettingsDetailRow("Device", value: .verbatim(InstanceIdentity.deviceFamily))
                SettingsDetailRow(
                    "Platform",
                    value: .verbatim(DeviceInfoHelper.platformStringForDisplay()))
                SettingsDetailRow(
                    "App",
                    value: .verbatim(DeviceInfoHelper.openClawVersionString()))
                SettingsDetailRow("Model", value: .verbatim(DeviceInfoHelper.modelIdentifier()))
            }

            self.diagnosticsAdvancedCard
        }
    }

    @ViewBuilder
    var gatewayActionStatusView: some View {
        if let gatewayActionStatusText {
            Text(verbatim: gatewayActionStatusText)
                .font(OpenClawType.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder var licensesDestination: some View {
        let documents = LicenseDocumentLoader.bundledDocuments()
        if documents.isEmpty {
            ContentUnavailableView(
                "No Licenses Bundled",
                systemImage: "doc.text",
                description: Text("License files are not available in this build."))
                .font(OpenClawType.body)
        } else {
            Section {
                ForEach(documents) { document in
                    NavigationLink {
                        LicenseDocumentDetailView(document: document)
                    } label: {
                        Label {
                            Text(document.title)
                                .font(OpenClawType.subhead)
                        } icon: {
                            NativeSettingsRowIcon(systemName: "doc.text")
                        }
                    }
                }
            } footer: {
                Text("OpenClaw appreciates its partners in the open-source community.")
                    .font(OpenClawType.footnote)
            }
            .accessibilityIdentifier("settings-licenses-list")
        }
    }

    /// Native inset-grouped action row (plain tinted text, no pill chrome).
    func gatewayActionButton(
        title: LocalizedStringKey,
        icon: String,
        isBusy: Bool,
        isDisabled: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack {
                Label {
                    Text(title).font(OpenClawType.body)
                } icon: {
                    NativeSettingsRowIcon(systemName: icon)
                }
                Spacer()
                if isBusy {
                    ProgressView().controlSize(.small)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
            }

            Section {
                self.aboutLinkRow(
                    title: "Support",
                    icon: "questionmark.circle",
                    url: URL(string: "https://community.openclaw.ai/")!)
                self.aboutLinkRow(
                    title: "Website",
                    icon: "globe",
                    url: URL(string: "https://openclaw.ai")!)
                self.aboutLinkRow(
                    title: "Docs",
                    icon: "book.fill",
                    url: URL(string: "https://docs.openclaw.ai")!)
                self.aboutLinkRow(
                    title: "GitHub",
                    icon: "chevron.left.slash.chevron.right",
                    url: URL(string: "https://github.com/openclaw/openclaw")!)
                self.aboutLinkRow(
                    title: "Discord",
                    icon: "bubble.left.and.bubble.right.fill",
                    url: URL(string: "https://openclaw.ai/discord?from=openclaw-app-ios-settings")!)
            } footer: {
                Text("© 2026 OpenClaw Foundation — MIT License.")
                    .font(OpenClawType.footnote)
            }
        }
    }

    /// About link row with explicit branded label; shorthand `Link("Title", ...)`
    /// would bypass the typography audit and OpenClawType styling.
    func aboutLinkRow(
        title: LocalizedStringKey,
        icon: String,
        url: URL) -> some View
    {
        Link(destination: url) {
            HStack {
                Label {
                    Text(title)
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(.primary)
                } icon: {
                    NativeSettingsRowIcon(systemName: icon)
                }
                Spacer()
                Image(systemName: "arrow.up.right")
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(.secondary)
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
                    icon: "bolt.horizontal.circle",
                    isBusy: self.setupAttemptID != nil,
                    isDisabled: self.connectingGateway != nil)
                {
                    Task { await self.applySetupCodeAndConnect() }
                }
            } else {
                Button {
                    self.openGatewayQRScanner()
                } label: {
                    Label {
                        Text(limited ? "Upgrade access" : "Add Gateway")
                            .font(OpenClawType.body)
                    } icon: {
                        NativeSettingsRowIcon(systemName: "qrcode.viewfinder")
                    }
                }
                .disabled(self.connectingGateway != nil)
                .accessibilityIdentifier("SettingsHub.PairGateway")
            }
        } footer: {
            if let status = self.setupStatusLine, self.setupStatusText != nil {
                Text(status).font(OpenClawType.footnote)
            } else if limited {
                Text("Pair again with a full-access setup code.")
                    .font(OpenClawType.footnote)
            }
        }
    }

    var pairedGatewaysCard: some View {
        Section {
            if self.gatewayRegistry.entries.isEmpty {
                Text("Pair a gateway to make it available here.")
                    .font(OpenClawType.subhead)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(self.gatewayRegistry.entries) { entry in
                    self.pairedGatewayRow(entry)
                }
            }
        } header: {
            Text("Saved gateways")
                .font(OpenClawType.captionSemiBold)
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
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: entry.name)
                        .font(OpenClawType.body)
                    if entry.name.trimmingCharacters(in: .whitespacesAndNewlines)
                        .caseInsensitiveCompare(endpoint) != .orderedSame
                    {
                        Text(verbatim: endpoint)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
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
                    .font(OpenClawType.subheadSemiBold)
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
                        .font(OpenClawType.subheadSemiBold)
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
                VStack(alignment: .leading, spacing: 3) {
                    Text(verbatim: gateway.name)
                        .font(OpenClawType.subheadSemiBold)
                    Text(verbatim: self.gatewayDetailLines(gateway).joined(separator: " • "))
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
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
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }

            if let guidanceText = availability.guidanceText {
                Text(guidanceText)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    var manualGatewayCard: some View {
        Section {
            self.settingsToggle("Use Manual Gateway", isOn: self.manualGatewayEnabledBinding)
            SettingsInputRow("Host") {
                TextField(text: self.manualHostBinding, prompt: Text(verbatim: "—").font(OpenClawType.body)) {
                    Text("Host").font(OpenClawType.body)
                }
                .textInputAutocapitalization(.never)
                .autocorrectionDisabled()
            }
            if let hostIssue = self.manualGatewayHostIssue {
                Text(hostIssue)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(OpenClawBrand.warn)
            }
            SettingsInputRow("Port") {
                TextField(text: self.manualPortBinding, prompt: Text(verbatim: "—").font(OpenClawType.body)) {
                    Text("Port").font(OpenClawType.body)
                }
                .keyboardType(.numberPad)
            }
            ManualGatewaySecurityRows(
                presentation: self.manualGatewayTransport,
                useTLS: self.manualGatewayTLSBinding)
            self.gatewayActionButton(
                title: "Connect Manual",
                icon: "network",
                isBusy: self.connectingGateway == .manual,
                isDisabled: self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || self.manualGatewayHostIssue != nil
                    || !self.manualPortIsValid)
            {
                Task { await self.connectManual() }
            }
        } header: {
            Text("Manual Gateway").font(OpenClawType.captionSemiBold)
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
                            .font(OpenClawType.body)
                    }
                }
            }
            if !self.appModel.isLocalGatewayFixtureEnabled,
               let attention = Self.gatewayAccessAttention(
                   in: self.gatewayRegistry, ingress: self.gatewayController.ingress)
            {
                Text(attention.message)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                if self.gatewayController.ingress.signingIn {
                    Button {
                        self.gatewayController.ingress.cancelSignIn()
                    } label: {
                        Text("Cancel sign-in").font(OpenClawType.body)
                    }
                } else if attention.canSignIn {
                    Button {
                        Task { await self.reconnectGateway(ingressAttention: attention) }
                    } label: {
                        Text("Sign in to Cloudflare Access").font(OpenClawType.body)
                    }
                    .disabled(self.isReconnectingGateway)
                }
            }
            if !self.appModel.isLocalGatewayFixtureEnabled,
               let target = Self.gatewayAccessSessionTarget(
                   in: self.gatewayRegistry, ingress: self.gatewayController.ingress)
            {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Access Host")
                        .font(OpenClawType.body)
                    Text(verbatim: target.origin.url.absoluteString)
                        .font(OpenClawType.subhead)
                        .foregroundStyle(.secondary)
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
                    Text("Sign out of Cloudflare Access").font(OpenClawType.body)
                }
                Text("Signs out gateways using this host’s Access session. Your browser may stay signed in.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            }
        }
        Section {
            Button(role: .destructive) {
                self.showResetOnboardingAlert = true
            } label: {
                Text("Reset Onboarding")
                    .font(OpenClawType.body)
                    .foregroundStyle(OpenClawBrand.danger)
            }
        }
    }

    func gatewaySecureField(
        _ title: LocalizedStringKey,
        text: Binding<String>) -> some View
    {
        SettingsInputRow(title) {
            SecureField(text: text, prompt: Text(verbatim: "—").font(OpenClawType.body)) {
                Text(title).font(OpenClawType.body)
            }
            .textInputAutocapitalization(.never)
            .autocorrectionDisabled()
            .accessibilityLabel(Text(title))
        }
    }

    var diagnosticsAdvancedCard: some View {
        Section {
            self.settingsToggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled) { enabled in
                self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
            }
            NavigationLink {
                GatewayDiscoveryDebugLogView()
            } label: {
                SettingsDetailRow(
                    "Discovery Logs",
                    value: .verbatim(self.gatewayController.discoveryStatusText))
            }
        }
    }

    var deviceIdentityCard: some View {
        Section {
            SettingsInputRow("Device Name") {
                TextField(text: self.$displayName, prompt: Text(verbatim: "—").font(OpenClawType.body)) {
                    Text("Device Name").font(OpenClawType.body)
                }
            }
            SettingsDetailRow("Instance ID", value: .verbatim(self.instanceId))
        } header: {
            Text("Device").font(OpenClawType.captionSemiBold)
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
                    .font(OpenClawType.body)
                Spacer(minLength: 8)
                OpenClawToggleIndicator(isOn: isOn.wrappedValue)
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
