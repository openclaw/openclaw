public struct TalkPromptTurn: Equatable, Sendable {
    public let message: String
    public let runtimePromptContext: String?

    public init(message: String, runtimePromptContext: String?) {
        self.message = message
        self.runtimePromptContext = runtimePromptContext
    }
}

public enum TalkPromptBuilder: Sendable {
    public static func buildTurn(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true) -> TalkPromptTurn
    {
        TalkPromptTurn(
            message: transcript,
            runtimePromptContext: self.buildRuntimePromptContext(
                interruptedAtSeconds: interruptedAtSeconds,
                includeVoiceDirectiveHint: includeVoiceDirectiveHint))
    }

    public static func buildRuntimePromptContext(
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true) -> String?
    {
        var lines: [String] = [
            "Talk Mode active. Reply in a concise, spoken tone.",
        ]

        if includeVoiceDirectiveHint {
            lines.append(
                "You may optionally prefix the response with JSON (first line) to set ElevenLabs voice (id or alias), e.g. {\"voice\":\"<id>\",\"once\":true}.")
        }

        if let interruptedAtSeconds {
            let formatted = String(format: "%.1f", interruptedAtSeconds)
            lines.append("Assistant speech interrupted at \(formatted)s.")
        }

        let prompt = lines.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
        return prompt.isEmpty ? nil : prompt
    }

    public static func build(
        transcript: String,
        interruptedAtSeconds: Double?,
        includeVoiceDirectiveHint: Bool = true) -> String
    {
        let turn = self.buildTurn(
            transcript: transcript,
            interruptedAtSeconds: interruptedAtSeconds,
            includeVoiceDirectiveHint: includeVoiceDirectiveHint)
        return [
            turn.runtimePromptContext,
            turn.message,
        ]
        .compactMap { $0 }
        .joined(separator: "\n\n")
    }
}
