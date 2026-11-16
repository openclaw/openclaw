import Foundation

struct ChatStreamingRevealState: Equatable {
    struct Word: Equatable {
        let characterRange: Range<Int>
        let fadeStart: TimeInterval
        let deadline: TimeInterval
    }

    var text: String
    var words: [Word]

    init(text: String = "", words: [Word] = []) {
        self.text = text
        self.words = words
    }

    var latestDeadline: TimeInterval? {
        self.words.map(\.deadline).max()
    }
}

struct ChatStreamingRevealFrame: Equatable {
    struct FadingWord: Equatable {
        let characterRange: Range<Int>
        let opacity: Double
    }

    let fading: [FadingWord]
}

private enum ChatStreamingRevealConstants {
    static let wordInterval: TimeInterval = 0.04
    static let fadeDuration: TimeInterval = 0.12
    static let maximumCatchUpDuration: TimeInterval = 0.4
    static let maximumFadingWords = 24
}

func step(
    state: ChatStreamingRevealState,
    newText: String,
    now: TimeInterval) -> ChatStreamingRevealState
{
    guard newText.hasPrefix(state.text) else {
        // Rewrites are uncommon and can invalidate every old character range.
        // Reveal the replacement immediately; later appends start a new pace.
        return ChatStreamingRevealState(text: newText)
    }
    guard newText != state.text else {
        return ChatStreamingRevealState(
            text: newText,
            words: state.words.filter { $0.deadline > now })
    }

    let oldCharacterCount = state.text.count
    let previousWords = Dictionary(uniqueKeysWithValues: state.words
        .filter { $0.deadline > now }
        .map { ($0.characterRange.lowerBound, $0) })
    let ranges = chatStreamingWordRanges(in: newText)
        .filter { previousWords[$0.lowerBound] != nil || $0.lowerBound >= oldCharacterCount }
        .suffix(ChatStreamingRevealConstants.maximumFadingWords)

    let spacing: TimeInterval
    if ranges.count > 1 {
        let catchUpSpacing =
            (ChatStreamingRevealConstants.maximumCatchUpDuration - ChatStreamingRevealConstants.fadeDuration)
            / Double(ranges.count - 1)
        spacing = min(ChatStreamingRevealConstants.wordInterval, catchUpSpacing)
    } else {
        spacing = 0
    }

    let words = ranges.enumerated().map { index, range in
        let previous = previousWords[range.lowerBound]
        let scheduledStart = now + Double(index) * spacing
        let scheduledDeadline = scheduledStart + ChatStreamingRevealConstants.fadeDuration
        return ChatStreamingRevealState.Word(
            characterRange: range,
            fadeStart: previous?.fadeStart ?? scheduledStart,
            // Catch-up may shorten an existing fade, never delay it or reset opacity.
            deadline: previous.map { min($0.deadline, scheduledDeadline) } ?? scheduledDeadline)
    }

    return ChatStreamingRevealState(text: newText, words: words)
}

func revealedOpacities(
    state: ChatStreamingRevealState,
    now: TimeInterval) -> ChatStreamingRevealFrame
{
    let fading = state.words.compactMap { word -> ChatStreamingRevealFrame.FadingWord? in
        guard now < word.deadline else { return nil }
        let duration = word.deadline - word.fadeStart
        let opacity = duration > 0
            ? min(1, max(0, (now - word.fadeStart) / duration))
            : 1
        return ChatStreamingRevealFrame.FadingWord(
            characterRange: word.characterRange,
            opacity: opacity)
    }
    return ChatStreamingRevealFrame(fading: fading)
}

func chatStreamingWordRanges(in text: String) -> [Range<Int>] {
    var ranges: [Range<Int>] = []
    var wordStart: Int?

    for (offset, character) in text.enumerated() {
        if character.isWhitespace {
            if let start = wordStart {
                ranges.append(start..<offset)
                wordStart = nil
            }
        } else if wordStart == nil {
            wordStart = offset
        }
    }
    if let wordStart {
        ranges.append(wordStart..<text.count)
    }
    return ranges
}
