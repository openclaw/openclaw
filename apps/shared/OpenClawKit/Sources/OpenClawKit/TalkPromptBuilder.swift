public enum TalkPromptBuilder: Sendable {
    public static func build(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true
    ) -> String {
        var lines: [String] = [
            "Talk Mode active. Reply in a concise, spoken tone.",
        ]

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
        guard trimmed.contains("Talk Mode active.") else { return prompt }

        // Strip leading System: lines (gateway-injected events like node connect/launch).
        let lines = trimmed.components(separatedBy: "\n")
        var contentStart = 0
        for (i, line) in lines.enumerated() {
            let stripped = line.trimmingCharacters(in: .whitespacesAndNewlines)
            if stripped.isEmpty || stripped.hasPrefix("System:") || stripped.hasPrefix("System (untrusted)") {
                contentStart = i + 1
            } else {
                break
            }
        }
        let withoutSystemLines = lines[contentStart...].joined(separator: "\n")
            .trimmingCharacters(in: .whitespacesAndNewlines)

        guard withoutSystemLines.contains("Talk Mode active."),
              let range = withoutSystemLines.range(of: "\n\n")
        else { return prompt }
        let before = String(withoutSystemLines[..<range.lowerBound])
        guard before.contains("Talk Mode active.") else { return prompt }
        return String(withoutSystemLines[range.upperBound...]).trimmingCharacters(in: .whitespacesAndNewlines)
    }
}
