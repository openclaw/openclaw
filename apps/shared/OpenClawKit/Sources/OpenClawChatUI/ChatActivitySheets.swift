#if os(iOS)
import OpenClawProtocol
import SwiftUI
import UIKit

/// The sheet behind each activity pill. Same family as the model and "+" sheets: a system sheet with a
/// grabber, an inset grouped list under an inline title, Close on the leading side, a resting height
/// that fits the content.
struct ChatActivitySheetView: View {
    let viewModel: OpenClawChatViewModel
    let sheet: ChatActivitySheet
    let onHideProgress: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var detent: PresentationDetent?
    @State private var fittedHeight: CGFloat?

    var body: some View {
        NavigationStack {
            self.root
                .listStyle(.insetGrouped)
                .listSectionSpacing(.compact)
                .contentMargins(.top, ChatModelPickerSheet.listTopMargin, for: .scrollContent)
                .onScrollGeometryChange(for: CGFloat.self) {
                    $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
                } action: { _, height in
                    // The first fit holds, so content that loads in later scrolls instead of moving the sheet.
                    if self.fittedHeight == nil || (self.fittedHeight ?? 0) < height, height > 0 {
                        self.fittedHeight = height
                    }
                }
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    OpenClawSheetCloseItem(identifier: "chat-activity-sheet-close") { self.dismiss() }
                }
                .navigationDestination(for: String.self) { key in
                    ChatActivityChildPage(viewModel: self.viewModel, childKey: key, onOpenChat: self.openChat)
                }
        }
        .tint(.primary)
        .accessibilityIdentifier("chat-activity-sheet")
        .presentationDetents([self.restingDetent, .large], selection: Binding(
            get: { self.detent ?? self.restingDetent },
            set: { self.detent = $0 }))
        .presentationDragIndicator(.visible)
        // Below full height iOS draws a sheet as glass, which lets the composer's red button tint it.
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
    }

    private var restingDetent: PresentationDetent {
        let fitted = (self.fittedHeight ?? 0) - ChatActivitySheetMetrics.emptySpaceAfterLastGroup
        return .height(max(ChatActivitySheetMetrics.minimumHeight, fitted))
    }

    @ViewBuilder
    private var root: some View {
        switch self.sheet {
        case .goal:
            ChatActivityGoalPage(viewModel: self.viewModel)
        case .progress:
            ChatActivityProgressPage(viewModel: self.viewModel, onHide: {
                self.onHideProgress()
                self.dismiss()
            })
        case .subagents:
            ChatActivitySubagentsPage(viewModel: self.viewModel)
        case let .child(key):
            ChatActivityChildPage(viewModel: self.viewModel, childKey: key, onOpenChat: self.openChat)
        }
    }

    private func openChat(_ key: String) {
        // The parent's draft is saved per chat, so it is there again on the way back.
        self.dismiss()
        self.viewModel.switchSession(to: key)
    }
}

enum ChatActivitySheetMetrics {
    static let minimumHeight: CGFloat = 280
    /// What an inset grouped list runs on past its last group, as the "+" sheet measured it (iOS 27.2):
    /// without it the sheet rests with an empty band above the home indicator.
    static let emptySpaceAfterLastGroup: CGFloat = 43.8
}

// MARK: - Goal

private struct ChatActivityGoalPage: View {
    let viewModel: OpenClawChatViewModel

