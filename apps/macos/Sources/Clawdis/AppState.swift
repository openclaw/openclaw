import AppKit
import Foundation
import ServiceManagement
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    private let isPreview: Bool

    private func ifNotPreview(_ action: () -> Void) {
        guard !self.isPreview else { return }
        action()
    }

    enum ConnectionMode: String {
        case local
        case remote
    }

    @Published var isPaused: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) } }
    }

    @Published var launchAtLogin: Bool {
        didSet { self.ifNotPreview { Task { AppStateStore.updateLaunchAtLogin(enabled: self.launchAtLogin) } } }
    }

    @Published var onboardingSeen: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.onboardingSeen, forKey: "clawdis.onboardingSeen") }
        }
    }

    @Published var debugPaneEnabled: Bool {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.debugPaneEnabled, forKey: "clawdis.debugPaneEnabled") }
        }
    }

    @Published var swabbleEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.swabbleEnabled, forKey: swabbleEnabledKey)
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var swabbleTriggerWords: [String] {
        didSet {
            // Preserve the raw editing state; sanitization happens when we actually use the triggers.
            self.ifNotPreview {
                UserDefaults.standard.set(self.swabbleTriggerWords, forKey: swabbleTriggersKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    @Published var voiceWakeTriggerChime: VoiceWakeChime {
        didSet { self.ifNotPreview { self.storeChime(self.voiceWakeTriggerChime, key: voiceWakeTriggerChimeKey) } }
    }

    @Published var voiceWakeSendChime: VoiceWakeChime {
        didSet { self.ifNotPreview { self.storeChime(self.voiceWakeSendChime, key: voiceWakeSendChimeKey) } }
    }

    @Published var iconAnimationsEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.iconAnimationsEnabled,
            forKey: iconAnimationsEnabledKey) } }
    }

    @Published var showDockIcon: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.showDockIcon, forKey: showDockIconKey)
                AppActivationPolicy.apply(showDockIcon: self.showDockIcon)
            }
        }
    }

    @Published var voiceWakeMicID: String {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.voiceWakeMicID, forKey: voiceWakeMicKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    @Published var voiceWakeLocaleID: String {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.voiceWakeLocaleID, forKey: voiceWakeLocaleKey)
                if self.swabbleEnabled {
                    Task { await VoiceWakeRuntime.shared.refresh(state: self) }
                }
            }
        }
    }

    @Published var voiceWakeAdditionalLocaleIDs: [String] {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.voiceWakeAdditionalLocaleIDs,
            forKey: voiceWakeAdditionalLocalesKey) } }
    }

    @Published var voicePushToTalkEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.voicePushToTalkEnabled,
            forKey: voicePushToTalkEnabledKey) } }
    }

    @Published var iconOverride: IconOverrideSelection {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.iconOverride.rawValue, forKey: iconOverrideKey) } }
    }

    @Published var isWorking: Bool = false
    @Published var earBoostActive: Bool = false
    @Published var blinkTick: Int = 0
    @Published var sendCelebrationTick: Int = 0
    @Published var heartbeatsEnabled: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.heartbeatsEnabled, forKey: heartbeatsEnabledKey)
                Task { _ = await AgentRPC.shared.setHeartbeatsEnabled(self.heartbeatsEnabled) }
            }
        }
    }

    @Published var connectionMode: ConnectionMode {
        didSet {
            self.ifNotPreview { UserDefaults.standard.set(self.connectionMode.rawValue, forKey: connectionModeKey) }
        }
    }

    @Published var webChatEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.webChatEnabled, forKey: webChatEnabledKey) } }
    }

    @Published var webChatSwiftUIEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(
            self.webChatSwiftUIEnabled,
            forKey: webChatSwiftUIEnabledKey) } }
    }

    @Published var webChatPort: Int {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.webChatPort, forKey: webChatPortKey) } }
    }

    @Published var canvasEnabled: Bool {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.canvasEnabled, forKey: canvasEnabledKey) } }
    }

    @Published var attachExistingGatewayOnly: Bool {
        didSet {
            self.ifNotPreview {
                UserDefaults.standard.set(self.attachExistingGatewayOnly, forKey: attachExistingGatewayOnlyKey)
            }
        }
    }

    @Published var remoteTarget: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteTarget, forKey: remoteTargetKey) } }
    }

    @Published var remoteIdentity: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteIdentity, forKey: remoteIdentityKey) } }
    }

    @Published var remoteProjectRoot: String {
        didSet { self.ifNotPreview { UserDefaults.standard.set(self.remoteProjectRoot, forKey: remoteProjectRootKey) } }
    }

    private var earBoostTask: Task<Void, Never>?

    init(preview: Bool = false) {
        self.isPreview = preview
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.launchAtLogin = false
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdis.debugPaneEnabled")
        let savedVoiceWake = UserDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleEnabled = voiceWakeSupported ? savedVoiceWake : false
        self.swabbleTriggerWords = UserDefaults.standard
            .stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
        self.voiceWakeTriggerChime = Self.loadChime(
            key: voiceWakeTriggerChimeKey,
            fallback: .system(name: "Glass"))
        self.voiceWakeSendChime = Self.loadChime(
            key: voiceWakeSendChimeKey,
            fallback: .system(name: "Glass"))
        if let storedIconAnimations = UserDefaults.standard.object(forKey: iconAnimationsEnabledKey) as? Bool {
            self.iconAnimationsEnabled = storedIconAnimations
        } else {
            self.iconAnimationsEnabled = true
            UserDefaults.standard.set(true, forKey: iconAnimationsEnabledKey)
        }
        self.showDockIcon = UserDefaults.standard.bool(forKey: showDockIconKey)
        self.voiceWakeMicID = UserDefaults.standard.string(forKey: voiceWakeMicKey) ?? ""
        self.voiceWakeLocaleID = UserDefaults.standard.string(forKey: voiceWakeLocaleKey) ?? Locale.current.identifier
        self.voiceWakeAdditionalLocaleIDs = UserDefaults.standard
            .stringArray(forKey: voiceWakeAdditionalLocalesKey) ?? []
        self.voicePushToTalkEnabled = UserDefaults.standard
            .object(forKey: voicePushToTalkEnabledKey) as? Bool ?? false
        if let storedHeartbeats = UserDefaults.standard.object(forKey: heartbeatsEnabledKey) as? Bool {
            self.heartbeatsEnabled = storedHeartbeats
        } else {
            self.heartbeatsEnabled = true
            UserDefaults.standard.set(true, forKey: heartbeatsEnabledKey)
        }
        if let storedOverride = UserDefaults.standard.string(forKey: iconOverrideKey),
           let selection = IconOverrideSelection(rawValue: storedOverride)
        {
            self.iconOverride = selection
        } else {
            self.iconOverride = .system
            UserDefaults.standard.set(IconOverrideSelection.system.rawValue, forKey: iconOverrideKey)
        }

        let storedMode = UserDefaults.standard.string(forKey: connectionModeKey)
        self.connectionMode = ConnectionMode(rawValue: storedMode ?? "local") ?? .local
        self.remoteTarget = UserDefaults.standard.string(forKey: remoteTargetKey) ?? ""
        self.remoteIdentity = UserDefaults.standard.string(forKey: remoteIdentityKey) ?? ""
        self.remoteProjectRoot = UserDefaults.standard.string(forKey: remoteProjectRootKey) ?? ""
        self.webChatEnabled = UserDefaults.standard.object(forKey: webChatEnabledKey) as? Bool ?? true
        self.webChatSwiftUIEnabled = UserDefaults.standard.object(forKey: webChatSwiftUIEnabledKey) as? Bool ?? false
        let storedPort = UserDefaults.standard.integer(forKey: webChatPortKey)
        self.webChatPort = storedPort > 0 ? storedPort : 18788
        self.canvasEnabled = UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
        self.attachExistingGatewayOnly = UserDefaults.standard.bool(forKey: attachExistingGatewayOnlyKey)

        if !self.isPreview {
            Task.detached(priority: .utility) { [weak self] in
                let current = await LaunchAgentManager.status()
                await MainActor.run { [weak self] in self?.launchAtLogin = current }
            }
        }

        if self.swabbleEnabled, !PermissionManager.voiceWakePermissionsGranted() {
            self.swabbleEnabled = false
        }

        if !self.isPreview {
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
        }
    }

    func triggerVoiceEars(ttl: TimeInterval? = 5) {
        self.earBoostTask?.cancel()
        self.earBoostActive = true

        guard let ttl else { return }

        self.earBoostTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ttl * 1_000_000_000))
            await MainActor.run { [weak self] in self?.earBoostActive = false }
        }
    }

    func stopVoiceEars() {
        self.earBoostTask?.cancel()
        self.earBoostTask = nil
        self.earBoostActive = false
    }

    func blinkOnce() {
        self.blinkTick &+= 1
    }

    func celebrateSend() {
        self.sendCelebrationTick &+= 1
    }

    func setVoiceWakeEnabled(_ enabled: Bool) async {
        guard voiceWakeSupported else {
            self.swabbleEnabled = false
            return
        }

        self.swabbleEnabled = enabled
        guard !self.isPreview else { return }

        if !enabled {
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        if PermissionManager.voiceWakePermissionsGranted() {
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        self.swabbleEnabled = granted
        Task { await VoiceWakeRuntime.shared.refresh(state: self) }
    }

    func setWorking(_ working: Bool) {
        self.isWorking = working
    }

    // MARK: - Chime persistence

    private static func loadChime(key: String, fallback: VoiceWakeChime) -> VoiceWakeChime {
        guard let data = UserDefaults.standard.data(forKey: key) else { return fallback }
        if let decoded = try? JSONDecoder().decode(VoiceWakeChime.self, from: data) {
            return decoded
        }
        return fallback
    }

    private func storeChime(_ chime: VoiceWakeChime, key: String) {
        guard let data = try? JSONEncoder().encode(chime) else { return }
        UserDefaults.standard.set(data, forKey: key)
    }
}

extension AppState {
    static var preview: AppState {
        let state = AppState(preview: true)
        state.isPaused = false
        state.launchAtLogin = true
        state.onboardingSeen = true
        state.debugPaneEnabled = true
        state.swabbleEnabled = true
        state.swabbleTriggerWords = ["Claude", "Computer", "Jarvis"]
        state.voiceWakeTriggerChime = .system(name: "Glass")
        state.voiceWakeSendChime = .system(name: "Ping")
        state.iconAnimationsEnabled = true
        state.showDockIcon = true
        state.voiceWakeMicID = "BuiltInMic"
        state.voiceWakeLocaleID = Locale.current.identifier
        state.voiceWakeAdditionalLocaleIDs = ["en-US", "de-DE"]
        state.voicePushToTalkEnabled = false
        state.iconOverride = .system
        state.heartbeatsEnabled = true
        state.connectionMode = .local
        state.webChatEnabled = true
        state.webChatSwiftUIEnabled = false
        state.webChatPort = 18788
        state.canvasEnabled = true
        state.remoteTarget = "user@example.com"
        state.remoteIdentity = "~/.ssh/id_ed25519"
        state.remoteProjectRoot = "~/Projects/clawdis"
        state.attachExistingGatewayOnly = false
        return state
    }
}

@MainActor
enum AppStateStore {
    static let shared = AppState()
    static var isPausedFlag: Bool { UserDefaults.standard.bool(forKey: pauseDefaultsKey) }

    static func updateLaunchAtLogin(enabled: Bool) {
        Task.detached(priority: .utility) {
            await LaunchAgentManager.set(enabled: enabled, bundlePath: Bundle.main.bundlePath)
        }
    }

    static var webChatEnabled: Bool {
        UserDefaults.standard.object(forKey: webChatEnabledKey) as? Bool ?? true
    }

    static var webChatSwiftUIEnabled: Bool {
        UserDefaults.standard.object(forKey: webChatSwiftUIEnabledKey) as? Bool ?? false
    }

    static var webChatPort: Int {
        let stored = UserDefaults.standard.integer(forKey: webChatPortKey)
        return stored > 0 ? stored : 18788
    }

    static var canvasEnabled: Bool {
        UserDefaults.standard.object(forKey: canvasEnabledKey) as? Bool ?? true
    }

    static var attachExistingGatewayOnly: Bool {
        UserDefaults.standard.bool(forKey: attachExistingGatewayOnlyKey)
    }
}

@MainActor
enum AppActivationPolicy {
    static func apply(showDockIcon: Bool) {
        NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
    }
}
