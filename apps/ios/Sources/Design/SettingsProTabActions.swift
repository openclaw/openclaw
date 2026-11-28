import OpenClawKit
import SwiftUI
import UserNotifications

extension SettingsProTab {
    /// A status row (label, description, current value) heading a detail page.
    func detailStatusCard(
        title: OpenClawTextValue,
        detail: OpenClawTextValue,
        value: OpenClawTextValue,
        header: LocalizedStringKey) -> some View
    {
        Section {
            SettingsDescriptionRow(title, description: detail, value: value)
        } header: {
            SettingsSectionTitle(header)
        }
    }

    var diagnosticChecksCard: some View {
        Section {
            let run = self.diagnosticsRunPresentation
            if let lastRun = self.diagnosticsLastRunText {
                SettingsDescriptionRow("Last run", description: .verbatim(lastRun), value: .verbatim(run))
            } else {
                SettingsDetailRow("Last run", value: .verbatim(run))
            }
            let gateway = self.gatewayStatusPresentation
            SettingsDescriptionRow(
                "Connection",
                description: .verbatim(gateway.detail),
                value: .verbatim(gateway.value))
            SettingsDescriptionRow(
                "Discovery",
                description: .verbatim(self.gatewayController.discoveryStatusText),
                value: .verbatim(self.gatewayController.gateways.count.formatted()))
            let talkConfig = self.gatewayTalkConfigPresentation
            SettingsDescriptionRow(
                "Talk config",
                description: .verbatim(talkConfig.detail),
                value: .verbatim(talkConfig.value))
            SettingsDescriptionRow(
                "Notifications",
                description: "Approval and event alerts",
                value: .verbatim(self.notificationPresentation.text))
            SettingsDescriptionRow(
                "Screen capture",
                description: "Screen recording while the app is open",
                value: .verbatim(self.appModel.screenRecordActive
                    ? String(localized: "Live")
                    : String(localized: "Idle")))
            SettingsDescriptionRow(
                "Voice Wake",
                description: .verbatim(self.appModel.voiceWake.statusText),
                value: .verbatim(self.voiceWakeEnabled
                    ? String(localized: "On")
                    : String(localized: "Off")))
        } header: {
            SettingsSectionTitle("Checks")
        }
    }

    func reconnectGateway(ingressAttention: GatewayIngressController.Attention? = nil) async {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        guard !self.isReconnectingGateway else { return }
        self.isReconnectingGateway = true
        self.gatewayActionStatusText = nil
        defer { self.isReconnectingGateway = false }
        let result = if let ingressAttention {
            await gatewayController.retryGatewayIngress(ingressAttention)
        } else {
            await gatewayController.connectActiveGateway()
        }
        if case let .failed(message) = result {
            gatewayActionStatusText = message
        }
    }

