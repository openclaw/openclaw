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
    let onOpenChild: (String, String) -> Void
    let onHideProgress: () -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var path = NavigationPath()
    @State private var detent: PresentationDetent?
    @State private var fittedHeight: CGFloat?

    var body: some View {
        NavigationStack(path: self.$path) {
            self.root
                .listStyle(.insetGrouped)
                .listSectionSpacing(.compact)
                .contentMargins(.top, self.listTopMargin, for: .scrollContent)
                .onScrollGeometryChange(for: CGFloat.self) {
                    $0.contentSize.height + $0.contentInsets.top + $0.contentInsets.bottom
                } action: { _, height in
                    if self.path.isEmpty, height > 0, self.fittedHeight == nil {
                        self.fittedHeight = height
                    }
                }
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    OpenClawSheetCloseItem(identifier: "chat-activity-sheet-close") { self.dismiss() }
                }
        }
        .tint(.primary)
        .accessibilityIdentifier("chat-activity-sheet")
        .presentationDetents([self.restingDetent, .large], selection: Binding(
            get: { self.detent ?? self.restingDetent },
            set: { self.detent = $0 == .large ? .large : nil }))
        .presentationDragIndicator(.visible)
        // Below full height iOS draws a sheet as glass, which lets the composer's red button tint it.
        .presentationBackground(Color(uiColor: .systemGroupedBackground))
    }

    /// Before iOS 26 the Subagents tabs sit in a bar above the list, which already spaces the first row.
    private var listTopMargin: CGFloat {
        if #unavailable(iOS 26), self.sheet == .subagents { return 0 }
        return ChatModelPickerSheet.listTopMargin
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
            ChatActivitySubagentsPage(onOpen: self.onOpenChild, viewModel: self.viewModel)
        }
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

/// Running goals tick each second. Stopped goals hold at the time of their last change.
private struct ChatActivityElapsed: View {
    let since: Double
    let until: Double?
    var prefix: String?

    var body: some View {
        if let until {
            self.label(at: until)
        } else {
            TimelineView(.periodic(from: .now, by: 1)) { context in
                self.label(at: context.date.timeIntervalSince1970 * 1000)
            }
        }
    }

