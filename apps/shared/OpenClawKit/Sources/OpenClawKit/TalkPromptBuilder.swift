public enum TalkPromptBuilder: Sendable {
    public static func build(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true) -> String
    {
        _ = includeVoiceDirectiveHint
        guard let interruptedAtSeconds else {
            return transcript
        }

        let formatted = String(format: "%.1f", interruptedAtSeconds)
        return "Assistant speech interrupted at \(formatted)s.\n\n\(transcript)"
    }
}
