import Foundation
import OpenClawKit
import SwiftUI

struct ChatToolActivityItem: Identifiable, Equatable {
    enum State: Equatable {
        case running
        case finished
        case failed
        case blocked
        case unavailable

        var title: LocalizedStringResource {
            switch self {
            case .running: "Working"
            case .finished: "Finished"
            case .failed: "Failed"
            case .blocked: "Blocked"
            case .unavailable: "No result"
            }
        }
    }

    let id: String
    let name: String?
    let arguments: AnyCodable?
    let details: AnyCodable?
    let resultText: String?
    let state: State
    let liveDiffStat: ChatToolDiffStat?
    var activity: OpenClawAgentActivityItem?
    var activityPrepared = false

    var isVisible: Bool {
        self.activity?.isVisible ?? !self.activityPrepared
    }

    var displayState: State {
        guard let activity = self.activity else { return self.state }
        switch activity.status {
        case "running": return .running
        case "completed": return .finished
        case "failed": return .failed
        case "blocked": return .blocked
        default: return .unavailable
        }
    }

    var isError: Bool {
        self.displayState == .failed
    }

    var isPending: Bool {
        self.displayState == .running
    }
}

enum ChatToolActivity {
    static func resultIsError(_ flag: Bool?, text: String?) -> Bool {
        if let flag { return flag }
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        if ["tool not found", "tool not found."].contains(text.lowercased()) { return true }
        guard text.utf16.count <= 20000,
              text.hasPrefix("{"), text.hasSuffix("}"),
              let data = text.data(using: .utf8),
              let result = try? JSONDecoder().decode(AnyCodable.self, from: data).dictionaryValue
        else { return false }
        if let flag = result["isError"]?.boolValue ?? result["is_error"]?.boolValue { return flag }
        if let error = result["error"] {
            if let text = error.stringValue,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
            if error.boolValue == true || error.dictionaryValue != nil || error.arrayValue != nil { return true }
        }
        return ["error", "failed", "timeout"].contains(
            result["status"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "")
    }

    static func items(
        calls: [OpenClawChatMessageContent],
        results: [OpenClawChatMessageContent]) -> [ChatToolActivityItem]
    {
        var remainingResults = Array(results.enumerated())
        var items = calls.enumerated().map { index, call in
            let resultIndex = call.id.flatMap { callID in
                remainingResults.firstIndex { _, result in result.id == callID }
            }
            let result = resultIndex.map { remainingResults.remove(at: $0).element }

            return ChatToolActivityItem(
                id: call.id ?? "call-\(index)",
                name: call.name,
                arguments: call.arguments,
                details: result?.details,
                resultText: result?.text,
                state: result
                    .map { Self.resultIsError($0.isError, text: $0.text) ? .failed : .finished } ?? .unavailable,
                liveDiffStat: nil)
        }

        items.append(contentsOf: remainingResults.map { index, result in
            ChatToolActivityItem(
                id: result.id ?? "result-\(index)",
                name: result.name,
                arguments: nil,
                details: result.details,
                resultText: result.text,
                state: Self.resultIsError(result.isError, text: result.text) ? .failed : .finished,
                liveDiffStat: nil)
        })
        return items
    }
}

struct ChatToolActivityRow: View, Equatable {
    let item: ChatToolActivityItem

