import Foundation
import Markdown
import OpenClawProtocol
import SwiftUI

private struct ChatProgressCardSurface: ViewModifier {
    let cornerRadius: CGFloat

    func body(content: Content) -> some View {
        #if os(macOS)
        content
            .background(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .fill(OpenClawChatTheme.subtleCard))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        #else
        if #available(iOS 26.0, *) {
            content
                .glassEffect(.regular, in: .rect(cornerRadius: self.cornerRadius))
        } else {
            content
                .background(
                    .regularMaterial,
                    in: RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
                .overlay(
                    RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.composerBorder, lineWidth: 1))
        }
        #endif
    }
}

struct ChatProgressCard: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let steps: [ProgressCardStep]
    let markdown: String?
    var isInline = false

    @State private var isExpanded = false

    private var completedCount: Int {
        self.steps.count { $0.status == .completed }
    }

    private var currentStep: ProgressCardStep? {
        self.steps.first { $0.status == .inProgress }
            ?? self.steps.last { $0.status == .completed }
            ?? self.steps.first
    }

    private var parsedMarkdown: ChatProgressCardMarkdown {
        ChatProgressCardMarkdown(self.markdown ?? "")
    }

    private var markdownSummary: String? {
        let parsed = self.parsedMarkdown
        guard let line = parsed.text
            .split(whereSeparator: \.isNewline)
            .map(String.init)
            .first(where: { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty })
        else { return parsed.bars.first?.label }
        var summary = line.trimmingCharacters(in: .whitespacesAndNewlines)
        while let first = summary.first,
              first.isWhitespace || "#-*>".contains(first)
        {
            summary.removeFirst()
        }
        return summary.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    var body: some View {
        Group {
            if self.isInline {
                self.content
            } else {
                self.content
                    .modifier(ChatProgressCardSurface(cornerRadius: self.isExpanded ? 16 : 18))
            }
        }
        .foregroundStyle(OpenClawChatTheme.assistantText)
    }

    private var content: some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(self.reduceMotion ? nil : .easeInOut(duration: 0.2)) {
                    self.isExpanded.toggle()
                }
            } label: {
                self.summary
                    .padding(.horizontal, self.isInline ? 0 : 12)
                    .padding(.vertical, self.isInline ? 4 : (self.isExpanded ? 11 : 9))
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityLabel(self.summaryAccessibilityLabel)
            .accessibilityHint(self.isExpanded ? "Collapse plan" : "Expand plan")

            if self.isExpanded {
                Divider()
                    .overlay(OpenClawChatTheme.divider)
                    .padding(.horizontal, 12)
                VStack(alignment: .leading, spacing: 9) {
                    let parsed = self.parsedMarkdown
                    ForEach(Array(parsed.bars.enumerated()), id: \.offset) { _, bar in
                        VStack(alignment: .leading, spacing: 4) {
                            if let label = bar.label {
                                Text(verbatim: label)
                                    .font(OpenClawChatTypography.caption)
                                    .foregroundStyle(.secondary)
                            }
                            ProgressView(value: bar.value, total: bar.total)
                        }
                        .accessibilityElement(children: .combine)
                    }
                    if !parsed.text.isEmpty {
                        ChatMarkdownRenderer(
                            text: parsed.text,
                            context: .assistant,
                            variant: .compact,
                            textColor: OpenClawChatTheme.assistantText)
                    }
                    VStack(alignment: .leading, spacing: 7) {
                        ForEach(Array(self.steps.enumerated()), id: \.offset) { _, step in
                            self.stepRow(step)
                        }
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 9)
                .padding(.bottom, 11)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var summaryAccessibilityLabel: String {
        if let currentStep {
            return "Plan, \(self.completedCount) of \(self.steps.count) steps done, "
                + "\(Self.accessibilityLabel(for: currentStep.status)): \(currentStep.step)"
        }
        return "Plan, \(self.markdownSummary ?? "Progress update")"
    }

    private var summary: some View {
        HStack(spacing: 8) {
            if self.isInline, !self.steps.isEmpty, self.completedCount == self.steps.count {
                Image(systemName: "checkmark")
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(OpenClawChatTheme.success)
                Text(verbatim: self.completedCount == 1
                    ? String(localized: "1 step completed")
                    : String(format: String(localized: "%lld steps completed"), self.completedCount))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
            } else if let currentStep {
                Text(Self.marker(for: currentStep.status))
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(Self.markerColor(for: currentStep.status))
                Text(currentStep.step)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                    .lineLimit(1)
                    .truncationMode(.tail)
            } else if let markdownSummary {
                Text(markdownSummary)
                    .font(OpenClawChatTypography.footnoteSemiBold)
                    .lineLimit(1)
                    .truncationMode(.tail)
            }
            if !self.isInline {
                Spacer(minLength: 8)
            }
            if !self.steps.isEmpty, !self.isInline || self.completedCount != self.steps.count {
                Text(verbatim: "\(self.completedCount)/\(self.steps.count)")
                    .font(OpenClawChatTypography.captionSemiBold)
                    .foregroundStyle(OpenClawChatTheme.muted)
            }
            Image(systemName: self.isInline ? "chevron.right" : "chevron.down")
                .font(OpenClawChatTypography.caption2)
                .foregroundStyle(OpenClawChatTheme.muted)
                .rotationEffect(.degrees(self.isExpanded ? (self.isInline ? 90 : 180) : 0))
            if self.isInline {
                Spacer(minLength: 0)
            }
        }
    }

    private func stepRow(_ step: ProgressCardStep) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Text(Self.marker(for: step.status))
                .font(OpenClawChatTypography.captionSemiBold)
                .foregroundStyle(Self.markerColor(for: step.status))
                .frame(width: 12, alignment: .center)
            Text(step.step)
                .font(OpenClawChatTypography.footnote)
                .foregroundStyle(
                    step.status == .pending
                        ? OpenClawChatTheme.muted
                        : OpenClawChatTheme.assistantText)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Self.stepAccessibilityLabel(step))
    }

    private static func marker(for status: ProgressCardStepStatus) -> String {
        switch status {
        case .completed: "✓"
        case .inProgress: "▸"
        case .pending: "▢"
        }
    }

    private static func markerColor(for status: ProgressCardStepStatus) -> Color {
        switch status {
        case .completed, .inProgress: OpenClawChatTheme.accent
        case .pending: OpenClawChatTheme.muted
        }
    }

    private static func stepAccessibilityLabel(_ step: ProgressCardStep) -> String {
        "\(self.accessibilityLabel(for: step.status)), \(step.step)"
    }

    private static func accessibilityLabel(for status: ProgressCardStepStatus) -> String {
        switch status {
        case .completed: "Completed"
        case .inProgress: "In progress"
        case .pending: "Pending"
        }
    }
}

