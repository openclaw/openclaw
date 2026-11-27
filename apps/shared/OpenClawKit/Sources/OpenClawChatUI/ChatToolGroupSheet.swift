#if os(iOS)
import OpenClawKit
import SwiftUI

enum ChatToolSheetSelection: Identifiable {
    case run(String, [ChatToolActivityItem])
    case work(ChatTranscriptRow.CompletedWork)
    case calls([ChatToolActivityItem], source: UUID, runID: String?)

    var id: String {
        switch self {
        case let .run(id, _): id
        case let .work(work): work.id.uuidString
        case let .calls(items, source, _): "\(source):\(items.first?.id ?? "")"
        }
    }
}

extension ChatTranscriptPresentation {
    func toolItems(in messages: some Sequence<OpenClawChatMessage>, live: [OpenClawChatPendingToolCall])
        -> [ChatToolActivityItem]
    {
        var seen = Set<String>()
        return messages.flatMap { message in
            ChatToolActivity.items(message: message, liveTools: live.filter { $0.runID == message.workRunID })
                .flatMap { self.tools.repeats.attempts[$0.id] ?? [$0] }
        }.filter { $0.isVisible && seen.insert($0.id).inserted }
    }

    func toolItems(for run: String, live: [OpenClawChatPendingToolCall]) -> [ChatToolActivityItem] {
        self.toolItems(
            in: self.inspectionRows.lazy.compactMap(\.workMessage).filter { $0.workRunID == run },
            live: live)
    }
}

extension EnvironmentValues {
    @Entry var openClawOpenToolSheet: (([ChatToolActivityItem]) -> Void)?
}

struct ChatToolGroupPresentation: View {
    let selection: ChatToolSheetSelection
    let transcript: ChatTranscriptPresentation
    let viewModel: OpenClawChatViewModel
    let displayOptions: OpenClawChatDisplayOptions
    let openChat: (String) -> Void

    var body: some View {
        let focus: String? = if case let .calls(items, _, _) = self.selection,
                                items.count == 1
        {
            items[0].id
        } else { nil }
        ChatToolGroupSheet(
            selection: self.currentSelection,
            focusedCallID: focus,
            liveTools: self.viewModel.toolActivities,
            displayOptions: self.displayOptions,
            openChat: self.openChat)
            .environment(\.openClawToolRowContext, self.transcript.tools)
    }

    private var currentSelection: ChatToolSheetSelection {
        let rows = self.transcript.inspectionRows
        let source: UUID
        let run: String?
        let anchorCall: String?
        switch self.selection {
        case let .run(id, previous):
            let items = self.transcript.toolItems(for: id, live: self.viewModel.toolActivities)
            return .run(id, items.isEmpty ? previous : items)
        case let .work(work):
            // Usually the transcript already has the exact updated stretch. Reproject only across a history handoff.
            for row in self.transcript.rows {
                if case let .completedWork(current) = row, current.isActivityRun == work.isActivityRun,
                   current.id == work.id
                {
                    return .work(current)
                }
            }
            guard work.isActivityRun, let first = work.messages.first else { return self.selection }
            source = first.id
            run = first.workRunID
            anchorCall = first.content.first(where: \.isToolCall)?.id
        case let .calls(items, messageID, runID):
            source = messageID
            run = runID
            anchorCall = items.first?.id
        }
        // First locate the tapped message. If history took over a live row, locate its canonical call.
        let index = rows.firstIndex { $0.workMessage?.id == source } ?? rows.firstIndex { row in
            guard let message = row.workMessage, let run, let anchorCall, message.workRunID == run else { return false }
            return message.content.contains { $0.isToolCall && $0.id == anchorCall }
        }
        guard let index else { return self.selection }
        let start = rows[...index].lastIndex(where: \.startsTurn) ?? rows.startIndex
        let end = rows[(index + 1)...].firstIndex { $0.startsTurn || $0.isToolHistoryBoundary } ?? rows.endIndex
        let lower = rows[start...index].lastIndex(where: \.isToolHistoryBoundary) ?? start
        let turn = rows[lower..<end]
        switch self.selection {
        case .run: return self.selection // Resolved by run identity above.
        case let .work(selected):
            let parts = turn.flatMap { row -> [ChatTranscriptRow] in
                row.workMessage?.workPresentationParts.map(ChatTranscriptRow.message) ?? [row]
            }
            // Same owner as the transcript; a later "Worked" disclosure must not widen this open stretch.
            for row in ChatTranscriptRow.coalescingActivityRuns(parts) {
                if case let .completedWork(work) = row, work.messages.contains(where: {
                    $0.presentationID == selected.anchorID || ($0.workRunID == run && anchorCall != nil &&
                        $0.content.contains { $0.isToolCall && $0.id == anchorCall })
                }) { return .work(work) }
                if case let .message(message) = row, message.isActivityRow,
                   message.id == source || (message.workRunID == run && anchorCall != nil &&
                       message.content.contains { $0.isToolCall && $0.id == anchorCall })
                { return .work(selected.replacingMessages([message])) }
            }
            return self.selection
        case let .calls(selected, _, _):
            let selectedIDs = Set(selected.map(\.id))
            let live = self.viewModel.toolActivities
            let peers = turn.compactMap(\.workMessage)
                .filter { run == nil || $0.workRunID == nil || $0.workRunID == run }
            let calls = self.transcript.toolItems(in: peers, live: live)
                .filter { selected.count == 1 || selectedIDs.contains($0.id) }
            return calls
                .contains(where: { $0.id == selected.first?.id }) ? .calls(calls, source: source, runID: run) : self
                .selection
        }
    }
}

