import Foundation

enum AmbientAssistantTone: String, CaseIterable, Equatable, Sendable {
    case ready
    case reading
    case planning
    case waitingForApproval
    case working
    case success
    case blocked
    case error

    var statusLabel: String {
        switch self {
        case .ready:
            "Ready"
        case .reading:
            "Reading"
        case .planning:
            "Planning"
        case .waitingForApproval:
            "Approval"
        case .working:
            "Working"
        case .success:
            "Done"
        case .blocked:
            "Blocked"
        case .error:
            "Error"
        }
    }

    var symbolName: String {
        switch self {
        case .ready:
            "sparkles"
        case .reading:
            "eye"
        case .planning:
            "point.topleft.down.curvedto.point.bottomright.up"
        case .waitingForApproval:
            "checkmark.shield"
        case .working:
            "gearshape.2"
        case .success:
            "checkmark.circle"
        case .blocked:
            "exclamationmark.triangle"
        case .error:
            "xmark.octagon"
        }
    }
}

enum AmbientAssistantAvailability: String, Equatable, Sendable {
    case available
    case needsPermission
    case needsApproval
    case unavailable
}

enum AmbientAssistantApprovalState: String, Equatable, Sendable {
    case notRequired
    case required
    case approved
    case blocked
}

struct AmbientAssistantContextSnapshot: Equatable, Sendable {
    var frontApp: String
    var sessionLabel: String
    var gatewayLabel: String
    var deviceLabel: String
    var permissionSummaries: [String]
    var confidenceLabel: String
}

struct AmbientAssistantCapability: Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var detail: String
    var availability: AmbientAssistantAvailability
}

struct AmbientAssistantProposalSummary: Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var detail: String
    var approvalState: AmbientAssistantApprovalState
    var tone: AmbientAssistantTone
}

struct AmbientAssistantReceiptSummary: Equatable, Sendable {
    var summary: String
    var detail: String
    var tone: AmbientAssistantTone
}

struct AmbientAssistantLaneItem: Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var detail: String
    var tone: AmbientAssistantTone
}

enum AmbientAssistantChatRole: String, Equatable, Sendable {
    case user
    case assistant
    case system
}

struct AmbientAssistantChatMessage: Equatable, Identifiable, Sendable {
    var id: String
    var role: AmbientAssistantChatRole
    var text: String
    var isPending: Bool

    init(
        id: String = UUID().uuidString,
        role: AmbientAssistantChatRole,
        text: String,
        isPending: Bool)
    {
        self.id = id
        self.role = role
        self.text = text
        self.isPending = isPending
    }
}

struct AmbientAssistantChatSummary: Equatable, Sendable {
    var lastUserText: String?
    var lastAssistantText: String?
    var messages: [AmbientAssistantChatMessage] = []
    var isAwaitingResponse: Bool
    var error: String?
}

struct AmbientAssistantScheduleItem: Equatable, Identifiable, Sendable {
    var id: String
    var title: String
    var dueLabel: String
    var source: String
    var sortDate: Date?

    init(id: String = UUID().uuidString, title: String, dueLabel: String, source: String, sortDate: Date? = nil) {
        self.id = id
        self.title = title
        self.dueLabel = dueLabel
        self.source = source
        self.sortDate = sortDate
    }
}

struct AmbientAssistantScheduleSummary: Equatable, Sendable {
    var authorizationLabel: String
    var items: [AmbientAssistantScheduleItem]
    var error: String?
}

struct AmbientAssistantAutomationSummary: Equatable, Sendable {
    var schedulerLabel: String
    var latestTitle: String?
    var latestDetail: String?
    var latestTone: AmbientAssistantTone
    var error: String?
}

struct AmbientAssistantLiveInputs: Equatable, Sendable {
    var frontApp: String
    var sessionLabel: String
    var gatewayLabel: String
    var deviceLabel: String
    var permissionSummaries: [String]
    var chat: AmbientAssistantChatSummary
    var schedule: AmbientAssistantScheduleSummary
    var automation: AmbientAssistantAutomationSummary
    var workLabel: String?
}

struct AmbientAssistantSurfaceSnapshot: Equatable, Sendable {
    var context: AmbientAssistantContextSnapshot
    var capabilities: [AmbientAssistantCapability]
    var proposals: [AmbientAssistantProposalSummary]
    var receipt: AmbientAssistantReceiptSummary
    var subagents: [AmbientAssistantLaneItem]
    var liveCards: [AmbientAssistantLaneItem]
    var chatMessages: [AmbientAssistantChatMessage]
    var status: AmbientAssistantLaneItem

