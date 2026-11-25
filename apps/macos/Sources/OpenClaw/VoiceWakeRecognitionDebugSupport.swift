import SwabbleKit

enum VoiceWakeRecognitionDebugSupport {
    static func textOnlyFallbackMatch(
        transcript: String,
        triggers: [String],
        config: WakeWordGateConfig,
        trimWake: (String, [String]) -> String) -> WakeWordGateMatch?
    {
        guard let command = VoiceWakeTextUtils.textOnlyCommand(
            transcript: transcript,
            triggers: triggers,
            minCommandLength: config.minCommandLength,
            trimWake: trimWake)
        else { return nil }
        return WakeWordGateMatch(
            triggerEndTime: 0,
            postGap: 0,
            command: command,
            trigger: VoiceWakeTextUtils.matchedTriggerWord(transcript: transcript, triggers: triggers))
    }

    static func triggerOnlyFallbackMatch(
        transcript: String,
        triggers: [String],
        trimWake: (String, [String]) -> String) -> WakeWordGateMatch?
    {
        guard VoiceWakeTextUtils.isTriggerOnly(
            transcript: transcript,
            triggers: triggers,
            trimWake: trimWake)
        else { return nil }
        return WakeWordGateMatch(
            triggerEndTime: 0,
            postGap: 0,
            command: "",
            trigger: VoiceWakeTextUtils.matchedTriggerWord(transcript: transcript, triggers: triggers))
    }
}
