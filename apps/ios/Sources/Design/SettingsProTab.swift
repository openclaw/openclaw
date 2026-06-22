import OpenClawKit
import SwiftUI

struct SettingsProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(VoiceWakeManager.self) var voiceWake
    @Environment(GatewayConnectionController.self) var gatewayController
    @Environment(\.scenePhase) var scenePhase
    @AppStorage(AppAppearancePreference.storageKey) var appearancePreferenceRaw: String =
        AppAppearancePreference.system.rawValue
    @AppStorage("node.displayName") var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") var instanceId: String = UUID().uuidString
    @AppStorage("camera.enabled") var cameraEnabled: Bool = true
    @AppStorage("location.enabledMode") var locationModeRaw: String = OpenClawLocationMode.off.rawValue
    @AppStorage("screen.preventSleep") var preventSleep: Bool = true
    @AppStorage("talk.enabled") var talkEnabled: Bool = false
    @AppStorage(TalkModeProviderSelection.storageKey) var talkProviderSelectionRaw: String =
        TalkModeProviderSelection.gatewayDefault.rawValue
    @AppStorage(TalkModeRealtimeVoiceSelection.storageKey) var talkRealtimeVoiceSelectionRaw: String = ""
    @AppStorage(TalkSpeechLocale.storageKey) var talkSpeechLocale: String = TalkSpeechLocale.automaticID
    @AppStorage("talk.button.enabled") var talkButtonEnabled: Bool = true
    @AppStorage("talk.background.enabled") var talkBackgroundEnabled: Bool = false
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage(VoiceWakePreferences.enabledKey) var voiceWakeEnabled: Bool = false
    @AppStorage("gateway.autoconnect") var gatewayAutoConnect: Bool = false
    @AppStorage("gateway.manual.enabled") var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") var manualGatewayHost: String = ""
    @AppStorage("gateway.manual.port") var manualGatewayPort: Int = 18789
    @AppStorage("gateway.manual.tls") var manualGatewayTLS: Bool = true
    @AppStorage("gateway.discovery.debugLogs") var discoveryDebugLogsEnabled: Bool = false
    @AppStorage("canvas.debugStatusEnabled") var canvasDebugStatusEnabled: Bool = false
    @AppStorage("gateway.setupCode") var setupCode: String = ""
    @AppStorage("gateway.onboardingComplete") var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") var hasConnectedOnce: Bool = false
    @AppStorage("onboarding.requestID") var onboardingRequestID: Int = 0
    @State var isReconnectingGateway = false
    @State var isRefreshingGateway = false
    @State var isChangingLocationMode = false
    @State var connectingGatewayID: String?
    @State var selectedAgentPickerId = ""
    @State var gatewayToken = ""
    @State var gatewayPassword = ""
    @State var manualGatewayPortText = ""
    @State var setupStatusText: String?
    @State var stagedGatewaySetupLink: GatewayConnectDeepLink?
    @State var pendingManualAuthOverride: GatewayConnectionController.ManualAuthOverride?
    @State var defaultShareInstruction = ""
    @State var showGatewayProblemDetails = false
    @State var showQRScanner = false
    @State var scannerError: String?
    @State var showResetOnboardingAlert = false
    @State var suppressCredentialPersist = false
    @State var locationStatusText: String?
    @State var previousLocationModeRaw: String = OpenClawLocationMode.off.rawValue
    @State var notificationStatus: SettingsNotificationStatus = .checking
    @State var isRequestingNotificationAuthorization = false
    @State var showNotificationRelayDisclosure = false
    @State var diagnosticsLastRunText = "Not run"
    @State var diagnosticsIssueCount: Int?
    @State var showTalkIssueDetails = false
    @State private var navigationPath: [SettingsRoute] = []
    let initialRoute: SettingsRoute?
    let directRoute: SettingsRoute?
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let onRouteChange: ((SettingsRoute?) -> Void)?

    init(
        initialRoute: SettingsRoute? = nil,
        directRoute: SettingsRoute? = nil,
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        onRouteChange: ((SettingsRoute?) -> Void)? = nil)
    {
        self.initialRoute = initialRoute
        self.directRoute = directRoute
        self.headerLeadingAction = headerLeadingAction
        self.onRouteChange = onRouteChange
    }

    var body: some View {
        self.settingsModalPresentation(
            self.settingsLifecycle(
                self.settingsContent))
    }

    @ViewBuilder
    private var settingsContent: some View {
        if let directRoute {
            self.destination(for: directRoute)
        } else {
            self.settingsNavigationStack
        }
    }

    private var settingsNavigationStack: some View {
        NavigationStack(path: self.$navigationPath) {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        self.settingsHeader
                        self.appearanceSection
                        self.gatewaySection
                        self.settingsListSection
                    }
                    .padding(.top, 18)
                    .padding(.bottom, 18)
                }
            }
            .navigationBarHidden(true)
            .navigationDestination(for: SettingsRoute.self) { route in
                self.destination(for: route)
            }
        }
    }

    private func settingsLifecycle(_ content: some View) -> some View {
        content
            .task {
                self.previousLocationModeRaw = self.locationModeRaw
                self.syncSettingsState()
                self.refreshNotificationSettings()
                self.applyPendingGatewaySetupLinkIfNeeded()
                self.applyInitialRouteIfNeeded()
                self.notifyRouteChange()
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
            .onChange(of: self.setupCode) { _, newValue in
                if !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    self.stagedGatewaySetupLink = nil
                }
            }
            .onChange(of: self.defaultShareInstruction) { _, newValue in
                ShareToAgentSettings.saveDefaultInstruction(newValue)
            }
            .onChange(of: self.appModel.gatewaySetupRequestID) { _, _ in
                self.applyPendingGatewaySetupLinkIfNeeded()
            }
            .onChange(of: self.navigationPath) { _, _ in
                self.notifyRouteChange()
            }
    }

    private func settingsModalPresentation(_ content: some View) -> some View {
        content
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
            .sheet(isPresented: self.$showTalkIssueDetails) {
                if let issue = self.appModel.talkMode.gatewayTalkCurrentFallbackIssue {
                    TalkRuntimeIssueDetailsSheet(issue: issue)
                }
            }
            .sheet(isPresented: self.$showQRScanner) {
                NavigationStack {
                    QRScannerView(
                        onGatewayLink: { link in
                            self.handleScannedGatewayLink(link)
                        },
                        onSetupCode: { code in
                            self.handleScannedSetupCode(code)
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
            .alert("OpenClaw Hosted Push Relay", isPresented: self.$showNotificationRelayDisclosure) {
                    Button("Continue") {
                        self.requestNotificationAuthorizationFromSettings()
                    }
                    Button("Not Now", role: .cancel) {}
                } message: {
                    Text(self.notificationRelayDisclosureMessage)
                }
    }

    func openNotificationsRouteFromApprovals() {
        guard self.directRoute == nil else { return }
        self.navigationPath = [.notifications]
    }

    private func applyInitialRouteIfNeeded() {
        guard self.directRoute == nil else { return }
        guard let initialRoute else { return }
        guard self.navigationPath != [initialRoute] else { return }
        self.navigationPath = [initialRoute]
    }

    private func notifyRouteChange() {
        if let directRoute {
            self.onRouteChange?(directRoute)
            return
        }
        self.onRouteChange?(self.navigationPath.last)
    }
}
