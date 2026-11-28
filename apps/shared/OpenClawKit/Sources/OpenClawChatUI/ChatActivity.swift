import Foundation
import OpenClawProtocol

/// A direct child of the chat (a subagent), as the activity row and its sheet show it.
struct ChatActivityChild: Equatable, Identifiable {
    enum State: Equatable {
        case working
        case queued
        case waiting
        case done
        case failed
        case stopped
        case timedOut

        var isFinished: Bool {
            switch self {
            case .done, .failed, .stopped, .timedOut: true
            case .working, .queued, .waiting: false
            }
        }
    }

    let key: String
    let name: String
    let state: State
    let startedAt: Double?
    let endedAt: Double?
    let runtimeMs: Double?
    let order: Int
    var model: String?
    var modelProvider: String?

    var id: String {
        self.key
    }

    var isWorking: Bool {
        !self.state.isFinished
    }

    /// A session turn ending does not finish a child that yielded or still owns descendants.
    static func state(of row: OpenClawChatSessionEntry) -> State {
        switch row.status {
        case "failed", "error": return .failed
        case "killed", "aborted", "stopped", "cancelled": return .stopped
        case "timeout", "timed_out": return .timedOut
        case "queued": return row.hasActiveRun == true ? .working : .queued
        default: break
        }
        if row.subagentRunState == "paused" || row.status == "waiting" || row.status == "paused" { return .waiting }
        switch row.status {
        case "done", "completed":
            if row.hasActiveRun == true || row.subagentRunState == "active" { return .working }
            if row.hasActiveSubagentRun == true { return .waiting }
            // Older rows have no registry state. An unrecognized registry state is not completion.
            return row.subagentRunState == nil || row.subagentRunState == "historical" ? .done : .working
        default: return .working
        }
    }

    /// Rows already known to be the chat's children (a `spawnedBy` page), in launch order. A swarm's members
    /// stay out: the swarm progress view above the composer already shows them.
    static func roster(_ rows: [OpenClawChatSessionEntry]) -> [Self] {
        rows.filter { $0.archived != true && $0.swarmGroupId == nil }.sorted { left, right in
            let l = (left.createdAt ?? left.startedAt ?? .greatestFiniteMagnitude, left.startedAt ?? 0, left.key)
            let r = (right.createdAt ?? right.startedAt ?? .greatestFiniteMagnitude, right.startedAt ?? 0, right.key)
            return l < r
        }.enumerated().map { index, row in
            Self(
                key: row.key,
                name: ChatSessionSidebarModel.displayName(for: row),
                state: self.state(of: row),
                startedAt: row.startedAt,
                endedAt: row.endedAt,
                runtimeMs: row.runtimeMs,
                order: index,
                model: row.model,
                modelProvider: row.modelProvider)
        }
    }
}

/// Membership belongs to the current chat, not to the last page of the session picker.
struct ChatActivityChildren {
    enum Load { case pending, complete, failed }
    var load: Load = .pending
    var revision = 0
    private(set) var rows: [String: OpenClawChatSessionEntry] = [:]

    var roster: [ChatActivityChild] {
        ChatActivityChild.roster(Array(self.rows.values))
    }

    mutating func observe(page: [OpenClawChatSessionEntry], parentKey: String, advertised: [String]) {
        let keys = Set(advertised)
        for row in page where row.key != parentKey {
            let belongs = (row.parentSessionKey ?? row.spawnedBy).map { $0 == parentKey }
                ?? (keys.contains(row.key) || self.rows[row.key] != nil)
            if belongs || self.rows[row.key] != nil { self.accept(row, belongs: belongs) }
        }
        // Absence from a bounded page is not a deletion.
    }

    mutating func receive(_ list: OpenClawChatChildSessionsResult) {
        if list.isComplete {
            let keys = Set(list.rows.map(\.key))
            self.rows = self.rows.filter { keys.contains($0.key) }
        }
        for row in list.rows {
            self.accept(row, belongs: true)
        }
        self.load = list.isComplete ? .complete : .failed
    }

    mutating func remove(_ key: String) {
        self.rows.removeValue(forKey: key)
    }

    private mutating func accept(_ row: OpenClawChatSessionEntry, belongs: Bool) {
        if let held = self.rows[row.key], held.sessionId == row.sessionId,
           let previous = held.updatedAt, let incoming = row.updatedAt, previous > incoming { return }
        self.rows[row.key] = belongs && !row.isArchived && row.swarmGroupId == nil ? row : nil
    }
}

/// The plan the progress card holds, read the same way by the pill and its sheet.
struct ChatActivityPlan {
    let steps: [ProgressCardStep]
    let note: String?
    let runActive: Bool
    let sessionStatus: String?
    let refreshPending: Bool