    static let `default` = AmbientAssistantSurfaceSnapshot(
        context: AmbientAssistantContextSnapshot(
            frontApp: "Current app",
            sessionLabel: "main session",
            gatewayLabel: "Gateway local",
            deviceLabel: "iPhone handoff not checked",
            permissionSummaries: ["Screen: optional", "Accessibility: optional"],
            confidenceLabel: "Local context"),
        capabilities: [
            AmbientAssistantCapability(
                id: "gateway.health",
                title: "Gateway health",
                detail: "Available through local diagnostics",
                availability: .available),
            AmbientAssistantCapability(
                id: "context.screen",
                title: "Screen context",
                detail: "Requires Screen Recording for visual summaries",
                availability: .needsPermission),
            AmbientAssistantCapability(
                id: "handoff.iphone",
                title: "iPhone handoff",
                detail: "Visible now, execution ships in cross-device phase",
                availability: .unavailable),
        ],
        proposals: [
            AmbientAssistantProposalSummary(
                id: "phase1.safe",
                title: "Ask or command Thomas",
                detail: "Prompts and local commands are available now",
                approvalState: .notRequired,
                tone: .ready),
        ],
        receipt: AmbientAssistantReceiptSummary(
            summary: "No recent ambient actions",
            detail: "Receipts will appear after approved assistant actions run",
            tone: .ready),
        subagents: [
            AmbientAssistantLaneItem(id: "context", title: "Context Scout", detail: "Ready", tone: .ready),
            AmbientAssistantLaneItem(id: "planner", title: "Intent Planner", detail: "Command-first in phase 1", tone: .planning),
            AmbientAssistantLaneItem(id: "safety", title: "Safety Clerk", detail: "Ask-first for risky work", tone: .waitingForApproval),
        ],
        liveCards: [
            AmbientAssistantLaneItem(id: "chat", title: "Chat", detail: "No recent Thomas reply yet", tone: .ready),
            AmbientAssistantLaneItem(id: "schedule", title: "Schedule", detail: "Calendar and Reminders are ready to connect", tone: .ready),
            AmbientAssistantLaneItem(id: "automation", title: "Automation", detail: "No recent cron result yet", tone: .ready),
        ],
        chatMessages: [],
        status: AmbientAssistantLaneItem(
            id: "status",
            title: "Thomas",
            detail: "Ready for a prompt or slash command",
            tone: .ready))
}

enum AmbientAssistantSnapshotBuilder {
    static func makeSnapshot(inputs: AmbientAssistantLiveInputs) -> AmbientAssistantSurfaceSnapshot {
        var snapshot = AmbientAssistantSurfaceSnapshot.default
        snapshot.context = AmbientAssistantContextSnapshot(
            frontApp: clean(inputs.frontApp, fallback: "Current app"),
            sessionLabel: clean(inputs.sessionLabel, fallback: "main session"),
            gatewayLabel: clean(inputs.gatewayLabel, fallback: "Gateway local"),
            deviceLabel: clean(inputs.deviceLabel, fallback: "Mac local"),
            permissionSummaries: inputs.permissionSummaries.isEmpty ? ["Screen: optional", "Accessibility: optional"] : inputs.permissionSummaries,
            confidenceLabel: inputs.workLabel == nil ? "Live context" : "Live work")
        snapshot.status = AmbientAssistantLaneItem(
            id: "status",
            title: "Thomas",
            detail: clean(inputs.workLabel, fallback: "Ready for a prompt or slash command"),
            tone: inputs.workLabel == nil ? .ready : .working)
        snapshot.liveCards = [
            chatCard(from: inputs.chat),
            scheduleCard(from: inputs.schedule),
            automationCard(from: inputs.automation),
        ]
        snapshot.chatMessages = chatMessages(from: inputs.chat)
        snapshot.receipt = receipt(from: inputs.automation)
        snapshot.proposals = proposals(from: inputs)
        snapshot.capabilities = capabilities(from: inputs)
        return snapshot
    }

    private static func chatCard(from summary: AmbientAssistantChatSummary) -> AmbientAssistantLaneItem {
        if let error = nonEmpty(summary.error) {
            return AmbientAssistantLaneItem(
                id: "chat",
                title: "Chat",
                detail: "Thomas chat unavailable: \(compact(error, maxLength: 92))",
                tone: .error)
        }
        if summary.isAwaitingResponse {
            let prompt = compact(summary.lastUserText, maxLength: 76)
            return AmbientAssistantLaneItem(
                id: "chat",
                title: "Chat",
                detail: prompt == "No summary provided." ? "Waiting for Thomas to answer" : "Waiting for Thomas: \(prompt)",
                tone: .working)
        }
        if let assistant = nonEmpty(summary.lastAssistantText) {
            return AmbientAssistantLaneItem(
                id: "chat",
                title: "Chat",
                detail: "Thomas: \(compact(assistant, maxLength: 102))",
                tone: .success)
        }
        if let user = nonEmpty(summary.lastUserText) {
            return AmbientAssistantLaneItem(
                id: "chat",
                title: "Chat",
                detail: "Last prompt: \(compact(user, maxLength: 96))",
                tone: .ready)
        }
        return AmbientAssistantLaneItem(
            id: "chat",
            title: "Chat",
            detail: "Type a prompt here and Thomas replies in this layer",
            tone: .ready)
    }