    func switchGateway(to entry: GatewaySettingsStore.GatewayRegistryEntry) async {
        guard self.connectingGateway == nil else { return }
        self.connectingGateway = .gateway(entry.id)
        self.gatewayActionStatusText = String(
            format: String(localized: "Switching to %@…"),
            entry.name)
        defer {
            self.connectingGateway = nil
            self.refreshGatewayRegistry()
        }
        switch await self.gatewayController.switchToGateway(stableID: entry.stableID) {
        case .accepted:
            self.gatewayActionStatusText = nil
            self.gatewayAuthFields.selectTarget(
                entry.stableID,
                instanceId: self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines),
                allowManualOverride: false)
        case let .failed(message):
            self.gatewayActionStatusText = message
        case .superseded:
            self.gatewayActionStatusText = nil
        }
    }

    func forgetGateway(_ entry: GatewaySettingsStore.GatewayRegistryEntry) async {
        self.pendingForgetGateway = nil
        guard await self.gatewayController.forgetGateway(stableID: entry.stableID) else {
            self.setupStatusText = String(
                format: String(localized: "Couldn’t forget %@."),
                entry.name)
            self.refreshGatewayRegistry()
            return
        }
        if GatewayStableIdentifier.matches(self.gatewayAuthFields.targetStableID, entry.stableID) {
            self.gatewayAuthFields = .init()
        }
        self.setupStatusText = String(
            format: String(localized: "Forgot %@."),
            entry.name)
        self.refreshGatewayRegistry()
    }

    func refreshGatewayRegistry() {
        self.gatewayRegistry = self.appModel.loadDisplayedGatewayRegistry()
    }

    func gatewayEndpointSummary(_ entry: GatewaySettingsStore.GatewayRegistryEntry) -> String {
        switch entry.kind {
        case .manual:
            let endpoint = if let host = entry.host, let port = entry.port {
                "\(host):\(port)"
            } else {
                String(localized: "Saved endpoint unavailable")
            }
            return entry.useTLS ? "\(endpoint) • TLS" : endpoint
        case .discovered:
            return entry.useTLS
                ? String(localized: "Discovered • TLS")
                : String(localized: "Discovered")
        }
    }

    @MainActor
    func runDiagnostics() async {
        guard !self.isRefreshingGateway else { return }
        self.isRefreshingGateway = true
        defer { self.isRefreshingGateway = false }

        if !self.appModel.isAppleReviewDemoModeEnabled {
            self.gatewayController.refreshActiveGatewayRegistrationFromSettings()
            self.gatewayController.restartDiscovery()
            await self.appModel.refreshGatewayOverviewIfConnected()
        }
        let notificationSettings = await UNUserNotificationCenter.current().notificationSettings()
        self.applyNotificationStatus(notificationSettings.authorizationStatus)
        IOSDeviceSettingsActions.registerForRemoteNotificationsIfEnrollmentReady(
            status: notificationSettings.authorizationStatus)

        self.diagnosticsIssueCount = SettingsDiagnostics.issues(
            gatewayConnected: self.gatewayDiagnosticConnected,
            discoveredGatewayCount: self.gatewayController.gateways.count,
            talkConfigLoaded: self.gatewayDiagnosticTalkConfigLoaded,
            notificationsAllowed: self.notificationPresentation.isActive).count
        self.diagnosticsLastRunText = Date().formatted(date: .omitted, time: .shortened)
    }

    func syncSettingsState() {
        self.refreshGatewayRegistry()
        self.manualGatewayPortText = self.manualGatewayPort > 0 ? String(self.manualGatewayPort) : ""
        let activeManual = self.gatewayRegistry.activeEntry
        if activeManual?.kind == .manual,
           activeManual?.host?.caseInsensitiveCompare(self.manualGatewayHost) == .orderedSame,
           activeManual?.port == self.manualGatewayPort
        {
            self.manualGatewayContextPath = activeManual?.contextPath
        } else {
            self.manualGatewayContextPath = nil
        }
        let trimmedInstanceId = self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedInstanceId.isEmpty else { return }
        guard !self.appModel.isLocalGatewayFixtureEnabled,
              let stableID = Self.defaultCredentialTargetStableID(
                  manualStableID: self.currentManualGatewayStableID,
                  registry: self.gatewayRegistry)
        else {
            self.gatewayAuthFields = .init()
            return
        }
        self.gatewayAuthFields.load(
            instanceId: trimmedInstanceId,
            targetStableID: stableID)
    }

    func syncAfterOnboardingReset() {
        self.invalidateGatewaySetupAttempt()
        self.setupStatusText = nil
        self.setupCode = ""
        self.stagedGatewaySetupLink = nil
        self.gatewayAuthFields.pendingOverride = nil
        self.syncSettingsState()
        self.pendingTargetSuppression.releaseAutoConnect(controller: self.gatewayController)
    }

    func applySetupCodeAndConnect() async {
        guard let attemptID = self.beginGatewaySetupAttempt() else { return }
        defer {
            self.finishGatewaySetupAttempt(attemptID)
            self.pendingTargetSuppression.resumeAutoConnect(.setupLink, controller: self.gatewayController)
        }
        self.setupStatusText = nil
        guard await self.applySetupCode(attemptID: attemptID) else { return }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.resolvedManualPort(host: host) != nil else {
            self.setupStatusText = String(localized: "Enter a valid port.")
            return
        }
        guard await self.preflightGateway(host: host) else { return }
        self.setupStatusText = String(localized: "Setup code applied. Connecting…")
        await self.connectManual(setupAttemptID: attemptID)
    }

    func applyGatewaySetupLink(_ link: GatewayConnectDeepLink) {
        // Only the root-selected Gateway destination may destructively claim a
        // setup link; other Settings views can remain mounted behind onboarding.
        self.showQRScanner = false
        self.scannerResultHandoff.cancel()
        let lease = self.gatewayController.cancelPendingConnectionAttempts()
        self.pendingTargetSuppression.replace(owner: .setupLink, lease: lease)
        self.setupCode = ""
        self.setupStatusText = nil
        self.stagedGatewaySetupLink = link
        let security = link.tls ? String(localized: "TLS") : String(localized: "plain")
        self.setupStatusText = String(
            format: String(
                localized: "Setup link loaded for %@:%@ (%@). Tap Connect to apply."),
            link.host,
            link.port.formatted(),
            security)
    }

    @discardableResult
    func applySetupCode(attemptID: GatewaySetupAttempt) async -> Bool {
        let raw = setupCode.trimmingCharacters(in: .whitespacesAndNewlines)
        let stagedLink = stagedGatewaySetupLink
        guard !raw.isEmpty || stagedLink != nil else {
            self.setupStatusText = String(localized: "Paste a setup code to continue.")
            return false
        }

        if AppleReviewDemoMode.isSetupCode(raw) {
            self.stagedGatewaySetupLink = nil
            self.setupCode = ""
            self.setupStatusText = String(localized: "Apple Review demo mode enabled.")
            self.appModel.enterAppleReviewDemoMode()
            self.pendingTargetSuppression.releaseAutoConnect(.setupLink, controller: self.gatewayController)
            return false
        }

        guard let parsedLink = raw.isEmpty ? stagedLink : GatewayConnectDeepLink.fromSetupInput(raw) else {
            self.setupStatusText = String(
                localized: "This setup code isn’t valid, or it uses an insecure ws:// address.")
            return false
        }
        let link = await self.gatewayController.selectReachableSetupLink(parsedLink)
        guard self.setupAttemptID == attemptID else { return false }
        guard await self.applyGatewayLink(link) else { return false }
        self.stagedGatewaySetupLink = nil
        self.setupCode = ""
        return true
    }

    func applyGatewayLink(_ link: GatewayConnectDeepLink) async -> Bool {
        let instanceId = GatewaySettingsStore.currentInstanceID()
        let setupAuth = GatewayConnectionController.ManualAuthOverride.setupAuth(from: link)
        if setupAuth.hasBootstrapToken {
            guard await GatewayOnboardingReset.prepareForBootstrapPairing(
                appModel: self.appModel,
                instanceId: instanceId,
                gatewayStableID: setupAuth.targetStableID)
            else {
                self.setupStatusText = self.appModel.gatewayStatusText
                return false
            }
        }
        self.manualGatewayHost = link.host
        self.manualGatewayPort = link.port
        self.manualGatewayPortText = String(link.port)
        self.manualGatewayTLS = link.tls
        self.manualGatewayContextPath = link.contextPath
        self.gatewayAuthFields.targetStableID = setupAuth.targetStableID
        if !instanceId.isEmpty {
            GatewaySettingsStore.saveGatewayCredentials(
                token: setupAuth.token,
                bootstrapToken: setupAuth.bootstrapToken,
                password: setupAuth.password,
                gatewayStableID: setupAuth.targetStableID,
                suppressStoredDeviceAuth: true,
                instanceId: instanceId)
        }
        self.gatewayAuthFields.token = setupAuth.token
        self.gatewayAuthFields.password = setupAuth.password
        self.gatewayAuthFields.pendingOverride = setupAuth.manualAuthOverride
        return true
    }

    func openGatewayQRScanner() {
        self.invalidateGatewaySetupAttempt()
        let lease = gatewayController.cancelPendingConnectionAttempts(suspendCurrentGateway: true)
        stagedGatewaySetupLink = nil
        pendingTargetSuppression.replace(owner: .qrScanner, lease: lease)
        scannerScanID = scannerResultHandoff.beginScan()
        connectingGateway = nil
        setupStatusText = String(localized: "Opening QR scanner…")
        pairUsingCode = false
        showQRScanner = true
    }

    func queueScannedResult(_ result: QRScannerResult, scanID: UInt64) {
        guard self.scannerResultHandoff.queue(result, scanID: scanID) else { return }
        self.setupStatusText = String(localized: "QR loaded. Closing scanner…")
        self.showQRScanner = false
    }

    func processQueuedScannerResult() {
        let delivery = self.scannerResultHandoff.processAfterDismissal { result in
            switch result {
            case let .gatewayLink(link):
                self.handleScannedGatewayLink(link)
            case let .setupCode(code):
                self.handleScannedSetupCode(code)
            case .espDevice:
                return
            }
        }
        if delivery == nil {
            self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        }
    }

    func handleScannedGatewayLink(_ link: GatewayConnectDeepLink) {
        self.showQRScanner = false
        guard let attemptID = self.beginGatewaySetupAttempt() else { return }
        self.setupCode = ""
        Task { await self.connectAfterScannedGatewayLink(link, attemptID: attemptID) }
    }

    func handleScannedSetupCode(_ code: String) {
        guard AppleReviewDemoMode.isSetupCode(code) else { return }
        self.showQRScanner = false
        self.setupCode = ""
        self.stagedGatewaySetupLink = nil
        self.setupStatusText = String(localized: "Apple Review demo mode enabled.")
        self.appModel.enterAppleReviewDemoMode()
        self.pendingTargetSuppression.releaseAutoConnect(.qrScanner, controller: self.gatewayController)
    }

    func clearStagedGatewaySetupLink() {
        guard self.stagedGatewaySetupLink != nil else { return }
        self.stagedGatewaySetupLink = nil
        self.pendingTargetSuppression.resumeAutoConnect(.setupLink, controller: self.gatewayController)
    }

    private func takeStagedGatewaySetupSuppression() -> GatewayConnectionController.AutoConnectSuppressionLease? {
        self.stagedGatewaySetupLink = nil
        return self.pendingTargetSuppression.take(ifOwnedBy: .setupLink)
    }

    func connectAfterScannedGatewayLink(_ parsedLink: GatewayConnectDeepLink, attemptID: GatewaySetupAttempt) async {
        defer {
            self.finishGatewaySetupAttempt(attemptID)
            self.pendingTargetSuppression.resumeAutoConnect(.qrScanner, controller: self.gatewayController)
        }
        let link = await self.gatewayController.selectReachableSetupLink(parsedLink)
        guard self.setupAttemptID == attemptID else { return }
        guard await self.applyGatewayLink(link) else { return }
        self.setupStatusText = String(
            format: String(localized: "QR loaded. Connecting to %@:%@…"),
            link.host,
            link.port.formatted())
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard self.resolvedManualPort(host: host) != nil else {
            self.setupStatusText = String(localized: "Enter a valid port.")
            return
        }
        guard await self.preflightGateway(host: host) else { return }
        await self.connectManual(setupAttemptID: attemptID)
    }

    func connectManual(setupAttemptID: GatewaySetupAttempt? = nil) async {
        let admissionCheckpoint = setupAttemptID?.admissionCheckpoint ?? gatewayController.ingress.admissionCheckpoint()
        if let setupAttemptID {
            guard self.setupAttemptID == setupAttemptID else { return }
        } else {
            self.invalidateGatewaySetupAttempt()
        }
        let supersededSetupLease = self.takeStagedGatewaySetupSuppression()
        defer {
            if let supersededSetupLease {
                self.gatewayController.resumeAutoConnect(after: supersededSetupLease)
            }
        }
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty else {
            self.setupStatusText = String(localized: "Enter a host.")
            return
        }
        guard self.manualPortIsValid, let port = self.resolvedManualPort(host: host) else {
            self.setupStatusText = String(localized: "Enter a valid port.")
            return
        }
        self.connectingGateway = .manual
        self.manualGatewayEnabled = true
        defer {
            self.connectingGateway = nil
            self.refreshGatewayRegistry()
        }
        let stableID = GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: host,
            port: port,
            contextPath: self.manualGatewayContextPath)
        self.gatewayAuthFields.selectTarget(
            stableID,
            instanceId: self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines),
            allowManualOverride: true)
        self.manualConnectGeneration &+= 1
        let generation = self.manualConnectGeneration
        let authOverride = self.gatewayAuthFields.prepareManualConnection(
            instanceId: GatewaySettingsStore.currentInstanceID(),
            targetStableID: stableID)
        let result = await self.gatewayController.connectManual(
            host: host,
            port: port,
            useTLS: manualGatewayTLS,
            contextPath: manualGatewayContextPath,
            authOverride: authOverride,
            admissionCheckpoint: admissionCheckpoint)
        guard !Task.isCancelled,
              generation == self.manualConnectGeneration,
              GatewayStableIdentifier.matches(self.currentManualGatewayStableID, stableID)
        else { return }
        self.gatewayAuthFields.pendingOverride = authOverride?.unconsumed
        if case let .failed(message) = result {
            self.setupStatusText = message
        }
    }

    func preflightGateway(host: String) async -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        self.gatewayController.requestLocalNetworkAccess(reason: "settings_preflight")
        return true
    }

    func resetOnboarding() async {
        self.invalidateGatewaySetupAttempt()
        self.setupStatusText = nil
        self.setupCode = ""
        self.gatewayAutoConnect = false
        self.suppressCredentialPersist = true
        defer { self.suppressCredentialPersist = false }
        self.gatewayAuthFields = .init()
        await GatewayOnboardingReset.reset(appModel: self.appModel, instanceId: self.instanceId)
        self.onboardingComplete = false
        self.hasConnectedOnce = false
        self.manualGatewayEnabled = false
        self.manualGatewayHost = ""
        self.onboardingRequestID += 1
    }

    func beginGatewaySetupAttempt() -> GatewaySetupAttempt? {
        guard connectingGateway == nil else { return nil }
        manualConnectGeneration &+= 1
        let attemptID = GatewaySetupAttempt(admissionCheckpoint: gatewayController.ingress.admissionCheckpoint())
        setupAttemptID = attemptID
        connectingGateway = .setupCode
        return attemptID
    }

    func finishGatewaySetupAttempt(_ attemptID: GatewaySetupAttempt) {
        guard setupAttemptID == attemptID else { return }
        self.invalidateGatewaySetupAttempt()
    }

    func invalidateGatewaySetupAttempt() {
        self.manualConnectGeneration &+= 1
        self.setupAttemptID = nil
        self.connectingGateway = nil
    }

    func refreshNotificationSettings() {
        UNUserNotificationCenter.current().getNotificationSettings { settings in
            let status = settings.authorizationStatus
            Task { @MainActor in
                self.applyNotificationStatus(status)
                IOSDeviceSettingsActions.registerForRemoteNotificationsIfEnrollmentReady(status: status)
            }
        }
    }

    @MainActor
    func applyNotificationStatus(_ status: UNAuthorizationStatus) {
        self.notificationStatus = SettingsNotificationStatus(status)
    }

    var currentManualGatewayStableID: String? {
        let host = self.manualGatewayHost.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !host.isEmpty, let port = self.resolvedManualPort(host: host) else { return nil }
        return GatewayConnectionController.ManualAuthOverride.manualStableID(
            host: host,
            port: port,
            contextPath: self.manualGatewayContextPath)
    }

    var gatewayCredentialTargetStableID: String? {
        // Auth fields follow the selected route. Otherwise a discovered-gateway retry can save
        // credentials under the unrelated manual endpoint and immediately reload an empty bundle.
        self.gatewayAuthFields.targetStableID ?? Self.defaultCredentialTargetStableID(
            manualStableID: self.currentManualGatewayStableID,
            registry: self.gatewayRegistry)
    }

    /// The manual endpoint when one is set; otherwise the active saved gateway. Pairing from
    /// onboarding leaves the manual host empty, and a credential typed then must reach the gateway
    /// the app actually connects to.
    static func defaultCredentialTargetStableID(
        manualStableID: String?,
        registry: GatewaySettingsStore.GatewayRegistry) -> String?
    {
        manualStableID ?? registry.activeEntry?.stableID
    }

    var gatewayCustomHeadersTargetStableID: String? {
        guard let stableID = self.gatewayCredentialTargetStableID else { return nil }
        if GatewayStableIdentifier.matches(self.currentManualGatewayStableID, stableID) {
            return self.manualGatewayTLS ? stableID : nil
        }
        if let active = self.appModel.activeGatewayConnectConfig,
           GatewayStableIdentifier.matches(active.effectiveStableID, stableID)
        {
            return active.url.scheme?.lowercased() == "wss" ? stableID : nil
        }
        return nil
    }

    static func gatewayAccessAttention(
        in registry: GatewaySettingsStore.GatewayRegistry,
        ingress: GatewayIngressController) -> GatewayIngressController.Attention?
    {
        guard let selected = registry.activeEntry,
              let attention = ingress.attention,
              GatewayStableIdentifier.matches(selected.stableID, attention.stableID)
        else { return nil }
        return attention
    }

    static func gatewayAccessSessionTarget(
        in registry: GatewaySettingsStore.GatewayRegistry,
        ingress: GatewayIngressController) -> (stableID: String, origin: CloudflareAccessOrigin)?
    {
        // Access belongs to the selected saved profile, not the editable manual
        // credential fields. Resolve its durable grant origin through the ingress owner.
        guard let selected = registry.activeEntry,
              let origin = ingress.sessionOrigin(stableID: selected.stableID)
        else { return nil }
        return (selected.stableID, origin)
    }

    var manualGatewayEnabledBinding: Binding<Bool> {
        Binding(
            get: { self.manualGatewayEnabled },
            set: { enabled in
                self.manualGatewayEnabled = enabled
                guard enabled, let stableID = self.currentManualGatewayStableID else { return }
                self.gatewayAuthFields.selectTarget(
                    stableID,
                    instanceId: self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines),
                    allowManualOverride: true)
            })
    }

    func gatewayCredentialBinding(
        _ field: WritableKeyPath<GatewayConnectionController.ManualAuthOverride.Fields, String>) -> Binding<String>
    {
        Binding(
            get: { self.gatewayAuthFields[keyPath: field] },
            set: { value in
                guard !self.suppressCredentialPersist else {
                    self.gatewayAuthFields[keyPath: field] = value
                    return
                }
                self.gatewayAuthFields.edit(
                    field,
                    to: value,
                    instanceId: self.instanceId.trimmingCharacters(in: .whitespacesAndNewlines),
                    defaultTarget: Self.defaultCredentialTargetStableID(
                        manualStableID: self.currentManualGatewayStableID,
                        registry: self.gatewayRegistry))
            })
    }

    var manualHostBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayHost },
            set: { value in
                self.updateManualTarget {
                    self.manualGatewayHost = value
                }
            })
    }

    func title(for route: SettingsRoute) -> String {
        switch route {
        case .deviceSettings: String(localized: "Device Settings")
        case .voiceAndTalk: String(localized: "Voice & Talk")
        case .permissions: String(localized: "Permissions")
        case .accessories: String(localized: "Accessories")
        case .chatPreferences: String(localized: "Chat")
        case .storage: String(localized: "Storage")
        case .sidebarPages: String(localized: "Pages")
        case .skills: String(localized: "Skills")
        case .plugins: String(localized: "Plugins")
        case .advanced: String(localized: "Advanced")
        case .gateway:
            self.gatewayRegistry.entries.first {
                GatewayStableIdentifier.matches(
                    $0.stableID,
                    self.appModel.activeGatewayConnectConfig?.effectiveStableID ??
                        self.appModel.connectedGatewayID ?? self.gatewayRegistry.activeStableID)
            }.map(self.gatewayRegistry.compactName) ?? String(localized: "Connection")
        case .gatewayDetails: String(localized: "Connection details")
        case .appleWatch: String(localized: "Apple Watch")
        case .espSetup: String(localized: "ESP device setup")
        case .approvals: String(localized: "Approvals")
        case .diagnostics: String(localized: "Diagnostics")
        case .licenses: String(localized: "Licenses")
        case .about: String(localized: "About")
        }
    }

    func sendDirectWatchSetup() async {
        guard !self.isSendingWatchDirectSetup else { return }
        self.isSendingWatchDirectSetup = true
        self.watchDirectSetupStatusText = String(localized: "Preparing one-time setup…")
        defer { self.isSendingWatchDirectSetup = false }
        do {
            let result = try await self.appModel.sendDirectWatchSetup()
            self.watchDirectSetupStatusText = result.deliveredImmediately
                ? String(localized: "Setup sent. Open OpenClaw on the watch to connect.")
                : String(
                    localized: "Setup queued for the watch. Open OpenClaw before the code expires.")
        } catch {
            self.watchDirectSetupStatusText = error.localizedDescription
        }
    }

    var manualPortBinding: Binding<String> {
        Binding(
            get: { self.manualGatewayPortText },
            set: { newValue in
                self.updateManualTarget {
                    let filtered = newValue.filter(\.isNumber)
                    self.manualGatewayPortText = filtered
                    self.manualGatewayPort = Int(filtered) ?? 0
                }
            })
    }

    private func updateManualTarget(_ update: () -> Void) {
        let previousStableID = self.currentManualGatewayStableID
        self.manualGatewayContextPath = nil
        update()
        if GatewayStableIdentifier.key(previousStableID) !=
            GatewayStableIdentifier.key(self.currentManualGatewayStableID)
        {
            self.gatewayAuthFields = .init()
        }
    }

    var manualPortIsValid: Bool {
        if self.manualGatewayPortText.isEmpty { return true }
        return self.manualGatewayPort >= 1 && self.manualGatewayPort <= 65535
    }

    func resolvedManualPort(host: String) -> Int? {
        guard self.manualGatewayPortText.isEmpty || self.manualGatewayPort > 0 else { return nil }
        return GatewayConnectionController.resolvedManualPort(
            host: host,
            port: self.manualGatewayPort)
    }

    var setupStatusLine: String? {
        if let problem = self.appModel.lastGatewayProblem {
            return problem.localizedMessage
        }
        let trimmedSetup = self.setupStatusText?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        // An idle gateway adds nothing unless an action left a notice.
        let source = GatewayStatusBuilder.source(for: self.appModel.connection.node, appModel: self.appModel)
        let gatewayStatus = source == .phase(.idle) ? nil : source.statusText
        if let friendly = self.friendlyGatewayMessage(from: trimmedSetup) { return friendly }
        if self.isTransientSetupStatus(trimmedSetup), let gatewayStatus { return gatewayStatus }
        if !trimmedSetup.isEmpty { return trimmedSetup }
        return gatewayStatus
    }

    var canApplyGatewaySetup: Bool {
        !self.setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            || self.stagedGatewaySetupLink != nil
    }

    func friendlyGatewayMessage(from raw: String) -> String? {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if lower.contains("pairing required") {
            return String(
                localized: "Pairing required. Run /pair approve in your OpenClaw chat, then connect again.")
        }
        if lower.contains("device nonce required") || lower.contains("device nonce mismatch") {
            return String(localized: "Secure handshake failed. Connect again.")
        }
        if lower.contains("tls fingerprint verification timed out")
            || lower.contains("no tls endpoint detected")
        {
            return raw.trimmingCharacters(in: .whitespacesAndNewlines)
        }
        if lower.contains("timed out") {
            return String(
                localized: "Connection timed out. Check your Gateway and network, then try again.")
        }
        if lower.contains("unauthorized role") {
            return String(
                localized: "Connected, but some controls are restricted for nodes. This is expected.")
        }
        return nil
    }

    func isTransientSetupStatus(_ raw: String) -> Bool {
        let lower = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let setupApplied = String(localized: "Setup code applied. Connecting…").lowercased()
        let checkingReachability = String(localized: "Checking Gateway reachability…").lowercased()
        let qrFormat = String(localized: "QR loaded. Connecting to %@:%@…").lowercased()
        return lower == setupApplied
            || Self.localizedFormat(qrFormat, matches: lower)
            || lower == checkingReachability
    }

    static func localizedFormat(_ format: String, matches value: String) -> Bool {
        guard let placeholder = try? NSRegularExpression(pattern: #"%(\d+\$)?@"#) else {
            return format == value
        }
        let formatRange = NSRange(format.startIndex..., in: format)
        let matches = placeholder.matches(in: format, range: formatRange)
        guard !matches.isEmpty else { return format == value }

        var pattern = "^"
        var cursor = format.startIndex
        for match in matches {
            guard let range = Range(match.range, in: format) else { return false }
            pattern += NSRegularExpression.escapedPattern(for: String(format[cursor..<range.lowerBound]))
            pattern += #"[\s\S]+?"#
            cursor = range.upperBound
        }
        pattern += NSRegularExpression.escapedPattern(for: String(format[cursor...]))
        pattern += "$"
        return value.range(of: pattern, options: .regularExpression) != nil
    }

    var gatewayConnected: Bool {
        !self.appModel.isAppleReviewDemoModeEnabled &&
            GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    var gatewayStatusPresentation: (detail: String, value: String) {
        if self.appModel.isAppleReviewDemoModeEnabled {
            return (String(localized: "Apple Review demo mode"), String(localized: "Demo"))
        }
        let connected = self.gatewayConnected
        return (
            self.appModel.gatewayDisplayStatusText,
            connected ? String(localized: "Online") : String(localized: "Offline"))
    }

    var gatewayDiagnosticConnected: Bool {
        self.appModel.isAppleReviewDemoModeEnabled || self.gatewayConnected
    }

    var gatewayDiagnosticTalkConfigLoaded: Bool {
        self.appModel.isAppleReviewDemoModeEnabled || self.appModel.talkMode.gatewayTalkConfigLoaded
    }

    var approvalEmptyDetail: String {
        if self.appModel.isAppleReviewDemoModeEnabled {
            return String(localized: "Live requests are off in demo mode.")
        }
        if self.notificationPresentation.needsAttention {
            return String(
                localized: "Foreground approvals still appear while OpenClaw is connected.")
        }
        return self.gatewayConnected
            ? String(localized: "Approval requests will appear here.")
            : String(localized: "Connect to OpenClaw.")
    }

    var gatewayTalkConfigPresentation: (detail: String, value: String) {
        if self.appModel.isAppleReviewDemoModeEnabled {
            return (String(localized: "Demo mode only"), String(localized: "Demo"))
        }
        let loaded = self.appModel.talkMode.gatewayTalkConfigLoaded
        return (
            self.appModel.talkMode.gatewayTalkTransportLabel,
            loaded ? String(localized: "Loaded") : String(localized: "Not loaded"))
    }

    var gatewayAddress: String {
        self.appModel.gatewayRemoteAddress ?? String(localized: "Waiting for Gateway")
    }

    var gatewayServer: String {
        self.appModel.gatewayServerName ?? "OpenClaw Gateway"
    }

    var approvalWaitingText: String {
        if self.appModel.pendingExecApprovalCount == 1 {
            return String(localized: "1 waiting")
        }
        return String(
            format: String(localized: "%@ waiting"),
            self.appModel.pendingExecApprovalCount.formatted())
    }

    var approvalItems: [SettingsApprovalItem] {
        guard let pendingApproval = self.appModel.pendingExecApprovalPrompt else { return [] }
        let pendingTitle = pendingApproval.commandPreview.map(OpenClawTextValue.verbatim)
            ?? OpenClawTextValue.localized("Review action")
        let agentDetail = String(
            format: String(localized: "Agent: %@"),
            self.appModel.activeAgentName)
        return [
            SettingsApprovalItem(
                id: "pending-real",
                icon: "terminal.fill",
                title: pendingTitle,
                detail: .verbatim(agentDetail),
                priority: self.appModel.pendingExecApprovalPromptResolving
                    ? .localized("Resolving")
                    : .localized("High"),
                color: OpenClawBrand.danger),
            SettingsApprovalItem(
                id: "pending-context",
                icon: "doc.text.fill",
                title: pendingApproval.allowsAllowAlways
                    ? .localized("Permission can be saved")
                    : .localized("One-time approval"),
                detail: "Approval request",
                priority: pendingApproval.allowsAllowAlways
                    ? .localized("Medium")
                    : .localized("Review"),
                color: OpenClawBrand.warn),
        ]
    }

    var diagnosticsRunPresentation: String {
        guard let diagnosticsIssueCount else { return String(localized: "Not run") }
        if diagnosticsIssueCount == 0 { return String(localized: "Passed") }
        if diagnosticsIssueCount == 1 { return String(localized: "1 issue") }
        return String(
            format: String(localized: "%lld issues"),
            Int64(diagnosticsIssueCount))
    }

    var notificationDisclosureAccepted: Bool {
        !PushBuildConfig.current.usesOpenClawHostedRelay
            || PushEnrollmentConsent.disclosureAccepted
    }

    var notificationPresentation: SettingsNotificationPresentation {
        switch self.notificationStatus {
        case .checking:
            return .checking
        case .allowed:
            if !self.notificationServingEnabled {
                return .off
            }
            if !self.notificationDisclosureAccepted {
                return .setup
            }
            return .enabled
        case .notAllowed:
            return .denied
        case .notSet:
            return .notSet
        case .unknown:
            return .unknown
        }
    }
}