extension ChatTranscriptRow {
    fileprivate var isToolHistoryBoundary: Bool {
        if case .historyDivider = self { return true }
        return false
    }
}

struct ChatToolGroupRow: View {
    let work: ChatTranscriptRow.CompletedWork
    let liveTools: [OpenClawChatPendingToolCall]
    let open: () -> Void
    var body: some View {
        Button(action: self.open) {
            ChatToolRowLabel(asset: "wrench", disclosure: .zero) {
                Text(verbatim: ChatCompletedWorkSummary.label(work: self.work, liveTools: self.liveTools))
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-tool-group")
        .transaction { $0.animation = nil }
    }
}

struct ChatToolGroupSheet: View {
    let selection: ChatToolSheetSelection
    let liveTools: [OpenClawChatPendingToolCall]
    let displayOptions: OpenClawChatDisplayOptions
    let openChat: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @Environment(\.openClawToolRowContext) private var toolContext
    @State private var detent: PresentationDetent = .medium
    let focusedCallID: String?
    @State private var path: [String]
    @State private var followsLiveTail = true

    init(
        selection: ChatToolSheetSelection,
        focusedCallID: String?,
        liveTools: [OpenClawChatPendingToolCall],
        displayOptions: OpenClawChatDisplayOptions,
        openChat: @escaping (String) -> Void)
    {
        self.selection = selection
        self.focusedCallID = focusedCallID
        self.liveTools = liveTools
        self.displayOptions = displayOptions
        self.openChat = openChat
        self._path = State(initialValue: focusedCallID.map { [$0] } ?? [])
    }

    private enum Step: Identifiable {
        case tool(String, ToolSheetStep)
        case note(String, String)

        var id: String {
            switch self {
            case let .tool(id, _), let .note(id, _): id
            }
        }
    }

    private var steps: [Step] {
        func tool(_ item: ChatToolActivityItem, id: String) -> Step {
            let chat = item.addressedSessionKey.flatMap(self.toolContext.names.name(for:))
            return .tool(id, ToolSheetStep(item: item, chatName: chat))
        }
        guard case let .work(work) = self.selection else {
            let items: [ChatToolActivityItem] = switch self.selection {
            case let .run(_, items), let .calls(items, _, _): items
            case .work: []
            }
            return items.map { tool($0, id: $0.id) }
        }
        var result: [Step] = []
        var seen = Set<String>()
        for message in work.messages {
            if !work.isActivityRun, message.role.lowercased() == "assistant" {
                let note = ChatMessageVisibleText.visibleText(in: message)
                if !note.isEmpty { result.append(.note(message.presentationID.uuidString, note)) }
                if self.displayOptions.contains(.reasoning) {
                    for (index, block) in message.content.enumerated() where block.type?.lowercased() == "thinking" {
                        if let thinking = block.thinking, !thinking.isEmpty {
                            result.append(.note("\(message.presentationID):\(index)", thinking))
                        }
                    }
                }
            }
            guard self.displayOptions.contains(.toolActivity) else { continue }
            let items = ChatToolActivity.items(message: message, liveTools: self.liveTools)
                .flatMap { self.toolContext.repeats.attempts[$0.id] ?? [$0] }
            for item in items {
                let id = "\(message.workRunID ?? ""):\(item.id)"
                guard seen.insert(id).inserted else { continue }
                result.append(tool(item, id: id))
            }
        }
        return result
    }

    var body: some View {
        let steps = self.steps
        Group {
            if steps.count == 1, let focusedCallID, case let .tool(id, tool) = steps[0], id == focusedCallID {
                NavigationStack {
                    ChatToolStepDetail(step: tool, openChat: self.openChat)
                        .toolbar { OpenClawSheetCloseItem(identifier: "chat-tool-sheet-close") { self.dismiss() } }
                }
            } else {
                NavigationStack(path: self.$path) {
                    ScrollViewReader { proxy in
                        ScrollView {
                            LazyVStack(alignment: .leading, spacing: 0) {
                                ForEach(Array(steps.enumerated()), id: \.element.id) { index, step in
                                    self.row(step, first: index == 0, last: index == steps.count - 1).id(step.id)
                                }
                            }
                            .padding(.horizontal, 20)
                            .padding(.vertical, 8)
                        }
                        .onScrollPhaseChange { previous, current, context in
                            if current == .interacting { self.followsLiveTail = false }
                            if current == .idle, previous == .interacting || previous == .decelerating {
                                self.followsLiveTail = context.geometry.visibleRect.maxY >= context.geometry.contentSize
                                    .height - 12
                            }
                        }
                        .onScrollGeometryChange(for: CGFloat.self) { geometry in
                            // A short timeline starts under the toolbar; only follow once its end overflows.
                            let viewport = geometry.containerSize.height - geometry.contentInsets.top - geometry
                                .contentInsets.bottom
                            return geometry.contentSize.height > viewport ? geometry.contentSize.height : 0
                        } action: { _, overflowingHeight in
                            if overflowingHeight > 0, case .run = self.selection,
                               self.path.isEmpty, self.followsLiveTail, let tail = steps.last?.id
                            {
                                proxy.scrollTo(tail, anchor: .bottom)
                            }
                        }
                        .onChange(of: self.path, initial: true) { previous, current in
                            if !current.isEmpty { self.followsLiveTail = false }
                            if current.isEmpty, let focus = previous.last ?? self.focusedCallID {
                                proxy.scrollTo(focus, anchor: .center)
                            }
                        }
                    }
                    .navigationTitle(Text(verbatim: self.title))
                    .navigationBarTitleDisplayMode(.inline)
                    .toolbar { OpenClawSheetCloseItem(identifier: "chat-tool-sheet-close") { self.dismiss() } }
                    .navigationDestination(for: String.self) { id in
                        if let step = steps.first(where: { $0.id == id }), case let .tool(_, tool) = step {
                            ChatToolStepDetail(step: tool, openChat: self.openChat)
                        }
                    }
                }
            }
        }
        .openClawSheetHeaderEdge()
        .tint(.primary)
        .presentationDetents([.medium, .large], selection: self.$detent)
        .presentationDragIndicator(.visible)
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
        .accessibilityIdentifier("chat-tool-sheet")
    }

    private var title: String {
        switch self.selection {
        case let .work(work): ChatCompletedWorkSummary.label(work: work, liveTools: self.liveTools)
        case .run, .calls: String(localized: "Tool details")
        }
    }

    @ViewBuilder
    private func row(_ step: Step, first: Bool, last: Bool) -> some View {
        switch step {
        case let .tool(id, tool):
            if tool.hasDetail {
                NavigationLink(value: id) { self.toolRow(tool, first: first, last: last) }
                    .buttonStyle(.plain)
                    .accessibilityIdentifier("chat-tool-step-\(tool.item.id)")
            } else {
                self.toolRow(tool, first: first, last: last)
                    .accessibilityElement(children: .combine)
            }
        case let .note(_, text):
            HStack(alignment: .center, spacing: 12) {
                self.marker(symbol: "text.bubble", first: first, last: last)
                Text(verbatim: text)
                    .font(OpenClawChatTypography.footnote)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .padding(.vertical, 12)
            }
        }
    }

    private func toolRow(_ step: ToolSheetStep, first: Bool, last: Bool) -> some View {
        HStack(spacing: 12) {
            self.marker(symbol: step.symbol, first: first, last: last)
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: step.title)
                    .font(OpenClawChatTypography.settingsBody)
                    .lineLimit(1)
                    .truncationMode(.tail)
                if let subtitle = step.subtitle {
                    Text(verbatim: subtitle)
                        .font(OpenClawChatTypography.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.tail)
                }
            }
            Spacer(minLength: 0)
            if step.item.isError {
                Text(step.item.statusTitle)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize()
            }
        }
        .frame(minHeight: 54)
        .contentShape(Rectangle())
    }

