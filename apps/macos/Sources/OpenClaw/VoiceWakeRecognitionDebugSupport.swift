import Foundation
import SwabbleKit

enum VoiceWakeRecognitionDebugSupport {
    struct TranscriptSummary {
        let textOnly: Bool
        let timingCount: Int
    }

    static func shouldLogTranscript(
        transcript: String,
        isFinal: Bool,
        loggerLevel: Logger.Level,
        lastLoggedText: inout String?,
        lastLoggedAt: inout Date?,
        minRepeatInterval: TimeInterval = 0.25) -> Bool
    {
        guard !transcript.isEmpty else { return false }
        guard loggerLevel == .debug || loggerLevel == .trace else { return false }
        if transcript == lastLoggedText,
           !isFinal,
           let last = lastLoggedAt,
           Date().timeIntervalSince(last) < minRepeatInterval
        {
            return false
        }
        lastLoggedText = transcript
        lastLoggedAt = Date()
        return true
    }

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

    static func appendedTextOnlyFallbackMatch(
        transcript: String,
        previousTranscript: String?,
        triggers: [String],
        config: WakeWordGateConfig,
        allowTriggerOnly: Bool,
        trimWake: (String, [String]) -> String) -> WakeWordGateMatch?
    {
        guard let appended = self.appendedTranscriptDelta(
            transcript: transcript,
            previousTranscript: previousTranscript)
        else { return nil }

        if let match = self.textOnlyFallbackMatch(
            transcript: appended,
            triggers: triggers,
            config: config,
            trimWake: trimWake)
        {
            return match
        }

        guard allowTriggerOnly else { return nil }
        return self.triggerOnlyFallbackMatch(
            transcript: appended,
            triggers: triggers,
            trimWake: trimWake)
    }

    private static func appendedTranscriptDelta(
        transcript: String,
        previousTranscript: String?) -> String?
    {
        guard !transcript.isEmpty else { return nil }
        guard let previousTranscript, !previousTranscript.isEmpty else { return transcript }
        guard transcript.hasPrefix(previousTranscript) else { return nil }

        let rawDelta = transcript.dropFirst(previousTranscript.count)
        guard !rawDelta.isEmpty else { return nil }
        guard self.hasBoundaryBetween(prefix: previousTranscript, suffix: rawDelta) else { return nil }

        let delta = rawDelta.trimmingCharacters(in: .whitespacesAndNewlines)
        return delta.isEmpty ? nil : String(delta)
    }

    private static func hasBoundaryBetween(prefix: String, suffix: Substring) -> Bool {
        guard let before = prefix.unicodeScalars.last, let after = suffix.unicodeScalars.first else { return true }
        return !self.isASCIIWordScalar(before) || !self.isASCIIWordScalar(after)
    }

    private static func isASCIIWordScalar(_ scalar: UnicodeScalar) -> Bool {
        scalar.isASCII && CharacterSet.alphanumerics.contains(scalar)
    }

    static func transcriptSummary(
        transcript: String,
        triggers: [String],
        segments: [WakeWordSegment]) -> TranscriptSummary
    {
        TranscriptSummary(
            textOnly: WakeWordGate.matchesTextOnly(text: transcript, triggers: triggers),
            timingCount: segments.count(where: { $0.start > 0 || $0.duration > 0 }))
    }

    static func matchSummary(_ match: WakeWordGateMatch?) -> String {
        match.map {
            "match=true gap=\(String(format: "%.2f", $0.postGap))s cmdLen=\($0.command.count)"
        } ?? "match=false"
    }
}
