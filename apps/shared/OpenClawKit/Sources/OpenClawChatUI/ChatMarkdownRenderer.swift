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
        case .prose(let markdown):
            Text(self.markdownText(ChatMarkdownDisplayPreprocessor.preserveChatSoftBreaks(in: markdown)))
                .font(self.font)
                .foregroundStyle(self.textColor)
                .tint(self.linkColor)
                .textSelection(.enabled)
                .lineSpacing(self.variant == .compact ? 2 : 4)
        case .code(let code):
            ChatCodeBlockView(block: code, textColor: self.textColor)
        case .table(let table):
            ChatMarkdownTableView(table: table, textColor: self.textColor)
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

        var output = ""
        for index in lines.indices {
            output += lines[index]

            guard index < lines.index(before: lines.endIndex) else {
                continue
            }

            if self.shouldPreserveSoftBreak(after: lines[index], before: lines[index + 1]) {
                output += "  \n"
            } else {
                output += "\n"
            }
        }

        return output
    }

    private static func shouldPreserveSoftBreak(after line: String, before nextLine: String) -> Bool {
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
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
