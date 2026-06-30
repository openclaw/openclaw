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
        VStack(alignment: .leading, spacing: 10) {
            Text(self.markdownText(processed.cleaned))
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
        Self.parsedMarkdown(markdown)
    }

    /// Parse `markdown` as an `AttributedString`, first promoting solo
    /// newlines into CommonMark hard breaks so the iOS chat bubble keeps
    /// the line layout the assistant emitted. Exposed for tests.
    nonisolated static func parsedMarkdown(_ markdown: String) -> AttributedString {
        let prepared = self.preserveSoftLineBreaks(in: markdown)
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .full,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: prepared, options: options))
            ?? AttributedString(prepared)
    }

    /// CommonMark collapses a single `\n` into a space, which strips the
    /// visible line breaks assistant responses emit (issue #98028 on iOS).
    /// Append two trailing spaces to every intra-paragraph newline so the
    /// parser keeps them as hard breaks. Blank lines remain paragraph
    /// separators and fenced code blocks are left untouched so their
    /// literal layout survives verbatim.
    nonisolated static func preserveSoftLineBreaks(in markdown: String) -> String {
        let lines = markdown
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
        guard lines.count > 1 else { return markdown }

        var output: [String] = []
        output.reserveCapacity(lines.count)
        var openFence: String?

        for index in lines.indices {
            let current = lines[index]
            let trimmedLead = String(current.drop(while: { $0 == " " }))

            if let marker = self.fenceMarker(in: trimmedLead) {
                if openFence == nil {
                    openFence = marker
                } else if openFence == marker {
                    openFence = nil
                }
                output.append(current)
                continue
            }

            if openFence != nil {
                output.append(current)
                continue
            }

            guard index + 1 < lines.count else {
                output.append(current)
                continue
            }

            let next = lines[index + 1]
            let nextIsBlank = next.allSatisfy({ $0 == " " || $0 == "\t" })
            let currentIsBlank = current.allSatisfy({ $0 == " " || $0 == "\t" })
            let alreadyHardBreak = current.hasSuffix("  ") || current.hasSuffix("\\")
            if nextIsBlank || currentIsBlank || alreadyHardBreak {
                output.append(current)
                continue
            }

            output.append(current + "  ")
        }

        return output.joined(separator: "\n")
    }

    private static func fenceMarker(in trimmed: String) -> String? {
        if trimmed.hasPrefix("```") { return "```" }
        if trimmed.hasPrefix("~~~") { return "~~~" }
        return nil
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