/// The card's Markdown with its `<progress aria-label="…" value="3" max="5"></progress>` tags taken out.
/// The Control UI draws those as bars; shown as text they are noise.
struct ChatProgressCardMarkdown: Equatable {
    struct Bar: Equatable {
        let label: String?
        let value: Double?
        let total: Double
    }

    let bars: [Bar]
    let text: String

    init(_ markdown: String) {
        // Built per call: the card is short and a shared Regex is not Sendable.
        guard let tag = try? Regex(#"<progress(?=\s|>)((?:[^>\"']|\"[^\"]*\"|'[^']*')*)>"#).ignoresCase(),
              let closingTag = try? Regex(#"\s*</progress\s*>"#).ignoresCase()
        else {
            self.bars = []
            self.text = markdown
            return
        }
        // Only rendered HTML can carry progress: link destinations, titles, and image text cannot.
        // Code examples and literal HTML contexts stay untouched. The Markdown parser
        // ends lines at LF, CR, and CRLF alike and reads each NUL byte as the three-byte
        // replacement character, so its line and column numbers address that expanded source.
        // Parse the same expansion and map its offsets back: lone-CR endings would otherwise
        // index this array out of range and trap the app, and NUL bytes would shift protection.
        let expanded = markdown.replacingOccurrences(of: "\u{0}", with: "\u{FFFD}")
        var expandedToOriginal = [Int]()
        expandedToOriginal.reserveCapacity(expanded.utf8.count)
        for (originalOffset, byte) in markdown.utf8.enumerated() {
            if byte == 0 {
                expandedToOriginal.append(contentsOf: [originalOffset, originalOffset, originalOffset])
            } else {
                expandedToOriginal.append(originalOffset)
            }
        }
        var lineStarts = [0]
        let utf8 = Array(expanded.utf8)
        var offset = 0
        while offset < utf8.count {
            if utf8[offset] == 13, offset + 1 < utf8.count, utf8[offset + 1] == 10 { offset += 1 }
            if utf8[offset] == 10 || utf8[offset] == 13 { lineStarts.append(offset + 1) }
            offset += 1
        }
        func sourceRange(_ node: any Markup, html: String) -> Range<String.Index>? {
            guard let range = node.range,
                  lineStarts.indices.contains(range.lowerBound.line - 1),
                  lineStarts.indices.contains(range.upperBound.line - 1),
                  range.lowerBound.column > 0, range.upperBound.column > 0 else { return nil }
            let startOffset = lineStarts[range.lowerBound.line - 1] + range.lowerBound.column - 1
            let endOffset = lineStarts[range.upperBound.line - 1] + range.upperBound.column - 1
            guard startOffset >= 0, endOffset > startOffset,
                  endOffset <= expandedToOriginal.count else { return nil }
            // Cmark can retain a container's column offset on lazy continuation lines.
            // Even in-bounds inline locations must identify the HTML that was parsed.
            if node is InlineHTML,
               String(bytes: utf8[startOffset..<endOffset], encoding: .utf8)?
                   .replacingOccurrences(of: "\r\n", with: "\n")
                   .replacingOccurrences(of: "\r", with: "\n") != html
            {
                return nil
            }
            let start = markdown.utf8.index(
                markdown.utf8.startIndex, offsetBy: expandedToOriginal[startOffset])
            let end = markdown.utf8.index(
                markdown.utf8.startIndex, offsetBy: expandedToOriginal[endOffset - 1] + 1)
            return start..<end
        }
        var htmlRanges: [Range<String.Index>] = []
        var literalRanges: [Range<String.Index>] = []
        var invalidHTMLRange = false
        func collectHTML(_ node: any Markup) {
            guard !invalidHTMLRange, !(node is Markdown.Image) else { return }
            let html = (node as? HTMLBlock)?.rawHTML ?? (node as? InlineHTML)?.rawHTML
            let literalHTML = html.map { raw in
                let start = raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                return ["<!--", "<!", "<?", "<pre", "<script", "<style", "<textarea"].contains {
                    start.hasPrefix($0)
                }
            } ?? false
            if let html {
                guard let range = sourceRange(node, html: html) else {
                    invalidHTMLRange = true
                    return
                }
                htmlRanges.append(range)
                if literalHTML {
                    literalRanges.append(range)
                }
            } else {
                for child in node.children {
                    collectHTML(child)
                }
            }
        }
        collectHTML(Document(parsing: expanded))
        // Preserve the complete card when upstream positions cannot identify its source safely.
        guard !invalidHTMLRange else {
            self.bars = []
            self.text = markdown
            return
        }
        // A raw element can span several inline nodes. Only an owned opener starts that
        // context: tag-like text in a quoted attribute or a code example cannot start one.
        if let rawTag = try? NSRegularExpression(
            pattern: #"<(pre|script|style|textarea)(?=\s|>)(?:[^>"']|"[^"]*"|'[^']*')*>"#,
            options: [.caseInsensitive])
        {
            for owner in htmlRanges {
                guard let startIndex = markdown[owner].firstIndex(where: { !$0.isWhitespace }),
                      let match = rawTag.firstMatch(
                          in: markdown, options: [.anchored], range: NSRange(startIndex..., in: markdown)),
                      let range = Range(match.range, in: markdown),
                      let nameRange = Range(match.range(at: 1), in: markdown) else { continue }
                let start = range.lowerBound
                guard !literalRanges.contains(where: { $0.lowerBound < start && $0.contains(start) }),
                      !ChatMarkdownBlockSyntax.isEscaped(at: range.lowerBound, in: markdown) else { continue }
                let closing = try? NSRegularExpression(
                    pattern: "</" + markdown[nameRange] + #"\s*>"#,
                    options: [.caseInsensitive])
                let tail = NSRange(range.upperBound..<markdown.endIndex, in: markdown)
                let end = closing?.firstMatch(in: markdown, range: tail)
                    .flatMap { Range($0.range, in: markdown) }?.upperBound ?? markdown.endIndex
                literalRanges.append(start..<end)
            }
        }
        var matches: [(range: Range<String.Index>, attributes: String)] = []
        for owner in htmlRanges {
            var cursor = owner.lowerBound
            // A block may contain a leading run of empty progress elements. Do not scan
            // through other HTML or text: that would promote attributes or fallback content.
            while cursor < owner.upperBound,
                  let start = markdown[cursor..<owner.upperBound].firstIndex(where: { !$0.isWhitespace })
            {
                guard !literalRanges.contains(where: { $0.contains(start) }),
                      !ChatMarkdownBlockSyntax.isEscaped(at: start, in: markdown),
                      let match = markdown[start..<owner.upperBound].prefixMatch(of: tag) else { break }
                var end = match.range.upperBound
                if let closing = markdown[end...].prefixMatch(of: closingTag),
                   let closeStart = markdown[closing.range].firstIndex(of: "<"),
                   htmlRanges.contains(where: { $0.contains(closeStart) })
                {
                    end = closing.range.upperBound
                }
                matches.append((start..<end, match.output[1].substring.map(String.init) ?? ""))
                if end >= owner.upperBound { break }
                cursor = end
            }
        }
        let attributePattern = #"(?:^|\s)([^\s=]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))"#
        let attributeRegex = try? Regex(attributePattern)
        self.bars = matches.map { match in
            let source = match.attributes
            var attributes: [String: String] = [:]
            for found in attributeRegex.map({ source.matches(of: $0) }) ?? [] {
                guard let name = found.output[1].substring?.lowercased(), attributes[name] == nil else { continue }
                attributes[name] = (found.output[2].substring ?? found.output[3].substring
                    ?? found.output[4].substring).map(String.init)
            }
            let total = attributes["max"].flatMap(Double.init).flatMap { $0.isFinite && $0 > 0 ? $0 : nil } ?? 1
            let value = attributes["value"].map { raw in
                let number = Double(raw).flatMap { $0.isFinite ? $0 : nil } ?? 0
                return min(max(number, 0), total)
            }
            let label = attributes["aria-label"].map(Self.decodedLabel)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            return Bar(label: label?.isEmpty == false ? label : nil, value: value, total: total)
        }
        var text = markdown
        for match in matches.reversed() {
            text.removeSubrange(match.range)
        }
        self.text = matches.isEmpty ? markdown : text.trimmingCharacters(in: .newlines)
    }

    private static func decodedLabel(_ label: String) -> String {
        // Preserve literal punctuation while allowing CommonMark's entity decoding.
        let escaped = label.replacingOccurrences(
            of: #"([\\`*_\[\]<>])"#,
            with: #"\\$1"#,
            options: .regularExpression)
        guard let parsed = try? AttributedString(
            markdown: escaped,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))
        else { return label }
        return String(parsed.characters)
    }
}
