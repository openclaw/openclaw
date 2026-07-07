import Foundation
import Markdown
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

    let snapshot: ChatMarkdownRenderSnapshot
    let context: Context
    let variant: ChatMarkdownVariant
    let font: Font
    let textColor: Color
    var reveal: ChatMarkdownProseReveal?

    init(
        text: String,
        context: Context,
        variant: ChatMarkdownVariant,
        font: Font,
        textColor: Color,
        isComplete: Bool = true)
    {
        self.init(
            snapshot: ChatMarkdownRenderSnapshot(text: text, isComplete: isComplete),
            context: context,
            variant: variant,
            font: font,
            textColor: textColor)
    }

    init(
        snapshot: ChatMarkdownRenderSnapshot,
        context: Context,
        variant: ChatMarkdownVariant,
        font: Font,
        textColor: Color,
        reveal: ChatMarkdownProseReveal? = nil)
    {
        self.snapshot = snapshot
        self.context = context
        self.variant = variant
        self.font = font
        self.textColor = textColor
        self.reveal = reveal
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(self.snapshot.blocks.enumerated()), id: \.offset) { entry in
                self.blockView(entry.element, index: entry.offset)
            }

            if !self.snapshot.images.isEmpty {
                InlineImageList(images: self.snapshot.images)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: ChatMarkdownRenderedBlock, index: Int) -> some View {
        switch block {
        case let .prose(prose):
            self.proseText(prose, index: index)
                .font(self.font)
                .foregroundStyle(self.textColor)
                .tint(self.linkColor)
                .textSelection(.enabled)
                .lineSpacing(self.variant == .compact ? 2 : 4)
        case let .code(code):
            ChatCodeBlockView(block: code)
        case let .math(math):
            ChatMathBlockView(block: math, textColor: self.textColor)
        case let .table(table):
            ChatMarkdownTableView(table: table)
        }
    }

    private func proseText(_ prose: ChatMarkdownProse, index: Int) -> SwiftUI.Text {
        guard let reveal = self.reveal, reveal.blockIndex == index else {
            return SwiftUI.Text(prose.attributed)
        }
        return prose.revealedText(
            frame: revealedOpacities(state: reveal.state, now: reveal.now),
            textColor: self.textColor)
    }

    private var linkColor: Color {
        self.context == .user ? self.textColor : OpenClawChatTheme.accent
    }
}

struct ChatMarkdownProseReveal {
    let blockIndex: Int
    let state: ChatStreamingRevealState
    let now: TimeInterval
}

struct ChatMarkdownRenderSnapshot {
    let blocks: [ChatMarkdownRenderedBlock]
    let images: [ChatMarkdownPreprocessor.InlineImage]

    init(text: String, isComplete: Bool, preparesReveal: Bool = false) {
        let processed = ChatMarkdownPreprocessor.preprocess(markdown: text)
        self.blocks = ChatMarkdownBlockSegmenter.segments(
            markdown: processed.cleaned,
            isComplete: isComplete).map { block in
            switch block {
            case let .prose(markdown):
                .prose(ChatMarkdownProse(markdown: markdown, preparesReveal: preparesReveal))
            case let .code(code):
                .code(code)
            case let .math(math):
                .math(math)
            case let .table(table):
                .table(table)
            }
        }
        self.images = processed.images
    }

    var lastProseIndex: Int? {
        self.blocks.lastIndex {
            if case .prose = $0 { return true }
            return false
        }
    }
}

enum ChatMarkdownRenderedBlock {
    case prose(ChatMarkdownProse)
    case code(ChatCodeBlock)
    case math(ChatMathBlock)
    case table(ChatMarkdownTable)
}

struct ChatMarkdownProse {
    struct TailPiece {
        let attributed: AttributedString
        let wordRange: Range<Int>?
    }

    let attributed: AttributedString
    let plainText: String
    let prefix: AttributedString
    let tail: [TailPiece]

    init(markdown: String, preparesReveal: Bool) {
        let displayMarkdown = ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        let attributed = (try? AttributedString(markdown: displayMarkdown, options: options))
            ?? AttributedString(displayMarkdown)
        let plainText = preparesReveal ? String(attributed.characters) : ""
        let wordRanges = preparesReveal
            ? Array(chatStreamingWordRanges(in: plainText).suffix(24))
            : []
        let tailStart = wordRanges.first?.lowerBound ?? plainText.count

        self.attributed = attributed
        self.plainText = plainText
        if preparesReveal {
            self.prefix = Self.slice(attributed, characterRange: 0..<tailStart)
            self.tail = Self.tailPieces(
                attributed: attributed,
                textLength: plainText.count,
                wordRanges: wordRanges,
                tailStart: tailStart)
        } else {
            self.prefix = AttributedString()
            self.tail = []
        }
    }