    var body: some View {
        let goal = self.viewModel.currentSessionEntry()?.goal
        List {
            if let goal, goal.isPresentable {
                Section {
                    Text(verbatim: goal.objective ?? "")
                        .font(OpenClawChatTypography.settingsBody)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("chat-activity-goal-objective")
                }
                Section {
                    LabeledContent {
                        Text(verbatim: Self.statusName(goal.status))
                    } label: {
                        Text("Status")
                    }
                    if let created = goal.createdAt {
                        LabeledContent {
                            ChatActivityElapsed(since: created, until: goal.statusChangedAt)
                        } label: {
                            Text("Time")
                        }
                    }
                    if let usage = ChatActivityFormat.goalUsage(goal) {
                        LabeledContent {
                            Text(verbatim: usage).monospacedDigit()
                        } label: {
                            Text("Tokens")
                        }
                    }
                }
                .font(OpenClawChatTypography.settingsBody)
                if let note = goal.lastStatusNote?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                    Section {
                        Text(verbatim: note)
                            .font(OpenClawChatTypography.settingsBody)
                            .foregroundStyle(.secondary)
                    } header: {
                        Text("Latest note")
                    }
                }
            } else {
                ChatActivityEmptyRow(text: String(localized: "No goal"))
            }
        }
        .navigationTitle(Text("Goal"))
    }

    static func statusName(_ status: OpenClawChatSessionGoal.Status?) -> String {
        switch status {
        case .active, nil: String(localized: "Active")
        case .paused: String(localized: "Paused")
        case .complete: String(localized: "Achieved")
        case .blocked: String(localized: "Blocked")
        case .usageLimited: String(localized: "Usage limit reached")
        case .budgetLimited: String(localized: "Budget reached")
        }
    }
}

/// Time since the Goal began; a running Goal ticks each second, a stopped one holds at its last change.
private struct ChatActivityElapsed: View {
    let since: Double
    let until: Double?

    var body: some View {
        if let until {
            Text(verbatim: ChatActivityFormat.duration(ms: until - self.since))
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                Text(verbatim: ChatActivityFormat.duration(ms: context.date.timeIntervalSince1970 * 1000 - self.since))
                    .monospacedDigit()
            }
        }
    }
}

// MARK: - Task progress

private struct ChatActivityProgressPage: View {
    let viewModel: OpenClawChatViewModel
    let onHide: () -> Void
    @State private var confirmsClear = false

