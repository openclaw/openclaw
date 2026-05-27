import OpenClawKit
import SwiftUI
import UIKit
import UserNotifications

struct SettingsProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(VoiceWakeManager.self) private var voiceWake
    @Environment(GatewayConnectionController.self) private var gatewayController
    @Environment(\.scenePhase) private var scenePhase
    @AppStorage(AppAppearancePreference.storageKey) private var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue
    @AppStorage("node.displayName") private var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") private var instanceId: String = UUID().uuidString
    @AppStorage("camera.enabled") private var cameraEnabled: Bool = true
    @AppStorage("location.enabledMode") private var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage("screen.preventSleep") private var preventSleep: Bool = true
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage(TalkModeProviderSelection.storageKey) private var talkProviderSelectionRaw: String =
        TalkModeProviderSelection.gatewayDefault.rawValue
    @AppStorage(TalkModeRealtimeVoiceSelection.storageKey) private var talkRealtimeVoiceSelectionRaw: String = ""
    @AppStorage(TalkSpeechLocale.storageKey) private var talkSpeechLocale: String = TalkSpeechLocale.automaticID
    @AppStorage("talk.button.enabled") private var talkButtonEnabled: Bool = true
    @AppStorage("talk.background.enabled") private var talkBackgroundEnabled: Bool = false
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) private var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage(VoiceWakePreferences.enabledKey) private var voiceWakeEnabled: Bool = false
    @AppStorage("gateway.autoconnect") private var gatewayAutoConnect: Bool = false
    @AppStorage("gateway.manual.enabled") private var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") private var manualGatewayHost: String = ""
    @AppStorage("gateway.manual.port") private var manualGatewayPort: Int = 18789
    @AppStorage("gateway.manual.tls") private var manualGatewayTLS: Bool = true
    @AppStorage("gateway.discovery.debugLogs") private var discoveryDebugLogsEnabled: Bool = false
    @AppStorage("canvas.debugStatusEnabled") private var canvasDebugStatusEnabled: Bool = false
    @AppStorage("gateway.setupCode") private var setupCode: String = ""
    @AppStorage("gateway.onboardingComplete") private var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") private var hasConnectedOnce: Bool = false
    @AppStorage("onboarding.requestID") private var onboardingRequestID: Int = 0
    @State private var isReconnectingGateway = false
    @State private var isRefreshingGateway = false
    @State private var isChangingLocationMode = false
    @State private var connectingGatewayID: String?
    @State private var selectedAgentPickerId = ""
    @State private var gatewayToken = ""
    @State private var gatewayPassword = ""
    @State private var manualGatewayPortText = ""
    @State private var setupStatusText: String?
    @State private var pendingManualAuthOverride: GatewayConnectionController.ManualAuthOverride?
    @State private var defaultShareInstruction = ""
    @State private var showGatewayProblemDetails = false
    @State private var showQRScanner = false
    @State private var scannerError: String?
    @State private var showResetOnboardingAlert = false
    @State private var suppressCredentialPersist = false
    @State private var locationStatusText: String?
    @State private var previousLocationModeRaw: String = OpenClawLocationMode.off.rawValue
    @State private var notificationStatusText = "Checking"
    @State private var notificationActionText = "Request Access"

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
                self.syncSettingsState()
                self.refreshNotificationSettings()
            }
            .onChange(of: self.scenePhase) { _, phase in
                if phase == .active {
                    self.syncSettingsState()
                    self.refreshNotificationSettings()
                }
            }
            .onChange(of: self.locationModeRaw) { _, newValue in
                self.handleLocationModeChange(newValue)
            }
            .onChange(of: self.selectedAgentPickerId) { _, newValue in
                let trimmed = newValue.trimmingCharacters(in: .whitespacesAndNewlines)
                self.appModel.setSelectedAgentId(trimmed.isEmpty ? nil : trimmed)
            }
            .onChange(of: self.appModel.selectedAgentId ?? "") { _, newValue in
                if newValue != self.selectedAgentPickerId {
                    self.selectedAgentPickerId = newValue
                }
            }
            .onChange(of: self.gatewayToken) { _, newValue in
                self.persistGatewayToken(newValue)
            }
            .onChange(of: self.gatewayPassword) { _, newValue in
                self.persistGatewayPassword(newValue)
            }
            .onChange(of: self.defaultShareInstruction) { _, newValue in
                ShareToAgentSettings.saveDefaultInstruction(newValue)
            }
        }
        .sheet(isPresented: self.$showGatewayProblemDetails) {
            if let gatewayProblem = self.appModel.lastGatewayProblem {
                GatewayProblemDetailsSheet(
                    problem: gatewayProblem,
                    primaryActionTitle: self.gatewayProblemPrimaryActionTitle(gatewayProblem),
                    onPrimaryAction: {
                        Task { await self.handleGatewayProblemPrimaryAction(gatewayProblem) }
                    })
            }
        }
        .sheet(isPresented: self.$showQRScanner) {
            NavigationStack {
                QRScannerView(
                    onGatewayLink: { link in
                        self.handleScannedGatewayLink(link)
                    },
                    onError: { error in
                        self.showQRScanner = false
                        self.setupStatusText = "Scanner error: \(error)"
                        self.scannerError = error
                    },
                    onDismiss: {
                        self.showQRScanner = false
                    })
                    .ignoresSafeArea()
                    .navigationTitle("Scan QR Code")
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar {
                        ToolbarItem(placement: .topBarLeading) {
                            Button("Cancel") { self.showQRScanner = false }
                        }
                    }
            }
        }
        .alert("Reset Onboarding?", isPresented: self.$showResetOnboardingAlert) {
            Button("Reset", role: .destructive) {
                self.resetOnboarding()
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text("This disconnects, clears saved gateway credentials, and reopens onboarding.")
        }
        .alert(
            "QR Scanner Unavailable",
            isPresented: Binding(
                get: { self.scannerError != nil },
                set: { if !$0 { self.scannerError = nil } }))
        {
            Button("OK", role: .cancel) {}
        } message: {
            Text(self.scannerError ?? "")
        }
    }
}