    func revealedText(frame: ChatStreamingRevealFrame, textColor: Color) -> SwiftUI.Text {
        self.tail.reduce(SwiftUI.Text(self.prefix)) { text, piece in
            var attributed = piece.attributed
            if let wordRange = piece.wordRange,
               let fading = frame.fading.first(where: { $0.characterRange == wordRange })
            {
                attributed.foregroundColor = textColor.opacity(fading.opacity)
            }
            return text + SwiftUI.Text(attributed)
        }
    }

    private static func tailPieces(
        attributed: AttributedString,
        textLength: Int,
        wordRanges: [Range<Int>],
        tailStart: Int) -> [TailPiece]
    {
        guard !wordRanges.isEmpty else { return [] }
        var pieces: [TailPiece] = []
        var cursor = tailStart
        for wordRange in wordRanges {
            if cursor < wordRange.lowerBound {
                pieces.append(TailPiece(
                    attributed: self.slice(attributed, characterRange: cursor..<wordRange.lowerBound),
                    wordRange: nil))
            }
            pieces.append(TailPiece(
                attributed: self.slice(attributed, characterRange: wordRange),
                wordRange: wordRange))
            cursor = wordRange.upperBound
        }
        if cursor < textLength {
            pieces.append(TailPiece(
                attributed: self.slice(attributed, characterRange: cursor..<textLength),
                wordRange: nil))
        }
        return pieces
    }

    private static func slice(
        _ attributed: AttributedString,
        characterRange: Range<Int>) -> AttributedString
    {
        let lower = attributed.characters.index(
            attributed.startIndex,
            offsetBy: characterRange.lowerBound)
        let upper = attributed.characters.index(
            attributed.startIndex,
            offsetBy: characterRange.upperBound)
        return AttributedString(attributed[lower..<upper])
    }
}

/// Fenced code, display math, and GFM tables are split out by `ChatMarkdownBlockSegmenter`
/// before this runs, so prose only needs chat-style soft-break preservation.
enum ChatMarkdownDisplayPreprocessor {
    static func preserveChatSoftBreaks(in markdown: String) -> String {
        let normalized = markdown.replacingOccurrences(of: "\r\n", with: "\n")
        let lines = normalized.split(separator: "\n", omittingEmptySubsequences: false).map(String.init)
        guard lines.count > 1 else { return normalized }
        let codeLines = self.codeLineIndices(in: normalized)

        var output = ""
        for index in lines.indices {
            output += lines[index]

            guard index < lines.index(before: lines.endIndex) else {
                continue
            }

            if !codeLines.contains(index),
               !codeLines.contains(index + 1),
               self.shouldPreserveSoftBreak(after: lines[index], before: lines[index + 1])
            {
                output += "  \n"
            } else {
                output += "\n"
            }
        }

        return output
    }

    private static func codeLineIndices(in markdown: String) -> Set<Int> {
        guard markdown.contains("```")
            || markdown.contains("~~~")
            || markdown.hasPrefix("    ")
            || markdown.contains("\n    ")
        else { return [] }

        var indices = Set<Int>()
        func collect(from markup: any Markup) {
            if markup is Markdown.CodeBlock, let range = markup.range {
                indices.formUnion((range.lowerBound.line - 1)..<range.upperBound.line)
            }
            for child in markup.children {
                collect(from: child)
            }
        }
        collect(from: Document(parsing: markdown))
        return indices
    }

    private static func shouldPreserveSoftBreak(after line: String, before nextLine: String) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        let nextTrimmed = nextLine.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !nextTrimmed.isEmpty else { return false }
        guard !self.hasMarkdownHardBreak(line) else { return false }
        guard !ChatMarkdownBlockSyntax.startsBlock(line), !ChatMarkdownBlockSyntax.startsBlock(nextLine) else {
            return false
        }
        return true
    }

    private static func hasMarkdownHardBreak(_ line: String) -> Bool {
        line.hasSuffix("\\") || line.hasSuffix("  ")
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
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
