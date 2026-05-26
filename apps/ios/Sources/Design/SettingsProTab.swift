import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

struct SettingsProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearancePreference.storageKey) private var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue
    @AppStorage("camera.enabled") private var cameraEnabled: Bool = true
    @AppStorage("location.enabledMode") private var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("talk.background.enabled") private var talkBackgroundEnabled: Bool = false
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) private var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @State private var isReconnectingGateway = false
    @State private var isRefreshingGateway = false
    @State private var isChangingLocationMode = false
    @State private var locationStatusText: String?
    @State private var previousLocationModeRaw: String = OpenClawLocationMode.off.rawValue
    @State private var notificationStatusText = "Checking"
    @State private var notificationActionText = "Request Access"
    var openFullSettings: () -> Void

    private enum SettingsRoute: Hashable {
        case gateway
        case permissions
        case diagnostics
        case privacy
        case notifications
        case about
    }

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        self.settingsHeader
                        self.appearanceSection
                        self.gatewaySection
                        self.settingsListSection
                    }
                    .padding(.vertical, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationBarHidden(true)
            .navigationDestination(for: SettingsRoute.self) { route in
                self.destination(for: route)
            }
            .task {
                self.previousLocationModeRaw = self.locationModeRaw
                self.refreshNotificationSettings()
            }
            .onChange(of: self.scenePhase) { _, phase in
                if phase == .active {
                    self.refreshNotificationSettings()
                }
            }
            .onChange(of: self.locationModeRaw) { _, newValue in
                self.handleLocationModeChange(newValue)
            }
        }
    }

    private var settingsHeader: some View {
        Text("Settings")
            .font(.system(size: 28, weight: .bold))
            .padding(.horizontal, OpenClawProMetric.pagePadding)
            .padding(.top, 6)
    }

    private var appearanceSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Appearance", uppercase: false)
            ProCard(radius: SettingsLayout.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    Picker("Appearance", selection: self.$appearancePreferenceRaw) {
                        ForEach(AppAppearancePreference.allCases) { preference in
                            Text(preference.label).tag(preference.rawValue)
                        }
                    }
                    .pickerStyle(.segmented)
                    Text("Follows iOS appearance.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var gatewaySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Gateway", uppercase: false)
            ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
                VStack(spacing: 0) {
                    NavigationLink(value: SettingsRoute.gateway) {
                        self.gatewayConnectionRow
                            .padding(14)
                    }
                    .buttonStyle(.plain)
                    Divider()
                    self.gatewayDetailRow(label: "Address", value: self.gatewayAddress)
                    Divider()
                    self.gatewayDetailRow(label: "Server", value: self.gatewayServer)
                    Divider()
                    self.gatewayDetailRow(label: "Agents", value: "\(self.appModel.gatewayAgents.count)")
                    Divider()
                    self.gatewayActions
                        .padding(14)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var gatewayConnectionRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: "antenna.radiowaves.left.and.right",
                color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)

            VStack(alignment: .leading, spacing: 3) {
                Text("Connection")
                    .font(.subheadline.weight(.semibold))
                Text(self.gatewayConnected ? "Connected" : self.appModel.gatewayDisplayStatusText)
                    .font(.caption)
                    .foregroundStyle(self.gatewayConnected ? OpenClawBrand.ok : .secondary)
            }

            Spacer(minLength: 8)

            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
    }

    private func gatewayDetailRow(label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 14)
        .frame(height: 40)
    }

    private var gatewayActions: some View {
        HStack(spacing: 10) {
            self.gatewayActionButton(
                title: "Reconnect",
                icon: "arrow.triangle.2.circlepath",
                color: OpenClawBrand.warn,
                isBusy: self.isReconnectingGateway)
            {
                Task { await self.reconnectGateway() }
            }

            self.gatewayActionButton(
                title: "Diagnose",
                icon: "cross.case",
                color: Color(red: 0 / 255.0, green: 122 / 255.0, blue: 255 / 255.0),
                isBusy: self.isRefreshingGateway)
            {
                Task { await self.refreshGateway() }
            }
        }
    }

    private var settingsListSection: some View {
        VStack(spacing: 10) {
            self.settingsListRow(
                icon: "person.2",
                title: "Permissions",
                detail: self.permissionsDetail,
                route: .permissions)
            self.settingsListRow(
                icon: "globe",
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
                detail: DeviceInfoHelper.openClawVersionString(),
                route: .about)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func settingsListRow(
        icon: String,
        title: String,
        detail: String,
        route: SettingsRoute) -> some View
    {
        NavigationLink(value: route) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: .secondary)
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
            .padding(12)
            .frame(maxWidth: .infinity, minHeight: SettingsLayout.rowHeight, alignment: .leading)
            .proPanelSurface(radius: SettingsLayout.cardRadius)
        }
        .buttonStyle(.plain)
    }

    private func destination(for route: SettingsRoute) -> some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 14) {
                    switch route {
                    case .gateway:
                        self.gatewayDestination
                    case .permissions:
                        self.permissionsDestination
                    case .diagnostics:
                        self.diagnosticsDestination
                    case .privacy:
                        self.privacyDestination
                    case .notifications:
                        self.notificationsDestination
                    case .about:
                        self.aboutDestination
                    }
                }
                .padding(.vertical, 18)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle(self.title(for: route))
        .navigationBarTitleDisplayMode(.inline)
    }

    private var gatewayDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "antenna.radiowaves.left.and.right",
                title: "Gateway",
                detail: self.gatewayConnected ? "Connected" : self.appModel.gatewayDisplayStatusText,
                value: self.gatewayConnected ? "online" : "offline",
                color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)

            self.detailListCard {
                self.detailRow("Address", value: self.gatewayAddress)
                Divider()
                self.detailRow("Server", value: self.gatewayServer)
                Divider()
                self.detailRow("Discovered", value: "\(self.gatewayController.gateways.count)")
                Divider()
                self.detailRow("Active Agent", value: self.appModel.activeAgentName)
                Divider()
                self.detailRow("Agents", value: "\(self.appModel.gatewayAgents.count)")
            }

            ProCard(radius: SettingsLayout.cardRadius) {
                self.gatewayActions
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)

            self.fullSettingsButton("Gateway setup", detail: "Pairing codes, manual host, TLS, and discovery logs.")
        }
    }

    private var permissionsDestination: some View {
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

            self.fullSettingsButton(
                "More permissions",
                detail: "Contacts, calendar, reminders, and advanced device access.")
        }
    }

    private var diagnosticsDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "checklist.checked",
                title: "Health Check",
                detail: "Run app, permission, and gateway-adjacent checks without editing setup.",
                value: self.diagnosticsHealthValue,
                color: self.gatewayConnected ? OpenClawBrand.ok : OpenClawBrand.warn)

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

            ProCard(radius: SettingsLayout.cardRadius) {
                self.gatewayActionButton(
                    title: "Run Diagnostics",
                    icon: "cross.case",
                    color: Color(red: 0 / 255.0, green: 122 / 255.0, blue: 255 / 255.0),
                    isBusy: self.isRefreshingGateway)
                {
                    Task { await self.refreshGateway() }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)

            self.fullSettingsButton("Discovery logs", detail: "Open the full diagnostics and debug log view.")
        }
    }

    private var privacyDestination: some View {
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

            self.fullSettingsButton(
                "Privacy & access",
                detail: "Contacts, calendar, reminders, and system privacy permissions.")
        }
    }

    private var notificationsDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "bell",
                title: "Notifications",
                detail: "Approvals and event alerts from OpenClaw.",
                value: self.notificationStatusText,
                color: self.notificationStatusText == "Allowed" ? OpenClawBrand.ok : .secondary)

            ProCard(radius: SettingsLayout.cardRadius) {
                VStack(alignment: .leading, spacing: 12) {
                    Button {
                        self.handleNotificationAction()
                    } label: {
                        Label(
                            self.notificationActionText,
                            systemImage: self.notificationStatusText == "Allowed" ? "gear" : "bell.badge")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)

                    Text("OpenClaw uses notifications for approval prompts and mirrored event alerts.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var aboutDestination: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.detailStatusCard(
                icon: "info.circle",
                title: "OpenClaw",
                detail: "iOS companion app",
                value: DeviceInfoHelper.openClawVersionString(),
                color: OpenClawBrand.accent)

            self.detailListCard {
                self.detailRow("Version", value: DeviceInfoHelper.openClawVersionString())
                Divider()
                self.detailRow("Device", value: DeviceInfoHelper.deviceFamily())
                Divider()
                self.detailRow("Platform", value: DeviceInfoHelper.platformStringForDisplay())
                Divider()
                self.detailRow("Model", value: DeviceInfoHelper.modelIdentifier())
            }

            self.fullSettingsButton("Advanced settings", detail: "Open the complete system settings form.")
        }
    }

    private func gatewayActionButton(
        title: String,
        icon: String,
        color: Color,
        isBusy: Bool,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 7) {
                Image(systemName: isBusy ? "hourglass" : icon)
                    .font(.caption.weight(.semibold))
                Text(title)
                    .font(.caption.weight(.semibold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.76)
            }
            .frame(maxWidth: .infinity)
            .frame(height: 34)
            .foregroundStyle(color)
            .background(color.opacity(0.09), in: RoundedRectangle(cornerRadius: 8, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .strokeBorder(color.opacity(0.14))
            }
        }
        .buttonStyle(.plain)
        .disabled(isBusy)
    }

    private func toggleCard(
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
                            .font(.subheadline.weight(.semibold))
                        Text(detail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
            }
            .toggleStyle(.switch)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var locationModeCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 12) {
                    ProIconBadge(
                        systemName: "location",
                        color: self.locationModeRaw == OpenClawLocationMode.off.rawValue ? .secondary : OpenClawBrand
                            .accent)
                    VStack(alignment: .leading, spacing: 3) {
                        Text("Location")
                            .font(.subheadline.weight(.semibold))
                        Text("Controls whether location can be shared with gateway tools.")
                            .font(.caption)
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
                    Text("Off").tag(OpenClawLocationMode.off.rawValue)
                    Text("While Using").tag(OpenClawLocationMode.whileUsing.rawValue)
                    Text("Always").tag(OpenClawLocationMode.always.rawValue)
                }
                .pickerStyle(.segmented)
                .disabled(self.isChangingLocationMode)

                if let locationStatusText {
                    Text(locationStatusText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func detailStatusCard(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        ProCard(radius: SettingsLayout.cardRadius) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                ProValuePill(value: value, color: color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var diagnosticChecksCard: some View {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0) {
                self.diagnosticCheckRow(
                    icon: "antenna.radiowaves.left.and.right",
                    title: "Gateway Link",
                    detail: self.appModel.gatewayDisplayStatusText,
                    value: self.gatewayConnected ? "online" : "offline",
                    color: self.gatewayConnected ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "dot.radiowaves.left.and.right",
                    title: "Discovery",
                    detail: self.gatewayController.discoveryStatusText,
                    value: "\(self.gatewayController.gateways.count)",
                    color: self.gatewayController.gateways.isEmpty ? .secondary : OpenClawBrand.accent)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "waveform",
                    title: "Talk Config",
                    detail: self.appModel.talkMode.gatewayTalkTransportLabel,
                    value: self.appModel.talkMode.gatewayTalkConfigLoaded ? "loaded" : "missing",
                    color: self.appModel.talkMode.gatewayTalkConfigLoaded ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "bell",
                    title: "Notifications",
                    detail: "Approval and event alert channel",
                    value: self.notificationStatusText,
                    color: self.notificationStatusText == "Allowed" ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "rectangle.on.rectangle",
                    title: "Screen Capture",
                    detail: "Live foreground capture state",
                    value: self.appModel.screenRecordActive ? "live" : "idle",
                    color: self.appModel.screenRecordActive ? OpenClawBrand.ok : .secondary)
                Divider().padding(.leading, 60)
                self.diagnosticCheckRow(
                    icon: "mic",
                    title: "Voice Wake",
                    detail: self.appModel.voiceWake.statusText,
                    value: self.voiceWakeEnabled ? "on" : "off",
                    color: self.voiceWakeEnabled ? OpenClawBrand.ok : .secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func diagnosticCheckRow(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            ProValuePill(value: value, color: color)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }

    private func detailListCard(@ViewBuilder content: () -> some View) -> some View {
        ProCard(padding: 0, radius: SettingsLayout.cardRadius) {
            VStack(spacing: 0, content: content)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func detailRow(_ label: String, value: String) -> some View {
        HStack {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
            Text(value)
                .font(.caption)
                .lineLimit(1)
                .truncationMode(.middle)
        }
        .padding(.horizontal, 14)
        .frame(height: 42)
    }

    private func fullSettingsButton(_ title: String, detail: String) -> some View {
        Button(action: self.openFullSettings) {
            HStack(spacing: 12) {
                ProIconBadge(systemName: "slider.horizontal.3", color: OpenClawBrand.accent)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 8)
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .buttonStyle(.plain)
        .padding(14)
        .proPanelSurface(tint: OpenClawBrand.accent, radius: SettingsLayout.cardRadius, isProminent: true)
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func reconnectGateway() async {
        guard !self.isReconnectingGateway else { return }
        self.isReconnectingGateway = true
        defer { self.isReconnectingGateway = false }
        await self.gatewayController.connectLastKnown()
    }

    private func refreshGateway() async {
        guard !self.isRefreshingGateway else { return }
        self.isRefreshingGateway = true
        defer { self.isRefreshingGateway = false }
        self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        self.gatewayController.restartDiscovery()
        await self.appModel.refreshGatewayOverviewIfConnected()
    }

    private func handleLocationModeChange(_ newValue: String) {
        guard !self.isChangingLocationMode else { return }
        guard newValue != self.previousLocationModeRaw else { return }
        guard let mode = OpenClawLocationMode(rawValue: newValue) else { return }
        let previous = self.previousLocationModeRaw
        Task {
            await self.applyLocationMode(mode, rawValue: newValue, previous: previous)
        }
    }

    @MainActor
    private func applyLocationMode(
        _ mode: OpenClawLocationMode,
        rawValue: String,
        previous: String) async
    {
        self.isChangingLocationMode = true
        self.locationStatusText = nil
        defer { self.isChangingLocationMode = false }

        if mode == .off {
            self.previousLocationModeRaw = rawValue
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            return
        }

        let granted = await self.appModel.requestLocationPermissions(mode: mode)
        if granted {
            self.previousLocationModeRaw = rawValue
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
        } else {
            self.locationModeRaw = previous
            self.previousLocationModeRaw = previous
            self.locationStatusText = "Location permission was not granted."
        }
    }

    private func refreshNotificationSettings() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                self.applyNotificationStatus(status)
            }
        }
    }

    private func handleNotificationAction() {
        if self.notificationStatusText == "Allowed" || self.notificationStatusText == "Not Allowed" {
            self.openSystemSettings()
            return
        }

        Task {
            let granted = await (try? UNUserNotificationCenter.current().requestAuthorization(options: [
                .alert,
                .badge,
                .sound,
            ])) ?? false
            await MainActor.run {
                self.notificationStatusText = granted ? "Allowed" : "Not Allowed"
                self.notificationActionText = granted ? "Open System Settings" : "Open System Settings"
            }
        }
    }

    @MainActor
    private func applyNotificationStatus(_ status: UNAuthorizationStatus) {
        switch status {
        case .authorized, .provisional, .ephemeral:
            self.notificationStatusText = "Allowed"
            self.notificationActionText = "Open System Settings"
        case .denied:
            self.notificationStatusText = "Not Allowed"
            self.notificationActionText = "Open System Settings"
        case .notDetermined:
            self.notificationStatusText = "Not Set"
            self.notificationActionText = "Request Access"
        @unknown default:
            self.notificationStatusText = "Unknown"
            self.notificationActionText = "Open System Settings"
        }
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func title(for route: SettingsRoute) -> String {
        switch route {
        case .gateway: "Gateway"
        case .permissions: "Permissions"
        case .diagnostics: "Diagnostics"
        case .privacy: "Privacy"
        case .notifications: "Notifications"
        case .about: "About"
        }
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var gatewayAddress: String {
        self.appModel.gatewayRemoteAddress ?? "Waiting for gateway"
    }

    private var gatewayServer: String {
        self.appModel.gatewayServerName ?? "OpenClaw Gateway"
    }

    private var permissionsDetail: String {
        var enabled = 0
        if self.cameraEnabled { enabled += 1 }
        if self.locationModeRaw != OpenClawLocationMode.off.rawValue { enabled += 1 }
        if self.preventSleep { enabled += 1 }
        return "\(enabled) enabled"
    }

    private var diagnosticsDetail: String {
        "System checks"
    }

    private var diagnosticsHealthValue: String {
        if self.gatewayConnected { return "ready" }
        if self.gatewayController.gateways.isEmpty { return "check" }
        return "partial"
    }

    private var privacyDetail: String {
        let location = OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off
        return location == .off ? "Location off" : "Location \(self.locationLabel)"
    }

    private var locationLabel: String {
        switch OpenClawLocationMode(rawValue: self.locationModeRaw) ?? .off {
        case .off: "Off"
        case .whileUsing: "While Using"
        case .always: "Always"
        }
    }
}

private enum SettingsLayout {
    static let cardRadius: CGFloat = 12
    static let rowHeight: CGFloat = 58
}
