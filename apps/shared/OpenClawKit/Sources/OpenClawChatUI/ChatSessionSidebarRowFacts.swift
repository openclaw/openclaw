#if os(macOS)
import Foundation
import OpenClawKit
import OpenClawProtocol

/// Presentation only: roster membership and mutations keep their existing owners.
struct ChatSessionSidebarRowFacts {
    enum Glyph: Equatable {
        case symbol(String), emoji(String)
    }

    enum Tone: Equatable { case secondary, accent, success, warning, danger }

    struct Badge {
        let glyph: Glyph
        let label: String
        var tone: Tone = .secondary
        var count: UInt64?
    }

    /// Metadata patches carry forward the sample; they must not restart its clock.
    struct RuntimeSample: Equatable {
        let sessionID: String?
        let runIDs: Set<String>
        let runtimeMs: Double?
        let startedAt: Double?
        let running: Bool

        init(_ session: OpenClawChatSessionEntry) {
            self.sessionID = session.sessionId
            self.runIDs = Set(session.activeRunIds ?? [])
            self.runtimeMs = session.runtimeMs
            self.startedAt = session.startedAt
            self.running = ChatSessionSidebarRowFacts.isRunning(session)
        }
    }

    let glyph: Glyph?
    let running: Bool
    let queued: Bool
    let unread: Bool
    let unreadDescendants: Bool
    let failedDescendants: Bool
    let attentionLabel: String?
    let glyphTone: Tone
    let idleLabel: String?
    let subtitle: String?
    let channelLabel: String?
    let badges: [Badge]

    init(
        node: ChatSessionSidebarModel.Node,
        isChild: Bool,
        attention: OpenClawChatAttentionSummary?,
        showPreview: Bool,
        isConnected: Bool = true,
        webFacts: NativeConversationSessionFacts.Session? = nil,
        preview: @autoclosure () -> String?,
        now: Date)
    {
        let session = node.session
        let nowMs = now.timeIntervalSince1970 * 1000
        let rows = session.isArchived ? [] : node.previewSessions.filter { !$0.isArchived }
        self.unreadDescendants = !session.isArchived && node.children.contains(where: \.badges.hasUnread)
        self.failedDescendants = !session.isArchived && node.children.contains { $0.badges.failedCount > 0 }
        let request = session.isArchived ? nil : attention
        let declaration = rows.compactMap { Self.declaration($0, now: nowMs) }.first { $0.attention != nil }
        let failed = rows.first {
            ["failed", "timeout"].contains($0.status ?? "") && ($0.lastReadAt == nil ||
                ($0.lastReadAt ?? 0) < ($0.endedAt ?? $0.updatedAt ?? 0))
        }
        let hasError = request == nil && declaration == nil && failed != nil
        // The native cache retains run facts; disconnected rows must not animate stale activity.
        let ownRun = isConnected && !session.isArchived && Self.isRunning(session)
        // ui/src/components/app-sidebar-session-tree.ts:166: the summary flag
        // includes an own queued run; only an idle parent proves unloaded child work.
        let childrenRun = isConnected && (rows.dropFirst().contains {
            Self.isRunning($0) || $0.hasActiveSubagentRun == true
        } || (!session.isArchived && !ownRun && session.hasActiveSubagentRun == true))
        let running = ownRun || childrenRun
        // ui/src/components/session-leading-indicator.ts:70: questions stop the ring;
        // all transient attention replaces decoration, while other attention keeps run state.
        self.running = running && request?.kind != .question
        self.queued = ownRun && session.status == "queued" && !childrenRun
        let failureLabel = failed.map { row in
            let reason = ChatPayloadDecoding
                .trimmedNonEmptyString(row.lastRunError) ?? String(localized: "Thread failed")
            // ui/src/components/app-sidebar-session-tree.ts:41 retains which child failed.
            return row.key == session.key ? reason : String(
                format: String(localized: "Child session %@ failed: %@"),
                ChatSessionSidebarModel.sidebarDisplayName(for: row),
                reason)
        }
        self.attentionLabel = request?.accessibilityText ?? declaration?.note ?? (hasError ? failureLabel : nil)
        let attentionIcon = request.map { $0.kind == .question ? "hand.raised.fill" : "checkmark.shield" } ??
            declaration?.attention.map { Self.attentionSymbols[$0] ?? "hand.raised.fill" } ??
            (hasError ? "exclamationmark.triangle.fill" : nil)
        let custom = ChatPayloadDecoding.trimmedNonEmptyString(session.icon).map(Self.icon)
        let terminal = isChild && !running ? Self.terminalBadge(session.status) : nil
        self.glyph = attentionIcon.map(Glyph.symbol) ?? custom ?? terminal?.glyph
        self.glyphTone = attentionIcon != nil ? (hasError ? .danger : .warning) :
            custom == nil ? terminal?.tone ?? .secondary : .secondary
        self.idleLabel = attentionIcon == nil && custom == nil ? terminal?.label : nil
        self.unread = !session.isArchived && session.unread == true && !running &&
            (attentionIcon != nil || custom != nil || !isChild)

        let declared = Self.declaration(session, now: nowMs)
        let digest = session.observerDigest.flatMap { digest in
            if ownRun { return session.activeRunIds?.contains(digest.runId ?? "") == true ? digest : nil }
            return ["done", "failed"].contains(digest.health) && (session.lastReadAt ?? 0) < digest.updatedAt
                ? digest : nil
        }
        let critical = digest.map { ["stuck", "waiting-on-user"].contains($0.health) } == true
        let attentionText = request?.kind == .approval ? request?.title : declaration?.note
        // ui/src/components/session-row-subtitle.ts:25,53: question/error have no
        // second line; preview-off preserves approvals, declarations and critical observer health.
        if request?.kind == .question || hasError {
            self.subtitle = nil
        } else if !showPreview {
            self.subtitle = attentionText ?? (critical ? digest?.headline : nil)
        } else {
            self.subtitle = attentionText ?? declared?.note ?? digest?.headline ??
                (!ownRun ? ChatPayloadDecoding.trimmedNonEmptyString(session.lastMessagePreview) ?? preview() : nil) ??
                Self.workSubtitle(session)
        }
        self.channelLabel = ChatSessionSidebarModel.sidebarChannelLabel(for: session)
        // ui/src/components/app-sidebar-session-tree.ts:160 folds loaded descendants;
        // the wire count and the web sum cap are Number.MAX_SAFE_INTEGER.
        let conflictRows = session.isArchived ? [session] : node.previewSessions
        let conflicts = conflictRows.reduce(0) { min(9_007_199_254_740_991, $0 + Self.workspaceConflicts($1)) }
        var badges = Self.badges(session, isChild: isChild, conflicts: conflicts)
        // session-row-badges.ts:166,177 uses outbox attention, not queue length;
        // composer drafts are independent of the Gateway's sharing-draft ghost.
        if let webFacts {
            if webFacts.outboxAttentionCount > 0 {
                badges.append(Badge(
                    glyph: .symbol("exclamationmark.triangle"),
                    label: webFacts.outboxAttentionCount == 1 ? String(localized: "1 message needs attention") :
                        String(
                            format: String(localized: "%lld messages need attention"),
                            webFacts.outboxAttentionCount),
                    tone: .warning,
                    count: webFacts.outboxAttentionCount))
            }
            if webFacts.hasComposerDraft {
                badges.append(Badge(glyph: .symbol("pencil"), label: String(localized: "Unsent draft")))
            }
        }
        self.badges = badges
    }

