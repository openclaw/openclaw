import AppKit
import Foundation
import ServiceManagement
import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var isPaused: Bool {
        didSet { UserDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) }
    }

    @Published var defaultSound: String {
        didSet { UserDefaults.standard.set(self.defaultSound, forKey: "clawdis.defaultSound") }
    }

    @Published var launchAtLogin: Bool {
        didSet { Task { AppStateStore.updateLaunchAtLogin(enabled: self.launchAtLogin) } }
    }

    @Published var onboardingSeen: Bool {
        didSet { UserDefaults.standard.set(self.onboardingSeen, forKey: "clawdis.onboardingSeen") }
    }

    @Published var debugPaneEnabled: Bool {
        didSet { UserDefaults.standard.set(self.debugPaneEnabled, forKey: "clawdis.debugPaneEnabled") }
    }

    @Published var swabbleEnabled: Bool {
        didSet {
            UserDefaults.standard.set(self.swabbleEnabled, forKey: swabbleEnabledKey)
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
        }
    }

    @Published var swabbleTriggerWords: [String] {
        didSet {
            let cleaned = self.swabbleTriggerWords.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            UserDefaults.standard.set(cleaned, forKey: swabbleTriggersKey)
            if cleaned.count != self.swabbleTriggerWords.count {
                self.swabbleTriggerWords = cleaned
                return
            }
            if self.swabbleEnabled {
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var iconAnimationsEnabled: Bool {
        didSet { UserDefaults.standard.set(self.iconAnimationsEnabled, forKey: iconAnimationsEnabledKey) }
    }

    @Published var showDockIcon: Bool {
        didSet {
            UserDefaults.standard.set(self.showDockIcon, forKey: showDockIconKey)
            AppActivationPolicy.apply(showDockIcon: self.showDockIcon)
        }
    }

    @Published var voiceWakeMicID: String {
        didSet {
            UserDefaults.standard.set(self.voiceWakeMicID, forKey: voiceWakeMicKey)
            if self.swabbleEnabled {
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var voiceWakeLocaleID: String {
        didSet {
            UserDefaults.standard.set(self.voiceWakeLocaleID, forKey: voiceWakeLocaleKey)
            if self.swabbleEnabled {
                Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            }
        }
    }

    @Published var voiceWakeAdditionalLocaleIDs: [String] {
        didSet { UserDefaults.standard.set(self.voiceWakeAdditionalLocaleIDs, forKey: voiceWakeAdditionalLocalesKey) }
    }

    @Published var voiceWakeForwardEnabled: Bool {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardEnabled, forKey: voiceWakeForwardEnabledKey) }
    }

    @Published var voiceWakeForwardTarget: String {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardTarget, forKey: voiceWakeForwardTargetKey) }
    }

    @Published var voiceWakeForwardIdentity: String {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardIdentity, forKey: voiceWakeForwardIdentityKey) }
    }

    @Published var voiceWakeForwardCommand: String {
        didSet { UserDefaults.standard.set(self.voiceWakeForwardCommand, forKey: voiceWakeForwardCommandKey) }
    }

    @Published var isWorking: Bool = false
    @Published var earBoostActive: Bool = false
    @Published var heartbeatsEnabled: Bool {
        didSet {
            UserDefaults.standard.set(self.heartbeatsEnabled, forKey: heartbeatsEnabledKey)
            Task { _ = await AgentRPC.shared.setHeartbeatsEnabled(self.heartbeatsEnabled) }
        }
    }

    private var earBoostTask: Task<Void, Never>?

    init() {
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.defaultSound = UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? ""
        self.launchAtLogin = LaunchAgentManager.status()
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdis.debugPaneEnabled")
        let savedVoiceWake = UserDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleEnabled = voiceWakeSupported ? savedVoiceWake : false
        self.swabbleTriggerWords = UserDefaults.standard
            .stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
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
        self.voiceWakeForwardEnabled = UserDefaults.standard.bool(forKey: voiceWakeForwardEnabledKey)
        let legacyTarget = Self.legacyTargetString()
        self.voiceWakeForwardTarget = UserDefaults.standard
            .string(forKey: voiceWakeForwardTargetKey) ?? legacyTarget
        self.voiceWakeForwardIdentity = UserDefaults.standard.string(forKey: voiceWakeForwardIdentityKey) ?? ""
        self.voiceWakeForwardCommand = UserDefaults.standard
            .string(forKey: voiceWakeForwardCommandKey) ?? defaultVoiceWakeForwardCommand
        if let storedHeartbeats = UserDefaults.standard.object(forKey: heartbeatsEnabledKey) as? Bool {
            self.heartbeatsEnabled = storedHeartbeats
        } else {
            self.heartbeatsEnabled = true
            UserDefaults.standard.set(true, forKey: heartbeatsEnabledKey)
        }

        if self.swabbleEnabled && !PermissionManager.voiceWakePermissionsGranted() {
            self.swabbleEnabled = false
        }

        Task { await VoiceWakeRuntime.shared.refresh(state: self) }
    }

    func triggerVoiceEars(ttl: TimeInterval = 5) {
        self.earBoostTask?.cancel()
        self.earBoostActive = true
        self.earBoostTask = Task { [weak self] in
            try? await Task.sleep(nanoseconds: UInt64(ttl * 1_000_000_000))
            await MainActor.run { [weak self] in self?.earBoostActive = false }
        }
    }

    func setVoiceWakeEnabled(_ enabled: Bool) async {
        guard voiceWakeSupported else {
            self.swabbleEnabled = false
            return
        }

        if !enabled {
            self.swabbleEnabled = false
            Task { await VoiceWakeRuntime.shared.refresh(state: self) }
            return
        }

        if PermissionManager.voiceWakePermissionsGranted() {
            self.swabbleEnabled = true
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
}

@MainActor
enum AppStateStore {
    static let shared = AppState()
    static var isPausedFlag: Bool { UserDefaults.standard.bool(forKey: pauseDefaultsKey) }
    static var defaultSound: String { UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? "" }

    static func updateLaunchAtLogin(enabled: Bool) {
        LaunchAgentManager.set(enabled: enabled, bundlePath: Bundle.main.bundlePath)
    }
}

extension AppState {
    var voiceWakeForwardConfig: VoiceWakeForwardConfig {
        VoiceWakeForwardConfig(
            enabled: self.voiceWakeForwardEnabled,
            target: self.voiceWakeForwardTarget,
            identityPath: self.voiceWakeForwardIdentity,
            commandTemplate: self.voiceWakeForwardCommand,
            timeout: defaultVoiceWakeForwardTimeout)
    }

    private static func legacyTargetString() -> String {
        let host = UserDefaults.standard.string(forKey: voiceWakeForwardHostKey) ?? ""
        let user = UserDefaults.standard.string(forKey: voiceWakeForwardUserKey) ?? ""
        let savedPort = UserDefaults.standard.integer(forKey: voiceWakeForwardPortKey)
        let port = savedPort == 0 ? defaultVoiceWakeForwardPort : savedPort
        let userPrefix = user.isEmpty ? "" : "\(user)@"
        let portSuffix = host.isEmpty ? "" : ":\(port)"
        return "\(userPrefix)\(host)\(portSuffix)"
    }
}

@MainActor
enum AppActivationPolicy {
    static func apply(showDockIcon: Bool) {
        NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
    }
}