    var body: some View {
        let card = self.viewModel.progressCard
        let plan = card.map {
            ChatActivityPlan(
                steps: $0.steps ?? [],
                note: $0.markdown,
                runActive: self.viewModel.hasBlockingRunActivity,
                sessionStatus: self.viewModel.currentSessionEntry()?.status,
                refreshPending: self.viewModel.progressCardRefreshPending)
        }
        List {
            if let plan {
                if !plan.steps.isEmpty {
                    Section {
                        self.summary(plan)
                    }
                    Section {
                        ForEach(Array(plan.steps.enumerated()), id: \.offset) { index, step in
                            ChatActivityStepRow(
                                step: step,
                                isCurrent: index == plan.currentIndex && !plan.isComplete,
                                isRunning: plan.runActive)
                        }
                    }
                }
                if let note = plan.note?.trimmingCharacters(in: .whitespacesAndNewlines), !note.isEmpty {
                    let parsed = ChatProgressCardMarkdown(note)
                    Section {
                        ForEach(Array(parsed.bars.enumerated()), id: \.offset) { _, bar in
                            VStack(alignment: .leading, spacing: 6) {
                                if let label = bar.label {
                                    Text(verbatim: label)
                                        .font(OpenClawChatTypography.settingsFootnote)
                                        .foregroundStyle(.secondary)
                                }
                                ProgressView(value: bar.value, total: bar.total)
                                    .tint(OpenClawChatTheme.assistantText)
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
                    }
                }
                Section {
                    if self.viewModel.progressCardRefreshAvailable {
                        Button {
                            self.viewModel.requestProgressCardRefresh()
                        } label: {
                            // Busy keeps the row's box: a spinner takes the label's place.
                            Text("Refresh plan")
                                .opacity(plan.refreshPending ? 0 : 1)
                                .overlay(alignment: .leading) {
                                    if plan.refreshPending { ProgressView() }
                                }
                        }
                        .disabled(plan.refreshPending)
                        .accessibilityIdentifier("chat-activity-progress-refresh")
                    }
                    Button(action: self.onHide) {
                        Text("Dismiss plan")
                    }
                    .accessibilityIdentifier("chat-activity-progress-dismiss")
                    if self.viewModel.progressCardStoreAvailable == true {
                        Button(role: .destructive) {
                            self.confirmsClear = true
                        } label: {
                            Text("Clear saved plan for everyone")
                        }
                        .accessibilityIdentifier("chat-activity-progress-clear")
                    }
                } footer: {
                    Text("Dismiss hides the plan here until it changes.")
                }
                .font(OpenClawChatTypography.settingsBody)
            } else {
                ChatActivityEmptyRow(text: String(localized: "No plan"))
            }
        }
        .navigationTitle(Text("Task progress"))
        .confirmationDialog(
            Text("Clear the saved plan for everyone in this chat?"),
            isPresented: self.$confirmsClear,
            titleVisibility: .visible)
        {
            Button(role: .destructive) {
                self.viewModel.clearSavedProgressCard()
            } label: {
                Text("Clear saved plan")
            }
        }
    }

    private func summary(_ plan: ChatActivityPlan) -> some View {
        let total = plan.steps.count
        let completed = plan.completed
        let outcome = ChatActivityRules.progress(plan).badge
        return VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Text(verbatim: String(format: String(localized: "%lld of %lld completed"), completed, total))
                    .font(OpenClawChatTypography.settingsBody)
                    .fontWeight(.semibold)
                    .monospacedDigit()
                Spacer(minLength: 12)
                if let outcome {
                    HStack(spacing: 6) {
                        if outcome.mark == .spinner {
                            ProgressView().controlSize(.small)
                        }
                        Text(verbatim: outcome.label)
                    }
                    .font(OpenClawChatTypography.settingsFootnote)
                    .foregroundStyle(outcome.tone == .problem ? Color(uiColor: .systemRed) : .secondary)
                }
            }
            ProgressView(value: Double(completed), total: Double(max(total, 1)))
                .tint(OpenClawChatTheme.assistantText)
                .accessibilityHidden(true)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
        .accessibilityIdentifier("chat-activity-progress-summary")
    }
}

private struct ChatActivityStepRow: View {
    let step: ProgressCardStep
    let isCurrent: Bool
    let isRunning: Bool

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            self.mark
                .frame(width: 22)
            Text(verbatim: self.step.step)
                .font(OpenClawChatTypography.settingsBody)
                .fontWeight(self.isCurrent ? .semibold : .regular)
                .foregroundStyle(self.step.status == .completed ? .secondary : .primary)
                .fixedSize(horizontal: false, vertical: true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: "\(self.step.step), \(self.stateName)"))
    }

    @ViewBuilder
    private var mark: some View {
        switch self.step.status {
        case .completed:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.secondary)
        case .inProgress where self.isRunning:
            ProgressView().controlSize(.small)
        case .inProgress:
            Image(systemName: "circle.circle").foregroundStyle(.primary)
        default:
            Image(systemName: "circle").foregroundStyle(.tertiary)
        }
    }

    private var stateName: String {
        switch self.step.status {
        case .completed: String(localized: "Completed")
        case .inProgress where self.isCurrent: String(localized: "Current step")
        case .inProgress: String(localized: "In progress")
        default: String(localized: "Pending")
        }
    }
}

// MARK: - Subagents