    static func icon(_ value: String) -> Glyph {
        // ui/src/components/session-icon-glyph-registry.ts:9 maps the six wire glyphs.
        // Native never executes SVG; unsupported artwork gets a visible default glyph.
        let symbols = [
            "braces": "curlybraces",
            "book": "book",
            "monitor": "desktopcomputer",
            "bot": "cpu",
            "kanban": "rectangle.split.3x1",
            "coins": "dollarsign.circle",
        ]
        if let symbol = symbols[value] { return .symbol(symbol) }
        if value.count == 1, value.unicodeScalars.contains(where: \.properties.isEmoji),
           value.utf16.count > 1 || value.unicodeScalars.contains(where: { $0.value > 127 })
        {
            return .emoji(value)
        }
        return .symbol("text.bubble")
    }

    static func runtimeText(
        _ session: OpenClawChatSessionEntry, sampledAt: Date, now: Date, isConnected: Bool = true) -> String?
    {
        let duration = session.runtimeMs.map {
            $0 + (isConnected && Self.isRunning(session) && !session.isArchived
                ? max(0, now.timeIntervalSince(sampledAt) * 1000) : 0)
        } ?? session.startedAt.flatMap { start in
            (session.endedAt ?? (isConnected ? now.timeIntervalSince1970 * 1000 : nil)).map { $0 - start }
        }
        guard let duration, duration.isFinite else { return nil }
        // ui/src/components/app-sidebar-session-row-render.ts:253 uses the sampled
        // runtime, not wall time since start (which includes gaps between runs).
        return duration < 999.5
            ? String(format: String(localized: "%lldms"), Int(max(0, duration.rounded())))
            : ChatWorkingDurationFormatter.compact(milliseconds: duration)
    }

    private static let attentionSymbols = [
        "hand": "hand.raised.fill",
        "key": "key.fill",
        "alert": "exclamationmark.triangle.fill",
        "flag": "flag.fill",
        "lock": "lock.fill",
        "hourglass": "circle",
    ]

    private static func declaration(_ row: OpenClawChatSessionEntry, now: Double) -> OpenClawChatSessionAgentStatus? {
        row.agentStatus.flatMap { $0.expiresAt > now && !$0.note.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            ? $0 : nil
        }
    }

