import Foundation
import Markdown

/// One renderable block of a chat message. Prose stays on the
/// AttributedString pipeline; fenced code and GFM tables get dedicated views.
enum ChatMarkdownBlock: Equatable {
    case prose(String)
    case code(ChatCodeBlock)
    case table(ChatMarkdownTable)
}

struct ChatCodeBlock: Equatable {
    let language: String?
    let code: String
    /// True when the fence was closed or the message finished streaming.
    /// Open fences render as plain mono text so every streaming delta stays cheap.
    let isComplete: Bool
}

struct ChatMarkdownTable: Equatable {
    enum ColumnAlignment: Equatable {
        case leading
        case center
        case trailing
    }

    let header: [String]
    let alignments: [ColumnAlignment]
    let rows: [[String]]
}

enum ChatMarkdownBlockSyntax {
    static func startsBlock(_ line: String, includesSetextUnderline: Bool = true) -> Bool {
        let trimmed = line.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }

        let startsIndependentBlock = self.matches(line, #"^\s{0,3}#{1,6}(\s|$)"#)
            || self.matches(line, #"^\s{0,3}>"#)
            || self.matches(line, #"^\s{0,3}([-+*])(?:\s+|$)"#)
            || self.matches(line, #"^\s{0,3}\d{1,9}[.)](?:\s+|$)"#)
            || self.matches(line, #"^( {4}|\t)"#)
            || self.matches(line, #"^\s{0,3}((\*\s*){3,}|(-\s*){3,}|(_\s*){3,})$"#)
        return startsIndependentBlock
            || (includesSetextUnderline && self.matches(line, #"^\s{0,3}={3,}$"#))
    }

    private static func matches(_ line: String, _ pattern: String) -> Bool {
        line.range(of: pattern, options: .regularExpression) != nil
    }
}

enum ChatMarkdownBlockSegmenter {
    static let maxTableBytes = 20000
    static let maxTableRows = 100
    static let maxTableColumns = 12
    static let maxTableCells = 600

    /// Extracts only top-level fenced code and GFM tables. The parser owns
    /// CommonMark container and reference semantics; nested blocks stay in the
    /// surrounding prose range unchanged.
    static func segments(markdown: String, isComplete: Bool) -> [ChatMarkdownBlock] {
        let source = SourceBuffer(markdown)
        let document = Document(parsing: source.markdown)
        var blocks: [ChatMarkdownBlock] = []
        var proseStart = 0

        func appendProse(until end: Int) {
            guard proseStart < end else { return }
            blocks.append(contentsOf: self.proseOnly(Array(source.lines[proseStart..<end])))
        }

        for child in document.children {
            guard let lineRange = source.lineRange(for: child.range), lineRange.lowerBound >= proseStart else {
                continue
            }

            if let code = child as? Markdown.CodeBlock,
               let opener = FenceOpener.parse(source.lines[lineRange.lowerBound])
            {
                appendProse(until: lineRange.lowerBound)
                let language = code.language?
                    .split(whereSeparator: \.isWhitespace)
                    .first
                    .map { $0.lowercased() }
                let closed = lineRange.count > 1
                    && opener.isClose(source.lines[lineRange.index(before: lineRange.endIndex)])
                blocks.append(.code(ChatCodeBlock(
                    language: language,
                    code: self.dropStructuralCodeNewline(code.code),
                    isComplete: closed || isComplete)))
                proseStart = lineRange.upperBound
                continue
            }

            if let table = child as? Markdown.Table {
                let tableRange = source.tableLineRange(
                    reportedRange: lineRange,
                    columnCount: table.maxColumnCount)
                guard let rendered = self.table(table, source: source, lineRange: tableRange) else {
                    continue
                }
                let trailingLines = source.lines[tableRange.upperBound...]
                if !isComplete,
                   trailingLines.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty })
                {
                    continue
                }
                appendProse(until: tableRange.lowerBound)
                blocks.append(.table(rendered))
                proseStart = tableRange.upperBound
            }
        }

        appendProse(until: source.lines.count)
        if blocks.count > 1, self.containsReferenceLink(document, source: source) {
            return self.proseOnly(source.lines)
        }
        return blocks
    }

    private static func proseOnly(_ lines: [String]) -> [ChatMarkdownBlock] {
        // Boundary blank lines only separate extracted blocks; the rendered
        // VStack provides that spacing. Interior blanks remain paragraphs.
        var slice = lines[...]
        while slice.first?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            slice = slice.dropFirst()
        }
        while slice.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
            slice = slice.dropLast()
        }
        guard !slice.isEmpty else { return [] }
        return [.prose(slice.joined(separator: "\n"))]
    }

    private static func containsReferenceLink(_ document: Document, source: SourceBuffer) -> Bool {
        func search(_ markup: any Markup) -> Bool {
            if markup is Markdown.Link || markup is Markdown.Image,
               let range = markup.range,
               let raw = source.text(in: range)?.trimmingCharacters(in: .whitespacesAndNewlines),
               raw.hasSuffix("]")
            {
                return true
            }
            return markup.children.contains(where: search)
        }
        return search(document)
    }

    private static func dropStructuralCodeNewline(_ code: String) -> String {
        code.hasSuffix("\n") ? String(code.dropLast()) : code
    }

    private static func table(
        _ table: Markdown.Table,
        source: SourceBuffer,
        lineRange: Range<Int>) -> ChatMarkdownTable?
    {
        let columnCount = table.maxColumnCount
        let bodyStart = min(lineRange.lowerBound + 2, lineRange.upperBound)
        let bodyLines = bodyStart..<lineRange.upperBound
        let rowCount = bodyLines.count + 1
        let cellCount = columnCount * rowCount
        let byteCount = source.text(in: lineRange).utf8.count
        guard columnCount > 0,
              columnCount <= self.maxTableColumns,
              rowCount <= self.maxTableRows,
              cellCount <= self.maxTableCells,
              byteCount <= self.maxTableBytes
        else { return nil }

        let header = source.tableCells(at: lineRange.lowerBound)
        guard header.count == columnCount else { return nil }
        let rows = bodyLines.map { lineIndex in
            let cells = source.tableCells(at: lineIndex)
            if cells.count >= columnCount { return Array(cells.prefix(columnCount)) }
            return cells + Array(repeating: "", count: columnCount - cells.count)
        }
        let alignments = table.columnAlignments.map { alignment in
            switch alignment {
            case .center: ChatMarkdownTable.ColumnAlignment.center
            case .right: ChatMarkdownTable.ColumnAlignment.trailing
            case .left, nil: ChatMarkdownTable.ColumnAlignment.leading
            }
        }
        return ChatMarkdownTable(header: header, alignments: alignments, rows: rows)
    }

    private struct SourceBuffer {
        let markdown: String
        let lines: [String]

        init(_ markdown: String) {
            self.markdown = markdown.replacingOccurrences(of: "\r\n", with: "\n")
            self.lines = self.markdown.split(separator: "\n", omittingEmptySubsequences: false)
                .map(String.init)
        }

        func lineRange(for range: SourceRange?) -> Range<Int>? {
            guard let range else { return nil }
            let start = range.lowerBound.line - 1
            let end = min(range.upperBound.line, self.lines.count)
            guard start >= 0, start < end else { return nil }
            return start..<end
        }

        func text(in lineRange: Range<Int>) -> String {
            self.lines[lineRange].joined(separator: "\n")
        }

        func text(in range: SourceRange) -> String? {
            let startLine = range.lowerBound.line - 1
            let endLine = range.upperBound.line - 1
            guard self.lines.indices.contains(startLine), self.lines.indices.contains(endLine) else { return nil }

            let startOffset = range.lowerBound.column - 1
            let endOffset = range.upperBound.column - 1
            if startLine == endLine {
                return self.utf8Slice(self.lines[startLine], from: startOffset, to: endOffset)
            }

            guard let first = self.utf8Slice(
                self.lines[startLine],
                from: startOffset,
                to: self.lines[startLine].utf8.count),
                let last = self.utf8Slice(self.lines[endLine], from: 0, to: endOffset)
            else { return nil }
            let middle = self.lines[(startLine + 1)..<endLine]
            return ([first] + middle + [last]).joined(separator: "\n")
        }

        private func utf8Slice(_ line: String, from start: Int, to end: Int) -> String? {
            let bytes = line.utf8
            guard start >= 0, start <= end, end <= bytes.count else { return nil }
            let lower = bytes.index(bytes.startIndex, offsetBy: start)
            let upper = bytes.index(bytes.startIndex, offsetBy: end)
            return String(decoding: bytes[lower..<upper], as: UTF8.self)
        }

        func tableCells(at lineIndex: Int) -> [String] {
            guard self.lines.indices.contains(lineIndex) else { return [] }
            let line = self.lines[lineIndex]
            var cells: [String] = []
            var current = ""
            var escaped = false
            for character in line {
                if escaped {
                    if character != "|" { current.append("\\") }
                    current.append(character)
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "|" {
                    cells.append(current)
                    current = ""
                } else {
                    current.append(character)
                }
            }
            if escaped { current.append("\\") }
            cells.append(current)

            var trimmed = cells.map { $0.trimmingCharacters(in: .whitespaces) }
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)
            if trimmedLine.hasPrefix("|"), trimmed.first?.isEmpty == true { trimmed.removeFirst() }
            if trimmedLine.hasSuffix("|"), trimmed.last?.isEmpty == true { trimmed.removeLast() }
            return trimmed
        }

        func tableLineRange(reportedRange: Range<Int>, columnCount: Int) -> Range<Int> {
            guard reportedRange.count > 1 else { return reportedRange }
            for delimiterIndex in reportedRange.dropFirst().indices
                where self.isTableDelimiter(self.lines[delimiterIndex], columnCount: columnCount)
            {
                return reportedRange.index(before: delimiterIndex)..<reportedRange.upperBound
            }
            return reportedRange
        }

        private func isTableDelimiter(_ line: String, columnCount: Int) -> Bool {
            let trimmedLine = line.trimmingCharacters(in: .whitespaces)
            var cells = trimmedLine.split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
            if trimmedLine.hasPrefix("|"), cells.first?.isEmpty == true { cells.removeFirst() }
            if trimmedLine.hasSuffix("|"), cells.last?.isEmpty == true { cells.removeLast() }
            return cells.count == columnCount && cells.allSatisfy {
                $0.range(of: #"^:?-+:?$"#, options: .regularExpression) != nil
            }
        }
    }

    private struct FenceOpener {
        let character: Character
        let count: Int

        static func parse(_ line: String) -> FenceOpener? {
            let (indent, afterIndent) = Self.leadingSpaces(of: line)
            guard indent <= 3, afterIndent < line.endIndex else { return nil }
            let character = line[afterIndent]
            guard character == "`" || character == "~" else { return nil }

            var cursor = afterIndent
            var count = 0
            while cursor < line.endIndex, line[cursor] == character {
                count += 1
                cursor = line.index(after: cursor)
            }
            guard count >= 3 else { return nil }
            let info = line[cursor...].trimmingCharacters(in: .whitespaces)
            if character == "`", info.contains("`") { return nil }
            return FenceOpener(character: character, count: count)
        }

        func isClose(_ line: String) -> Bool {
            let (indent, afterIndent) = Self.leadingSpaces(of: line)
            guard indent <= 3, afterIndent < line.endIndex, line[afterIndent] == self.character else {
                return false
            }
            var cursor = afterIndent
            var count = 0
            while cursor < line.endIndex, line[cursor] == self.character {
                count += 1
                cursor = line.index(after: cursor)
            }
            return count >= self.count && line[cursor...].allSatisfy(\.isWhitespace)
        }

        private static func leadingSpaces(of line: String) -> (count: Int, end: String.Index) {
            var count = 0
            var cursor = line.startIndex
            while cursor < line.endIndex, line[cursor] == " " {
                count += 1
                cursor = line.index(after: cursor)
            }
            return (count, cursor)
        }
    }
}