private struct ChatActivitySubagentsPage: View {
    let viewModel: OpenClawChatViewModel
    @State private var loaded: [ChatActivityChild]?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        let roster = ChatActivityChild.children(of: self.viewModel.currentSessionEntry(), in: self.viewModel.sessions)
        // The roster answers at once; the full list of direct children replaces it when it arrives.
        let children = Self.merge(roster: roster, loaded: self.loaded)
        let working = children.filter { $0.state == .working || $0.state == .queued }
        let finished = children.filter { $0.state != .working && $0.state != .queued }
        List {
            if !working.isEmpty {
                Section {
                    ForEach(working) { ChatActivityChildRow(viewModel: self.viewModel, child: $0) }
                } header: {
                    Text("Working")
                }
            }
            if !finished.isEmpty {
                Section {
                    ForEach(finished) { ChatActivityChildRow(viewModel: self.viewModel, child: $0) }
                } header: {
                    Text("Finished")
                }
            }
            if children.isEmpty {
                if self.loaded == nil, !self.failed {
                    ChatActivityLoadingRow()
                } else if !self.failed {
                    ChatActivityEmptyRow(text: String(localized: "No subagents"))
                }
            }
            if self.failed {
                ChatActivityFailedRow(text: String(localized: "Couldn’t load every subagent.")) {
                    self.failed = false
                    self.attempt += 1
                }
            }
        }
        .navigationTitle(Text("Subagents"))
        .task(id: self.attempt) {
            do {
                let result = try await self.viewModel.transport.listChildSessions(parentKey: self.viewModel.sessionKey)
                self.loaded = ChatActivityChild.roster(result.rows)
            } catch {
                if !(error is CancellationError) { self.failed = true }
            }
        }
    }

    static func merge(roster: [ChatActivityChild], loaded: [ChatActivityChild]?) -> [ChatActivityChild] {
        guard let loaded else { return roster }
        // Live roster rows carry the newest state; the full list adds the ones the roster window left out.
        let live = Dictionary(roster.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        let merged = loaded.map { live[$0.key] ?? $0 }
        let extra = roster.filter { row in !loaded.contains { $0.key == row.key } }
        return merged + extra
    }
}

private struct ChatActivityChildRow: View {
    let viewModel: OpenClawChatViewModel
    let child: ChatActivityChild
    @State private var transcript: ChatActivityChildTranscript?
    @State private var settled = false

    var body: some View {
        NavigationLink(value: self.child.key) {
            VStack(alignment: .leading, spacing: 3) {
                Text(verbatim: self.child.name)
                    .font(OpenClawChatTypography.settingsBody)
                    .fontWeight(.medium)
                    .lineLimit(2)
                Text(verbatim: ChatActivityChildFacts.stateLine(self.child))
                    .font(OpenClawChatTypography.settingsFootnote)
                    .foregroundStyle(ChatActivityChildFacts
                        .isProblem(self.child) ? Color(uiColor: .systemRed) : .secondary)
                // The order holds the row's height while it loads; a row whose order never came gives the space back.
                if !self.settled || self.transcript?.order != nil {
                    Text(verbatim: self.transcript?.order ?? " ")
                        .font(OpenClawChatTypography.settingsFootnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2, reservesSpace: true)
                }
            }
            .padding(.vertical, 2)
        }
        .accessibilityIdentifier("chat-activity-child-\(self.child.key)")
        .task(id: self.child.key) {
            self.transcript = try? await self.viewModel.loadActivityChildTranscript(sessionKey: self.child.key)
            self.settled = true
        }
    }
}

enum ChatActivityChildFacts {
    static func stateName(_ state: ChatActivityChild.State) -> String {
        switch state {
        case .working: String(localized: "Working")
        case .queued: String(localized: "Queued")
        case .done: String(localized: "Done")
        case .failed: String(localized: "Failed")
        case .stopped: String(localized: "Stopped")
        case .timedOut: String(localized: "Timed out")
        }
    }

    static func isProblem(_ child: ChatActivityChild) -> Bool {
        child.state == .failed
    }

    static func duration(_ child: ChatActivityChild, now: Date = Date()) -> String? {
        if let runtime = child.runtimeMs, child.state != .working { return ChatActivityFormat.duration(ms: runtime) }
        guard let started = child.startedAt else { return nil }
        let end = child.endedAt ?? (child.state == .working ? now.timeIntervalSince1970 * 1000 : nil)
        return end.map { ChatActivityFormat.duration(ms: $0 - started) }
    }

    static func stateLine(_ child: ChatActivityChild) -> String {
        [self.stateName(child.state), self.duration(child)].compactMap(\.self).joined(separator: " · ")
    }
}