    private func label(at time: Double) -> Text {
        let elapsed = ChatActivityFormat.duration(ms: time - self.since)
        return Text(verbatim: self.prefix.map { "\($0) · \(elapsed)" } ?? elapsed).monospacedDigit()
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
    let onOpen: (String, String) -> Void
    private enum Tab { case running, finished }

    let viewModel: OpenClawChatViewModel
    @State private var tab: Tab?
    @State private var listWidth: CGFloat = 0

    var body: some View {
        let activity = self.viewModel.activityChildren
        let children = activity.roster
        let working = children.filter(\.isWorking)
        let finished = children.filter { !$0.isWorking }
        let defaultTab: Tab = working.isEmpty ? .finished : .running
        let selected = self.tab ?? defaultTab
        let rows = selected == .running ? working : finished
        List {
            if !rows.isEmpty {
                Section {
                    ForEach(rows) { child in
                        ChatActivityChildRow(
                            child: child,
                            model: self.viewModel.modelChoice(modelID: child.model, provider: child.modelProvider)?
                                .name ?? child.model,
                            showsSeparator: child.id != rows.last?.id,
                            viewModel: self.viewModel,
                            row: activity.rows[child.key],
                            onOpen: self.onOpen)
                    }
                }
            } else if children.isEmpty, activity.load == .pending {
                ChatActivityLoadingRow().listRowBackground(Color.clear)
            } else if activity.load != .failed || !children.isEmpty {
                Text(selected == .running ? LocalizedStringKey("No subagents running") :
                    LocalizedStringKey("No finished subagents"))
                    .font(OpenClawChatTypography.settingsBody)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                    .listRowSeparator(.hidden)
            }
            if activity.load == .failed {
                ChatActivityFailedRow(text: String(localized: "Couldn’t load every subagent.")) {
                    self.viewModel.activityChildren.load = .pending
                    self.viewModel.activityChildren.revision += 1
                }
            }
        }
        .contentMargins(.horizontal, 16, for: .scrollContent)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { self.listWidth = $0 }
        .modifier(ChatActivityTabsBar(listWidth: self.listWidth) {
            Picker(selection: Binding(get: { selected }, set: { self.tab = $0 })) {
                Text(verbatim: String(format: String(localized: "Running %lld"), working.count)).tag(Tab.running)
                Text(verbatim: String(format: String(localized: "Finished %lld"), finished.count)).tag(Tab.finished)
            } label: {
                Text("Subagents")
            }
            .pickerStyle(.segmented)
            .controlSize(.large)
        })
        // Pick once the full roster arrives. A child finishing must not switch tabs under the reader.
        .onChange(of: activity.load != .pending, initial: true) { _, settled in
            if settled, self.tab == nil { self.tab = defaultTab }
        }
        .navigationTitle(Text("Subagents"))
    }
}

/// iOS 26 draws a segmented control's glass only when it is a toolbar item, the way Photos shows Years, Months
/// and All. The bottom bar is the toolbar row where it can span the list; the top row shares Close and the title.
private struct ChatActivityTabsBar<Tabs: View>: ViewModifier {
    let listWidth: CGFloat
    @ViewBuilder let tabs: () -> Tabs

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            content.toolbar {
                ToolbarItem(placement: .bottomBar) {
                    // A toolbar item hugs its content; the list's inset width gives two equal, full-width halves.
                    self.tabs().frame(width: self.listWidth > 32 ? self.listWidth - 32 : nil)
                }
                // The control is glass already; the bar's shared capsule would draw a second rim around it.
                .sharedBackgroundVisibility(.hidden)
            }
            // Rows fade under the control instead of stopping at a hard line, as in Photos.
            .scrollEdgeEffectStyle(.soft, for: .bottom)
        } else {
            content.safeAreaInset(edge: .top, spacing: 0) {
                self.tabs().padding(.horizontal, 16).padding(.vertical, 12)
            }
        }
    }
}

private struct ChatActivityChildRow: View {
    let child: ChatActivityChild
    let model: String?
    let showsSeparator: Bool
    let viewModel: OpenClawChatViewModel
    let row: OpenClawChatSessionEntry?
    let onOpen: (String, String) -> Void
    @Environment(\.colorScheme) private var colorScheme
    @State private var action: OpenClawChildStopAction?
    @State private var pending = false
    @State private var stopError: String?