    var body: some View {
        // Compare the item before constructing the content: its initializer prepares
        // the diff, which unchanged siblings must not repeat on every tool update.
        ChatToolActivityRowContent(item: self.item)
    }
}

private struct ChatToolActivityRowContent: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let item: ChatToolActivityItem
    private let resolvedDiff: (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    @State private var expanded = false
    @State private var showsFullResult = false

    private static let disclosureWidth: CGFloat = 12
    private static let expandedLineLimit = 40

    private var display: ToolDisplaySummary {
        ToolDisplayRegistry.resolve(name: self.item.name ?? "tool", args: self.item.arguments)
    }

    private var detailLine: String? {
        guard let detail = self.display.detailLine, !detail.isEmpty else { return nil }
        return detail
    }

    private var formattedResult: String {
        guard let resultText = self.item.resultText else { return "" }
        return ToolResultTextFormatter.format(text: resultText, toolName: self.item.name)
    }

    private var expandable: Bool {
        self.resolvedDiff != nil || !self.formattedResult.isEmpty
    }

    private var accessibilityValue: String {
        let status = String(localized: self.item.displayState.title)
        return self.detailLine.map { "\(status), \($0)" } ?? status
    }

    private var expandedLineCount: Int {
        self.resolvedDiff?.lines.count ?? self.formattedResult.components(separatedBy: .newlines).count
    }

    private var isResultTruncated: Bool {
        self.expandedLineCount > Self.expandedLineLimit
    }

    private var expandedResult: String {
        guard self.isResultTruncated, !self.showsFullResult else { return self.formattedResult }
        let lines = self.formattedResult.components(separatedBy: .newlines)
        return lines.prefix(Self.expandedLineLimit - 1).joined(separator: "\n") + "\n…"
    }

    private var expandedDiffLines: [ChatToolDiffLine] {
        guard let lines = self.resolvedDiff?.lines else { return [] }
        guard self.isResultTruncated, !self.showsFullResult else { return lines }
        return Array(lines.prefix(Self.expandedLineLimit - 1)) + [
            ChatToolDiffLine(kind: .skip, text: ""),
        ]
    }

    private var displayedDiffStat: ChatToolDiffStat? {
        self.item.isPending ? self.item.liveDiffStat ?? self.resolvedDiff?.stat : self.resolvedDiff?.stat
    }

    init(item: ChatToolActivityItem) {
        self.item = item
        self.resolvedDiff = ChatToolDiff.resolveDiff(
            name: item.name,
            arguments: item.arguments,
            details: item.details,
            isError: item.isError)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            if self.expandable {
                Button {
                    withAnimation(self.reduceMotion ? nil : .easeOut(duration: 0.15)) {
                        self.expanded.toggle()
                    }
                } label: {
                    self.collapsedRow
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(self.display.title)
                .accessibilityValue(self.accessibilityValue)
                .accessibilityHint(self.expanded ? "Collapse tool result" : "Expand tool result")
                .accessibilityIdentifier("chat-tool-activity-\(self.item.id)")
            } else {
                self.collapsedRow
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(self.display.title)
                    .accessibilityValue(self.accessibilityValue)
            }

            if self.expanded, self.expandable {
                VStack(alignment: .leading, spacing: 6) {
                    if self.resolvedDiff != nil {
                        self.diffRows
                        // The result text carries the outcome (success summary or the
                        // error diagnostic); hiding it would misrepresent failed edits
                        // as applied changes. Bounded so foreign harness output cannot
                        // dwarf the diff.
                        if !self.formattedResult.isEmpty {
                            Text(self.formattedResult)
                                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                                .foregroundStyle(.secondary)
                                .textSelection(.enabled)
                                .lineLimit(Self.expandedLineLimit)
                        }
                    } else {
                        Text(self.expandedResult)
                            .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                            .foregroundStyle(.secondary)
                            .textSelection(.enabled)
                    }

                    if self.isResultTruncated {
                        Button {
                            self.showsFullResult.toggle()
                        } label: {
                            Text(
                                self.showsFullResult
                                    ? String(localized: "Show less")
                                    : String(
                                        format: String(localized: "Show all %lld lines"),
                                        Int64(self.expandedLineCount)))
                                .font(OpenClawChatTypography.caption)
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    if !self.isDesktopLayout {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(OpenClawChatTheme.subtleCard)
                    }
                }
                .padding(.leading, self.isDesktopLayout ? 0 : 19)
            }
        }
        .modifier(ChatWorkCardStyle())
    }

    private var collapsedRow: some View {
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Group {
                if self.item.isPending {
                    ProgressView()
                        .controlSize(.mini)
                } else if self.expandable {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .opacity(0.7)
                        .rotationEffect(.degrees(self.expanded ? 90 : 0))
                } else {
                    Color.clear
                }
            }
            .frame(width: Self.disclosureWidth, height: 12)

            Image(systemName: Self.symbol(forToolName: self.item.name))
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(self.item.isError ? OpenClawChatTheme.danger : Color.secondary)

            if self.isDesktopLayout {
                VStack(alignment: .leading, spacing: 3) {
                    self.toolTitle
                    self.toolDetail
                }
            } else {
                self.toolTitle
                self.toolDetail
            }

            if let stat = self.displayedDiffStat {
                ChatDiffStatChips(stat: stat)
            }

            Spacer(minLength: 0)

            if self.isDesktopLayout {
                Text(self.item.displayState.title)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(self.item.isError ? OpenClawChatTheme.danger : .secondary)
                    .fixedSize()
            }
        }
        .padding(.vertical, 3)
    }

    private var toolTitle: some View {
        Text(self.item.activity?.title ?? self.display.title)
            .font(OpenClawChatTypography.footnoteSemiBold)
            .foregroundStyle(self.item.isError ? OpenClawChatTheme.danger : self.textColor)
            .lineLimit(1)
    }

    @ViewBuilder
    private var toolDetail: some View {
        if let detailLine = self.detailLine {
            Text(detailLine)
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var textColor: Color {
        self.isDesktopLayout
            ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
            : OpenClawChatTheme.assistantText
    }

    private var diffRows: some View {
        // The orthogonal nested scroll keeps long diff lines reachable without
        // competing with the transcript's vertical gesture.
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(self.expandedDiffLines.indices, id: \.self) { index in
                    self.diffRow(self.expandedDiffLines[index])
                }
            }
            .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func diffRow(_ line: ChatToolDiffLine) -> some View {
        if line.kind == .file {
            Text(verbatim: String(line.text.unicodeScalars.prefix(2000)))
                .font(OpenClawChatTypography.mono(size: 11, relativeTo: .caption))
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.top, 6)
        } else if line.kind == .skip {
            Text("⋯")
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary.opacity(0.6))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 2)
                // Reuses the existing localized "Collapsed" key so omitted
                // preview rows stay announced to assistive tech.
                .accessibilityLabel(Text("Collapsed"))
        } else {
            HStack(spacing: 6) {
                if let lineNo = line.lineNo {
                    Text(verbatim: "\(lineNo)")
                        .font(OpenClawChatTypography.mono(size: 10, relativeTo: .caption2))
                        .foregroundStyle(.secondary.opacity(0.6))
                        .frame(minWidth: 34, alignment: .trailing)
                }
                // Bound per-line render work; generated/minified payloads can put
                // megabytes on a single line.
                Text(verbatim: String(line.text.unicodeScalars.prefix(2000)))
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(self.diffTextColor(line.kind))
                    .fixedSize(horizontal: true, vertical: false)
            }
            .background(self.diffBackground(line.kind))
            // Color alone must not carry add/del semantics for assistive tech.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: Self.accessibilityText(for: line)))
        }
    }

    private static func accessibilityText(for line: ChatToolDiffLine) -> String {
        let lineNo = line.lineNo.map { "\($0) " } ?? ""
        return lineNo + self.accessibilityMarker(line.kind) + String(line.text.unicodeScalars.prefix(2000))
    }

    private static func accessibilityMarker(_ kind: ChatToolDiffLineKind) -> String {
        switch kind {
        case .add:
            "+ "
        case .del:
            "\u{2212} "
        case .ctx, .file, .skip:
            ""
        }
    }

    private func diffTextColor(_ kind: ChatToolDiffLineKind) -> Color {
        switch kind {
        case .add:
            OpenClawChatTheme.assistantText
        case .del, .ctx, .file, .skip:
            .secondary
        }
    }

    private func diffBackground(_ kind: ChatToolDiffLineKind) -> Color {
        switch kind {
        case .add:
            OpenClawChatTheme.success.opacity(0.14)
        case .del:
            OpenClawChatTheme.danger.opacity(0.12)
        case .ctx, .file, .skip:
            .clear
        }
    }

    private static func symbol(forToolName name: String?) -> String {
        let normalized = name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let exact: [String: String] = [
            "agent": "rectangle.stack",
            "bash": "terminal",
            "browser": "safari",
            "canvas": "photo",
            "clock": "clock",
            "command": "terminal",
            "cron": "clock",
            "create_file": "square.and.pencil",
            "edit": "pencil.line",
            "edit_file": "pencil.line",
            "exec": "terminal",
            "fetch": "globe",
            "find": "magnifyingglass",
            "gateway": "server.rack",
            "glob": "magnifyingglass",
            "grep": "magnifyingglass",
            "view_image": "photo",
            "list": "magnifyingglass",
            "ls": "magnifyingglass",
            "memory": "brain",
            "message": "bubble.left",
            "multi_edit": "pencil.line",
            "multiedit": "pencil.line",
            "notebook_edit": "pencil.line",
            "notebookedit": "pencil.line",
            "node": "server.rack",
            "apply_patch": "pencil.line",
            "applypatch": "pencil.line",
            "patch": "pencil.line",
            "photo": "photo",
            "read": "doc.text",
            "reply": "bubble.left",
            "schedule": "clock",
            "screenshot": "photo",
            "search": "magnifyingglass",
            "send": "bubble.left",
            "session": "rectangle.stack",
            "shell": "terminal",
            "terminal": "terminal",
            "web": "globe",
            "write": "square.and.pencil",
            "write_file": "square.and.pencil",
            "str_replace_based_edit_tool": "pencil.line",
            "str_replace_editor": "pencil.line",
        ]
        if let symbol = exact[normalized] { return symbol }

        let fallbacks: [([String], String)] = [
            (["canvas", "image", "screenshot", "photo"], "photo"),
            (["browser"], "safari"),
            (["message", "send", "reply"], "bubble.left"),
            (["node", "gateway"], "server.rack"),
            (["cron", "schedule", "clock"], "clock"),
            (["memory"], "brain"),
            (["session", "agent"], "rectangle.stack"),
            (["exec", "bash", "shell", "command", "terminal"], "terminal"),
            (["edit", "patch"], "pencil.line"),
            (["write"], "square.and.pencil"),
            (["grep", "glob", "find", "search", "list"], "magnifyingglass"),
            (["read"], "doc.text"),
            (["fetch", "web"], "globe"),
        ]
        return fallbacks.first { keys, _ in keys.contains(where: normalized.contains) }?.1
            ?? "wrench.and.screwdriver"
    }
}

struct ChatWorkCardStyle: ViewModifier {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .padding(self.isDesktopLayout ? 10 : 0)
            .background {
                if self.isDesktopLayout {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(.primary.opacity(self.colorScheme == .dark ? 0.035 : 0.025))
                }
            }
            .overlay {
                if self.isDesktopLayout {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(.primary.opacity(0.07), lineWidth: 1)
                }
            }
    }
}

struct ChatDiffStatChips: View {
    let stat: ChatToolDiffStat

    var body: some View {
        Group {
            Text(verbatim: "+\(self.stat.added)")
                .foregroundStyle(OpenClawChatTheme.success.opacity(0.9))
            Text(verbatim: "−\(self.stat.removed)")
                .foregroundStyle(OpenClawChatTheme.danger.opacity(0.9))
        }
        .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
        .lineLimit(1)
    }
}

struct ChatToolActivityList: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    let items: [ChatToolActivityItem]

    var body: some View {
        VStack(alignment: .leading, spacing: self.isDesktopLayout ? 6 : 2) {
            ForEach(self.items.indices.filter { self.items[$0].isVisible }, id: \.self) { index in
                ChatToolActivityRow(item: self.items[index])
                    .equatable()
            }
            let quiet = self.items.indices.filter { !self.items[$0].isVisible }
            if !quiet.isEmpty {
                DisclosureGroup("Tool details") {
                    ForEach(quiet, id: \.self) { index in
                        ChatToolActivityRow(item: self.items[index]).equatable()
                    }
                }
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}
