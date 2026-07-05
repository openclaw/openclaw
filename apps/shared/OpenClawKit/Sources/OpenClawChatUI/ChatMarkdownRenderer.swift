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

    let text: String
    let context: Context
    let variant: ChatMarkdownVariant
    let font: Font
    let textColor: Color
    /// False while the message is still streaming: trailing open fences and
    /// growing tables then stay on the cheap plain-text path.
    var isComplete: Bool = true

    var body: some View {
        let processed = ChatMarkdownPreprocessor.preprocess(markdown: self.text)
        let blocks = ChatMarkdownBlockSegmenter.segments(
            markdown: processed.cleaned,
            isComplete: self.isComplete)
        VStack(alignment: .leading, spacing: 10) {
            ForEach(Array(blocks.enumerated()), id: \.offset) { entry in
                self.blockView(entry.element)
            }

            if !processed.images.isEmpty {
                InlineImageList(images: processed.images)
            }
        }
    }

    @ViewBuilder
    private func blockView(_ block: ChatMarkdownBlock) -> some View {
        switch block {
        case let .prose(markdown):
            Text(self.markdownText(ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)))
                .font(self.font)
                .foregroundStyle(self.textColor)
                .tint(self.linkColor)
                .textSelection(.enabled)
                .lineSpacing(self.variant == .compact ? 2 : 4)
        case let .code(code):
            ChatCodeBlockView(block: code)
        case let .table(table):
            ChatMarkdownTableView(table: table)
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

/// Fenced code and GFM tables are split out by `ChatMarkdownBlockSegmenter`
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