    private static func chatMessages(from summary: AmbientAssistantChatSummary) -> [AmbientAssistantChatMessage] {
        let explicit = summary.messages
            .filter { !clean($0.text, fallback: "").isEmpty }
            .suffix(6)
        if !explicit.isEmpty {
            return Array(explicit)
        }

        var messages: [AmbientAssistantChatMessage] = []
        if let user = nonEmpty(summary.lastUserText) {
            messages.append(AmbientAssistantChatMessage(
                role: .user,
                text: user,
                isPending: summary.isAwaitingResponse))
        }
        if let assistant = nonEmpty(summary.lastAssistantText) {
            messages.append(AmbientAssistantChatMessage(
                role: .assistant,
                text: assistant,
                isPending: false))
        }
        return messages
    }

    private static func scheduleCard(from summary: AmbientAssistantScheduleSummary) -> AmbientAssistantLaneItem {
        if let error = nonEmpty(summary.error) {
            return AmbientAssistantLaneItem(
                id: "schedule",
                title: "Schedule",
                detail: "Schedule unavailable: \(compact(error, maxLength: 92))",
                tone: .error)
        }
        guard let first = summary.items.first else {
            let needsPermission = summary.authorizationLabel.localizedCaseInsensitiveContains("permission needed")
            return AmbientAssistantLaneItem(
                id: "schedule",
                title: "Schedule",
                detail: needsPermission ? summary.authorizationLabel : "No upcoming calendar events or reminders",
                tone: needsPermission ? .waitingForApproval : .ready)
        }

        let second = summary.items.dropFirst().first
        let detail = if let second {
            "\(first.dueLabel): \(first.title) · \(second.dueLabel): \(second.title)"
        } else {
            "\(first.dueLabel): \(first.title) · \(summary.authorizationLabel)"
        }
        return AmbientAssistantLaneItem(
            id: "schedule",
            title: "Schedule",
            detail: compact(detail, maxLength: 120),
            tone: .reading)
    }

    private static func automationCard(from summary: AmbientAssistantAutomationSummary) -> AmbientAssistantLaneItem {
        if let error = nonEmpty(summary.error) {
            return AmbientAssistantLaneItem(
                id: "automation",
                title: "Automation",
                detail: "Cron unavailable: \(compact(error, maxLength: 96))",
                tone: .error)
        }
        guard let title = nonEmpty(summary.latestTitle) else {
            return AmbientAssistantLaneItem(
                id: "automation",
                title: "Automation",
                detail: summary.schedulerLabel,
                tone: .ready)
        }
        let detail = [title, summary.latestDetail].compactMap(nonEmpty).joined(separator: " · ")
        return AmbientAssistantLaneItem(
            id: "automation",
            title: "Automation",
            detail: compact(detail, maxLength: 118),
            tone: summary.latestTone)
    }

    private static func receipt(from summary: AmbientAssistantAutomationSummary) -> AmbientAssistantReceiptSummary {
        guard let title = nonEmpty(summary.latestTitle) else {
            return AmbientAssistantSurfaceSnapshot.default.receipt
        }
        return AmbientAssistantReceiptSummary(
            summary: title,
            detail: clean(summary.latestDetail, fallback: summary.schedulerLabel),
            tone: summary.latestTone)
    }

    private static func proposals(from inputs: AmbientAssistantLiveInputs) -> [AmbientAssistantProposalSummary] {
        if inputs.automation.latestTone == .error {
            return [
                AmbientAssistantProposalSummary(
                    id: "automation.review",
                    title: "Review failed automation",
                    detail: clean(inputs.automation.latestDetail, fallback: "A cron run needs attention"),
                    approvalState: .notRequired,
                    tone: .error),
            ]
        }
        if inputs.schedule.authorizationLabel.localizedCaseInsensitiveContains("permission needed") {
            return [
                AmbientAssistantProposalSummary(
                    id: "schedule.permission",
                    title: "Enable schedule context",
                    detail: "Grant Calendar and Reminders access to make this layer time-aware",
                    approvalState: .required,
                    tone: .waitingForApproval),
            ]
        }
        return AmbientAssistantSurfaceSnapshot.default.proposals
    }

    private static func capabilities(from inputs: AmbientAssistantLiveInputs) -> [AmbientAssistantCapability] {
        var capabilities = AmbientAssistantSurfaceSnapshot.default.capabilities
        let scheduleAvailability: AmbientAssistantAvailability =
            inputs.schedule.authorizationLabel.localizedCaseInsensitiveContains("permission needed") ? .needsPermission : .available
        capabilities.append(AmbientAssistantCapability(
            id: "context.schedule",
            title: "Calendar and Reminders",
            detail: inputs.schedule.authorizationLabel,
            availability: scheduleAvailability))
        capabilities.append(AmbientAssistantCapability(
            id: "automation.cron",
            title: "Cron run results",
            detail: inputs.automation.schedulerLabel,
            availability: inputs.automation.error == nil ? .available : .unavailable))
        return capabilities
    }

    private static func clean(_ value: String?, fallback: String) -> String {
        nonEmpty(value) ?? fallback
    }

    private static func compact(_ value: String?, maxLength: Int) -> String {
        let trimmed = clean(value, fallback: "No summary provided.")
        guard trimmed.count > maxLength else { return trimmed }
        let end = trimmed.index(trimmed.startIndex, offsetBy: max(1, maxLength - 1))
        return String(trimmed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }

    private static func nonEmpty(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }
}
