import SwiftUI

struct TalkProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @AppStorage("talk.enabled") private var talkEnabled: Bool = false
    @AppStorage(TalkDefaults.speakerphoneEnabledKey) private var talkSpeakerphoneEnabled: Bool =
        TalkDefaults.speakerphoneEnabledByDefault
    @AppStorage(TalkDefaults.wallpaperSelectionKey) private var wallpaperSelectionRaw =
        TalkWallpaperSelection.default.rawValue
    @Environment(\.dismiss) private var dismiss
    @State private var showPermissionPrompt = false
    @State private var showTalkIssueDetails = false
    @State private var showVoiceSettings = false
    @State private var callStartedAt: Date?
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let ownsNavigationStack: Bool
    var openSettings: () -> Void

    init(
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        ownsNavigationStack: Bool = true,
        openSettings: @escaping () -> Void)
    {
        self.headerLeadingAction = headerLeadingAction
        self.ownsNavigationStack = ownsNavigationStack
        self.openSettings = openSettings
    }

    private var state: TalkProState {
        TalkProState(
            gatewayConnected: self.gatewayConnected,
            isDemoMode: self.appModel.isAppleReviewDemoModeEnabled,
            isEnabled: self.appModel.talkMode.isEnabled || self.talkEnabled,
            statusText: self.appModel.talkMode.statusText,
            isConfigLoaded: self.appModel.talkMode.gatewayTalkConfigLoaded,
            isListening: self.appModel.talkMode.isListening,
            isSpeaking: self.appModel.talkMode.isSpeaking,
            isUserSpeechDetected: self.appModel.talkMode.isUserSpeechDetected,
            isInputMuted: self.appModel.talkMode.isInputMuted,
            permissionState: self.appModel.talkMode.gatewayTalkPermissionState)
    }

    var body: some View {
        Group {
            if self.ownsNavigationStack {
                NavigationStack {
                    self.content
                }
            } else {
                self.content
            }
        }
        .sheet(isPresented: self.$showPermissionPrompt) {
            NavigationStack {
                TalkPermissionPromptView(
                    style: .sheet,
                    onPermissionReady: {
                        self.showPermissionPrompt = false
                        self.startTalk()
                    })
                    .padding()
                    .navigationTitle("Enable Talk")
                    .toolbar {
                        ToolbarItem(placement: .cancellationAction) {
                            Button("Not Now") {
                                self.showPermissionPrompt = false
                            }
                        }
                    }
            }
            .presentationDetents([.medium, .large])
            .openClawSheetChrome()
        }
        .sheet(isPresented: self.$showTalkIssueDetails) {
            if let fallbackIssue = self.fallbackIssue {
                TalkRuntimeIssueDetailsSheet(
                    issue: fallbackIssue,
                    onOpenSettings: self.presentVoiceSettings)
                    .openClawSheetChrome()
            }
        }
        .onAppear {
            self.alignPersistedTalkState()
            self.syncCallStartedAt()
            self.autoStartIfNeeded()
        }
        .onChange(of: self.appModel.talkMode.isEnabled) { _, _ in
            self.syncCallStartedAt()
        }
        .onChange(of: self.wallpaperSelectionRaw) { _, _ in }
        .onDisappear {
            self.stopTalk()
        }
        .toolbar(.hidden, for: .tabBar)
    }

    private var chromeStyle: TalkProChromeStyle {
        TalkProChromeStyle(usesImageWallpaper: TalkWallpaperStore.usesImageWallpaper())
    }

    private var content: some View {
        ZStack {
            TalkWallpaperBackground()
            VStack(spacing: 0) {
                if let fallbackIssue = self.fallbackIssue {
                    TalkRuntimeIssueBanner(
                        issue: fallbackIssue,
                        onOpenSettings: self.presentVoiceSettings,
                        onShowDetails: {
                            self.showTalkIssueDetails = true
                        })
                        .padding(.horizontal, OpenClawProMetric.pagePadding)
                        .padding(.top, 8)
                }

                Spacer(minLength: 0)

                self.talkCenter

                Spacer(minLength: 0)

                if self.showsBlockingAction {
                    self.blockingAction
                        .padding(.horizontal, OpenClawProMetric.pagePadding)
                        .padding(.bottom, 40)
                } else if self.showsBottomControls {
                    VStack(spacing: 12) {
                        if self.showsOfflineReconnect {
                            self.offlineReconnect
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                        } else if self.showsConnectingRetry {
                            self.connectingRetry
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                        }
                        self.callControls
                    }
                }
            }
        }
        .modifier(TalkProNavigationChrome(
            ownsNavigationStack: self.ownsNavigationStack,
            chromeStyle: self.chromeStyle,
            openVoiceSettings: self.presentVoiceSettings))
        .navigationDestination(isPresented: self.$showVoiceSettings) {
            SettingsProTab(directRoute: .voice, ownsNavigationStack: false)
        }
    }

    private var talkCenter: some View {
        VStack(spacing: 8) {
            if self.showsWaveform {
                TalkProWaveform(
                    mode: self.state.waveformMode(micLevel: self.appModel.talkMode.micLevel),
                    tint: self.state.color,
                    barCount: 5)
                    .frame(height: 36)
                    .padding(.bottom, 4)
            }

            if self.showsAgentName {
                Text(self.appModel.chatAgentName)
                    .font(.title2.weight(.bold))
                    .foregroundStyle(self.chromeStyle.primary)
                    .multilineTextAlignment(.center)
            }

            if self.showsCallDuration, let callStartedAt = self.callStartedAt {
                Text(callStartedAt, style: .timer)
                    .font(OpenClawProFont.minimum.weight(.medium))
                    .foregroundStyle(self.chromeStyle.secondary)
                    .monospacedDigit()
            }

            if self.showsCenterStatus {
                Text(self.centerStatusText)
                    .font(.subheadline.weight(.medium))
                    .foregroundStyle(self.centerStatusColor)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var offlineReconnect: some View {
        VStack(spacing: 12) {
            Button(action: self.handlePrimaryAction) {
                Label("Reconnect", systemImage: "arrow.clockwise")
                    .font(.subheadline.weight(.bold))
                    .frame(minWidth: 140)
                    .frame(height: 44)
            }
            .buttonStyle(.bordered)
            .tint(self.chromeStyle.primary)
        }
    }

    private var blockingAction: some View {
        Button(action: self.handlePrimaryAction) {
            Label(self.state.primaryButtonTitle, systemImage: self.state.primaryButtonIcon)
                .font(.subheadline.weight(.bold))
                .frame(maxWidth: .infinity)
                .frame(height: 44)
        }
        .buttonStyle(.borderedProminent)
        .tint(self.state.primaryButtonFill)
        .disabled(self.state.primaryAction == .waiting)
    }

    private var isInActiveCall: Bool {
        self.state.isEnabled && self.gatewayConnected && !self.state.isDemoMode && self.state
            .primaryAction != .enablePermission
    }

    private var showsOfflineReconnect: Bool {
        !self.gatewayConnected
    }

    private var showsBlockingAction: Bool {
        !self.isInActiveCall && !self.showsOfflineReconnect &&
            (self.state.primaryAction == .enablePermission || self.state.primaryAction == .waiting || self.state
                .primaryAction == .openSettings)
    }

    private var showsBottomControls: Bool {
        self.isInActiveCall || self.showsOfflineReconnect
    }

    private var showsConnectingRetry: Bool {
        self.isInActiveCall && self.state.isConnecting
    }

    private var connectingRetry: some View {
        Button(action: self.retryTalkConnection) {
            Label("Retry", systemImage: "arrow.clockwise")
                .font(.subheadline.weight(.bold))
                .frame(minWidth: 140)
                .frame(height: 44)
        }
        .buttonStyle(.bordered)
        .tint(self.chromeStyle.primary)
        .accessibilityIdentifier("talk-connecting-retry-control")
    }

    private var callControls: some View {
        HStack(spacing: 36) {
            self.callControlItem(
                label: self.appModel.talkMode.isInputMuted ? "Mic off" : "Mic on",
                accessibilityIdentifier: "talk-mute-control")
            {
                Button {
                    self.appModel.setTalkInputMuted(!self.appModel.talkMode.isInputMuted)
                } label: {
                    Image(systemName: self.appModel.talkMode.isInputMuted ? "mic.slash.fill" : "mic.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(self.chromeStyle.micButtonForeground)
                        .frame(width: 64, height: 64)
                        .background(Circle().fill(self.chromeStyle.micButtonFill))
                        .overlay {
                            Circle()
                                .strokeBorder(Color.primary.opacity(0.08), lineWidth: 1)
                        }
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Microphone")
                .accessibilityValue(self.appModel.talkMode.isInputMuted ? "Off" : "On")
            }

            self.callControlItem(label: "Hang up", accessibilityIdentifier: "talk-hangup-control") {
                Button(action: self.handleHangUp) {
                    Image(systemName: "phone.down.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(Circle().fill(self.chromeStyle.hangupButtonFill))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Hang up")
            }

            self.callControlItem(
                label: self.talkSpeakerphoneEnabled ? "Speaker on" : "Speaker off",
                accessibilityIdentifier: "talk-speakerphone-control")
            {
                Button {
                    self.appModel.setTalkSpeakerphoneEnabled(!self.talkSpeakerphoneEnabled)
                } label: {
                    Image(systemName: self.talkSpeakerphoneEnabled ? "speaker.wave.2.fill" : "speaker.fill")
                        .font(.system(size: 24, weight: .semibold))
                        .foregroundStyle(.white)
                        .frame(width: 64, height: 64)
                        .background(Circle().fill(self.chromeStyle.speakerButtonFill))
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Speakerphone")
                .accessibilityValue(self.talkSpeakerphoneEnabled ? "On" : "Off")
            }
        }
        .padding(.horizontal, 28)
        .padding(.top, 20)
        .padding(.bottom, 44)
    }

    private func callControlItem(
        label: String,
        accessibilityIdentifier: String,
        @ViewBuilder control: () -> some View) -> some View
    {
        VStack(spacing: 10) {
            control()
                .accessibilityIdentifier(accessibilityIdentifier)
            Text(label)
                .font(OpenClawProFont.minimum.weight(.medium))
                .foregroundStyle(self.chromeStyle.dockLabel)
        }
        .frame(width: 72)
    }

    private var showsWaveform: Bool {
        self.isInActiveCall && (self.state.isSpeaking || self.state.isListening)
    }

    private var showsAgentName: Bool {
        !self.state.isConnecting
    }

    private var showsCallDuration: Bool {
        self.isInActiveCall && !self.state.isConnecting
    }

    private var showsCenterStatus: Bool {
        guard !self.state.isConnecting else { return false }
        return !self.isInActiveCall && !self.centerStatusText.isEmpty
    }

    private var centerStatusText: String {
        if !self.gatewayConnected { return "Cannot connect" }
        if self.state.isDemoMode { return self.state.title }
        if self.state.primaryAction == .enablePermission { return self.state.title }
        if self.state.primaryAction == .waiting { return self.state.title }
        if !self.state.isConfigLoaded || self.state.primaryAction == .openSettings {
            return self.state.title
        }
        return ""
    }

    private var centerStatusColor: Color {
        if !self.gatewayConnected { return self.chromeStyle.primary }
        return self.chromeStyle.secondary
    }

    private var gatewayConnected: Bool {
        !self.appModel.isAppleReviewDemoModeEnabled &&
            GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var fallbackIssue: TalkRuntimeIssue? {
        guard self.gatewayConnected else { return nil }
        return self.appModel.talkMode.gatewayTalkCurrentFallbackIssue
    }

    private func alignPersistedTalkState() {
        if self.appModel.isAppleReviewDemoModeEnabled,
           self.talkEnabled || self.appModel.talkMode.isEnabled
        {
            self.stopTalk()
        } else if self.appModel.talkMode.gatewayTalkPermissionState.requiresTalkPermissionAction,
                  self.talkEnabled || self.appModel.talkMode.isEnabled
        {
            self.stopTalk()
        } else if self.talkEnabled != self.appModel.talkMode.isEnabled {
            self.appModel.setTalkEnabled(self.talkEnabled)
        }
    }

    private func handlePrimaryAction() {
        switch self.state.primaryAction {
        case .start:
            self.startTalk()
        case .stop:
            self.handleHangUp()
        case .enablePermission:
            self.stopTalk()
            self.showPermissionPrompt = true
        case .openSettings:
            self.openPrimarySettings()
        case .waiting:
            break
        }
    }

    private func handleHangUp() {
        self.stopTalk()
        if !self.ownsNavigationStack {
            self.dismiss()
        }
    }

    private func autoStartIfNeeded() {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        guard self.gatewayConnected else { return }
        guard self.state.primaryAction == .start else { return }
        self.startTalk()
    }

    private func syncCallStartedAt() {
        if self.appModel.talkMode.isEnabled || self.talkEnabled {
            if self.callStartedAt == nil {
                self.callStartedAt = Date()
            }
        } else {
            self.callStartedAt = nil
        }
    }

    private func startTalk() {
        guard !self.appModel.isAppleReviewDemoModeEnabled else { return }
        self.talkEnabled = true
        self.appModel.talkMode.updateMainSessionKey(self.appModel.chatSessionKey)
        self.appModel.setTalkEnabled(true)
    }

    private func stopTalk() {
        self.talkEnabled = false
        self.appModel.setTalkEnabled(false)
    }

    private func openPrimarySettings() {
        if self.gatewayConnected {
            self.presentVoiceSettings()
        } else {
            self.openSettings()
        }
    }

    private func presentVoiceSettings() {
        self.showVoiceSettings = true
    }

    private func retryTalkConnection() {
        guard self.isInActiveCall else { return }
        self.stopTalk()
        self.startTalk()
    }
}

private struct TalkProNavigationChrome: ViewModifier {
    let ownsNavigationStack: Bool
    let chromeStyle: TalkProChromeStyle
    let openVoiceSettings: () -> Void

    func body(content: Content) -> some View {
        if self.ownsNavigationStack {
            content.navigationBarHidden(true)
        } else {
            content
                .navigationTitle("")
                .navigationBarTitleDisplayMode(.inline)
                .navigationBarBackButtonHidden(false)
                .toolbar {
                    ToolbarItem(placement: .topBarTrailing) {
                        Button(action: self.openVoiceSettings) {
                            Image(systemName: "slider.horizontal.3")
                                .font(.body.weight(.semibold))
                                .foregroundStyle(self.chromeStyle.primary)
                        }
                        .accessibilityLabel("Voice & Talk settings")
                        .accessibilityIdentifier("talk-voice-settings-control")
                    }
                }
                .toolbarColorScheme(self.chromeStyle.usesImageWallpaper ? .dark : .light, for: .navigationBar)
        }
    }
}

enum TalkProPrimaryAction: Equatable {
    case start
    case stop
    case enablePermission
    case openSettings
    case waiting
}

enum TalkProWaveformMode: Equatable {
    case level(Double)
    case inputSpeech
    case speaking
    case indeterminate
    case still
}

struct TalkProState: Equatable {
    let gatewayConnected: Bool
    let isDemoMode: Bool
    let isEnabled: Bool
    let statusText: String
    let isConfigLoaded: Bool
    let isListening: Bool
    let isSpeaking: Bool
    let isUserSpeechDetected: Bool
    let isInputMuted: Bool
    let permissionState: TalkGatewayPermissionState

    private var normalizedStatus: String {
        self.statusText.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    var isConnecting: Bool {
        self.normalizedStatus.contains("connecting")
    }

    var title: String {
        if self.isDemoMode { return "Demo mode only" }
        if !self.gatewayConnected { return "Gateway offline" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "Gateway permission required"
        case .requestingUpgrade:
            return "Requesting approval"
        case .upgradeRequested:
            return "Approval requested"
        case .apiKeyMissing:
            return "Voice API key missing"
        case .loadFailed:
            return "Voice config failed"
        default:
            break
        }
        if !self.isConfigLoaded { return "Voice config unavailable" }
        if self.isInputMuted { return "Mic muted" }
        if self.isSpeaking { return "Speaking" }
        if self.isListening { return "Listening" }
        if self.normalizedStatus.contains("connecting") { return "Connecting" }
        if self.normalizedStatus.contains("thinking") { return "Asking OpenClaw" }
        if self.isEnabled { return "Ready to talk" }
        return "Talk is off"
    }

    var chipText: String {
        if self.isDemoMode { return "Demo" }
        if !self.gatewayConnected { return "Offline" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "Needs approval"
        case .requestingUpgrade, .upgradeRequested:
            return "Pending"
        case .apiKeyMissing:
            return "API key"
        case .loadFailed:
            return "Config"
        default:
            break
        }
        if !self.isConfigLoaded { return "Config" }
        if self.isInputMuted { return "Muted" }
        if self.isSpeaking { return "Speaking" }
        if self.isListening { return "Listening" }
        if self.isEnabled { return "Ready" }
        return "Off"
    }

    var icon: String {
        if self.isDemoMode { return "waveform.slash" }
        if !self.gatewayConnected { return "wifi.slash" }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return "key.fill"
        case .requestingUpgrade:
            return "paperplane.fill"
        case .upgradeRequested:
            return "hourglass"
        case .apiKeyMissing, .loadFailed:
            return "exclamationmark.triangle.fill"
        default:
            break
        }
        if !self.isConfigLoaded { return "exclamationmark.triangle.fill" }
        if self.isInputMuted { return "mic.slash.fill" }
        if self.isSpeaking { return "speaker.wave.2.fill" }
        if self.isListening { return "mic.fill" }
        if self.normalizedStatus.contains("thinking") { return "sparkles" }
        if self.normalizedStatus.contains("connecting") { return "dot.radiowaves.left.and.right" }
        return "waveform"
    }

    var color: Color {
        if self.isDemoMode { return .secondary }
        if !self.gatewayConnected { return .secondary }
        switch self.permissionState {
        case .requestFailed, .loadFailed:
            return OpenClawBrand.danger
        case .missingScope, .requestingUpgrade, .upgradeRequested, .apiKeyMissing:
            return OpenClawBrand.warn
        default:
            if !self.isConfigLoaded { return OpenClawBrand.warn }
            return self.isEnabled ? OpenClawBrand.ok : .secondary
        }
    }

    var primaryAction: TalkProPrimaryAction {
        if self.isDemoMode { return .waiting }
        if !self.gatewayConnected { return .openSettings }
        switch self.permissionState {
        case .missingScope, .requestFailed:
            return .enablePermission
        case .requestingUpgrade, .upgradeRequested:
            return .waiting
        case .apiKeyMissing, .loadFailed:
            return .openSettings
        default:
            return self.isEnabled ? .stop : .start
        }
    }

    var primaryButtonTitle: String {
        switch self.primaryAction {
        case .start: "Start Talk"
        case .stop: "Stop Talk"
        case .enablePermission: "Enable Talk"
        case .openSettings: self.gatewayConnected ? "Open Voice Settings" : "Reconnect"
        case .waiting: self.isDemoMode ? "Demo Mode Only" : "Waiting for Approval"
        }
    }

    var primaryButtonIcon: String {
        switch self.primaryAction {
        case .start: "play.fill"
        case .stop: "stop.fill"
        case .enablePermission: "key.fill"
        case .openSettings: self.gatewayConnected ? "gearshape.fill" : "checkmark"
        case .waiting: self.isDemoMode ? "lock.fill" : "hourglass"
        }
    }

    var primaryButtonFill: Color {
        switch self.primaryAction {
        case .stop:
            OpenClawBrand.danger
        case .waiting:
            OpenClawBrand.warn.opacity(0.72)
        default:
            OpenClawBrand.accent
        }
    }

    var prefersPermissionCopy: Bool {
        switch self.permissionState {
        case .missingScope, .requestingUpgrade, .upgradeRequested, .requestFailed:
            true
        default:
            false
        }
    }

    func waveformMode(micLevel: Double) -> TalkProWaveformMode {
        if self.isDemoMode { return .still }
        if !self.gatewayConnected { return .still }
        switch self.permissionState {
        case .requestingUpgrade, .upgradeRequested:
            return .indeterminate
        case .missingScope, .requestFailed, .apiKeyMissing, .loadFailed:
            return .still
        default:
            break
        }
        if !self.isConfigLoaded { return .still }
        if self.isSpeaking { return .speaking }
        if self.isListening, self.isUserSpeechDetected { return .inputSpeech }
        if self.isListening { return .level(micLevel) }
        if self.normalizedStatus.contains("connecting") || self.normalizedStatus.contains("thinking") {
            return .indeterminate
        }
        return self.isEnabled ? .indeterminate : .still
    }
}

struct TalkProWaveform: View {
    let mode: TalkProWaveformMode
    let tint: Color
    let barCount: Int

    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1.0 / 24.0)) { timeline in
            HStack(alignment: .center, spacing: 4) {
                ForEach(0..<self.barCount, id: \.self) { index in
                    Capsule(style: .continuous)
                        .fill(self.tint.opacity(self.opacity(for: index)))
                        .frame(width: 4, height: self.height(for: index, date: timeline.date))
                }
            }
            .frame(maxHeight: .infinity)
        }
    }

    private func height(for index: Int, date: Date) -> CGFloat {
        let minimum = 6.0
        let maximum = 48.0
        return CGFloat(minimum + ((maximum - minimum) * self.amplitude(for: index, date: date)))
    }

    private func opacity(for index: Int) -> Double {
        switch self.mode {
        case .still:
            index == self.barCount / 2 ? 0.64 : 0.30
        default:
            0.82
        }
    }

    private func amplitude(for index: Int, date: Date) -> Double {
        if self.reduceMotion {
            switch self.mode {
            case let .level(level): return min(max(level, 0.10), 1.0)
            case .inputSpeech: return 0.72
            case .speaking: return 0.62
            case .indeterminate: return 0.34
            case .still: return 0.18
            }
        }

        let t = date.timeIntervalSinceReferenceDate
        let phase = Double(index) * 0.52
        switch self.mode {
        case let .level(level):
            let clamped = min(max(level, 0), 1)
            let shaped = 0.12 + (0.88 * clamped)
            let variation = 0.72 + (0.28 * sin((t * 12.0) + phase))
            return min(max(shaped * variation, 0.10), 1.0)
        case .inputSpeech:
            let primary = 0.5 + (0.5 * sin((t * 14.0) + phase))
            let secondary = 0.5 + (0.5 * sin((t * 5.0) + (phase * 1.35)))
            return min(max(0.16 + (0.60 * primary) + (0.24 * secondary), 0.14), 1.0)
        case .speaking:
            let wave = 0.5 + (0.5 * sin((t * 7.5) + phase))
            let secondary = 0.5 + (0.5 * sin((t * 3.0) + (phase * 0.7)))
            return min(max(0.18 + (0.58 * wave) + (0.24 * secondary), 0.12), 1.0)
        case .indeterminate:
            let center = (sin((t * 3.2) + phase) + 1) / 2
            return 0.16 + (0.42 * center)
        case .still:
            return index == self.barCount / 2 ? 0.32 : 0.16
        }
    }
}