    private func marker(symbol: String, first: Bool, last: Bool) -> some View {
        ZStack {
            GeometryReader { geometry in
                let mid = geometry.size.height / 2
                Path { line in
                    if !first {
                        line.move(to: CGPoint(x: 12, y: 0))
                        line.addLine(to: CGPoint(x: 12, y: max(0, mid - 14)))
                    }
                    if !last {
                        line.move(to: CGPoint(x: 12, y: mid + 14))
                        line.addLine(to: CGPoint(x: 12, y: geometry.size.height))
                    }
                }
                .stroke(.quaternary, lineWidth: 1)
            }
            Image(systemName: symbol)
                .font(.system(size: 17, weight: .regular))
                .foregroundStyle(.secondary)
        }
        .frame(width: 24)
        .accessibilityHidden(true)
    }
}

private struct ToolSheetStep {
    let item: ChatToolActivityItem
    let chatName: String?
    private var call: (name: String?, args: AnyCodable?) {
        ToolDisplayRegistry.displayCall(name: self.item.name, args: self.item.arguments)
    }

    private var display: ToolDisplaySummary {
        ToolDisplayRegistry.resolve(name: self.call.name, args: self.call.args)
    }

    var symbol: String {
        ChatToolIcon.symbol(for: self.display.name, icon: self.display.icon)
    }

