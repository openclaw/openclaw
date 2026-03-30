import Foundation
import Testing
@testable import Swabble

@Test
func redactMasksEmailPhoneAndQueryValues() {
    let input = "Reach me at person@example.com or +1 (415) 555-1212. URL: https://example.com/search?q=openclaw&lang=en"
    let output = redact(input)

    #expect(output.contains("[REDACTED_EMAIL]"))
    #expect(output.contains("[REDACTED_PHONE]"))
    #expect(output.contains("q=[REDACTED_QUERY]"))
    #expect(output.contains("lang=[REDACTED_QUERY]"))
}

@Test
func loggerProducesJsonSchemaAndRedactsSensitiveFields() throws {
    let logger = Logger(level: .trace, format: .json, redactPii: true)
    let timestamp = Date(timeIntervalSince1970: 0)

    let line = try #require(logger.formattedLine(
        .info,
        event: "wake.detected",
        message: "Wake word from person@example.com",
        fields: [
            "transcript": .string("clawd turn on the lights"),
            "confidence": .double(0.92),
            "device": .string("Built-in Microphone"),
            "url": .string("https://example.com/find?q=hello")
        ],
        timestamp: timestamp))

    let data = Data(line.utf8)
    let jsonObject = try #require(try JSONSerialization.jsonObject(with: data) as? [String: Any])
    let fields = try #require(jsonObject["fields"] as? [String: Any])

    #expect(jsonObject["ts"] as? String == "1970-01-01T00:00:00.000Z")
    #expect(jsonObject["level"] as? String == "info")
    #expect(jsonObject["event"] as? String == "wake.detected")
    #expect(jsonObject["message"] as? String == "Wake word from [REDACTED_EMAIL]")
    #expect(fields["transcript"] as? String == "[REDACTED_TEXT]")
    #expect(fields["confidence"] as? Double == 0.92)
    #expect(fields["url"] as? String == "https://example.com/find?q=[REDACTED_QUERY]")
}

@Test
func loggerTextFormatKeepsReadableOutput() throws {
    let logger = Logger(level: .debug, format: .text, redactPii: false)
    let timestamp = Date(timeIntervalSince1970: 0)

    let line = try #require(logger.formattedLine(
        .info,
        event: "log",
        message: "plain text line",
        timestamp: timestamp))

    #expect(line == "[INFO] 1970-01-01T00:00:00.000Z | plain text line")
}

@Test
func loggerFiltersMessagesBelowConfiguredLevel() {
    let logger = Logger(level: .warn, format: .json, redactPii: true)
    let line = logger.formattedLine(.info, event: "noop", message: "ignored")
    #expect(line == nil)
}

@Test
func transcriptRedactionHelperRespectsToggle() {
    #expect(redactTranscriptIfNeeded("keep this", enabled: false) == "keep this")
    #expect(redactTranscriptIfNeeded("hide this", enabled: true) == "[REDACTED_TEXT]")
}