/// One child: what it was asked to do, where it stands, and its latest reply. Reading only.
private struct ChatActivityChildPage: View {
    let viewModel: OpenClawChatViewModel
    let childKey: String
    let onOpenChat: (String) -> Void
    @State private var transcript: ChatActivityChildTranscript?
    @State private var failed = false
    @State private var attempt = 0

    var body: some View {
        let row = self.viewModel.sessions.first { $0.key == self.childKey }
        let child = row.map {
            ChatActivityChild(
                key: $0.key,
                name: ChatSessionSidebarModel.displayName(for: $0),
                state: ChatActivityChild.state(of: $0),
                startedAt: $0.startedAt,
                endedAt: $0.endedAt,
                runtimeMs: $0.runtimeMs,
                order: 0)
        }
        List {
            Section {
                if let order = self.transcript?.order {
                    Text(verbatim: order)
                        .font(OpenClawChatTypography.settingsBody)
                        .textSelection(.enabled)
                        .accessibilityIdentifier("chat-activity-child-order")
                } else if self.failed {
                    ChatActivityFailedRow(text: String(localized: "Couldn’t load what it was asked.")) {
                        self.failed = false
                        self.attempt += 1
                    }
                } else if self.transcript != nil {
                    Text("No request yet").foregroundStyle(.secondary)
                } else {
                    ChatActivityLoadingRow()
                }
            } header: {
                Text("Asked to")
            }
            if let child {
                Section {
                    LabeledContent {
                        Text(verbatim: ChatActivityChildFacts.stateName(child.state))
                            .foregroundStyle(ChatActivityChildFacts
                                .isProblem(child) ? Color(uiColor: .systemRed) : .secondary)
                    } label: {
                        Text("Status")
                    }
                    if let duration = ChatActivityChildFacts.duration(child) {
                        LabeledContent {
                            Text(verbatim: duration)
                        } label: {
                            Text("Time")
                        }
                    }
                }
                .font(OpenClawChatTypography.settingsBody)
            }
            if let reply = self.transcript?.latestReply {
                Section {
                    ChatMarkdownRenderer(
                        text: reply,
                        context: .assistant,
                        variant: .compact,
                        textColor: OpenClawChatTheme.assistantText)
                        .lineLimit(14)
                } header: {
                    Text("Latest reply")
                }
            }
            Section {
                Button {
                    self.onOpenChat(self.childKey)
                } label: {
                    Text("Open chat")
                }
                .font(OpenClawChatTypography.settingsBody)
                .accessibilityIdentifier("chat-activity-child-open")
            }
        }
        .navigationTitle(Text(verbatim: child?.name ?? String(localized: "Subagent")))
        .task(id: self.attempt) {
            do {
                self.transcript = try await self.viewModel.loadActivityChildTranscript(sessionKey: self.childKey)
            } catch {
                if !(error is CancellationError) { self.failed = true }
            }
        }
    }
}

// MARK: - States

private struct ChatActivityLoadingRow: View {
    var body: some View {
        ProgressView()
            .frame(maxWidth: .infinity, minHeight: 44)
            .accessibilityIdentifier("chat-activity-loading")
    }
}

private struct ChatActivityEmptyRow: View {
    let text: String

    var body: some View {
        Text(verbatim: self.text)
            .font(OpenClawChatTypography.settingsBody)
            .foregroundStyle(.secondary)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
    }
}

/// A failure keeps its place in the list and offers the retry right there.
private struct ChatActivityFailedRow: View {
    let text: String
    let retry: () -> Void

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 12) {
            Text(verbatim: self.text)
                .font(OpenClawChatTypography.settingsBody)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button(action: self.retry) {
                Text("Try again").fontWeight(.semibold)
            }
            .buttonStyle(.borderless)
            .font(OpenClawChatTypography.settingsBody)
            .accessibilityIdentifier("chat-activity-try-again")
        }
        .frame(minHeight: 44)
    }
}
#endif
