public enum TalkPromptBuilder: Sendable {
    public static func build(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true) -> String
    {
        // Kept for source compatibility; talk prompts should not add visible
        // instruction preambles to the user-facing chat message.
        _ = includeVoiceDirectiveHint

        var lines: [String] = []

        if let interruptedAtSeconds {
            let formatted = String(format: "%.1f", interruptedAtSeconds)
            lines.append("Assistant speech interrupted at \(formatted)s.")
        }

        if !lines.isEmpty {
            lines.append("")
        }
        lines.append(transcript)
        return lines.joined(separator: "\n")
    }
}
