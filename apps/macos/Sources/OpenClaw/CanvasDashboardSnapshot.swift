import Foundation

struct CanvasDashboardPayload: Codable, Equatable {
    var gatewayState: String
    var eyebrow: String
    var title: String
    var subtitle: String
    var mood: String
    var moodNote: String
    var gatewayLabel: String
    var gatewayCaption: String
    var activeAgentName: String
    var activeAgentCaption: String
    var talkLabel: String
    var talkCaption: String
    var nextLabel: String
    var nextCaption: String
    var plan: [CanvasDashboardCard]
    var actions: [CanvasDashboardCard]
    var devices: [CanvasDashboardCard]
    var memories: [CanvasDashboardCard]
    var agents: [CanvasDashboardCard]
    var notion: [CanvasDashboardCard]
    var cronRuns: [CanvasDashboardCard]
    var attention: [CanvasDashboardCard]
    var today: [CanvasDashboardCard]
    var seriousSuggestion: CanvasDashboardSuggestion
    var funSuggestion: CanvasDashboardSuggestion
    var updatedAtLabel: String
}

struct CanvasDashboardCard: Codable, Equatable {
    var kicker: String?
    var title: String?
    var caption: String?
    var status: String?
    var badge: String?
    var name: String?
    var id: String?
    var isActive: Bool?
}

struct CanvasDashboardSuggestion: Codable, Equatable {
    var kicker: String
    var title: String
    var caption: String
    var actionLabel: String
}

struct CanvasDashboardLocalSource: Codable, Equatable {
    var notion: [CanvasDashboardCard]?
    var today: [CanvasDashboardCard]?
    var attention: [CanvasDashboardCard]?
    var seriousSuggestion: CanvasDashboardSuggestion?
    var funSuggestion: CanvasDashboardSuggestion?
}

struct CanvasActionQueueItem: Codable, Equatable {
    var id: String
    var title: String
    var caption: String?
    var kind: String
    var source: String
    var priority: String
    var status: String
    var createdAtMs: Int
    var updatedAtMs: Int
    var dueAtMs: Int?
    var actionLabel: String?
}

