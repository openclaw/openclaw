import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw

@Suite(.serialized) struct VoiceWakeGlobalSettingsSyncTests {
    private func voiceWakeChangedEvent(payload: OpenClawProtocol.AnyCodable) -> EventFrame {
        EventFrame(
            type: "event",
            event: "voicewake.changed",
            payload: payload,
            seq: nil,
            stateversion: nil)
    }

    private func applyTriggersAndCapturePrevious(_ triggers: [String]) async -> [String] {
        let previous = await MainActor.run { AppStateStore.shared.swabbleTriggerWords }
        await MainActor.run {
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(triggers)
        }
        return previous
    }

    @Test func appliesVoiceWakeChangedEventToAppState() async {
        let previous = await applyTriggersAndCapturePrevious(["before"])
        let evt = voiceWakeChangedEvent(payload: OpenClawProtocol.AnyCodable(["triggers": ["openclaw", "computer"]]))

        await VoiceWakeGlobalSettingsSync.shared.handle(push: .event(evt))

        let updated = await MainActor.run { AppStateStore.shared.swabbleTriggerWords }
        #expect(updated == ["openclaw", "computer"])

        await MainActor.run {
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(previous)
        }
    }

    @Test func ignoresVoiceWakeChangedEventWithInvalidPayload() async {
        let previous = await applyTriggersAndCapturePrevious(["before"])
        let evt = voiceWakeChangedEvent(payload: OpenClawProtocol.AnyCodable(["unexpected": 123]))

        await VoiceWakeGlobalSettingsSync.shared.handle(push: .event(evt))

        let updated = await MainActor.run { AppStateStore.shared.swabbleTriggerWords }
        #expect(updated == ["before"])

        await MainActor.run {
            AppStateStore.shared.applyGlobalVoiceWakeTriggers(previous)
        }
    }
}
