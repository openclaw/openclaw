import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct GatewaySetupRequest {
    let id: Int
    let link: GatewayConnectDeepLink
}

enum GatewayConnectionAttempt: Equatable {
    case gateway(GatewayStableIdentifier.Key)
    case manual
    case setupCode
}

struct SettingsProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(GatewayConnectionController.self) var gatewayController
    @Environment(\.scenePhase) var scenePhase
    @AppStorage("node.displayName") var displayName: String = "iOS Node"
    @AppStorage("node.instanceId") var instanceId: String = UUID().uuidString
    @AppStorage(VoiceWakePreferences.enabledKey) var voiceWakeEnabled: Bool = false
    @AppStorage("gateway.autoconnect") var gatewayAutoConnect: Bool = false
    @AppStorage("gateway.manual.enabled") var manualGatewayEnabled: Bool = false
    @AppStorage("gateway.manual.host") var manualGatewayHost: String = ""
    @AppStorage("gateway.manual.port") var manualGatewayPort: Int = 18789
    @AppStorage("gateway.manual.tls") var manualGatewayTLS: Bool = true
    @AppStorage("gateway.discovery.debugLogs") var discoveryDebugLogsEnabled: Bool = false
    // A setup code carries Gateway credentials; keep it in memory only, as onboarding does.
    @State var setupCode = ""
    @AppStorage("gateway.onboardingComplete") var onboardingComplete: Bool = false
    @AppStorage("gateway.hasConnectedOnce") var hasConnectedOnce: Bool = false
    @AppStorage("onboarding.requestID") var onboardingRequestID: Int = 0
    @AppStorage(NotificationServingPreference.storageKey) var notificationServingEnabled: Bool =
        NotificationServingPreference.defaultEnabled
    @State var isReconnectingGateway = false
    @State var isRefreshingGateway = false
    @State var connectingGateway: GatewayConnectionAttempt?
    @State var gatewayRegistry = GatewaySettingsStore.GatewayRegistry.empty
    @State var pendingForgetGateway: GatewaySettingsStore.GatewayRegistryEntry?
    @State var gatewayAuthFields = GatewayConnectionController.ManualAuthOverride.Fields()
    @State var manualGatewayPortText = ""
    @State var manualGatewayContextPath: String?
    @State var setupStatusText: String?
    @State var gatewayActionStatusText: String?
    @State var setupAttemptID: GatewaySetupAttempt?
    @State var manualConnectGeneration: UInt64 = 0
    @State var stagedGatewaySetupLink: GatewayConnectDeepLink?
    @State var scannerResultHandoff = QRScannerResultHandoff()
    @State var scannerScanID: UInt64 = 0
    @State var pendingTargetSuppression = GatewayPendingTargetSuppression()
    @State var showQRScanner = false
    @State var pairUsingCode = false
    @State var scannerError: String?
    @State var showResetOnboardingAlert = false
    @State var suppressCredentialPersist = false
    @State var watchDirectSetupStatusText: String?
    @State var isSendingWatchDirectSetup = false
    @State var notificationStatus: SettingsNotificationStatus = .checking
    @State var diagnosticsLastRunText: String?
    @State var diagnosticsIssueCount: Int?
    let directRoute: SettingsRoute?
    let registersNavigationDestinations: Bool
    let acceptsGatewaySetupRequests: Bool
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let onRouteChange: ((SettingsRoute?) -> Void)?
    let onApprovalNotificationsRoute: ((String?) -> Void)?
    let gatewaySetupRequest: GatewaySetupRequest?
    let onGatewaySetupRequestHandled: ((Int) -> Void)?

    init(
        directRoute: SettingsRoute? = nil,
        registersNavigationDestinations: Bool = true,
        acceptsGatewaySetupRequests: Bool = false,
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        onRouteChange: ((SettingsRoute?) -> Void)? = nil,
        onApprovalNotificationsRoute: ((String?) -> Void)? = nil,
        gatewaySetupRequest: GatewaySetupRequest? = nil,
        onGatewaySetupRequestHandled: ((Int) -> Void)? = nil)
    {
        self.directRoute = directRoute
        self.registersNavigationDestinations = registersNavigationDestinations
        self.acceptsGatewaySetupRequests = acceptsGatewaySetupRequests
        self.headerSidebarAction = headerSidebarAction
        self.onRouteChange = onRouteChange
        self.onApprovalNotificationsRoute = onApprovalNotificationsRoute
        self.gatewaySetupRequest = gatewaySetupRequest
        self.onGatewaySetupRequestHandled = onGatewaySetupRequestHandled
    }

    var body: some View {
        self.settingsModalPresentation(
            self.settingsLifecycle(
                self.settingsContent))
    }

    @ViewBuilder private var settingsContent: some View {
        if self.registersNavigationDestinations {
            self.settingsRootContent
                .navigationDestination(for: SettingsRoute.self) { route in
                    self.destination(for: route)
                }
        } else {
            self.settingsRootContent
        }
    }

    @ViewBuilder
    private var settingsRootContent: some View {
        if let directRoute {
            self.destination(for: directRoute)
        } else {
            self.settingsNavigationContent
        }
    }

    private var settingsNavigationContent: some View {
        List {
            self.offlineDeviceSection
            self.gatewayDestination
        }
        .accessibilityIdentifier("SettingsHub.Fallback")
        .font(OpenClawType.body)
        .navigationTitle("Settings")
        .toolbar {
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(
                    action: headerSidebarAction,
                    placement: .topBarLeading)
            }
        }
    }

    private func settingsLifecycle(_ content: some View) -> some View {
        content
            .onDisappear {
                self.invalidateGatewaySetupAttempt()
            }
            .task {
                self.syncSettingsState()
                self.refreshNotificationSettings()
                self.applyGatewaySetupRequestIfNeeded()
                self.onRouteChange?(self.directRoute)
            }
            .onDisappear {
                self.scannerResultHandoff.cancel()
                self.pendingTargetSuppression.resumeAutoConnect(controller: self.gatewayController)
            }
            .onChange(of: self.gatewaySetupRequest?.id) { _, _ in
                self.applyGatewaySetupRequestIfNeeded()
            }
            .onChange(of: self.scenePhase) { _, phase in
                if phase == .active {
                    self.syncSettingsState()
                    self.refreshNotificationSettings()
                }
            }
            .onReceive(NotificationCenter.default.publisher(for: GatewaySettingsStore.gatewayRegistryDidChange)
                .receive(on: DispatchQueue.main)) { _ in self.refreshGatewayRegistry() }
            .onChange(of: self.appModel.isLocalGatewayFixtureEnabled) { _, _ in
                // Leaving a fixture must reload the saved registry and credentials before they are editable.
                self.syncSettingsState()
            }
            .onChange(of: self.setupCode) { _, newValue in
                if !newValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
                    self.clearStagedGatewaySetupLink()
                }
            }
            .onChange(of: self.acceptsGatewaySetupRequests) { _, acceptsRequests in
                guard acceptsRequests else { return }
                self.applyGatewaySetupRequestIfNeeded()
            }
            .onChange(of: self.onboardingRequestID) { _, _ in
                // Root-owned resets leave Settings mounted behind onboarding.
                // Reload cleared credentials before the view can persist stale state.
                self.syncAfterOnboardingReset()
            }
    }

    private func gatewayPairingSheet(scanID: UInt64) -> some View {
        NavigationStack {
            Group {
                if self.pairUsingCode {
                    Form {
                        SecureField(text: self.$setupCode) {
                            Text("Setup code").font(OpenClawType.body)
                        }
                        .font(OpenClawType.body)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .accessibilityLabel("Setup code")
                        .accessibilityIdentifier("SettingsHub.SetupCode")
                        .disabled(self.connectingGateway != nil)
                        Button {
                            Task { await self.applySetupCodeAndConnect() }
                        } label: {
                            Text("Connect").font(OpenClawType.subheadSemiBold)
                        }
                        .disabled(!self.canApplyGatewaySetup || self.connectingGateway != nil)
                        if let status = self.setupStatusLine, self.setupStatusText != nil {
                            Text(status)
                                .font(OpenClawType.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                } else {
                    QRScannerView(
                        onResult: { self.queueScannedResult($0, scanID: scanID) },
                        onError: { _ in
                            guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                            self.showPairingCode()
                        },
                        onDismiss: {
                            guard self.scannerResultHandoff.isActive(scanID: scanID) else { return }
                            self.showQRScanner = false
                        })
                        .ignoresSafeArea()
                        .safeAreaInset(edge: .bottom) {
                            Button {
                                self.showPairingCode()
                            } label: {
                                Text("Paste setup code")
                                    .font(OpenClawType.subheadSemiBold)
                            }
                            .buttonStyle(.bordered)
                            .padding()
                        }
                }
            }
            .navigationTitle("Pair Gateway")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                OpenClawSheetCloseItem {
                    self.scannerResultHandoff.cancel()
                    self.showQRScanner = false
                    self.setupCode = ""
                }
            }
        }
        .openClawSheetHeaderEdge()
        .tint(.primary)
    }

    private func showPairingCode() {
        self.scannerResultHandoff.cancel()
        self.setupStatusText = nil
        self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        self.pairUsingCode = true
    }

    private func settingsModalPresentation(_ content: some View) -> some View {
        let scanID = self.scannerScanID
        return content
            .sheet(
                isPresented: self.$showQRScanner,
                onDismiss: {
                    self.processQueuedScannerResult()
                    if self.pairUsingCode {
                        self.setupCode = ""
                        self.pairUsingCode = false
                    }
                },
                content: {
                    self.gatewayPairingSheet(scanID: scanID)
                })
            .alert("Reset Onboarding?", isPresented: self.$showResetOnboardingAlert) {
                Button(role: .destructive) {
                    Task { await self.resetOnboarding() }
                } label: {
                    Text("Reset")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {} label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: {
                Text("This disconnects, clears saved Gateway credentials, and restarts onboarding.")
                    .font(OpenClawType.subhead)
            }
            .alert(
                "QR Scanner Unavailable",
                isPresented: Binding(
                    get: { self.scannerError != nil },
                    set: {
                        if !$0 {
                            self.scannerError = nil
                        }
                    })) {
                Button(role: .cancel) {} label: {
                    Text("OK")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: {
                Text(self.scannerError ?? "")
                    .font(OpenClawType.subhead)
            }
            .confirmationDialog(
                String(
                    format: String(localized: "Forget %@?"),
                    self.pendingForgetGateway?.name ?? String(localized: "gateway")),
                isPresented: Binding(
                    get: { self.pendingForgetGateway != nil },
                    set: {
                        if !$0 {
                            self.pendingForgetGateway = nil
                        }
                    }),
                titleVisibility: .visible,
                // The action only schedules Task; dismissal clears state before that task resumes.
                presenting: self.pendingForgetGateway)
            { entry in
                Button(role: .destructive) {
                    Task { await self.forgetGateway(entry) }
                } label: {
                    Text("Forget Gateway")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {
                    self.pendingForgetGateway = nil
                } label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: { _ in
                // Keep the extraction key contiguous for the native localization inventory.
                Text(
                    String(
                        localized:
                        "This removes saved credentials, device access, TLS trust, and cached chats for this gateway."))
                    .font(OpenClawType.subhead)
            }
    }

    private func applyGatewaySetupRequestIfNeeded() {
        guard self.acceptsGatewaySetupRequests else { return }
        guard let gatewaySetupRequest else { return }
        self.applyGatewaySetupLink(gatewaySetupRequest.link)
        self.onGatewaySetupRequestHandled?(gatewaySetupRequest.id)
    }

    func openNotificationsRouteFromApprovals() {
        let approvalID = ExecApprovalIdentifier.exact(self.appModel.pendingExecApprovalPrompt?.id)
        self.onApprovalNotificationsRoute?(approvalID)
    }
}