    private static func isRunning(_ row: OpenClawChatSessionEntry) -> Bool {
        // src/shared/session-run-state.ts: terminal status wins, then explicit liveness.
        if let status = row.status, status != "queued", status != "running" { return false }
        return row.hasActiveRun ?? (row.status == "running" || row.status == "queued")
    }

    private static func terminalBadge(_ status: String?) -> Badge? {
        // ui/src/styles/layout.css:2413: read terminal children keep their status color.
        let (symbol, label, tone): (String, String, Tone)
        switch status {
        case "done": (symbol, label, tone) = ("checkmark", String(localized: "Finished"), .success)
        case "killed": (symbol, label, tone) = ("stop.fill", String(localized: "Stopped"), .secondary)
        case "timeout": (symbol, label, tone) = (
                "exclamationmark.triangle.fill",
                String(localized: "Timed out"),
                .danger)
        case "interrupted": (symbol, label, tone) = ("pause.fill", String(localized: "Interrupted"), .secondary)
        case "failed": (symbol, label, tone) = ("exclamationmark.triangle.fill", String(localized: "Failed"), .danger)
        default: return nil
        }
        return Badge(glyph: .symbol(symbol), label: label, tone: tone)
    }

    private static func workspaceConflicts(_ session: OpenClawChatSessionEntry) -> Int {
        let conflict = session.placement?.workspaceResultConflict?.value as? [String: AnyCodable]
        return max(
            (conflict?["paths"]?.value as? [AnyCodable])?.count ?? 0,
            conflict?["totalCount"]?.value as? Int ?? 0)
    }

    private static func workSubtitle(_ session: OpenClawChatSessionEntry) -> String? {
        guard session.worktree != nil || session.repository != nil || session.execNode != nil,
              let subtitle = ChatSessionSidebarModel.sidebarWorkSubtitle(for: session),
              subtitle != ChatSessionSidebarModel.sidebarDisplayName(for: session)
        else { return nil }
        return subtitle
    }

    private static func badges(_ session: OpenClawChatSessionEntry, isChild: Bool, conflicts count: Int) -> [Badge] {
        var badges: [Badge] = []
        if session.visibility == .draft {
            badges.append(Badge(glyph: .emoji("👻"), label: String(localized: "Draft")))
        }
        if session.isArchived {
            badges.append(Badge(glyph: .symbol("archivebox"), label: String(localized: "Archived")))
        }
        if session.forkSource != nil {
            badges.append(Badge(glyph: .symbol("arrow.triangle.branch"), label: String(localized: "Forked session")))
        }
        if session.incognito == true {
            badges.append(Badge(glyph: .symbol("lock"), label: String(localized: "Incognito")))
        }
        let placement = session.placement
        // ui/src/components/session-row-badges.ts:66: children hide ordinary
        // placement/disk chrome but retained workspace conflicts must stay visible.
        let cloud = !isChild && placement.map { ![.local, .reclaimed].contains($0.state) } == true
        let state = cloud || count > 0 ? placement?.state : nil
        guard state != nil || count > 0 else { return badges }
        let disk = placement?.state == .active && !isChild
            ? (placement?.diskSpace?.value as? [String: AnyCodable])?["status"]?.value as? String : nil
        var label = state.map { String(format: String(localized: "Placement: %@"), $0.rawValue) } ?? ""
        if let placement, let provider = placement.providerId, let profile = placement.profileId {
            let machine = placement.machine?.value as? [String: AnyCodable]
            let os = machine?["osLabel"]?.value as? String ?? machine?["os"]?.value as? String
            let cpu = (machine?["cpu"]?.value as? NSNumber).map {
                String(format: String(localized: "%@ vCPU"), $0.stringValue)
            }
            let memory = (machine?["memoryGb"]?.value as? NSNumber).map {
                String(format: String(localized: "%@ GB"), $0.stringValue)
            }
            label = [provider, profile, os, machine?["class"]?.value as? String, cpu, memory, placement.state.rawValue]
                .compactMap(ChatPayloadDecoding.trimmedNonEmptyString).joined(separator: " · ")
        }
        if state == nil {
            label = count == 1 ? String(localized: "Cloud worker child: 1 workspace conflict") :
                String(format: String(localized: "Cloud worker children: %lld workspace conflicts"), count)
        } else if count == 1 {
            label += " · " + String(localized: "1 workspace conflict")
        } else if count > 1 {
            label += " · " + String(format: String(localized: "%lld workspace conflicts"), count)
        }
        if disk == "warning" { label += " · " + String(localized: "Cloud session disk space is low") }
        if disk == "critical" { label += " · " + String(localized: "Cloud session disk space is critically low") }
        let tone: Tone = count > 0 || disk == "warning" ? .warning : disk == "critical" || state == .failed
            ? .danger : state == .active ? .success : state == .local || state == .reclaimed
            ? .secondary : .accent
        badges.append(Badge(glyph: .symbol("globe"), label: label, tone: tone))
        return badges
    }
}
#endif
