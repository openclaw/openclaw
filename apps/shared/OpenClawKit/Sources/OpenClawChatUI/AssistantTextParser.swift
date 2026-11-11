import Foundation

struct AssistantTextSegment: Identifiable {
    enum Kind {
        case thinking
        case response
    }

    let id: Int
    let kind: Kind
    let text: String
}

enum AssistantTextParser {
    static func segments(from raw: String, includeThinking: Bool = true) -> [AssistantTextSegment] {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return [] }
        // Preserve Foundation’s nonliteral entry check for delimiters with combining marks.
        guard raw.contains("<") else {
            return [AssistantTextSegment(id: 0, kind: .response, text: trimmed)]
        }

        var segments: [AssistantTextSegment] = []
        var cursor = raw.startIndex
        var currentKind: AssistantTextSegment.Kind = .response
        var matchedTag = false

        while let match = self.nextTag(in: raw, from: cursor) {
            matchedTag = true
            if match.range.lowerBound > cursor {
                self.appendSegment(kind: currentKind, text: raw[cursor..<match.range.lowerBound], to: &segments)
            }

            guard let tagEnd = raw.range(of: ">", range: match.range.upperBound..<raw.endIndex) else {
                cursor = raw.endIndex
                break
            }

            let isSelfClosing = raw[..<tagEnd.lowerBound].reversed().first { !$0.isWhitespace } == "/"
            cursor = tagEnd.upperBound
            if isSelfClosing { continue }

            currentKind = match.kind
        }

        if cursor < raw.endIndex {
            self.appendSegment(kind: currentKind, text: raw[cursor..<raw.endIndex], to: &segments)
        }

        guard matchedTag else {
            return [AssistantTextSegment(id: 0, kind: .response, text: trimmed)]
        }

        if includeThinking {
            return segments
        }

        return segments.filter { $0.kind == .response }
    }

    static func visibleSegments(from raw: String) -> [AssistantTextSegment] {
        self.segments(from: raw, includeThinking: false)
    }

    static func hasVisibleContent(in raw: String, includeThinking: Bool = false) -> Bool {
        !self.segments(from: raw, includeThinking: includeThinking).isEmpty
    }

    struct TagMatch {
        let kind: AssistantTextSegment.Kind
        let range: Range<String.Index>
    }

    /// Finds the next `<think`, `</think`, `<final` or `</final` tag at or after `start`.
    ///
    /// Scan opening-byte candidates instead of repeatedly searching the whole string. ASCII tag names use
    /// byte comparisons; candidates involving non-ASCII text (`<thínk`, a combining mark, or precomposed `≮`)
    /// retain the original folding comparison, anchored at that position.
    static func nextTag(in text: String, from start: String.Index) -> TagMatch? {
        let utf8 = text.utf8
        var cursor = start
        while let candidate = utf8[cursor...].firstIndex(where: { $0 == Self.lessThan || $0 == 0xE2 }) {
            cursor = utf8.index(after: candidate)
            // Reject unrelated scalars before locating boundaries in potentially long graphemes.
            guard utf8[candidate] == Self.lessThan || utf8[candidate...].starts(with: Self.notLessThan) else {
                continue
            }
            // A prepending mark (U+0600 and its kind) joins the `<` after it into one character, and the search
            // never matched inside a character that began within its range. Only a non-ASCII byte before the
            // candidate can do that.
            if candidate > start, utf8[utf8.index(before: candidate)] >= 0x80,
               String.Index(candidate, within: text) == nil
            {
                continue
            }
            if utf8[candidate] == Self.lessThan {
                if let match = self.tag(in: text, atLessThan: candidate) { return match }
            } else {
                // U+226E is `<` with a combining solidus, which the folding comparison treats as `<`.
                if let match = self.foldedTag(in: text, at: candidate) { return match }
            }
        }
        return nil
    }

    private static let lessThan = UInt8(ascii: "<")
    private static let notLessThan: [UInt8] = [0xE2, 0x89, 0xAE]
    private static let thinkName = Array("think".utf8)
    private static let finalName = Array("final".utf8)

    private static func tag(in text: String, atLessThan open: String.Index) -> TagMatch? {
        let utf8 = text.utf8
        var index = utf8.index(after: open)
        var closing = false
        if index < utf8.endIndex, utf8[index] == UInt8(ascii: "/") {
            closing = true
            index = utf8.index(after: index)
        }
        var isThink = true
        var isFinal = true
        for offset in 0..<5 {
            guard index < utf8.endIndex else { return nil }
            let byte = utf8[index]
            // Accented and combining forms are rare; let the folding comparison decide them.
            guard byte < 0x80 else { return self.foldedTag(in: text, at: open) }
            // Setting bit 5 lowercases ASCII letters and maps no other byte onto a letter.
            let lowered = byte | 0x20
            isThink = isThink && lowered == Self.thinkName[offset]
            isFinal = isFinal && lowered == Self.finalName[offset]
            guard isThink || isFinal else { return nil }
            index = utf8.index(after: index)
        }
        if index < utf8.endIndex {
            guard utf8[index] < 0x80 else { return self.foldedTag(in: text, at: open) }
            guard self.isTagBoundary(text[index], closing: closing) else { return nil }
        }
        return TagMatch(kind: isThink && !closing ? .thinking : .response, range: open..<index)
    }

    private static func foldedTag(in text: String, at open: String.Index) -> TagMatch? {
        let tokens: [(token: String, closing: Bool, kind: AssistantTextSegment.Kind)] = [
            ("<think", false, .thinking),
            ("</think", true, .response),
            ("<final", false, .response),
            ("</final", true, .response),
        ]
        for candidate in tokens {
            guard let range = text.range(
                of: candidate.token,
                options: [.caseInsensitive, .diacriticInsensitive, .anchored],
                range: open..<text.endIndex)
            else { continue }
            if range.upperBound < text.endIndex,
               !self.isTagBoundary(text[range.upperBound], closing: candidate.closing)
            {
                continue
            }
            return TagMatch(kind: candidate.kind, range: range)
        }
        return nil
    }

    private static func isTagBoundary(_ character: Character, closing: Bool) -> Bool {
        character == ">" || character.isWhitespace || (!closing && character == "/")
    }

    private static func appendSegment(
        kind: AssistantTextSegment.Kind,
        text: Substring,
        to segments: inout [AssistantTextSegment])
    {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        // Parsing repeats during unrelated view updates. Stable positional IDs keep
        // SwiftUI from rebuilding unchanged markdown segments and visibly flickering.
        segments.append(AssistantTextSegment(id: segments.count, kind: kind, text: trimmed))
    }
}
