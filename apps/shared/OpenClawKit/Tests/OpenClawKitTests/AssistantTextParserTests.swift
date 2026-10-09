import Testing
@testable import OpenClawChatUI

@Suite struct AssistantTextParserTests {
    @Test func splitsThinkAndFinalSegments() {
        let segments = AssistantTextParser.segments(
            from: "<think>internal</think>\n\n<final>Hello there</final>")

        #expect(segments.count == 2)
        #expect(segments[0].kind == .thinking)
        #expect(segments[0].text == "internal")
        #expect(segments[1].kind == .response)
        #expect(segments[1].text == "Hello there")
    }

    @Test func keepsTextWithoutTags() {
        let segments = AssistantTextParser.segments(from: "Just text.")

        #expect(segments.count == 1)
        #expect(segments[0].kind == .response)
        #expect(segments[0].text == "Just text.")
    }

    @Test func ignoresThinkingLikeTags() {
        let raw = "<thinking>example</thinking>\nKeep this."
        let segments = AssistantTextParser.segments(from: raw)

        #expect(segments.count == 1)
        #expect(segments[0].kind == .response)
        #expect(segments[0].text == raw.trimmingCharacters(in: .whitespacesAndNewlines))
    }

    @Test func `matches tags in any case with attributes and skips lookalikes`() {
        let segments = AssistantTextParser.segments(
            from: "a < b <final-ish>kept</final-ish> <THINK id=\"1\">hidden</Think > <Final/>shown</FINAL")

        #expect(segments.map(\.kind) == [.response, .thinking, .response])
        #expect(segments.map(\.text) == ["a < b <final-ish>kept</final-ish>", "hidden", "shown"])
    }

    @Test(arguments: ["<\u{0301}think>shown", "<\u{0338}think>shown", "<\u{0301}final>shown"])
    func `keeps combining-only opening delimiters as visible literal text`(_ raw: String) {
        let segments = AssistantTextParser.segments(from: raw)

        #expect(segments.map(\.kind) == [.response])
        #expect(segments.map(\.text) == [raw])
        #expect(AssistantTextParser.visibleSegments(from: raw).map(\.text) == [raw])
        #expect(AssistantTextParser.hasVisibleContent(in: raw))
    }

    @Test func `preserves folded tags when a plain delimiter admits parsing`() {
        let raw = "<\u{0301}think>hidden</think>shown"
        let segments = AssistantTextParser.segments(from: raw)

        #expect(segments.map(\.kind) == [.thinking, .response])
        #expect(segments.map(\.text) == ["hidden", "shown"])
        #expect(AssistantTextParser.visibleSegments(from: raw).map(\.text) == ["shown"])
    }

    @Test func dropsEmptyTaggedContent() {
        let segments = AssistantTextParser.segments(from: "<think></think>")
        #expect(segments.isEmpty)
    }

    @Test func hidesThinkingSegmentsFromVisibleOutput() {
        let segments = AssistantTextParser.visibleSegments(
            from: "<think>internal</think>\n\n<final>Hello there</final>")

        #expect(segments.count == 1)
        #expect(segments[0].kind == .response)
        #expect(segments[0].text == "Hello there")
    }

    @Test func thinkingOnlyTextIsNotVisibleByDefault() {
        #expect(AssistantTextParser.hasVisibleContent(in: "<think>internal</think>") == false)
        #expect(AssistantTextParser.hasVisibleContent(in: "<think>internal</think>", includeThinking: true))
    }

    @Test func usesStableSegmentIDsAcrossRepeatedParses() {
        let raw = "<think>internal</think>\n\n<final>Hello there</final>"
        let first = AssistantTextParser.segments(from: raw, includeThinking: true)
        let second = AssistantTextParser.segments(from: raw, includeThinking: true)

        #expect(first.map(\.id) == [0, 1])
        #expect(first.map(\.id) == second.map(\.id))
    }