extension SettingsProTab {
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
                icon: "waveform",
                title: "Voice & Talk",
                detail: self.voiceDetail,
                route: .voice)
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
                    case .voice:
                        self.voiceDestination
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
            if let gatewayProblem = self.appModel.lastGatewayProblem {
                self.gatewayProblemCard(gatewayProblem)
            }

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

            self.deviceIdentityCard
            self.agentSelectionCard
            self.gatewaySetupCard
            self.discoveredGatewaysCard
            self.manualGatewayCard
            self.gatewayAdvancedCard
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

            self.privacyAccessCard
        }
    }

    private var voiceDestination: some View {
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

            self.diagnosticsAdvancedCard
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

            self.privacyAccessCard
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

    private var agentSelectionCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 10) {
                Text("Active Agent")
                    .font(.subheadline.weight(.semibold))
                Picker("Agent", selection: self.$selectedAgentPickerId) {
                    Text("Default").tag("")
                    let defaultId = (self.appModel.gatewayDefaultAgentId ?? "")
                        .trimmingCharacters(in: .whitespacesAndNewlines)
                    ForEach(self.appModel.gatewayAgents.filter { $0.id != defaultId }, id: \.id) { agent in
                        let name = (agent.name ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
                        Text(name.isEmpty ? agent.id : name).tag(agent.id)
                    }
                }
                Text("Controls which agent Chat and Talk use.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var gatewaySetupCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Setup Code")
                    .font(.subheadline.weight(.semibold))
                TextField("Paste setup code", text: self.$setupCode)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
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
                    .disabled(self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                }
                if let status = self.setupStatusLine {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
                if let warning = self.tailnetWarningText {
                    Text(warning)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var discoveredGatewaysCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Text("Discovered Gateways")
                    .font(.subheadline.weight(.semibold))
                if self.gatewayController.gateways.isEmpty {
                    Text("No gateways found yet. Use manual setup if Bonjour is blocked.")
                        .font(.caption)
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

    private func discoveredGatewayRow(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: gateway.name)
                    .font(.subheadline.weight(.semibold))
                Text(verbatim: self.gatewayDetailLines(gateway).joined(separator: " • "))
                    .font(.caption)
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
                }
            }
            .buttonStyle(.bordered)
            .disabled(self.connectingGatewayID != nil)
        }
    }

    private var manualGatewayCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Use Manual Gateway", isOn: self.$manualGatewayEnabled)
                TextField("Host", text: self.$manualGatewayHost)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                TextField("Port", text: self.manualPortBinding)
                    .keyboardType(.numberPad)
                    .textFieldStyle(.roundedBorder)
                Toggle("Use TLS", isOn: self.$manualGatewayTLS)
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

    private var gatewayAdvancedCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Auto-connect on launch", isOn: self.$gatewayAutoConnect)
                Toggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled)
                    .onChange(of: self.discoveryDebugLogsEnabled) { _, enabled in
                        self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
                    }
                SecureField("Gateway Auth Token", text: self.$gatewayToken)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .textFieldStyle(.roundedBorder)
                SecureField("Gateway Password", text: self.$gatewayPassword)
                    .textFieldStyle(.roundedBorder)
                Button("Reset Onboarding", role: .destructive) {
                    self.showResetOnboardingAlert = true
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var voiceFeatureCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                self.settingsToggle("Voice Wake", isOn: self.$voiceWakeEnabled) { enabled in
                    self.appModel.setVoiceWakeEnabled(enabled)
                }
                self.settingsToggle("Talk Mode", isOn: self.$talkEnabled) { enabled in
                    self.appModel.setTalkEnabled(enabled)
                }
                Picker("Speech Language", selection: self.$talkSpeechLocale) {
                    ForEach(TalkSpeechLocale.supportedOptions()) { option in
                        Text(option.label).tag(option.id)
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

    private var talkVoiceSettingsCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Picker("Provider", selection: self.talkProviderSelectionBinding) {
                    ForEach(TalkModeProviderSelection.allCases) { option in
                        Text(option.label).tag(option.rawValue)
                    }
                }
                if self.shouldShowRealtimeVoicePicker {
                    Picker("Realtime Voice", selection: self.talkRealtimeVoiceSelectionBinding) {
                        Text("Gateway Default").tag("")
                        ForEach(TalkModeRealtimeVoiceSelection.voices, id: \.self) { voice in
                            Text(TalkModeRealtimeVoiceSelection.label(for: voice)).tag(voice)
                        }
                    }
                }
                self.detailRow("Voice Mode", value: self.appModel.talkMode.gatewayTalkVoiceModeTitle)
                Divider()
                self.detailRow("Transport", value: self.appModel.talkMode.gatewayTalkTransportLabel)
                Divider()
                self.detailRow("API Key", value: self.talkApiKeyStatus)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var shareSettingsCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Show Talk Control", isOn: self.$talkButtonEnabled)
                TextField("Default Share Instruction", text: self.$defaultShareInstruction, axis: .vertical)
                    .lineLimit(2...5)
                    .textInputAutocapitalization(.sentences)
                    .textFieldStyle(.roundedBorder)
                Button {
                    Task { await self.appModel.runSharePipelineSelfTest() }
                } label: {
                    Label("Run Share Self-Test", systemImage: "checkmark.seal")
                }
                .buttonStyle(.bordered)
                Text(self.appModel.lastShareEventText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var privacyAccessCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            PrivacyAccessSectionView()
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var diagnosticsAdvancedCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                Toggle("Discovery Debug Logs", isOn: self.$discoveryDebugLogsEnabled)
                    .onChange(of: self.discoveryDebugLogsEnabled) { _, enabled in
                        self.gatewayController.setDiscoveryDebugLoggingEnabled(enabled)
                    }
                Toggle("Debug Canvas Status", isOn: self.$canvasDebugStatusEnabled)
                NavigationLink {
                    GatewayDiscoveryDebugLogView()
                } label: {
                    self.simpleSettingsRow(title: "Discovery Logs", value: self.gatewayController.discoveryStatusText)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var deviceIdentityCard: some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            VStack(alignment: .leading, spacing: 12) {
                TextField("Device Name", text: self.$displayName)
                    .textFieldStyle(.roundedBorder)
                self.detailRow("Instance ID", value: self.instanceId)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func gatewayProblemCard(_ problem: GatewayConnectionProblem) -> some View {
        ProCard(radius: SettingsLayout.cardRadius) {
            GatewayProblemBanner(
                problem: problem,
                primaryActionTitle: self.gatewayProblemPrimaryActionTitle(problem),
                onPrimaryAction: {
                    Task { await self.handleGatewayProblemPrimaryAction(problem) }
                },
                onShowDetails: {
                    self.showGatewayProblemDetails = true
                })
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func settingsToggle(
        _ title: String,
        isOn: Binding<Bool>,
        onChange: ((Bool) -> Void)? = nil) -> some View
    {
        Toggle(title, isOn: isOn)
            .onChange(of: isOn.wrappedValue) { _, enabled in
                onChange?(enabled)
            }
    }

    private func simpleSettingsRow(title: String, value: String) -> some View {
        HStack {
            Text(title)
            Spacer(minLength: 8)
            Text(value)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
            Image(systemName: "chevron.right")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .font(.subheadline)
    }
}

extension SettingsProTab {
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

    private func syncSettingsState() {
        self.manualGatewayPortText = self.manualGatewayPort > 0 ? String(self.manualGatewayPort) : ""
        self.selectedAgentPickerId = self.appModel.selectedAgentId ?? ""
        self.defaultShareInstruction = ShareToAgentSettings.loadDefaultInstruction()
        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInstanceId.isEmpty else { return }
        self.gatewayToken = GatewaySettingsStore.loadGatewayToken(instanceId: trimmedInstanceId) ?? ""
        self.gatewayPassword = GatewaySettingsStore.loadGatewayPassword(instanceId: trimmedInstanceId) ?? ""
    }

    private func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        self.connectingGatewayID = gateway.id
        defer { self.connectingGatewayID = nil }
        self.manualGatewayEnabled = false
        GatewaySettingsStore.savePreferredGatewayStableID(gateway.stableID)
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(gateway.stableID)
        if let err = await self.gatewayController.connectWithDiagnostics(gateway) {
            self.setupStatusText = err
        }
    }

    private func applySetupCodeAndConnect() async {
        self.setupStatusText = nil
        guard self.applySetupCode() else { return }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = self.resolvedManualPort(host: host) else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        guard await self.preflightGateway(host: host, port: port, useTLS: self.manualGatewayTLS) else { return }
        self.setupStatusText = "Setup code applied. Connecting..."
        await self.connectManual()
    }

    @discardableResult
    private func applySetupCode() -> Bool {
        let raw = self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !raw.isEmpty else {
            self.setupStatusText = "Paste a setup code to continue."
            return false
        }
        guard let link = GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupStatusText = "Setup code not recognized or uses an insecure ws:// gateway URL."
            return false
        }
        self.applyGatewayLink(link)
        return true
    }

    private func applyGatewayLink(_ link: GatewayConnectDeepLink) {
        self.manualGatewayHost = link.host
        self.manualGatewayPort = link.port
        self.manualGatewayPortText = String(link.port)
        self.manualGatewayTLS = link.tls
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        if setupAuth.hasBootstrapToken {
            GatewayOnboardingReset.prepareForBootstrapPairing(appModel: self.appModel, instanceId: instanceId)
        }
        if !instanceId.isEmpty {
            GatewaySettingsStore.saveGatewayBootstrapToken(setupAuth.bootstrapToken, instanceId: instanceId)
        }
        if setupAuth.shouldApplyTokenField {
            self.gatewayToken = setupAuth.token
            if !instanceId.isEmpty {
                GatewaySettingsStore.saveGatewayToken(setupAuth.token, instanceId: instanceId)
            }
        }
        if setupAuth.shouldApplyPasswordField {
            self.gatewayPassword = setupAuth.password
            if !instanceId.isEmpty {
                GatewaySettingsStore.saveGatewayPassword(setupAuth.password, instanceId: instanceId)
            }
        }
        self.pendingManualAuthOverride = setupAuth.manualAuthOverride
    }

    private func openGatewayQRScanner() {
        self.appModel.disconnectGateway()
        self.connectingGatewayID = nil
        self.setupStatusText = "Opening QR scanner..."
        self.showQRScanner = true
    }

    private func handleScannedGatewayLink(_ link: GatewayConnectDeepLink) {
        self.showQRScanner = false
        self.setupCode = ""
        self.applyGatewayLink(link)
        self.setupStatusText = "QR loaded. Connecting to \(link.host):\(link.port)..."
        Task { await self.connectAfterScannedGatewayLink() }
    }

    private func connectAfterScannedGatewayLink() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let port = self.resolvedManualPort(host: host) else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        guard await self.preflightGateway(host: host, port: port, useTLS: self.manualGatewayTLS) else { return }
        await self.connectManual()
    }

    private func connectManual() async {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.setupStatusText = "Failed: host required"
            return
        }
        guard self.manualPortIsValid else {
            self.setupStatusText = "Failed: invalid port"
            return
        }
        self.connectingGatewayID = "manual"
        self.manualGatewayEnabled = true
        defer { self.connectingGatewayID = nil }
        let authOverride = GatewayConnectionController.ManualAuthOverride.currentManualInput(
            token: self.gatewayToken,
            pendingOverride: self.pendingManualAuthOverride,
            password: self.gatewayPassword)
        self.pendingManualAuthOverride = nil
        await self.gatewayController.connectManual(
            host: host,
            port: self.manualGatewayPort,
            useTLS: self.manualGatewayTLS,
            authOverride: authOverride)
    }

    private func preflightGateway(host: String, port: Int, useTLS: Bool) async -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if Self.isTailnetHostOrIP(trimmed), !Self.hasTailnetIPv4() {
            self.setupStatusText = "Tailscale is off on this iPhone. Turn it on, then try again."
            return false
        }
        self.setupStatusText = "Checking gateway reachability..."
        let ok = await TCPProbe.probe(host: trimmed, port: port, timeoutSeconds: 3, queueLabel: "gateway.preflight")
        if !ok {
            self.setupStatusText = "Can't reach gateway at \(trimmed):\(port). Check Tailscale or LAN."
        }
        return ok
    }

    private func resetOnboarding() {
        self.connectingGatewayID = nil
        self.setupStatusText = nil
        self.setupCode = ""
        self.gatewayAutoConnect = false
        self.suppressCredentialPersist = true
        defer { self.suppressCredentialPersist = false }
        self.gatewayToken = ""
        self.gatewayPassword = ""
        GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: self.instanceId)
        self.onboardingComplete = false
        self.hasConnectedOnce = false
        self.manualGatewayEnabled = false
        self.manualGatewayHost = ""
        self.onboardingRequestID += 1
    }

    private func retryGatewayConnectionFromProblem() async {
        if self.manualGatewayEnabled || self.connectingGatewayID == "manual" {
            await self.connectManual()
        } else {
            await self.gatewayController.connectLastKnown()
        }
    }

    private func gatewayProblemPrimaryActionTitle(_ problem: GatewayConnectionProblem) -> String {
        if problem.suggestsOnboardingReset { return "Reset onboarding" }
        return problem.canTrustRotatedCertificate ? "Trust certificate" : "Retry connection"
    }

    private func handleGatewayProblemPrimaryAction(_ problem: GatewayConnectionProblem) async {
        if problem.suggestsOnboardingReset {
            self.resetOnboarding()
            return
        }
        if problem.canTrustRotatedCertificate {
            _ = await self.gatewayController.trustRotatedGatewayCertificate(from: problem)
            return
        }
        await self.retryGatewayConnectionFromProblem()
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

    private func persistGatewayToken(_ value: String) {
        guard !self.suppressCredentialPersist else { return }
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceId.isEmpty else { return }
        GatewaySettingsStore.saveGatewayToken(
            value.trimmingCharacters(in: .whitespacesAndNewlines),
            instanceId: instanceId)
    }

    private func persistGatewayPassword(_ value: String) {
        guard !self.suppressCredentialPersist else { return }
        let instanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !instanceId.isEmpty else { return }
        GatewaySettingsStore.saveGatewayPassword(
            value.trimmingCharacters(in: .whitespacesAndNewlines),
            instanceId: instanceId)
    }

    private func openSystemSettings() {
        guard let url = URL(string: UIApplication.openSettingsURLString) else { return }
        UIApplication.shared.open(url)
    }

    private func title(for route: SettingsRoute) -> String {
        switch route {
        case .gateway: "Gateway"
        case .permissions: "Permissions"
        case .voice: "Voice & Talk"
        case .diagnostics: "Diagnostics"
        case .privacy: "Privacy"
        case .notifications: "Notifications"
        case .about: "About"
        }
    }

    private var manualPortBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayPortText },
            set: { newValue in
                let filtered = newValue.filter(\.isNumber)
                self.manualGatewayPortText = filtered
                self.manualGatewayPort = Int(filtered) ?? 0
            })
    }

    private var manualPortIsValid: Bool {
        if self.manualGatewayPortText.isEmpty { return true }
        return self.manualGatewayPort >= 1 && self.manualGatewayPort <= 65535
    }

    private func resolvedManualPort(host: String) -> Int? {
        if self.manualGatewayPort > 0 {
            return self.manualGatewayPort <= 65535 ? self.manualGatewayPort : nil
        }
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if self.manualGatewayTLS, trimmed.lowercased().hasSuffix(".ts.net") {
            return 443
        }
        return 18789
    }

    private var setupStatusLine: String? {
        if let problem = self.appModel.lastGatewayProblem {
            return problem.message
        }
        let trimmedSetup = self.setupStatusText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let gatewayStatus = self.appModel.gatewayStatusText.trimmingCharacters(in: .whitespacesAndNewlines)
        if let friendly = self.friendlyGatewayMessage(from: gatewayStatus) { return friendly }
        if let friendly = self.friendlyGatewayMessage(from: trimmedSetup) { return friendly }
        if !trimmedSetup.isEmpty { return trimmedSetup }
        if gatewayStatus.isEmpty || gatewayStatus == "Offline" { return nil }
        return gatewayStatus
    }

    private var tailnetWarningText: String? {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, Self.isTailnetHostOrIP(host), !Self.hasTailnetIPv4() else { return nil }
        return "This gateway is on your tailnet. Turn on Tailscale on this iPhone, then tap Connect."
    }

    private func friendlyGatewayMessage(from raw: String) -> String? {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.contains("pairing required") {
            return "Pairing required. Run /pair approve in your OpenClaw chat, then connect again."
        }
        if lower.contains("device nonce required") || lower.contains("device nonce mismatch") {
            return "Secure handshake failed. Check Tailscale, then connect again."
        }
        if lower.contains("timed out") {
            return "Connection timed out. Make sure Tailscale is connected, then try again."
        }
        if lower.contains("unauthorized role") {
            return "Connected, but some controls are restricted for nodes. This is expected."
        }
        return nil
    }

    private var shouldShowRealtimeVoicePicker: Bool {
        let providerSelection = TalkModeProviderSelection.resolved(self.talkProviderSelectionRaw)
        return providerSelection == .openAIRealtime || self.appModel.talkMode.gatewayTalkUsesRealtime
    }

    private var talkProviderSelectionBinding: Binding<String> {
        Binding(
            get: { self.talkProviderSelectionRaw },
            set: { newValue in
                let selection = TalkModeProviderSelection.resolved(newValue)
                self.talkProviderSelectionRaw = selection.rawValue
                self.appModel.setTalkProviderSelection(selection.rawValue)
            })
    }

    private var talkRealtimeVoiceSelectionBinding: Binding<String> {
        Binding(
            get: { self.talkRealtimeVoiceSelectionRaw },
            set: { newValue in
                let voice = TalkModeRealtimeVoiceSelection.resolvedOverride(newValue) ?? ""
                self.talkRealtimeVoiceSelectionRaw = voice
                self.appModel.setTalkRealtimeVoiceSelection(voice)
            })
    }

    private var talkSpeakerphoneBinding: Binding<Bool> {
        Binding(
            get: { self.talkSpeakerphoneEnabled },
            set: { newValue in
                self.talkSpeakerphoneEnabled = newValue
                self.appModel.setTalkSpeakerphoneEnabled(newValue)
            })
    }

    private var talkApiKeyStatus: String {
        guard self.appModel.talkMode.gatewayTalkConfigLoaded else { return "Not loaded" }
        return self.appModel.talkMode.gatewayTalkApiKeyConfigured ? "Configured" : "Not configured"
    }

    private func gatewayDetailLines(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> [String] {
        var lines: [String] = []
        if let lanHost = gateway.lanHost { lines.append("LAN: \(lanHost)") }
        if let tailnet = gateway.tailnetDns { lines.append("Tailnet: \(tailnet)") }
        let gw = gateway.gatewayPort.map(String.init)
        let canvas = gateway.canvasPort.map(String.init)
        if gw != nil || canvas != nil {
            lines.append("Ports: gateway \(gw ?? "-") / canvas \(canvas ?? "-")")
        }
        return lines.isEmpty ? [gateway.debugID] : lines
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

    private var voiceDetail: String {
        if self.talkEnabled, self.voiceWakeEnabled { return "Talk + Wake" }
        if self.talkEnabled { return "Talk on" }
        if self.voiceWakeEnabled { return "Wake on" }
        return "Off"
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
