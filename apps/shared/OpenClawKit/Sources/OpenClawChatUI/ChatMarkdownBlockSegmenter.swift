import Foundation

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

enum ChatMarkdownBlockSegmenter {
    /// Splits message markdown into prose / fenced-code / table blocks.
    /// `isComplete: false` (streaming) keeps a trailing open fence or a table
    /// that is still growing on the plain-text path; anything ambiguous falls
    /// back to prose unchanged.
    static func segments(markdown: String, isComplete: Bool) -> [ChatMarkdownBlock] {
        let lines = markdown.replacingOccurrences(of: "\r\n", with: "\n")
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)

        var blocks: [ChatMarkdownBlock] = []
        var prose: [String] = []
        var index = 0

        func flushProse() {
            // Boundary blank lines only separated prose from extracted blocks;
            // the rendered VStack provides that spacing. Interior blanks stay
            // as paragraph breaks.
            var slice = prose[...]
            prose = []
            while slice.first?.trimmingCharacters(in: .whitespaces).isEmpty == true {
                slice = slice.dropFirst()
            }
            while slice.last?.trimmingCharacters(in: .whitespaces).isEmpty == true {
                slice = slice.dropLast()
            }
            guard !slice.isEmpty else { return }
            blocks.append(.prose(slice.joined(separator: "\n")))
        }

        while index < lines.count {
            if let opener = FenceOpener.parse(lines[index]) {
                flushProse()
                index = self.consumeFence(
                    opener,
                    lines: lines,
                    openerIndex: index,
                    isComplete: isComplete,
                    into: &blocks)
                continue
            }

            if let parsed = self.parseTable(lines: lines, startIndex: index) {
                // A table with no committed content after it may still be
                // growing while streaming; keep it prose (raw pipes) until the
                // message settles so rows don't re-layout on every delta.
                let rest = lines[parsed.endIndex...]
                if !isComplete, rest.allSatisfy({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) {
                    prose.append(contentsOf: lines[index...])
                    index = lines.count
                    continue
                }
                flushProse()
                blocks.append(.table(parsed.table))
                index = parsed.endIndex
                continue
            }

            prose.append(lines[index])
            index += 1
        }

        flushProse()
        return blocks
    }

    // MARK: - Fenced code

    private struct FenceOpener {
        let character: Character
        let count: Int
        let indent: Int
        let language: String?

        static func parse(_ line: String) -> FenceOpener? {
            let (indent, afterIndent) = Self.leadingSpaces(of: line)
            // 4+ spaces of indent is an indented code block, not a fence.
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
            // CommonMark: a backtick in the info string means this is an inline
            // code span, not a fence opener (tilde fences allow backticks).
            if character == "`", info.contains("`") { return nil }

            let language = info.split(separator: " ").first.map { $0.lowercased() }
            return FenceOpener(
                character: character,
                count: count,
                indent: indent,
                language: (language?.isEmpty ?? true) ? nil : language)
        }

        /// A close fence needs the same character, at least the opener's run
        /// length, <=3 spaces of indent, and nothing else on the line.
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
            guard count >= self.count else { return false }
            return line[cursor...].allSatisfy(\.isWhitespace)
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

    private static func consumeFence(
        _ opener: FenceOpener,
        lines: [String],
        openerIndex: Int,
        isComplete: Bool,
        into blocks: inout [ChatMarkdownBlock]) -> Int
    {
        var content: [String] = []
        var cursor = openerIndex + 1
        var closed = false
        while cursor < lines.count {
            if opener.isClose(lines[cursor]) {
                closed = true
                cursor += 1
                break
            }
            content.append(self.dedent(lines[cursor], by: opener.indent))
            cursor += 1
        }

        // CommonMark runs an unclosed fence to end-of-input, so a finished
        // message still renders it as code; while streaming it stays plain.
        blocks.append(.code(ChatCodeBlock(
            language: opener.language,
            code: content.joined(separator: "\n"),
            isComplete: closed || isComplete)))
        return cursor
    }

    /// CommonMark strips up to the opener's indent from fence content lines.
    private static func dedent(_ line: String, by indent: Int) -> String {
        guard indent > 0 else { return line }
        var removed = 0
        var cursor = line.startIndex
        while cursor < line.endIndex, line[cursor] == " ", removed < indent {
            removed += 1
            cursor = line.index(after: cursor)
        }
        return String(line[cursor...])
    }

    // MARK: - Tables

    private static func parseTable(
        lines: [String],
        startIndex: Int) -> (table: ChatMarkdownTable, endIndex: Int)?
    {
        guard startIndex + 1 < lines.count else { return nil }
        let headerLine = lines[startIndex]
        guard headerLine.contains("|") else { return nil }
        guard let alignments = self.parseDelimiterRow(lines[startIndex + 1]) else { return nil }

        let header = self.parseRow(headerLine)
        // GFM: the delimiter row must match the header cell count exactly,
        // otherwise the block is not a table and stays prose.
        guard !header.isEmpty, header.count == alignments.count else { return nil }

        var rows: [[String]] = []
        var cursor = startIndex + 2
        while cursor < lines.count {
            let line = lines[cursor]
            let trimmed = line.trimmingCharacters(in: .whitespaces)
            guard !trimmed.isEmpty, line.contains("|") else { break }
            // GFM pads short rows and truncates long ones to the header width.
            var cells = self.parseRow(line)
            if cells.count < header.count {
                cells += Array(repeating: "", count: header.count - cells.count)
            }
            rows.append(Array(cells.prefix(header.count)))
            cursor += 1
        }
        return (ChatMarkdownTable(header: header, alignments: alignments, rows: rows), cursor)
    }

    private static func parseDelimiterRow(_ line: String) -> [ChatMarkdownTable.ColumnAlignment]? {
        guard line.contains("|") else { return nil }
        let cells = self.parseRow(line)
        guard !cells.isEmpty else { return nil }

        var alignments: [ChatMarkdownTable.ColumnAlignment] = []
        for cell in cells {
            guard cell.range(of: "^:?-+:?$", options: .regularExpression) != nil else { return nil }
            let leading = cell.hasPrefix(":")
            let trailing = cell.hasSuffix(":")
            if leading, trailing {
                alignments.append(.center)
            } else if trailing {
                alignments.append(.trailing)
            } else {
                alignments.append(.leading)
            }
        }
        return alignments
    }

    /// Splits a table row on unescaped pipes; `\|` stays a literal pipe.
    private static func parseRow(_ line: String) -> [String] {
        var cells: [String] = []
        var current = ""
        var escaped = false
        for character in line {
            if escaped {
                // Only "\|" is meaningful here; other escapes pass through for
                // the inline markdown renderer to handle.
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

        var trimmedCells = cells.map { $0.trimmingCharacters(in: .whitespaces) }
        // A leading/trailing unescaped pipe produces an empty boundary cell;
        // escaped pipes never yield empty cells, so this cannot eat content.
        let trimmedLine = line.trimmingCharacters(in: .whitespaces)
        if trimmedCells.count > 1, trimmedLine.hasPrefix("|"), trimmedCells.first?.isEmpty == true {
            trimmedCells.removeFirst()
        }
        if trimmedCells.count > 1, trimmedLine.hasSuffix("|"), trimmedCells.last?.isEmpty == true {
            trimmedCells.removeLast()
        }
        return trimmedCells
    }
}