    var completed: Int {
        self.steps.count(where: { $0.status == .completed })
    }

    var isComplete: Bool {
        !self.steps.isEmpty && self.completed == self.steps.count
    }

    /// The step in front of the person: the first in progress, else the first pending, else the last completed
    /// (ui/src/components/session-progress-card.ts).
    var currentIndex: Int? {
        self.steps.firstIndex { $0.status == .inProgress }
            ?? self.steps.firstIndex { $0.status == .pending }
            ?? (self.steps.isEmpty ? nil : self.steps.count - 1)
    }

    enum Outcome: Equatable {
        case updating
        case running
        case complete
        case timedOut
        case failed
        case stopped
        case waiting
    }

    var outcome: Outcome {
        if self.refreshPending { return .updating }
        if self.runActive { return .running }
        if self.isComplete { return .complete }
        switch self.sessionStatus {
        case "timeout", "timed_out": return .timedOut
        case "failed", "error": return .failed
        case "killed", "aborted", "stopped", "cancelled": return .stopped
        default: return .waiting
        }
    }
}

/// One pill above the composer. The row and its tests read only this.
struct ChatActivityPill: Equatable, Identifiable {
    enum Kind: Hashable {
        case subagents
        case goal
        case progress
        case pullRequest(String)
    }

    /// Neutral ink everywhere; color only marks a problem that needs the person.
    enum Tone: Equatable {
        case neutral
        case muted
        case attention
        case problem
    }

    struct Badge: Equatable {
        enum Mark: Equatable {
            case symbol(String)
            case spinner
        }

        let mark: Mark
        let tone: Tone
        let label: String
    }

    let kind: Kind
    /// SF Symbol for the pill's leading mark; the subagents pill leads with its children's avatars instead.
    let symbol: String?
    let label: String
    let count: String?
    let badge: Badge?
    let labelTone: Tone
    let accessibilityLabel: String
    /// The subagents pill: the first three working children's keys, for their avatars.
    var avatarKeys: [String] = []
    /// The label sweeps while the work it names is running, as the web's `shine`.
    var shimmers = false
    var pullRequestState: ChatPullRequestState?
    var checkMark: ChatActivityCheckRow.Kind?

    var id: Kind {
        self.kind
    }
}

struct ChatActivityInput {
    var approvalPending = false
    var children: [ChatActivityChild] = []
    var goal: OpenClawChatSessionGoal?
    var goalOperationLabel: String?
    var plan: ChatActivityPlan?
    var pullRequests: OpenClawSessionPullRequestSnapshot?
}

enum ChatActivityRules {
    /// Which pills show and in what order: subagents, Goal, task progress, then one per PR
    /// (ui/src/pages/chat/components/chat-activity-pills.tsx). While an approval waits, only the Goal stays.
    static func pills(_ input: ChatActivityInput) -> [ChatActivityPill] {
        var pills: [ChatActivityPill] = []
        let working = input.children.filter(\.isWorking)
        if !input.approvalPending, !working.isEmpty {
            pills.append(self.subagents(working: working))
        }
        if let goal = input.goal, goal.isPresentable {
            pills.append(self.goal(
                goal,
                operationLabel: input.goalOperationLabel))
        }
        if !input.approvalPending, let plan = input.plan {
            pills.append(self.progress(plan))
        }
        if !input.approvalPending, let snapshot = input.pullRequests {
            pills += self.pullRequestPills(snapshot)
        }
        return pills
    }

    /// "3 working" after the first three working children's avatars, the label sweeping while they run
    /// (the web's subagents pill).
    static func subagents(working: [ChatActivityChild]) -> ChatActivityPill {
        let count = working.count
        let label = String(format: String(localized: "%lld working"), count)
        return ChatActivityPill(
            kind: .subagents,
            symbol: nil,
            label: label,
            count: nil,
            badge: nil,
            labelTone: .neutral,
            accessibilityLabel: count == 1
                ? String(localized: "1 subagent working")
                : String(format: String(localized: "%lld subagents working"), count),
            avatarKeys: working.prefix(3).map(\.key),
            shimmers: true)
    }

    static func goalLabel(_ status: OpenClawChatSessionGoal.Status?) -> String {
        // "Pursuing goal" needs a receipt that ties the Goal to the run in progress; the phone has none yet,
        // and an active Goal alone is not proof that work is happening.
        switch status {
        case .active, nil: String(localized: "Goal active")
        case .paused: String(localized: "Goal paused")
        case .complete: String(localized: "Goal achieved")
        case .blocked: String(localized: "Goal blocked")
        case .usageLimited: String(localized: "Goal usage limit")
        case .budgetLimited: String(localized: "Goal budget reached")
        }
    }

