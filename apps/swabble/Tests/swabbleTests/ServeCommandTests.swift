import Foundation
import XCTest
@testable import Swabble
@testable import SwabbleCLI

@available(macOS 26.0, *)
@MainActor
final class ServeCommandTests: XCTestCase {
    func testTranscriptStreamKeepsCooldownAndMeasuresStrippedText() async throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let output = directory.appendingPathComponent("hook-output.txt")

        var config = SwabbleConfig()
        config.transcripts.enabled = false
        config.hook.command = "/bin/sh"
        config.hook.args = ["-c", #"printf '%s\n' "$SWABBLE_TEXT" >> "$SWABBLE_TEST_OUTPUT""#]
        config.hook.env = ["SWABBLE_TEST_OUTPUT": output.path]
        config.hook.minCharacters = 6
        config.hook.cooldownSeconds = .greatestFiniteMagnitude

        let stream = AsyncStream<SpeechSegment> { continuation in
            for (text, isFinal) in [
                ("background speech", false),
                ("clawd tiny", false),
                ("clawd run me", false),
                ("clawd run next", true),
            ] {
                continuation.yield(SpeechSegment(text: text, isFinal: isFinal))
            }
            continuation.finish()
        }
        try await ServeCommand.consumeTranscripts(stream, config: config, logger: Logger(level: .error))

        XCTAssertEqual(try String(contentsOf: output, encoding: .utf8), "run me\n")
    }
}
