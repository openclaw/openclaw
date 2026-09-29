import Foundation

extension AppState {
    func persistTalkSpokenExitAcknowledgementPreference(previousValue: Bool) {
        guard !self.isPreview else { return }
        AppDefaults.standard.set(
            self.talkSpokenExitAcknowledgementEnabled, forKey: talkSpokenExitAcknowledgementEnabledKey)
        guard self.talkEnabled, self.talkSpokenExitAcknowledgementEnabled != previousValue else { return }
        Task { await TalkModeRuntime.shared.localTalkExitPreferencesDidChange() }
    }

    func persistTalkRealtimeRelayPreference(previousValue: Bool) {
        guard !self.isPreview else { return }
        AppDefaults.standard.set(self.talkRealtimeRelayEnabled, forKey: talkRealtimeRelayEnabledKey)
        guard self.talkEnabled, self.talkRealtimeRelayEnabled != previousValue else { return }
        Task { await TalkModeRuntime.shared.realtimeRelayPreferenceDidChange() }
    }

    func setTalkEnabled(_ enabled: Bool, onLocalDisable: (@MainActor () -> Void)? = nil) async {
        let wasEnabled = self.talkEnabled
        self.talkEnabled = enabled && voiceWakeSupported
        guard !self.isPreview else { return }

        if !self.talkEnabled {
            // A caller that already retired local audio can confirm shutdown before
            // Gateway publication suspends and the controller resumes Voice Wake.
            if wasEnabled { onLocalDisable?() }
            await GatewayConnection.shared.talkMode(enabled: false, phase: "disabled")
            return
        }

        if PermissionManager.voiceWakePermissionsGranted() {
            await GatewayConnection.shared.talkMode(enabled: true, phase: "enabled")
            return
        }

        let granted = await PermissionManager.ensureVoiceWakePermissions(interactive: true)
        self.talkEnabled = granted
        await GatewayConnection.shared.talkMode(enabled: granted, phase: granted ? "enabled" : "denied")
    }
}