    static func goal(
        _ goal: OpenClawChatSessionGoal,
        operationLabel: String? = nil) -> ChatActivityPill
    {
        let label = operationLabel ?? self.goalLabel(goal.status)
        let symbol = switch goal.status {
        case .paused: "pause"
        case .complete: "checkmark"
        case .blocked, .usageLimited, .budgetLimited: "exclamationmark.triangle"
        case .active, nil: "scope"
        }
        let needsAttention = [.blocked, .usageLimited, .budgetLimited].contains(goal.status)
        return ChatActivityPill(
            kind: .goal,
            symbol: symbol,
            label: label,
            count: nil,
            badge: nil,
            labelTone: needsAttention ? .attention : goal.status == .paused ? .muted : .neutral,
            accessibilityLabel: String(format: String(localized: "%@: %@"), label, goal.objective ?? ""))
    }

    static func progress(_ plan: ChatActivityPlan) -> ChatActivityPill {
        let title = String(localized: "Task progress")
        let badge: ChatActivityPill.Badge? = switch plan.outcome {
        case .updating:
            .init(mark: .spinner, tone: .neutral, label: String(localized: "Updating saved progress"))
        case .running:
            .init(mark: .spinner, tone: .neutral, label: String(localized: "Running"))
        case .complete:
            .init(mark: .symbol("checkmark"), tone: .neutral, label: String(localized: "Completed"))
        case .timedOut:
            .init(
                mark: .symbol("exclamationmark.triangle.fill"),
                tone: .attention,
                label: String(localized: "Reply timed out; plan saved"))
        case .failed:
            .init(
                mark: .symbol("xmark"),
                tone: .problem,
                label: String(localized: "Reply failed; plan saved"))
        case .stopped:
            .init(mark: .symbol("stop.fill"), tone: .problem, label: String(localized: "Reply stopped; plan saved"))
        case .waiting:
            .init(mark: .symbol("clock"), tone: .muted, label: String(localized: "Pending"))
        }
        guard let index = plan.currentIndex else {
            // A note without steps names the feature, never a cut-off sentence of the note.
            let quiet = plan.outcome == .waiting || plan.outcome == .complete
            return ChatActivityPill(
                kind: .progress,
                symbol: "checklist",
                label: title,
                count: nil,
                badge: quiet ? nil : badge,
                labelTone: .neutral,
                accessibilityLabel: quiet || badge == nil
                    ? title : String(format: String(localized: "%@, %@"), title, badge?.label ?? ""))
        }
        let step = plan.steps[index].step
        let completed = plan.completed
        let total = plan.steps.count
        return ChatActivityPill(
            kind: .progress,
            symbol: "checklist",
            label: step,
            count: "\(completed)/\(total)",
            badge: badge,
            labelTone: .neutral,
            accessibilityLabel: String(
                format: String(localized: "Task progress, %@, %lld of %lld completed, %@"),
                step,
                completed,
                total,
                badge?.label ?? ""))
    }
}

enum ChatActivityFormat {
    /// The web Goal card's clock (src/shared/session-goal-display.ts formatGoalElapsed).
    static func duration(ms: Double) -> String {
        let seconds = max(0, Int(ms / 1000))
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return minutes % 60 == 0 ? "\(hours)h" : "\(hours)h \(minutes % 60)m" }
        let days = hours / 24
        let period = days >= 7 ? "\(days / 7)wk \(days % 7)d" : "\(days)d"
        return "\(period) \(hours % 24)h \(minutes % 60)m"
    }

    /// The web's token count: 950, 1.2k, 184k, 1.5m (formatGoalTokenCount).
    static func tokens(_ value: Double) -> String {
        guard value.isFinite, value > 0 else { return "0" }
        func trimmed(_ number: Double) -> String {
            number == number.rounded() ? String(Int(number)) : String(number)
        }
        if value < 1000 { return String(Int(value.rounded())) }
        if value < 1_000_000 {
            let rounded = value >= 10000 ? (value / 1000).rounded() : (value / 100).rounded() / 10
            return rounded >= 1000 ? "1m" : "\(trimmed(rounded))k"
        }
        let rounded = value >= 10_000_000 ? (value / 1_000_000).rounded() : (value / 100_000).rounded() / 10
        return "\(trimmed(rounded))m"
    }

    /// "184k/500k" against a budget, "184k used" without one, nothing before any use (formatGoalUsage).
    static func goalUsage(_ goal: OpenClawChatSessionGoal) -> String? {
        let used = goal.tokensUsed ?? 0
        if let budget = goal.tokenBudget, budget.isFinite { return "\(self.tokens(used))/\(self.tokens(budget))" }
        return used > 0 ? String(format: String(localized: "%@ used"), self.tokens(used)) : nil
    }
}