enum CanvasDashboardSnapshot {
    static func build(
        gatewayLabel: String,
        gatewayCaption: String,
        activeAgentName: String,
        talkLabel: String,
        talkCaption: String,
        cronRuns: [CronRunLogEntry],
        actionItems: [CanvasActionQueueItem] = [],
        localSource: CanvasDashboardLocalSource? = Self.loadLocalSource(),
        localSourceUpdatedAt: Date? = Self.localSourceUpdatedAt(),
        now: Date = Date()) -> CanvasDashboardPayload
    {
        let cronCards = Self.cronCards(from: cronRuns)
        let actionCards = Self.actionCards(from: actionItems)
        let failedRun = cronRuns.first { ($0.status ?? "").localizedCaseInsensitiveContains("fail") || $0.error != nil }
        var attention = localSource?.attention ?? []
        if let failedRun {
            attention.insert(Self.attentionCard(for: failedRun), at: 0)
        }
        if !actionCards.isEmpty {
            attention.insert(contentsOf: actionCards.prefix(3), at: 0)
        }
        if attention.isEmpty {
            attention = [
                CanvasDashboardCard(
                    kicker: "Ready",
                    title: "Choose the next useful thing",
                    caption: "Thomas is watching for follow-ups, failures, approvals, and handoffs.",
                    status: "ready",
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil),
            ]
        }

        let notion = localSource?.notion ?? [
            CanvasDashboardCard(
                kicker: "Notion",
                title: "Connect a source",
                caption: "Pin important Notion pages, projects, and reminders through ~/.openclaw/canvas-dashboard.json.",
                status: "setup",
                badge: nil,
                name: nil,
                id: nil,
                isActive: nil),
        ]

        var today = localSource?.today ?? [
            CanvasDashboardCard(
                kicker: "Now",
                title: "Workspace awake",
                caption: "Gateway, Canvas, and assistant surface are ready.",
                status: "ready",
                badge: nil,
                name: nil,
                id: nil,
                isActive: nil),
        ]
        if let localSourceUpdatedAt {
            today.append(
                CanvasDashboardCard(
                    kicker: "Notion sync",
                    title: "Dashboard context refreshed",
                    caption: "\(Self.relativeLabel(for: localSourceUpdatedAt)): \(notion.count) Notion cards are pinned.",
                    status: "fresh",
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil))
        }
        if let latest = cronCards.first {
            today.append(
                CanvasDashboardCard(
                    kicker: "Automation",
                    title: latest.title,
                    caption: latest.caption,
                    status: latest.status,
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil))
        }

        let leadingAction = actionItems.first
        let fallbackNextLabel = failedRun == nil ? "Proactive queue" : "Check automation"
        let fallbackNextCaption = failedRun == nil ? "Suggestions, cron output, and useful next moves land here." :
            "A recent cron run needs attention."
        let nextLabel = leadingAction?.actionLabel ?? fallbackNextLabel
        let nextCaption = leadingAction.map {
            "\($0.title): \(Self.compact($0.caption, maxLength: 120))"
        } ?? fallbackNextCaption

        let defaultActions = [
            CanvasDashboardCard(
                kicker: "Work",
                title: "Draft a message",
                caption: "Turn a summary into a BlueBubbles-ready approval draft.",
                status: nil,
                badge: nil,
                name: nil,
                id: nil,
                isActive: nil),
            CanvasDashboardCard(
                kicker: "Notion",
                title: "Pin context",
                caption: "Add a card to the dashboard source file and keep it nearby.",
                status: nil,
                badge: nil,
                name: nil,
                id: nil,
                isActive: nil),
            CanvasDashboardCard(
                kicker: "Voice",
                title: "Check Talk",
                caption: "Review provider, key, voice, and latency state.",
                status: nil,
                badge: nil,
                name: nil,
                id: nil,
                isActive: nil),
            CanvasDashboardCard(
                kicker: "Files",
                title: "Preview output",
                caption: "Render generated pages, docs, and screenshots here.",
                status: nil,
                badge: nil,
                name: nil,
                id: nil,
                isActive: nil),
        ]

        return CanvasDashboardPayload(
            gatewayState: "connected",
            eyebrow: "Thomas Workbench",
            title: "Good. The desk is awake.",
            subtitle: "A living command surface for Notion context, recent automations, useful suggestions, and the next thing Thomas should help with.",
            mood: "Ready",
            moodNote: "Personal, fast, and only mildly too pleased with itself.",
            gatewayLabel: gatewayLabel,
            gatewayCaption: gatewayCaption,
            activeAgentName: activeAgentName,
            activeAgentCaption: "Thomas is ready for the next useful thing.",
            talkLabel: talkLabel,
            talkCaption: talkCaption,
            nextLabel: nextLabel,
            nextCaption: nextCaption,
            plan: [
                CanvasDashboardCard(
                    kicker: nil,
                    title: "Keep priorities visible",
                    caption: "Current work, approvals, reminders, and handoff stay in view.",
                    status: "ready",
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil),
                CanvasDashboardCard(
                    kicker: nil,
                    title: "Turn context into action",
                    caption: "Use Canvas for previews, checklists, generated pages, and device actions.",
                    status: "next",
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil),
                CanvasDashboardCard(
                    kicker: nil,
                    title: "Stay useful and personal",
                    caption: "Thomas should be quick, direct, funny when useful, and proactive without becoming noisy.",
                    status: "soon",
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil),
            ],
            actions: Array((actionCards + defaultActions).prefix(4)),
            devices: [
                CanvasDashboardCard(
                    kicker: nil,
                    title: nil,
                    caption: "Local control center",
                    status: nil,
                    badge: "Mac",
                    name: "Mac gateway",
                    id: "mac",
                    isActive: true),
                CanvasDashboardCard(
                    kicker: nil,
                    title: nil,
                    caption: "Paired assistant mode",
                    status: nil,
                    badge: "iOS",
                    name: "iPhone",
                    id: "ios",
                    isActive: nil),
            ],
            memories: [
                CanvasDashboardCard(
                    kicker: nil,
                    title: nil,
                    caption: "Personal, direct, funny when it helps.",
                    status: nil,
                    badge: "Tone",
                    name: "Tone",
                    id: "tone",
                    isActive: nil),
                CanvasDashboardCard(
                    kicker: nil,
                    title: nil,
                    caption: "Fast voice first, cloud deluxe when available.",
                    status: nil,
                    badge: "Voice",
                    name: "Voice",
                    id: "voice",
                    isActive: nil),
                CanvasDashboardCard(
                    kicker: nil,
                    title: nil,
                    caption: "Make the next useful action obvious.",
                    status: nil,
                    badge: "Next",
                    name: "Focus",
                    id: "focus",
                    isActive: nil),
            ],
            agents: [
                CanvasDashboardCard(
                    kicker: nil,
                    title: nil,
                    caption: "Active on this Mac",
                    status: nil,
                    badge: "OC",
                    name: activeAgentName,
                    id: "main",
                    isActive: true),
            ],
            notion: Array(notion.prefix(4)),
            cronRuns: cronCards.isEmpty ? [
                CanvasDashboardCard(
                    kicker: "Cron",
                    title: "No recent run yet",
                    caption: "Completed automation runs will appear here with compact summaries.",
                    status: "idle",
                    badge: nil,
                    name: nil,
                    id: nil,
                    isActive: nil),
            ] : Array(cronCards.prefix(5)),
            attention: Array(attention.prefix(4)),
            today: Array(today.prefix(4)),
            seriousSuggestion: localSource?.seriousSuggestion ?? CanvasDashboardSuggestion(
                kicker: "Serious suggestion",
                title: "Draft a useful BlueBubbles message",
                caption: "Summarize a news article, make it personal, and queue the message for approval before sending.",
                actionLabel: "Prepare draft"),
            funSuggestion: localSource?.funSuggestion ?? CanvasDashboardSuggestion(
                kicker: "Fun suggestion",
                title: "Teach Thomas image generation",
                caption: "Add a playful image mode with prompt templates, style memory, and Canvas previews before anything gets saved or sent.",
                actionLabel: "Explore image mode"),
            updatedAtLabel: Self.timeLabel(now))
    }

