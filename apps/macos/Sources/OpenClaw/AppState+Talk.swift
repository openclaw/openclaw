import Foundation

extension AppState {
    func persistTalkRealtimeRelayPreference(previousValue: Bool) {
        if !self.isPreview {
            AppDefaults.standard.set(self.talkRealtimeRelayEnabled, forKey: talkRealtimeRelayEnabledKey)
        }
        guard self.voiceRuntime.isActive, self.talkEnabled,
              self.talkRealtimeRelayEnabled != previousValue else { return }
        Task { [runtime = self.voiceRuntime.talkRuntime] in await runtime.realtimeRelayPreferenceDidChange() }
    }
}