    var isCommand: Bool {
        ChatToolActivityItem.commandToolNames.contains(self.call.name?.lowercased() ?? "")
    }

    var title: String {
        self.item.stepTitle(chatName: self.chatName)
    }

    var toolName: String {
        self.isCommand ? String(localized: "Command") : self.display.title
    }

    var subtitle: String? {
        if self.item.commandPreview != nil { return nil }
        if self.item.addressedSessionKey != nil {
            return self.item.namesChatInTitle ? nil : self.chatName ?? self.item.callLabel
        }
        // The title already says the action. Bridge selectors belong in Input, not the timeline.
        let display = self.display
        if display.name.lowercased() == "toolsearch", display.detail?.hasPrefix("select:") == true { return nil }
        return display.detail
    }

    var input: String? {
        if self.isCommand, let command = self.call.args?.dictionaryValue?["command"]?.stringValue { return command }
        guard let args = self.call.args else { return nil }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(args)).flatMap { String(data: $0, encoding: .utf8) }
    }

    var output: String? {
        if let result = self.item.resultText ?? self.item.outcomeText, !result.isEmpty { return result }
        guard let details = self.item.details ?? self.item.outcomeDetails else { return self.item.failureReason }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys, .withoutEscapingSlashes]
        return (try? encoder.encode(details)).flatMap { String(data: $0, encoding: .utf8) }
    }

    var hasDetail: Bool {
        self.call.args != nil || self.item.resultText?.isEmpty == false || self.item.outcomeText?.isEmpty == false ||
            self.item.details != nil || self.item.outcomeDetails != nil || self.item.sessionLaunch?
            .childKey != nil || self.item.isError
    }
}

private struct ChatToolStepDetail: View {
    let step: ToolSheetStep
    let openChat: (String) -> Void

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 20) {
                Text(verbatim: self.step.title)
                    .font(OpenClawChatTypography.body)
                if let purpose = self.step.item.commandPurpose, purpose != self.step.title {
                    Text(verbatim: purpose).font(OpenClawChatTypography.footnote).foregroundStyle(.secondary)
                }
                if self.step.item.isError {
                    Label { Text(self.step.item.statusTitle) } icon: { Image(systemName: "exclamationmark.circle") }
                        .font(OpenClawChatTypography.footnote)
                        .foregroundStyle(.secondary)
                }
                if let input = self.step.input {
                    self.block(
                        title: self.step.isCommand ? "Command" : "Input",
                        copyLabel: self.step.isCommand ? "Copy command" : "Copy input",
                        text: input)
                }
                if let output = self.step.output { self.block(title: "Output", copyLabel: "Copy output", text: output) }
                if let launch = self.step.item.sessionLaunch, launch.phase == .succeeded, let key = launch.childKey {
                    Button { self.openChat(key) } label: { Text("Open chat").font(OpenClawChatTypography.body) }
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(20)
        }
        .navigationTitle(Text(verbatim: self.step.toolName))
        .navigationBarTitleDisplayMode(.inline)
    }

    private func block(title: LocalizedStringKey, copyLabel: LocalizedStringKey, text: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack {
                Text(title).font(OpenClawChatTypography.footnote)
                Spacer()
                ChatCopyButton(text: text, label: copyLabel)
                    .font(.system(size: 15))
            }
            .foregroundStyle(.secondary)
            Text(verbatim: text)
                .font(OpenClawChatTypography.mono(size: 14, relativeTo: .footnote))
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(14)
                .background(Color(uiColor: .secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 12))
        }
    }
}
#endif
