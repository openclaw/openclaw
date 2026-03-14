public enum TalkPromptBuilder: Sendable {
    public static func build(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true,
        sttBackendName: String? = nil,
        sttBackendDebugHint: String? = nil
    ) -> String {
        var lines: [String] = [
            "Talk Mode active. Reply in a concise, spoken tone.",
        ]

        if let sttBackendName {
            lines.append("STT: \(sttBackendName).")
        }
        if let sttBackendDebugHint, !sttBackendDebugHint.isEmpty {
            lines.append("(\(sttBackendDebugHint))")
        }

        if includeVoiceDirectiveHint {
            lines.append(
                "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {\"voice\":\"<id>\",\"once\":true}."
            )
        }

        if let interruptedAtSeconds {
            let formatted = String(format: "%.1f", interruptedAtSeconds)
            lines.append("Assistant speech interrupted at \(formatted)s.")
        }

        lines.append("")
        lines.append(transcript)
        return lines.joined(separator: "\n")
    }
}
