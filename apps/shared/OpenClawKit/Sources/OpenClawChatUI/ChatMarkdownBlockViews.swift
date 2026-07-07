import SwiftMath
import SwiftUI
#if os(macOS)
import AppKit
#else
import UIKit
#endif

@MainActor
struct ChatCodeBlockView: View {
    let block: ChatCodeBlock

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let language = self.block.language {
                Text(language)
                    .font(OpenClawChatTypography.caption2)
                    .foregroundStyle(.secondary)
            }
            ScrollView(.horizontal, showsIndicators: false) {
                Text(self.attributedCode)
                    .font(OpenClawChatTypography.mono(size: 13, relativeTo: .footnote))
                    .foregroundStyle(OpenClawChatTheme.assistantText)
                    .lineSpacing(2)
                    .textSelection(.enabled)
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private var attributedCode: AttributedString {
        // Open (still-streaming) fences skip highlighting so each delta stays
        // cheap; completed blocks hit the content-keyed highlight cache.
        guard self.block.isComplete else { return AttributedString(self.block.code) }
        return ChatCodeHighlightCache.highlighted(
            code: self.block.code,
            languageId: self.block.language)
    }
}

@MainActor
struct ChatMathBlockView: View {
    let block: ChatMathBlock
    let textColor: Color

    @ScaledMetric(relativeTo: .body) private var fontSize: CGFloat = OpenClawChatTypography.bodySize

    var body: some View {
        if self.block.isComplete,
           ChatMathParseCache.mathList(latex: self.block.latex) != nil
        {
            ScrollView(.horizontal, showsIndicators: false) {
                ChatMathPlatformView(
                    latex: self.block.latex,
                    fontSize: self.fontSize,
                    textColor: self.textColor)
                    .fixedSize()
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(Text(self.block.latex))
            }
            .defaultScrollAnchor(.center)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 4)
        } else {
            ChatCodeBlockView(block: ChatCodeBlock(
                language: nil,
                code: self.block.latex,
                isComplete: false))
        }
    }
}

/// Parsed math is stable after its delimiter closes. A bounded cache avoids
/// repeating SwiftMath parsing as later streaming deltas rerender old blocks.
@MainActor
private enum ChatMathParseCache {
    private enum Result {
        case parsed(MTMathList)
        case invalid
    }

    private static var cache: [String: Result] = [:]
    private static let capacity = 80
    private static let maxNestingDepth = 64
    private static let maxCommandCount = 128
    private static let unsafeCommands = [#"\color"#, #"\colorbox"#, #"\textcolor"#]

    static func mathList(latex: String) -> MTMathList? {
        guard !latex.isEmpty else { return nil }
        // SwiftMath silently drops unsupported Unicode instead of reporting a
        // parse error. Preserve the source through the raw-text fallback.
        guard latex.unicodeScalars.allSatisfy(\.isASCII) else { return nil }
        // SwiftMath recursively parses groups. Bound hostile nesting before
        // entering the dependency so a short expression cannot exhaust stack.
        guard self.isWithinParserLimits(latex) else { return nil }
        // SwiftMath 1.7.3 traps while typesetting empty color-command bodies.
        // Chat owns the surrounding color, so preserve these as raw source.
        guard !self.unsafeCommands.contains(where: latex.contains) else { return nil }
        if let hit = self.cache[latex] {
            if case let .parsed(mathList) = hit { return mathList }
            return nil
        }

        let result = MTMathListBuilder.build(fromString: latex)
            .map(Result.parsed) ?? .invalid
        if self.cache.count >= self.capacity {
            self.cache.removeAll(keepingCapacity: true)
        }
        self.cache[latex] = result
        if case let .parsed(mathList) = result { return mathList }
        return nil
    }

    private static func isWithinParserLimits(_ latex: String) -> Bool {
        var depth = 0
        var commandCount = 0
        var escaped = false
        for character in latex {
            if escaped {
                escaped = false
                continue
            }
            if character == "\\" {
                commandCount += 1
                if commandCount > self.maxCommandCount { return false }
                escaped = true
            } else if character == "{" {
                depth += 1
                if depth > self.maxNestingDepth { return false }
            } else if character == "}" {
                depth = max(0, depth - 1)
            }
        }
        return true
    }
}

#if os(macOS)
@MainActor
private struct ChatMathPlatformView: NSViewRepresentable {
    let latex: String
    let fontSize: CGFloat
    let textColor: Color

    func makeNSView(context: Context) -> MTMathUILabel {
        MTMathUILabel()
    }

    func updateNSView(_ view: MTMathUILabel, context: Context) {
        self.configure(view)
    }

    private func configure(_ view: MTMathUILabel) {
        view.displayErrorInline = false
        view.labelMode = .display
        view.textAlignment = .center
        view.fontSize = self.fontSize
        view.textColor = NSColor(self.textColor)
        if view.latex != self.latex {
            view.latex = self.latex
        }
    }
}
#else
@MainActor
private struct ChatMathPlatformView: UIViewRepresentable {
    let latex: String
    let fontSize: CGFloat
    let textColor: Color

    func makeUIView(context: Context) -> MTMathUILabel {
        MTMathUILabel()
    }

    func updateUIView(_ view: MTMathUILabel, context: Context) {
        self.configure(view)
    }

    private func configure(_ view: MTMathUILabel) {
        view.displayErrorInline = false
        view.labelMode = .display
        view.textAlignment = .center
        view.fontSize = self.fontSize
        view.textColor = UIColor(self.textColor)
        if view.latex != self.latex {
            view.latex = self.latex
        }
    }
}
#endif

@MainActor
struct ChatMarkdownTableView: View {
    let table: ChatMarkdownTable

    var body: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            Grid(alignment: .topLeading, horizontalSpacing: 14, verticalSpacing: 7) {
                GridRow {
                    ForEach(self.table.header.indices, id: \.self) { column in
                        // One cell per column carries the GFM alignment.
                        self.cell(self.table.header[column], column: column, isHeader: true)
                            .gridColumnAlignment(self.columnAlignment(column))
                    }
                }
                Divider()
                ForEach(self.table.rows.indices, id: \.self) { rowIndex in
                    GridRow {
                        ForEach(self.table.rows[rowIndex].indices, id: \.self) { column in
                            self.cell(self.table.rows[rowIndex][column], column: column, isHeader: false)
                        }
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.08), lineWidth: 1)))
    }

    private func cell(_ text: String, column: Int, isHeader: Bool) -> some View {
        Text(self.inlineMarkdown(text))
            .font(isHeader ? OpenClawChatTypography.footnoteSemiBold : OpenClawChatTypography.footnote)
            .foregroundStyle(OpenClawChatTheme.assistantText)
            .textSelection(.enabled)
    }

    private func inlineMarkdown(_ text: String) -> AttributedString {
        let options = AttributedString.MarkdownParsingOptions(
            interpretedSyntax: .inlineOnlyPreservingWhitespace,
            failurePolicy: .returnPartiallyParsedIfPossible)
        return (try? AttributedString(markdown: text, options: options)) ?? AttributedString(text)
    }

    private func columnAlignment(_ column: Int) -> HorizontalAlignment {
        guard column < self.table.alignments.count else { return .leading }
        switch self.table.alignments[column] {
        case .leading: return .leading
        case .center: return .center
        case .trailing: return .trailing
        }
    }
}
