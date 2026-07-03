import OpenClawKit
import SwiftUI

extension SettingsProTab {
    var currentAppearancePreference: AppAppearancePreference {
        AppAppearancePreference(rawValue: self.appearancePreferenceRaw) ?? .system
    }

    var appearanceRow: some View {
        // Menu hides its source label while open on iPad; a dialog keeps the visible row stable.
        Button {
            self.isShowingAppearanceDialog = true
        } label: {
            self.appearanceRowLabel
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("settings-appearance-row")
        .accessibilityLabel("Appearance")
        .accessibilityValue(self.currentAppearancePreference.label)
        .accessibilityHint("Choose system, light, or dark appearance")
        .confirmationDialog(
            "Appearance",
            isPresented: self.$isShowingAppearanceDialog,
            titleVisibility: .visible)
        {
            ForEach(AppAppearancePreference.allCases) { preference in
                Button {
                    self.appearancePreferenceRaw = preference.rawValue
                } label: {
                    Label(preference.label, systemImage: preference.systemImage)
                }
            }
        } message: {
            Text("Choose system, light, or dark appearance")
        }
    }

    var appearanceRowLabel: some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: "circle.lefthalf.filled",
                color: .secondary)

            Text("Appearance")
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.primary)

            Spacer(minLength: 8)

            HStack(spacing: 5) {
                Text(self.currentAppearancePreference.label)
                    .font(OpenClawType.subheadSemiBold)
                Image(systemName: "chevron.up.chevron.down")
                    .font(OpenClawType.caption2Bold)
            }
            .foregroundStyle(OpenClawBrand.accent)
        }
        .padding(.vertical, 4)
        .frame(maxWidth: .infinity, alignment: .leading)
        .contentShape(Rectangle())
    }

    var gatewaySection: some View {
        Section {
            NavigationLink(value: SettingsRoute.gateway) {
                self.gatewayConnectionRow
            }
        }
    }

    var gatewayConnectionRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: "antenna.radiowaves.left.and.right",
                color: self.gatewayStatusColor)

            VStack(alignment: .leading, spacing: 3) {
                Text("Gateway")
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(self.gatewaySummaryDetail)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.middle)
            }

            Spacer(minLength: 8)
        }
        .padding(.vertical, 4)
    }

    var gatewaySummaryDetail: String {
        let agentCount = self.appModel.gatewayAgents.count
        let agents = agentCount == 1 ? "1 agent" : "\(agentCount) agents"
        return "\(self.gatewayStatusDetail) • \(agents)"
    }

    var gatewayActions: some View {
        HStack(spacing: 10) {
            self.gatewayActionButton(
                title: "Reconnect",
                icon: "arrow.triangle.2.circlepath",
                color: OpenClawBrand.warn,
                isBusy: self.isReconnectingGateway,
                isDisabled: self.appModel.isAppleReviewDemoModeEnabled)
            {
                Task { await self.reconnectGateway() }
            }

            self.gatewayActionButton(
                title: "Diagnose",
                icon: "cross.case",
                color: OpenClawBrand.info,
                isBusy: self.isRefreshingGateway)
            {
                Task { await self.runDiagnostics() }
            }
        }
    }

    @ViewBuilder
    var settingsListSection: some View {
        Section {
            self.settingsListRow(
                icon: "checkmark.shield.fill",
                title: "Approvals",
                detail: self.pendingApproval == nil ? nil : "1 pending",
                route: .approvals,
                color: self.pendingApproval == nil ? .secondary : OpenClawBrand.warn,
                badgeValue: self.pendingApproval == nil ? nil : "1")
            self.settingsListRow(
                icon: "person.2",
                title: "Permissions",
                detail: self.permissionsDetail,
                route: .permissions)
            self.settingsListRow(
                icon: "point.3.connected.trianglepath.dotted",
                title: "Channels",
                route: .channels)
            self.settingsListRow(
                icon: "waveform",
                title: "Voice & Talk",
                detail: self.voiceDetail,
                route: .voice)
        }

        Section {
            self.appearanceRow
            self.settingsListRow(
                icon: "stethoscope",
                title: "Diagnostics",
                detail: self.diagnosticsDetail,
                route: .diagnostics)
            self.settingsListRow(
                icon: "hand.raised",
                title: "Privacy",
                detail: self.privacyDetail,
                route: .privacy)
            self.settingsListRow(
                icon: "bell",
                title: "Notifications",
                detail: self.notificationStatusText,
                route: .notifications)
            self.settingsListRow(
                icon: "info.circle",
                title: "About",
                route: .about)
        } header: {
            Text("Device")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
        }

        Section {
            self.settingsListRow(
                icon: "doc.text",
                title: "Licenses",
                route: .licenses)
                .accessibilityIdentifier("settings-licenses-row")
        }
    }

    func settingsListRow(
        icon: String,
        title: String,
        detail: String? = nil,
        route: SettingsRoute,
        color: Color = .secondary,
        badgeValue: String? = nil) -> some View
    {
        NavigationLink(value: route) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(OpenClawType.subheadSemiBold)
                    if let detail, !detail.isEmpty {
                        Text(detail)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                    }
                }
                Spacer(minLength: 8)
                if let badgeValue {
                    ProValuePill(value: badgeValue, color: color)
                }
            }
            .padding(.vertical, 4)
        }
    }

    func destination(for route: SettingsRoute) -> some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch route {
                    case .gateway:
                        self.gatewayDestination
                    case .approvals:
                        self.approvalsDestination
                    case .permissions:
                        self.permissionsDestination
                    case .channels:
                        SettingsChannelsDestination()
                    case .voice:
                        self.voiceDestination
                    case .diagnostics:
                        self.diagnosticsDestination
                    case .privacy:
                        self.privacyDestination
                    case .notifications:
                        self.notificationsDestination
                    case .licenses:
                        self.licensesDestination
                    case .about:
                        self.aboutDestination
                    }
                }
                .padding(.top, 18)
                .padding(.bottom, OpenClawProMetric.bottomScrollInset)
                .font(OpenClawType.body)
            }
        }
        .navigationTitle(self.title(for: route))
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            if let headerLeadingAction {
                ToolbarItem(placement: .topBarLeading) {
                    OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)
                }
            }
        }
    }

    var gatewayDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "antenna.radiowaves.left.and.right",
                title: "Gateway",
                detail: self.gatewayStatusDetail,
                value: self.gatewayStatusValue,
                color: self.gatewayStatusColor)

            self.detailListCard {
                self.detailRow("Address", value: self.gatewayAddress)
                Divider()
                self.detailRow("Server", value: self.gatewayServer)
                Divider()
                self.detailRow("Discovered", value: "\(self.gatewayController.gateways.count)")
                Divider()
                self.detailRow("Default Agent", value: self.appModel.activeAgentName)
                Divider()
                self.detailRow("Agents", value: "\(self.appModel.gatewayAgents.count)")
            }

            ProCard(radius: SettingsLayout.cardRadius) {
                self.gatewayActions
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)

            self.manualGatewayCard
            self.deviceIdentityCard
            self.agentSelectionCard
            self.gatewaySetupCard
            self.discoveredGatewaysCard
            self.gatewayAdvancedCard
        }
    }

    var approvalsDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "checkmark.shield.fill",
                title: "Approvals",
                detail: self.notificationsNeedAttention
                    ? "Out-of-app approval alerts need notification permission."
                    : (self.pendingApproval == nil ? "No gateway actions are waiting for review." :
                        "Review the pending gateway action."),
                value: self.notificationsNeedAttention
                    ? "Alerts Off"
                    : (self.pendingApproval == nil ? "clear" : "1 waiting"),
                color: self.notificationsNeedAttention ? OpenClawBrand.warn :
                    (self.pendingApproval == nil ? OpenClawBrand.ok : OpenClawBrand.warn))

            if self.notificationsNeedAttention {
                self.approvalNotificationsWarningCard
            }

            self.approvalsReviewCard
        }
    }

    var approvalNotificationsWarningCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: "bell.slash.fill", color: OpenClawBrand.warn)
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Notifications are off")
                            .font(OpenClawType.subheadSemiBold)
                        Text(
                            """
                            Enable Notifications to receive approval notifications while OpenClaw is not open.
                            """)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if self.directRoute == nil {
                    Button {
                        self.openNotificationsRouteFromApprovals()
                    } label: {
                        Label("Open Notifications", systemImage: "bell.badge")
                            .font(OpenClawType.captionSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var approvalsReviewCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                if let pendingApproval {
                    VStack(spacing: 0) {
                        ForEach(Array(self.approvalItems.enumerated()), id: \.element.id) { index, item in
                            SettingsApprovalRow(item: item)
                            if index < self.approvalItems.count - 1 {
                                Divider().padding(.leading, 46)
                            }
                        }
                    }

                    if let errorText = self.appModel.pendingExecApprovalPromptErrorText {
                        Text(errorText)
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawBrand.danger)
                    }

                    HStack(spacing: 8) {
                        Button {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-once") }
                        } label: {
                            Label("Allow", systemImage: "checkmark")
                                .font(OpenClawType.captionSemiBold)
                        }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)

                        if pendingApproval.allowsAllowAlways {
                            Button {
                                Task {
                                    await self.appModel.resolvePendingExecApprovalPrompt(decision: "allow-always")
                                }
                            } label: {
                                Label("Always", systemImage: "checkmark.shield")
                                    .font(OpenClawType.captionSemiBold)
                            }
                            .buttonStyle(.bordered)
                            .disabled(self.appModel.pendingExecApprovalPromptResolving)
                        }

                        Button(role: .destructive) {
                            Task { await self.appModel.resolvePendingExecApprovalPrompt(decision: "deny") }
                        } label: {
                            Label("Deny", systemImage: "xmark")
                                .font(OpenClawType.captionSemiBold)
                        }
                        .buttonStyle(.bordered)
                        .disabled(self.appModel.pendingExecApprovalPromptResolving)

                        Spacer(minLength: 0)
                    }
                    .controlSize(.small)
                } else {
                    HStack(spacing: 12) {
                        ProIconBadge(systemName: "checkmark.shield.fill", color: OpenClawBrand.ok)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("No approvals waiting")
                                .font(OpenClawType.subheadSemiBold)
                            Text(self.approvalEmptyDetail)
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var permissionsDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.toggleCard(
                icon: "camera",
                title: "Camera",
                detail: "Allow the gateway to request photos or video while OpenClaw is foregrounded.",
                isOn: self.$cameraEnabled)

            self.locationModeCard

            self.toggleCard(
                icon: "lock.display",
                title: "Keep Awake",
                detail: "Keep the screen awake while OpenClaw is open.",
                isOn: self.$preventSleep)

            self.privacyAccessCard
        }
    }

    var voiceDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "waveform",
                title: "Voice & Talk",
                detail: self.appModel.talkMode.gatewayTalkVoiceModeTitle,
                value: self.voiceDetail,
                color: self.talkEnabled || self.voiceWakeEnabled ? OpenClawBrand.accent : .secondary)

            self.voiceFeatureCard
            self.talkVoiceSettingsCard
            self.shareSettingsCard
        }
    }

    var diagnosticsDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "checklist.checked",
                title: "Health Check",
                detail: "Run app, permission, and gateway-adjacent checks without editing setup.",
                value: self.diagnosticsHealthValue,
                color: self.gatewayDiagnosticConnected ? OpenClawBrand.ok : OpenClawBrand.warn)

            ProCard(radius: SettingsLayout.cardRadius) {
                self.gatewayActionButton(
                    title: "Run Diagnostics",
                    icon: "cross.case",
                    color: OpenClawBrand.info,
                    isBusy: self.isRefreshingGateway)
                {
                    Task { await self.runDiagnostics() }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)

            self.diagnosticChecksCard

            self.detailListCard {
                self.detailRow("Device", value: DeviceInfoHelper.deviceFamily())
                Divider()
                self.detailRow("Platform", value: DeviceInfoHelper.platformStringForDisplay())
                Divider()
                self.detailRow("App", value: DeviceInfoHelper.openClawVersionString())
                Divider()
                self.detailRow("Model", value: DeviceInfoHelper.modelIdentifier())
            }

            self.diagnosticsAdvancedCard
        }
    }

    var privacyDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "hand.raised",
                title: "Privacy",
                detail: "Control what device context OpenClaw can expose to the gateway.",
                value: self.privacyDetail,
                color: .secondary)

            self.toggleCard(
                icon: "camera",
                title: "Camera Access",
                detail: "Disable to block camera capture requests from the gateway.",
                isOn: self.$cameraEnabled)

            self.locationModeCard

            self.toggleCard(
                icon: "lock.open.display",
                title: "Background Listening",
                detail: "Allow active Talk sessions to continue while the app is backgrounded.",
                isOn: self.$talkBackgroundEnabled)

            self.privacyAccessCard
        }
    }

    var notificationsDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "bell",
                title: "Notifications",
                detail: self.notificationStatusDetail,
                value: self.notificationStatusText,
                color: self.notificationStatus.color)

            ProCard(radius: SettingsLayout.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        self.handleNotificationAction()
                    } label: {
                        Label(
                            self.notificationActionText,
                            systemImage: self.notificationStatus.actionIcon)
                            .font(OpenClawType.captionSemiBold)
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
                    .disabled(self.notificationStatus == .checking || self.isRequestingNotificationAuthorization)

                    Text(self.notificationStatusDetail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)

                    Divider()

                    HStack(alignment: .top, spacing: 10) {
                        Image(systemName: "network")
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(OpenClawBrand.accent)
                            .frame(width: 22, height: 22)
                        Text(self.notificationRelayDetail)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var aboutDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailListCard {
                self.detailRow("OpenClaw app version", value: DeviceInfoHelper.openClawVersionString())
                Divider()
                self.detailRow("Device", value: DeviceInfoHelper.deviceFamily())
                Divider()
                self.detailRow("iOS", value: DeviceInfoHelper.iOSVersionStringForDisplay())
            }
        }
    }

    var licensesDestination: some View {
        let documents = LicenseDocumentLoader.bundledDocuments()
        return VStack(alignment: .leading, spacing: 14) {
            if documents.isEmpty {
                ProCard(radius: SettingsLayout.cardRadius) {
                    HStack(spacing: 12) {
                        ProIconBadge(systemName: "doc.text", color: .secondary)
                        VStack(alignment: .leading, spacing: 3) {
                            Text("No licenses bundled")
                                .font(OpenClawType.subheadSemiBold)
                            Text("License files are not available in this build.")
                                .font(OpenClawType.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                    }
                }
                .padding(.horizontal, OpenClawProMetric.pagePadding)
            } else {
                let lastDocumentID = documents.last?.id

                Text("OpenClaw appreciates its partners in the open-source community.")
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity)
                    .padding(.horizontal, OpenClawProMetric.pagePadding)

                self.detailListCard {
                    ForEach(documents) { document in
                        NavigationLink {
                            LicenseDocumentDetailView(document: document)
                        } label: {
                            self.licenseDocumentRow(document)
                        }
                        .buttonStyle(.plain)

                        if document.id != lastDocumentID {
                            Divider().padding(.leading, 60)
                        }
                    }
                }
                .accessibilityIdentifier("settings-licenses-list")
            }
        }
    }

    func licenseDocumentRow(_ document: LicenseDocument) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "doc.text", color: .secondary)
            Text(document.title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.primary)
            Spacer(minLength: 8)
            Image(systemName: "chevron.right")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.tertiary)
        }
        .padding(.horizontal, 14)
        .frame(minHeight: SettingsLayout.rowHeight)
    }

    func gatewayActionButton(
        title: String,
        icon: String,
        color: Color,
        isBusy: Bool,
        isDisabled: Bool = false,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: isBusy ? "hourglass" : icon)
                    .font(OpenClawType.captionSemiBold)
                Text(title)
                    .font(OpenClawType.captionSemiBold)
                    .lineLimit(1)
                    .minimumScaleFactor(0.76)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 32)
        }
        .buttonStyle(.bordered)
        .buttonBorderShape(.roundedRectangle(radius: 8))
        .tint(color)
        .controlSize(.small)
        .disabled(isBusy || isDisabled)
    }

    func toggleCard(
        icon: String,
        title: String,
        detail: String,
        isOn: Binding<Bool>) -> some View
    {
        ProCard(radius: SettingsLayout.cardRadius) {
            Toggle(isOn: isOn) {
                HStack(spacing: 12) {
                    ProIconBadge(systemName: icon, color: isOn.wrappedValue ? OpenClawBrand.accent : .secondary)
                    VStack(alignment: .leading, spacing: 3) {
                        Text(title)
                            .font(OpenClawType.subheadSemiBold)
                        Text(detail)
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            .toggleStyle(.switch)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var locationModeCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ProIconBadge(
                        systemName: "location",
                        color: self.locationModeRaw == OpenClawLocationMode.off.rawValue ? .secondary : OpenClawBrand
                            .accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Location")
                            .font(OpenClawType.subheadSemiBold)
                        Text("Controls whether location can be shared with gateway tools.")
                            .font(OpenClawType.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                    Spacer(minLength: 8)
                    if self.isChangingLocationMode {
                        ProgressView()
                            .controlSize(.small)
                    }
                }

                Picker("Location", selection: self.$locationModeRaw) {
                    Text("Off")
                        .font(OpenClawType.captionSemiBold)
                        .tag(OpenClawLocationMode.off.rawValue)
                    Text("While Using")
                        .font(OpenClawType.captionSemiBold)
                        .tag(OpenClawLocationMode.whileUsing.rawValue)
                    Text("Always")
                        .font(OpenClawType.captionSemiBold)
                        .tag(OpenClawLocationMode.always.rawValue)
                }
                .pickerStyle(.segmented)
                .disabled(self.isChangingLocationMode)

                Text(self.locationPermissionDetailText)
                    .font(OpenClawType.caption2)
                    .foregroundStyle(
                        self.locationPermissionSummary.needsAttention ? OpenClawBrand.warn : .secondary)

                if self.locationModeRaw == OpenClawLocationMode.always.rawValue {
                    self.locationAlwaysGuidance
                }

                if let locationPermissionWarningText {
                    Text(locationPermissionWarningText)
                        .font(OpenClawType.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var locationAlwaysGuidance: some View {
        let osStatus = CLLocationManager().authorizationStatus
        switch osStatus {
        case .authorizedAlways:
            Label {
                Text("Always Allow is active.")
            } icon: {
                Image(systemName: "checkmark.circle")
            }
            .font(OpenClawType.caption)
            .foregroundStyle(OpenClawBrand.ok)
        case .authorizedWhenInUse:
            VStack(alignment: .leading, spacing: 6) {
                Label {
                    Text("iOS is set to While Using.")
                        + Text(" Change to Always in Settings for reliable background automations.")
                } icon: {
                    Image(systemName: "exclamationmark.triangle")
                }
                .font(OpenClawType.caption)
                .foregroundStyle(OpenClawBrand.warn)
                self.openSettingsButton
            }
        case .denied, .restricted:
            VStack(alignment: .leading, spacing: 6) {
                Label {
                    Text("Location access is denied.")
                        + Text(" Enable it in Settings.")
                } icon: {
                    Image(systemName: "xmark.circle")
                }
                .font(OpenClawType.caption)
                .foregroundStyle(OpenClawBrand.danger)
                self.openSettingsButton
            }
        default:
            EmptyView()
        }
    }

    private var openSettingsButton: some View {
        Button("Open Settings") {
            guard let url = URL(
                string: UIApplication.openSettingsURLString) else { return }
            UIApplication.shared.open(url)
        }
        .font(OpenClawType.caption)
        .buttonStyle(.bordered)
    }

    var agentSelectionCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Default Agent")
                    .font(OpenClawType.subheadSemiBold)
                Picker("Agent", selection: self.$selectedAgentPickerId) {
                    Text("Default")
                        .font(OpenClawType.subhead)
                        .tag("")
                    let defaultId = (self.appModel.gatewayDefaultAgentId ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    ForEach(self.appModel.gatewayAgents.filter { $0.id != defaultId }, id: \.id) { agent in
                        let name = (agent.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        Text(name.isEmpty ? agent.id : name)
                            .font(OpenClawType.subhead)
                            .tag(agent.id)
                    }
                }
                Text("Used for new Chat and Talk sessions.")
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var gatewaySetupCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Setup Code")
                    .font(OpenClawType.subheadSemiBold)
                TextField("Paste setup code", text: self.$setupCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(OpenClawType.subhead)
                    .textFieldStyle(.roundedBorder)
                HStack(spacing: 10) {
                    self.gatewayActionButton(
                        title: "Scan QR",
                        icon: "qrcode.viewfinder",
                        color: OpenClawBrand.accent,
                        isBusy: self.connectingGatewayID != nil)
                    {
                        self.openGatewayQRScanner()
                    }
                    self.gatewayActionButton(
                        title: "Connect",
                        icon: "bolt.horizontal.circle",
                        color: OpenClawBrand.ok,
                        isBusy: self.connectingGatewayID == "manual")
                    {
                        Task { await self.applySetupCodeAndConnect() }
                    }
                    .disabled(!self.canApplyGatewaySetup)
                }
                if let status = self.setupStatusLine {
                    Text(status)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                if let warning = self.tailnetWarningText {
                    Text(warning)
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var discoveredGatewaysCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Discovered Gateways")
                    .font(OpenClawType.subheadSemiBold)
                if self.gatewayController.gateways.isEmpty {
                    Text("No gateways found yet. Use manual setup if Bonjour is blocked.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                } else {
                    ForEach(self.gatewayController.gateways) { gateway in
                        self.discoveredGatewayRow(gateway)
                        if gateway.id != self.gatewayController.gateways.last?.id {
                            Divider()
                        }
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func discoveredGatewayRow(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> some View {
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
            Button {
                Task { await self.connect(gateway) }
            } label: {
                if self.connectingGatewayID == gateway.id {
                    ProgressView().controlSize(.small)
                } else {
                    Text("Connect")
                        .font(OpenClawType.captionSemiBold)
                }
            }
            .buttonStyle(.bordered)
            .disabled(self.connectingGatewayID != nil)
        }
    }

    var manualGatewayCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.settingsButtonToggle("Use Manual Gateway", isOn: self.$manualGatewayEnabled)
                TextField("Host", text: self.$manualGatewayHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(OpenClawType.subhead)
                    .textFieldStyle(.roundedBorder)
                TextField("Port", text: self.manualPortBinding)
                    .keyboardType(.numberPad)
                    .font(OpenClawType.subhead)
                    .textFieldStyle(.roundedBorder)
                self.settingsButtonToggle("Use TLS", isOn: self.$manualGatewayTLS)
                self.gatewayActionButton(
                    title: "Connect Manual",
                    icon: "network",
                    color: OpenClawBrand.accent,
                    isBusy: self.connectingGatewayID == "manual")
                {
                    Task { await self.connectManual() }
                }
                .disabled(self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                    || !self.manualPortIsValid)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var gatewayAdvancedCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.settingsButtonToggle("Auto-connect on launch", isOn: self.$gatewayAutoConnect)
                SecureField("Gateway Auth Token", text: self.$gatewayToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(OpenClawType.subhead)
                    .textFieldStyle(.roundedBorder)
                SecureField("Gateway Password", text: self.$gatewayPassword)
                    .font(OpenClawType.subhead)
                    .textFieldStyle(.roundedBorder)
                Button(role: .destructive) {
                    self.showResetOnboardingAlert = true
                } label: {
                    Label("Reset Onboarding", systemImage: "arrow.counterclockwise")
                        .font(OpenClawType.captionSemiBold)
                        .frame(maxWidth: .infinity)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var voiceFeatureCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.settingsToggle("Voice Wake", isOn: self.$voiceWakeEnabled) { enabled in
                    self.appModel.setVoiceWakeEnabled(enabled)
                }
                self.settingsToggle("Talk Mode", isOn: self.$talkEnabled) { enabled in
                    guard !self.appModel.isAppleReviewDemoModeEnabled else {
                        self.talkEnabled = false
                        return
                    }
                    self.appModel.setTalkEnabled(enabled)
                }
                .disabled(self.appModel.isAppleReviewDemoModeEnabled)
                Picker("Speech Language", selection: self.$talkSpeechLocale) {
                    ForEach(TalkSpeechLocale.supportedOptions()) { option in
                        Text(option.label)
                            .font(OpenClawType.subhead)
                            .tag(option.id)
                    }
                }
                self.settingsToggle("Background Listening", isOn: self.$talkBackgroundEnabled)
                self.settingsToggle("Speakerphone", isOn: self.talkSpeakerphoneBinding)
                NavigationLink {
                    VoiceWakeWordsSettingsView()
                } label: {
                    self.simpleSettingsRow(
                        title: "Wake Words",
                        value: VoiceWakePreferences.displayString(for: self.voiceWake.triggerWords))
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var talkVoiceSettingsCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            if self.gatewayConnected,
               let issue = self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
            {
                TalkRuntimeIssueBanner(
                    issue: issue,
                    onOpenSettings: nil,
                    onShowDetails: {
                        self.showTalkIssueDetails = true
                    })
            }
            ProCard(radius: SettingsLayout.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Provider", selection: self.talkProviderSelectionBinding) {
                        ForEach(TalkModeProviderSelection.allCases) { option in
                            Text(option.label)
                                .font(OpenClawType.subhead)
                                .tag(option.rawValue)
                        }
                    }
                    if self.shouldShowRealtimeVoicePicker {
                        Picker("Realtime Voice", selection: self.talkRealtimeVoiceSelectionBinding) {
                            Text("Gateway Default")
                                .font(OpenClawType.subhead)
                                .tag("")
                            ForEach(TalkModeRealtimeVoiceSelection.voices, id: \.self) { voice in
                                Text(TalkModeRealtimeVoiceSelection.label(for: voice))
                                    .font(OpenClawType.subhead)
                                    .tag(voice)
                            }
                        }
                    }
                    self.detailRow("Voice Mode", value: self.appModel.talkMode.gatewayTalkVoiceModeTitle)
                    Divider()
                    self.detailRow("Active Voice", value: self.gatewayTalkActiveVoiceDetail)
                    if let issue = self.gatewayTalkLastIssueDetail {
                        Divider()
                        self.detailRow("Last Voice Issue", value: issue)
                    }
                    Divider()
                    self.detailRow("Transport", value: self.appModel.talkMode.gatewayTalkTransportLabel)
                    Divider()
                    self.detailRow("API Key", value: self.talkApiKeyStatus)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var shareSettingsCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle(isOn: self.$talkButtonEnabled) {
                    Text("Show Talk Control")
                        .font(OpenClawType.subhead)
                }
                TextField("Default Share Instruction", text: self.$defaultShareInstruction, axis: .vertical)
                    .lineLimit(2...5)
                    .textInputAutocapitalization(.sentences)
                    .font(OpenClawType.subhead)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await self.appModel.runSharePipelineSelfTest() }
                } label: {
                    Label("Run Share Self-Test", systemImage: "checkmark.seal")
                        .font(OpenClawType.captionSemiBold)
                }
                .buttonStyle(.bordered)
                Text(self.appModel.lastShareEventText)
                    .font(OpenClawType.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var privacyAccessCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            PrivacyAccessSectionView()
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var diagnosticsAdvancedCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.settingsButtonToggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled) { enabled in
                    self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
                }
                self.settingsButtonToggle("Debug Screen Status", isOn: self.$canvasDebugStatusEnabled)
                NavigationLink {
                    GatewayDiscoveryDebugLogView()
                } label: {
                    self.simpleSettingsRow(title: "Discovery Logs", value: self.gatewayController.discoveryStatusText)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var deviceIdentityCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Device Name", text: self.$displayName)
                    .textFieldStyle(.roundedBorder)
                self.detailRow("Instance ID", value: self.instanceId)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    func settingsToggle(
        _ title: String,
        isOn: Binding<Bool>,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        Toggle(isOn: isOn) {
            Text(title)
                .font(OpenClawType.subhead)
        }
        .onChange(of: isOn.wrappedValue) { _, enabled in
            onChange?(enabled)
        }
    }

    func settingsButtonToggle(
        _ title: String,
        isOn: Binding<Bool>,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        // Settings switch rows need full-width taps; wrapping Toggle crashes this NavigationStack on iOS 26.
        Button {
            isOn.wrappedValue.toggle()
        } label: {
            HStack {
                Text(title)
                Spacer(minLength: 8)
                self.settingsSwitchIndicator(isOn: isOn.wrappedValue)
            }
            .font(OpenClawType.subhead)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(title)
        .accessibilityValue(isOn.wrappedValue ? "On" : "Off")
        .onChange(of: isOn.wrappedValue) { _, enabled in
            onChange?(enabled)
        }
    }

    func settingsSwitchIndicator(isOn: Bool) -> some View {
        Capsule()
            .fill(isOn ? OpenClawBrand.accent : Color.secondary.opacity(0.35))
            .frame(width: 52, height: 32)
            .overlay(alignment: isOn ? .trailing : .leading) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 28, height: 28)
                    .padding(2)
                    .shadow(color: Color.black.opacity(0.14), radius: 1, x: 0, y: 1)
            }
    }

    func simpleSettingsRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
            Spacer(minLength: 8)
            Text(value)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.right")
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary)
        }
        .font(OpenClawType.subhead)
    }
}
