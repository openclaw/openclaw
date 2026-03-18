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

        // Do not inject sttBackendName / sttBackendDebugHint into the prompt; the model would
        // otherwise mention them in replies (e.g. "I'm using ExecuTorch...").

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

    /// Returns only the transcript portion of a Talk Mode prompt for UI display, or the original
    /// string if it does not look like a Talk Mode prompt. Use when rendering user message bubbles
    /// so the chat shows only what the user said, not the system instructions.
    public static func displayText(fromPrompt prompt: String) -> String {
        let trimmed = prompt.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed.contains("Talk Mode active."),
              let range = trimmed.range(of: "\n\n")
        else { return prompt }
        let before = String(trimmed[..<range.lowerBound])
        guard before.hasPrefix("Talk Mode active.") else { return prompt }
        return String(trimmed[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