    var body: some View {
        let target = self.viewModel.healthOK ? self.row.flatMap(OpenClawChildStopTarget.init) : nil
        let stop = self.action?.target == target ? self.action : nil
        Button { self.onOpen(self.child.key, self.child.name) } label: {
            HStack(spacing: 12) {
                OpenClawSubagentAvatar(key: self.child.key)
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: self.child.name).font(OpenClawChatTypography.settingsBody)
                        .foregroundStyle(.primary).lineLimit(2)
                    TimelineView(.periodic(from: .now, by: self.child.state.isFinished ? 60 : 1)) { context in
                        Text(self.metadata(at: context.date)).font(OpenClawChatTypography.settingsFootnote)
                            .foregroundStyle(.secondary).monospacedDigit().lineLimit(1)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "chevron.forward").font(.footnote.weight(.semibold))
                    .foregroundStyle(.tertiary).accessibilityHidden(true)
            }
            .padding(.vertical, 12)
            .padding(.horizontal, 16)
            .overlay(alignment: .bottom) {
                if self.showsSeparator { Divider().padding(.leading, 16 + 32 + 12) }
            }
            .contentShape(.rect)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-activity-child-\(self.child.key)")
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            if let stop {
                let red = Color(uiColor: .systemRed)
                Button(role: .destructive) { self.stop(stop) } label: {
                    if let symbol = UIImage(systemName: "stop.fill") {
                        let ink = red.mix(with: self.colorScheme == .dark ? .white : .black, by: 0.2, in: .device)
                        Image(uiImage: symbol.withTintColor(UIColor(ink), renderingMode: .alwaysOriginal))
                    }
                }
                .accessibilityLabel(Text("Stop"))
                .disabled(self.pending).tint(red.opacity(0.23))
            }
        }
        .contextMenu {
            if let stop {
                Button(role: .destructive) { self.stop(stop) } label: { Label("Stop", systemImage: "stop.fill") }
                    .disabled(self.pending)
            }
        }
        .task(id: target) {
            self.action = nil
            self.pending = false
            guard let target,
                  let transport = self.viewModel.transport as? any OpenClawChildStopTransport else { return }
            let action = await transport.prepareChildStop(target)
            if !Task.isCancelled { self.action = action }
        }
        .alert(Text("Couldn’t confirm the stop"), isPresented: Binding(
            get: { self.stopError != nil }, set: { if !$0 { self.stopError = nil } }))
        { Button(role: .cancel) {} label: { Text("Close") } } message: { Text(verbatim: self.stopError ?? "") }
            .listRowInsets(EdgeInsets())
            .listRowSeparator(.hidden)
    }

    private func stop(_ stop: OpenClawChildStopAction) {
        guard !self.pending, let row, OpenClawChildStopTarget(row) == stop.target else { return }
        self.pending = true
        Task {
            do {
                self.stopError = try await self.viewModel.stopActivityChild(stop, current: row).warning
            } catch {
                self.stopError = String(localized: "Check the chat before trying again.")
            }
            self.pending = false
        }
    }

    private func metadata(at date: Date) -> AttributedString {
        let now = date.timeIntervalSince1970 * 1000
        let time: String?
        if !self.child.state.isFinished {
            time = self.child.startedAt.map { ChatWorkingDurationFormatter.compact(milliseconds: now - $0) }
        } else if let end = self.child.endedAt {
            let age = Duration.seconds(max(0, (now - end) / 1000)).formatted(.units(
                allowed: [.days, .hours, .minutes, .seconds], width: .narrow, maximumUnitCount: 1))
            time = String(format: String(localized: "%@ ago"), age)
        } else {
            time = nil
        }
        let facts = [self.model, time].compactMap(\.self).joined(separator: " · ")
        guard self.child.state != .done, self.child.state != .working else { return AttributedString(facts) }
        var status = AttributedString(ChatActivityChildFacts.stateName(self.child.state))
        if self.child.state == .failed { status.foregroundColor = Color(uiColor: .systemRed) }
        if !facts.isEmpty { status += AttributedString(" · " + facts) }
        return status
    }
}

extension OpenClawChatViewModel {
    /// Only exceptions get a secondary line in the child chat's header.
    public func subagentChatStatus(for key: String) -> String? {
        guard let row = self.sessions.first(where: { $0.key == key }),
              let child = ChatActivityChild.roster([row]).first,
              child.state != .working, child.state != .waiting, child.state != .done else { return nil }
        return [ChatActivityChildFacts.stateName(child.state), ChatActivityChildFacts.duration(child)]
            .compactMap(\.self).joined(separator: " · ")
    }
}

enum ChatActivityChildFacts {
    static func stateName(_ state: ChatActivityChild.State) -> String {
        switch state {
        case .working: String(localized: "Working")
        case .queued: String(localized: "Queued")
        case .waiting: String(localized: "Waiting")
        case .done: String(localized: "Done")
        case .failed: String(localized: "Failed")
        case .stopped: String(localized: "Stopped")
        case .timedOut: String(localized: "Timed out")
        }
    }

    static func duration(_ child: ChatActivityChild, now: Date = Date()) -> String? {
        if let runtime = child.runtimeMs, child.state != .working { return ChatActivityFormat.duration(ms: runtime) }
        guard let started = child.startedAt else { return nil }
        let end = child.endedAt ?? (child.state == .working ? now.timeIntervalSince1970 * 1000 : nil)
        return end.map { ChatActivityFormat.duration(ms: $0 - started) }
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
