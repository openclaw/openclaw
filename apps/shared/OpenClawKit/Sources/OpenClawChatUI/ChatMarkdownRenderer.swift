import Foundation
import SwiftUI

public enum ChatMarkdownVariant: String, CaseIterable, Sendable {
    case standard
    case compact
}

@MainActor
struct ChatMarkdownRenderer: View {
    enum Context {
        case user
        case assistant
    }

    let text: String
    let context: Context
    let variant: ChatMarkdownVariant
    let font: Font
    let textColor: Color

    var body: some View {
        let processed = ChatMarkdownPreprocessor.preprocess(markdown: self.text)
        let renderMarkdown = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: processed.cleaned)
        VStack(alignment: .leading, spacing: 10) {
            Text(self.markdownText(renderMarkdown))
                .font(self.font)
                .foregroundStyle(self.textColor)
                .tint(self.linkColor)
                .textSelection(.enabled)
                .lineSpacing(self.variant == .compact ? 2 : 4)

            if !processed.images.isEmpty {
                InlineImageList(images: processed.images)
            }
        }
    }

    private var linkColor: Color {
        self.context == .user ? self.textColor : OpenClawChatTheme.accent
    }

    private func markdownText(_ markdown: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: markdown, options: options)) ?? AttributedString(markdown)
    }
}

enum ChatMarkdownDisplayPreprocessor {
    static func preserveChatSoftBreaks(in markdown: String) -> String {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count > 1 else { return normalized }

        var output = ""
        var fence: Fence?
        let tableRows = self.tableRowIndices(in: lines)

        for index in lines.indices {
            let line = lines[index]
            let wasInFence = fence != nil
            let fenceBoundary = self.fenceBoundary(in: line, activeFence: fence)
            if case let .open(nextFence) = fenceBoundary {
                fence = nextFence
            } else if case .close = fenceBoundary {
                fence = nil
            }

            output += line

            guard index < lines.index(before: lines.endIndex) else {
                continue
            }

            let nextLine = lines[lines.index(after: index)]
            let nextIndex = lines.index(after: index)
            if self.shouldPreserveSoftBreak(
                after: line,
                before: nextLine,
                inTable: tableRows.contains(index) || tableRows.contains(nextIndex),
                inFence: wasInFence,
                fenceBoundary: fenceBoundary)
            {
                output += "  \n"
            } else {
                output += "\n"
            }
        }

        return output
    }

    private enum FenceBoundary {
        case none
        case open(Fence)
        case close
    }

    private struct Fence {
        let character: Character
        let count: Int
        let hasOnlyTrailingWhitespace: Bool
    }

    private static func shouldPreserveSoftBreak(
        after line: String,
        before nextLine: String,
        inTable: Bool,
        inFence: Bool,
        fenceBoundary: FenceBoundary) -> Bool
    {
        guard !inTable else { return false }
        guard !inFence else { return false }
        guard case .none = fenceBoundary else { return false }

        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextTrimmed = nextLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !nextTrimmed.isEmpty else { return false }
        guard !self.hasMarkdownHardBreak(line) else { return false }
        guard !self.isBlockMarkdownLine(line), !self.isBlockMarkdownLine(nextLine) else { return false }
        return true
    }

    private static func hasMarkdownHardBreak(_ line: String) -> Bool {
        line.hasSuffix("\\") || line.hasSuffix("  ")
    }

    private static func isBlockMarkdownLine(_ line: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        return self.matches(line, #"^\s{0,3}#{1,6}(\s|$)"#)
            || self.matches(line, #"^\s{0,3}>"#)
            || self.matches(line, #"^\s{0,3}([-+*])\s+"#)
            || self.matches(line, #"^\s{0,3}\d{1,9}[.)]\s+"#)
            || self.matches(line, #"^( {4}|\t)"#)
            || self.matches(line, #"^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,}|={3,})$"#)
    }

    private static func tableRowIndices(in lines: [String]) -> Set<Int> {
        var indices = Set<Int>()
        for index in lines.indices where index > lines.startIndex {
            guard self.isTableDelimiterLine(lines[index]), lines[lines.index(before: index)].contains("|") else {
                continue
            }

            indices.insert(lines.index(before: index))
            indices.insert(index)

            var cursor = lines.index(after: index)
            while cursor < lines.endIndex, lines[cursor].contains("|") {
                indices.insert(cursor)
                cursor = lines.index(after: cursor)
            }
        }
        return indices
    }

    private static func isTableDelimiterLine(_ line: String) -> Bool {
        self.matches(line, #"^\s{0,3}\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$"#)
    }

    private static func fenceBoundary(in line: String, activeFence: Fence?) -> FenceBoundary {
        guard let candidate = self.fenceCandidate(in: line) else {
            return .none
        }

        guard let activeFence else {
            return .open(candidate)
        }

        if candidate.character == activeFence.character,
           candidate.count >= activeFence.count,
           candidate.hasOnlyTrailingWhitespace
        {
            return .close
        }
        return .none
    }

    private static func fenceCandidate(in line: String) -> Fence? {
        var cursor = line.startIndex
        var spaces = 0
        while cursor < line.endIndex, line[cursor] == " ", spaces < 4 {
            spaces += 1
            cursor = line.index(after: cursor)
        }
        guard spaces <= 3, cursor < line.endIndex else {
            return nil
        }

        let character = line[cursor]
        guard character == "`" || character == "~" else {
            return nil
        }

        var count = 0
        while cursor < line.endIndex, line[cursor] == character {
            count += 1
            cursor = line.index(after: cursor)
        }
        guard count >= 3 else {
            return nil
        }
        let trailing = line[cursor...]
        return Fence(
            character: character,
            count: count,
            hasOnlyTrailingWhitespace: trailing.allSatisfy(\.isWhitespace))
    }

    private static func matches(_ line: String, _ pattern: String) -> Bool {
        line.range(of: pattern, options: .regularExpression) != nil
    }
}

@MainActor
private struct InlineImageList: View {
    let images: [ChatMarkdownPreprocessor.InlineImage]

    var body: some View {
        ForEach(self.images, id: \.id) { item in
            if let img = item.image {
                OpenClawPlatformImageFactory.image(img)
                    .resizable()
                    .scaledToFit()
                    .frame(maxHeight: 260)
                    .clipShape(RoundedRectangle(cornerRadius: 12, style: .continuous))
                    .overlay(
                        RoundedRectangle(cornerRadius: 12, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.12), lineWidth: 1))
            } else {
                Text(item.label.isEmpty ? "Image" : item.label)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