    /// The Foundation-search scanner this parser used before the byte scan, kept as the reference to compare with.
    private enum ReferenceScanner {
        static func nextTag(
            in text: String,
            from start: String.Index) -> (kind: AssistantTextSegment.Kind, range: Range<String.Index>)?
        {
            let tags: [(name: String, closing: Bool, kind: AssistantTextSegment.Kind)] = [
                ("think", false, .thinking), ("think", true, .response),
                ("final", false, .response), ("final", true, .response),
            ]
            let candidates = tags.compactMap { tag in
                self.findTagStart(tag: tag.name, closing: tag.closing, in: text, from: start).map { (tag.kind, $0) }
            }
            return candidates.min { $0.1.lowerBound < $1.1.lowerBound }.map { (kind: $0.0, range: $0.1) }
        }

        static func findTagStart(tag: String, closing: Bool, in text: String, from start: String.Index)
            -> Range<String.Index>?
        {
            let token = closing ? "</\(tag)" : "<\(tag)"
            var searchRange = start..<text.endIndex
            while let range = text.range(
                of: token,
                options: [.caseInsensitive, .diacriticInsensitive],
                range: searchRange)
            {
                let boundaryIndex = range.upperBound
                guard boundaryIndex < text.endIndex else { return range }
                let boundary = text[boundaryIndex]
                if boundary == ">" || boundary.isWhitespace || (!closing && boundary == "/") { return range }
                searchRange = boundaryIndex..<text.endIndex
            }
            return nil
        }
    }

    @Test func `byte scan finds the same tags as the Foundation search`() {
        let mismatches = Self.scanMismatches(pieces: Self.tagLikePieces)
        #expect(mismatches.isEmpty, "\(mismatches.prefix(12))")
    }

    /// Tag fragments plus the accented, combining, joined and look-alike forms the folding search accepts or rejects.
    private static let tagLikePieces = [
        "<", "</", "<think", "</think", "<final", "</final", "THINK", "Final", "think", "final", ">", "/>",
        " ", "\n", "/", "x", "thinking", "finally", "<thinker>", "é", "🙂", "<", "<",
        "<th\u{ED}nk", "</th\u{ED}nk", "<thi\u{301}nk", "<think\u{301}", "<F\u{130}NAL", "<\u{FF54}hink",
        "\u{226E}think", "<\u{338}think", "<fina\u{142}", "<\u{DE}ink", "\u{301}", "\u{338}", "\u{200D}",
        "\u{FE0F}", "\u{600}", "\u{E2}", "\u{2014}", "\u{226E}", "\u{226F}", "\u{3000}", "\u{A0}",
    ]

    /// Inputs on which the byte scan and the reference disagree, as "text @offset: reference vs actual".
    private static func scanMismatches(pieces: [String], samples: Int = 1500) -> [String] {
        var seed: UInt64 = 0x2545_F491_4F6C_DD1D
        func next(_ bound: Int) -> Int {
            seed = seed &* 6_364_136_223_846_793_005 &+ 1_442_695_040_888_963_407
            return Int((seed >> 33) % UInt64(bound))
        }
        func show(_ text: String, _ range: Range<String.Index>?) -> String {
            range.map { String(text[$0]).debugDescription } ?? "nil"
        }
        var mismatches: [String] = []
        for _ in 0..<samples {
            let text = (0..<(1 + next(14))).map { _ in pieces[next(pieces.count)] }.joined()
            var start = text.startIndex
            while true {
                let expected = ReferenceScanner.nextTag(in: text, from: start)
                let actual = AssistantTextParser.nextTag(in: text, from: start)
                if expected?.range != actual?.range || expected?.kind != actual?.kind {
                    let offset = text.distance(from: text.startIndex, to: start)
                    let found = "\(show(text, expected?.range)) vs \(show(text, actual?.range))"
                    mismatches.append("\(text.debugDescription) @\(offset): \(found)")
                }
                guard start < text.endIndex else { break }
                // Every scalar boundary: a search can resume inside a character, right after a tag's `>`.
                start = text.unicodeScalars.index(after: start)
            }
        }
        return mismatches
    }
}
