import SwiftUI

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
