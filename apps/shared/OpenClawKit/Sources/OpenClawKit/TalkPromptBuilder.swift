public enum TalkPromptBuilder: Sendable {
    public static func build(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true) -> String
    {
        var lines: [String] = [
            "Talk Mode active. Reply in a concise, spoken tone.",
            "Return exactly one compact JSON object like {\"response\":\"...\"}. The voice layer will speak only `response`; put no tool notes, routing notes, or metadata in it. Do not wrap the JSON in Markdown.",
        ]

        if includeVoiceDirectiveHint {
            lines.append(
                "Optional provider-neutral voice controls may be included as sibling JSON fields; they are not spoken.")
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