    static func cronCards(from entries: [CronRunLogEntry]) -> [CanvasDashboardCard] {
        entries.prefix(8).map { entry in
            let status = Self.compact(entry.status ?? entry.action, maxLength: 28)
            let title = Self.compact(entry.jobName ?? entry.jobId, maxLength: 48)
            let detail = entry.error ?? entry.summary ?? entry.action
            let duration = entry.durationMs.map { " in \(Self.formatDuration(ms: $0))" } ?? ""
            return CanvasDashboardCard(
                kicker: "Cron \(status)",
                title: title,
                caption: "\(Self.relativeLabel(for: entry.date))\(duration): \(Self.compact(detail, maxLength: 130))",
                status: status,
                badge: nil,
                name: nil,
                id: entry.id,
                isActive: nil)
        }
    }

    static func actionCards(from items: [CanvasActionQueueItem]) -> [CanvasDashboardCard] {
        items
            .filter { $0.status == "open" || $0.status == "in_progress" }
            .prefix(8)
            .map { item in
                CanvasDashboardCard(
                    kicker: Self.actionSourceLabel(item.source),
                    title: Self.compact(item.title, maxLength: 54),
                    caption: Self.compact(item.caption, maxLength: 130),
                    status: item.priority,
                    badge: item.actionLabel,
                    name: nil,
                    id: item.id,
                    isActive: item.status == "in_progress")
            }
    }

    static func compact(_ value: String?, maxLength: Int) -> String {
        let trimmed = (value ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "No summary provided." }
        guard trimmed.count > maxLength else { return trimmed }
        let end = trimmed.index(trimmed.startIndex, offsetBy: max(1, maxLength - 1))
        return String(trimmed[..<end]).trimmingCharacters(in: .whitespacesAndNewlines) + "..."
    }

    private static func attentionCard(for entry: CronRunLogEntry) -> CanvasDashboardCard {
        CanvasDashboardCard(
            kicker: "Cron",
            title: "Automation needs attention",
            caption: "\(entry.jobName ?? entry.jobId): \(self.compact(entry.error ?? entry.summary, maxLength: 120))",
            status: "attention",
            badge: nil,
            name: nil,
            id: entry.id,
            isActive: nil)
    }

    private static func actionSourceLabel(_ source: String) -> String {
        switch source.lowercased() {
        case "bluebubbles": "BlueBubbles"
        case "notion": "Notion"
        case "cron": "Cron"
        case "talk": "Talk"
        case "canvas": "Canvas"
        case "system": "System"
        default: "Thomas"
        }
    }

    private static func loadLocalSource() -> CanvasDashboardLocalSource? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let url = home.appendingPathComponent(".openclaw/canvas-dashboard.json", isDirectory: false)
        guard let data = try? Data(contentsOf: url) else { return nil }
        return try? JSONDecoder().decode(CanvasDashboardLocalSource.self, from: data)
    }

    private static func localSourceUpdatedAt() -> Date? {
        let home = FileManager.default.homeDirectoryForCurrentUser
        let url = home.appendingPathComponent(".openclaw/canvas-dashboard.json", isDirectory: false)
        let values = try? url.resourceValues(forKeys: [.contentModificationDateKey])
        return values?.contentModificationDate
    }

    private static func timeLabel(_ date: Date) -> String {
        let formatter = DateFormatter()
        formatter.dateFormat = "EEE HH:mm"
        return formatter.string(from: date)
    }

    private static func relativeLabel(for date: Date) -> String {
        let seconds = max(0, Int(Date().timeIntervalSince(date)))
        if seconds < 90 { return "just now" }
        let minutes = seconds / 60
        if minutes < 90 { return "\(minutes)m ago" }
        let hours = minutes / 60
        if hours < 48 { return "\(hours)h ago" }
        let days = hours / 24
        return "\(days)d ago"
    }

    private static func formatDuration(ms: Int) -> String {
        if ms < 1000 { return "\(ms)ms" }
        let seconds = Double(ms) / 1000
        return String(format: "%.1fs", seconds)
    }
}
