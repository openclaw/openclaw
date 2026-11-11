import Testing
@testable import OpenClawChatUI

struct ChatStreamingRevealTests {
    @Test func `word boundaries use whitespace and preserve gaps`() {
        let text = "one  two\n\nthree\tfour"
        let words = chatStreamingWordRanges(in: text).map { range in
            let lower = text.index(text.startIndex, offsetBy: range.lowerBound)
            let upper = text.index(text.startIndex, offsetBy: range.upperBound)
            return String(text[lower..<upper])
        }

        #expect(words == ["one", "two", "three", "four"])
    }

    @Test func `appended words receive staggered deadlines`() {
        let state = step(
            state: ChatStreamingRevealState(),
            newText: "one two three",
            now: 10)

        #expect(state.words.count == 3)
        #expect(abs(state.words[1].deadline - state.words[0].deadline - 0.04) < 0.0001)
        #expect(abs(state.words[2].deadline - state.words[1].deadline - 0.04) < 0.0001)
    }

    @Test func `burst catch up is capped and retains only trailing window`() throws {
        let text = (0..<40).map { "word\($0)" }.joined(separator: " ")
        let state = step(state: ChatStreamingRevealState(), newText: text, now: 20)

        #expect(state.words.count == 24)
        #expect((state.latestDeadline ?? .infinity) <= 20.400001)
        #expect(try state.words.first?.characterRange.lowerBound == text.distance(
            from: text.startIndex,
            to: #require(text.range(of: "word16")?.lowerBound)))
    }

    @Test func `revealed word never becomes hidden after append`() {
        let initial = step(state: ChatStreamingRevealState(), newText: "one", now: 0)
        let revealed = revealedOpacities(state: initial, now: 0.2)
        #expect(revealed.fading.isEmpty)

        let appended = step(state: initial, newText: "one two", now: 0.2)
        let frame = revealedOpacities(state: appended, now: 0.2)
        #expect(frame.fading.first?.characterRange == 4..<7)
        #expect(frame.fading.count == 1)
    }

    @Test func `non append rewrite reveals replacement immediately then restarts`() {
        let initial = step(state: ChatStreamingRevealState(), newText: "draft words", now: 0)
        let rewritten = step(state: initial, newText: "replacement text", now: 0.01)

        #expect(rewritten.words.isEmpty)
        #expect(revealedOpacities(state: rewritten, now: 0.01).fading.isEmpty)

        let appended = step(state: rewritten, newText: "replacement text continues", now: 0.02)
        #expect(appended.words.count == 1)
    }

    @Test func `empty state schedules first delta`() {
        let empty = step(state: ChatStreamingRevealState(), newText: "", now: 0)
        let first = step(state: empty, newText: "hello", now: 1)

        #expect(empty.words.isEmpty)
        #expect(first.words.count == 1)
        #expect(revealedOpacities(state: first, now: 1).fading.first?.opacity == 0)
    }

    @Test func `unicode runs are one word without whitespace and reveal fully`() {
        let text = "👋🏽你好世界"
        let state = step(state: ChatStreamingRevealState(), newText: text, now: 5)

        #expect(state.words.count == 1)
        #expect(state.words.first?.characterRange == 0..<text.count)
        #expect(revealedOpacities(state: state, now: 6).fading.isEmpty)
    }

    struct AppendScheduleCase: Sendable {
        struct Sample: Sendable {
            let index: Int
            let range: Range<Int>
            let fadeStart: Double
            let deadline: Double
        }

        let initialText: String
        let appendedText: String
        let now: Double
        let wordCount: Int
        let samples: [Sample]
    }

    @Test(arguments: [
        AppendScheduleCase(
            initialText: "hel",
            appendedText: "hello one",
            now: 0.02,
            wordCount: 2,
            samples: [
                .init(index: 0, range: 0..<5, fadeStart: 0, deadline: 0.12),
                .init(index: 1, range: 6..<9, fadeStart: 0.06, deadline: 0.18),
            ]),
        AppendScheduleCase(
            initialText: "one two",
            appendedText: "one two three",
            now: 0.06,
            wordCount: 3,
            samples: [
                .init(index: 0, range: 0..<3, fadeStart: 0, deadline: 0.12),
                .init(index: 1, range: 4..<7, fadeStart: 0.04, deadline: 0.16),
                .init(index: 2, range: 8..<13, fadeStart: 0.14, deadline: 0.26),
            ]),
        AppendScheduleCase(
            initialText: "a b c d e f g h i j k l m n o p q r s t u v",
            appendedText: "a b c d e f g h i j k l m n o p q r s t u v w x y z",
            now: 0.01,
            wordCount: 24,
            samples: [
                .init(index: 0, range: 4..<5, fadeStart: 0.02666666666666667, deadline: 0.13),
                .init(index: 23, range: 50..<51, fadeStart: 0.29, deadline: 0.41),
            ]),
    ])
    func `append scheduling preserves partial words and retained fade timing`(_ sample: AppendScheduleCase) throws {
        let initial = step(state: ChatStreamingRevealState(), newText: sample.initialText, now: 0)
        let appended = step(state: initial, newText: sample.appendedText, now: sample.now)

        #expect(appended.words.count == sample.wordCount)
        for expected in sample.samples {
            try #require(appended.words.indices.contains(expected.index))
            let word = appended.words[expected.index]
            #expect(word.characterRange == expected.range)
            #expect(abs(word.fadeStart - expected.fadeStart) < 0.000000001)
            #expect(abs(word.deadline - expected.deadline) < 0.000000001)
        }
    }
}
