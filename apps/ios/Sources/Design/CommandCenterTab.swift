import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct CommandCenterTab: View {
    static let recentSessionsFetchLimit = 200

    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    private let headerTitle = "Overview"
    var headerSidebarAction: OpenClawSidebarHeaderAction?
    var dashboardModel: RootSidebarModel
    var openChat: () -> Void
    var openSettings: () -> Void
    var openSessions: () -> Void
    var openApprovals: () -> Void
    var openAutomations: () -> Void
    var openUsage: () -> Void

    struct WorkItem {
        let icon: String
        let title: String
        let detail: String
        let state: String
        let color: Color
        let isUnread: Bool
        let isPinned: Bool
        var sessionColor: String?
    }

    var body: some View {
        GeometryReader { geometry in
            ZStack {
                OpenClawProBackground()
                self.commandAmbientOverlay
                ScrollView {
                    VStack(alignment: .leading, spacing: 14) {
                        self.header
                        self.gatewayCard
                        self.threadTiles
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        self.attentionCard
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        self.usageSummaryCard
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        if Self.usesSplitSectionsLayout(
                            horizontalSizeClass: self.horizontalSizeClass,
                            containerWidth: geometry.size.width)
                        {
                            HStack(alignment: .top, spacing: 12) {
                                self.defaultChatSessionSection
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                                self.recentSessions
                                    .frame(maxWidth: .infinity, alignment: .topLeading)
                            }
                            .padding(.horizontal, OpenClawProMetric.pagePadding)
                        } else {
                            self.defaultChatSessionSection
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                            self.recentSessions
                                .padding(.horizontal, OpenClawProMetric.pagePadding)
                        }
                    }
                    .padding(.top, 18)
                    .padding(.bottom, 18)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
        }
        .navigationTitle(self.headerTitle)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
    }

    private var threadTiles: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.flexible(), spacing: 8), count: 4), spacing: 8) {
            self.threadTile(
                title: String(localized: "Sessions"),
                value: self.overviewCountText(self.overviewSessions.count))
            self.threadTile(
                title: String(localized: "Live"),
                value: self.overviewCountText(self.overviewLiveCount))
            self.threadTile(
                title: String(localized: "Unread"),
                value: self.overviewCountText(self.overviewUnreadCount))
            self.threadTile(
                title: String(localized: "Tokens"),
                value: self.overviewTokenText)
        }
    }

    private func threadTile(title: String, value: String) -> some View {
        Button {
            self.openSessions()
        } label: {
            ProCard(padding: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(verbatim: value)
                        .font(OpenClawType.headline)
                        .foregroundStyle(OpenClawBrand.accent)
                        .lineLimit(1)
                        .minimumScaleFactor(0.7)
                    Text(verbatim: title)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
        }
        .buttonStyle(.plain)
        .accessibilityHint(String(localized: "Opens Sessions"))
    }

    @ViewBuilder
    private var attentionCard: some View {
        let approvalCount = self.appModel.pendingExecApprovalCount
        let cronCount = self.dashboardModel.failedCronJobCount + self.dashboardModel.overdueCronJobCount
        if approvalCount > 0 || cronCount > 0 {
            ProCard(tint: OpenClawBrand.warn, padding: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    self.cardHeader(title: String(localized: "Attention"))
                    if approvalCount > 0 {
                        self.dashboardActionRow(
                            title: String(localized: "Pending approvals"),
                            value: approvalCount.formatted(),
                            systemImage: "checkmark.shield",
                            action: self.openApprovals)
                    }
                    if cronCount > 0 {
                        self.dashboardActionRow(
                            title: String(localized: "Automation issues"),
                            value: cronCount.formatted(),
                            systemImage: "clock.badge.exclamationmark",
                            action: self.openAutomations)
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var usageSummaryCard: some View {
        if let usage = self.dashboardModel.usage {
            Button(action: self.openUsage) {
                ProCard(padding: 12) {
                    HStack(spacing: 12) {
                        VStack(alignment: .leading, spacing: 4) {
                            Text(String(localized: "31-day usage"))
                                .font(OpenClawType.subheadSemiBold)
                                .foregroundStyle(.primary)
                            Text(self.usageCostText(usage.totalCost))
                                .font(OpenClawType.title3SemiBold)
                                .foregroundStyle(OpenClawBrand.accent)
                        }
                        Spacer(minLength: 8)
                        self.usageTrend(usage.daily ?? [])
                    }
                }
            }
            .buttonStyle(.plain)
            .accessibilityHint(String(localized: "Opens Usage"))
        }
    }

    private func dashboardActionRow(
        title: String,
        value: String,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            HStack(spacing: 10) {
                Image(systemName: systemImage)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawBrand.warn)
                Text(verbatim: title)
                    .font(OpenClawType.subheadSemiBold)
                Spacer(minLength: 8)
                Text(verbatim: value)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawBrand.warn)
                Image(systemName: "chevron.right")
                    .font(OpenClawType.captionSemiBold)
                    .foregroundStyle(.secondary)
            }
            .frame(minHeight: 44)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
    }

    private func usageTrend(_ daily: [CostUsageDailyEntryLite]) -> some View {
        let values = daily.suffix(14).map { max(0, $0.totalCost ?? 0) }
        let maximum = values.max() ?? 0
        return HStack(alignment: .bottom, spacing: 2) {
            ForEach(Array(values.enumerated()), id: \.offset) { _, value in
                Capsule()
                    .fill(OpenClawBrand.accent.opacity(0.75))
                    .frame(width: 3, height: maximum > 0 ? max(3, 28 * value / maximum) : 3)
            }
        }
        .frame(height: 30, alignment: .bottom)
        .accessibilityHidden(true)
    }

    private func usageCostText(_ value: Double?) -> String {
        guard let value else { return "—" }
        return value.formatted(.currency(code: "USD"))
    }

    private var overviewSessions: [OpenClawChatSessionEntry] {
        Self.visibleOverviewSessions(self.dashboardModel.sessions, now: self.dashboardModel.now)
    }

    static func visibleOverviewSessions(
        _ sessions: [OpenClawChatSessionEntry],
        now: Date = .now) -> [OpenClawChatSessionEntry]
    {
        sessions.filter {
            SessionStatusScope.active.includes($0, at: now) &&
                !ChatSessionSidebarModel.isHiddenInternalSession($0.key)
        }
    }

    private var overviewLiveCount: Int {
        self.overviewSessions.count { session in
            session.hasActiveRun == true || session.hasActiveSubagentRun == true ||
                session.status?.lowercased() == "running"
        }
    }

    private var overviewUnreadCount: Int {
        self.overviewSessions.count { $0.unread == true }
    }

    private func overviewCountText(_ count: Int) -> String {
        "\(count.formatted())\(self.dashboardModel.isSessionRosterComplete ? "" : "+")"
    }

    private var overviewTokenText: String {
        let summary = RootSidebarModel.tokenUsageSummary(
            for: self.overviewSessions,
            rosterIsComplete: self.dashboardModel.isSessionRosterComplete)
        guard let total = summary.total else { return "n/a" }
        return "\(summary.isPartial ? "~" : "")\(total.formatted(.number.notation(.compactName)))"
    }

    static func usesSplitSectionsLayout(
        horizontalSizeClass: UserInterfaceSizeClass?,
        containerWidth: CGFloat) -> Bool
    {
        guard horizontalSizeClass == .regular else { return false }
        return containerWidth >= 1000
    }

    private var header: some View {
        OpenClawAdaptiveHeaderRow(
            title: .localized(self.headerTitle),
            subtitle: .localized(self.gatewaySubtitle),
            titleFont: OpenClawType.title3SemiBold,
            subtitleFont: OpenClawType.caption,
            subtitleLineLimit: 1)
        {
            if let headerSidebarAction {
                OpenClawSidebarControlButton(action: headerSidebarAction)
            }
        } accessory: {
            HStack(spacing: 10) {
                Button(action: self.openSettings) {
                    Image(systemName: "gearshape.fill")
                        .font(OpenClawType.subheadSemiBold)
                        .frame(
                            width: OpenClawProMetric.compactControlSize,
                            height: OpenClawProMetric.compactControlSize)
                }
                .openClawGlassButton()
                .accessibilityLabel("Gateway settings")
                .accessibilityHint("Opens gateway settings")
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @ViewBuilder
    private var commandAmbientOverlay: some View {
        if self.colorScheme == .light {
            LinearGradient(
                colors: [
                    Color.white.opacity(0.05),
                    Color.clear,
                ],
                startPoint: .top,
                endPoint: .bottom)
                .ignoresSafeArea()
                .allowsHitTesting(false)
        }
    }

    private var gatewayCard: some View {
        ProCard(isProminent: true, padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                self.cardHeader(title: "Gateway")

                HStack(spacing: 0) {
                    self.gatewayFact(
                        icon: "network",
                        title: "Connection",
                        value: self.gatewayDisplayState.statusPresentation.title,
                        color: self.gatewayStatusColor)
                    Divider().frame(height: 38)
                    self.gatewayFact(
                        icon: "server.rack",
                        title: "Address",
                        value: self.gatewayAddressText,
                        color: OpenClawBrand.accent)
                    Divider().frame(height: 38)
                    self.gatewayFact(
                        icon: "person.2.fill",
                        title: "Agents",
                        value: self.gatewayAgentCountText,
                        color: OpenClawBrand.accentHotForeground)
                }
                .padding(.vertical, 7)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func gatewayFact(icon: String, title: String, value: String, color: Color) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(spacing: 5) {
                Image(systemName: icon)
                    .font(OpenClawType.caption2Bold)
                    .foregroundStyle(color)
                Text(title)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Text(value)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(title == "Connection" ? color : .primary)
                .lineLimit(1)
                .minimumScaleFactor(0.72)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
    }

    private var defaultChatSessionSection: some View {
        ProCard(padding: 12) {
            VStack(spacing: 10) {
                self.cardHeader(title: "Agent session")

                Button {
                    self.openSessionKey(nil)
                } label: {
                    CommandSessionRow(item: self.defaultChatWorkItem)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var recentSessions: some View {
        ProCard(padding: 12) {
            VStack(spacing: 10) {
                self.cardHeader(title: "Recent sessions")

                if let sessionErrorText = self.dashboardModel.sessionErrorText {
                    Text(verbatim: sessionErrorText)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawBrand.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                if self.recentSessionPreviewSessions.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.gatewayConnected ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: self.gatewayConnected ? "No recent sessions" : "Gateway offline",
                        detail: self
                            .gatewayConnected ? "Start a chat and it will appear here." : "Connect to the gateway.")
                } else {
                    VStack(spacing: 8) {
                        ForEach(self.recentSessionPreviewSessions) { session in
                            let item = Self.sessionWorkItem(
                                for: session,
                                currentSessionKey: self.appModel.chatSessionKey)
                            Button {
                                self.openSessionKey(session.key)
                            } label: {
                                CommandSessionRow(item: item)
                            }
                            .buttonStyle(.plain)
                            .commandSessionActions(
                                session: session,
                                mainSessionKey: self.appModel.mainSessionKey,
                                categories: self.sessionCategories,
                                isEnabled: self.sessionControlsAvailable,
                                canArchive: ChatSessionSidebarModel.canArchiveSession(
                                    session,
                                    mainSessionKey: self.appModel.mainSessionKey),
                                performMutation: self.performSessionMutation,
                                fork: { self.forkSession(session) })
                        }

                        if self.hasMoreRecentSessions {
                            Button(action: self.openSessions) {
                                Label("View More", systemImage: "chevron.right")
                                    .font(OpenClawType.subheadBold)
                                    .foregroundStyle(OpenClawBrand.accent)
                                    .frame(maxWidth: .infinity)
                                    .padding(.vertical, 10)
                                    .contentShape(Rectangle())
                            }
                            .buttonStyle(.plain)
                        }
                    }
                }
            }
        }
    }

    private func cardHeader(title: String) -> some View {
        HStack(spacing: 8) {
            Text(title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(.secondary)
            Spacer(minLength: 8)
        }
    }

    private var gatewayConnected: Bool {
        self.gatewayDisplayState == .connected
    }

    private var gatewayDisplayState: GatewayDisplayState {
        GatewayStatusBuilder.build(appModel: self.appModel)
    }

    private var gatewayStatusColor: Color {
        let state = self.gatewayDisplayState
        return state == .disconnected ? .secondary : state.statusPresentation.tone.color
    }

    private var gatewayAddressText: String {
        self.appModel.gatewayRemoteAddress?.trimmedNonEmpty
            ?? self.appModel.gatewayServerName?.trimmedNonEmpty
            ?? String(localized: "Unknown")
    }

    private var gatewayAgentCountText: String {
        guard self.gatewayConnected else { return "—" }
        return self.appModel.gatewayAgents.count.formatted()
    }

    private var defaultChatWorkItem: WorkItem {
        let isOpen = self.appModel.chatSessionKey == self.appModel.mainSessionKey
        return WorkItem(
            icon: isOpen ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
            title: self.appModel.activeAgentName,
            detail: self.defaultChatActivityText,
            state: isOpen ? "open" : "default",
            color: isOpen ? OpenClawBrand.accent : OpenClawBrand.ok,
            isUnread: self.effectiveDefaultChatSessionEntry?.unread == true,
            isPinned: self.effectiveDefaultChatSessionEntry?.pinned == true,
            sessionColor: self.effectiveDefaultChatSessionEntry?.color)
    }

    private var defaultChatActivityText: String {
        let activityAt = self.effectiveDefaultChatSessionEntry?.lastActivityAt ??
            self.effectiveDefaultChatSessionEntry?.updatedAt
        guard let activityAt, activityAt > 0 else {
            return String(localized: "No recent activity")
        }
        return Self.relativeTimeText(forMilliseconds: activityAt)
    }

    private var recentSessionPreviewSessions: [OpenClawChatSessionEntry] {
        CommandSessionGrouping.previewSelection(
            self.effectiveRecentChatSessions,
            currentKey: self.appModel.chatSessionKey)
    }

    private var hasMoreRecentSessions: Bool {
        self.effectiveRecentChatSessions.count > self.recentSessionPreviewSessions.count
    }

    private var sessionCategories: [String] {
        CommandSessionGrouping.categories(
            from: self.effectiveRecentChatSessions,
            knownGroups: self.appModel.sessionGroups.names(for: self.effectiveRecentChatSessions))
    }

    private var effectiveDefaultChatSessionEntry: OpenClawChatSessionEntry? {
        let sessions = self.dashboardModel.sessions
        let mainKey = ChatSessionSidebarModel.selectedSessionKey(
            sessions: sessions,
            currentSessionKey: "main",
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
        return sessions.first { $0.key == mainKey }
    }

    private var effectiveRecentChatSessions: [OpenClawChatSessionEntry] {
        self.dashboardModel.sessions.filter {
            SessionStatusScope.active.includes($0, at: self.dashboardModel.now) &&
                Self.isRecentChatSession($0.key, defaultSessionKey: self.appModel.mainSessionKey)
        }
    }

    private var sessionControlsAvailable: Bool {
        !self.appModel.isLocalChatFixtureEnabled && self.appModel.isOperatorGatewayConnected
    }

    private func openSessionKey(_ key: String?) {
        self.appModel.openChat(sessionKey: key)
        self.openChat()
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(
                    parentKey: session.key,
                    fromLastCompleted: session.hasActiveRun == true)
                await self.dashboardModel.refreshSessions(appModel: self.appModel)
                self.openSessionKey(key)
            } catch {
                self.dashboardModel.reportSessionError(error)
            }
        }
    }

    private func performSessionMutation(
        resetActiveSessionKey: String? = nil,
        _ operation: @escaping (any OpenClawChatTransport) async throws -> Void)
    {
        Task {
            do {
                try await operation(self.appModel.makeChatTransport())
                if resetActiveSessionKey == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.dashboardModel.refreshSessions(appModel: self.appModel)
            } catch {
                self.dashboardModel.reportSessionError(error)
            }
        }
    }

    static func sessionWorkItem(
        for session: OpenClawChatSessionEntry,
        currentSessionKey: String,
        now: Date = .now) -> WorkItem
    {
        let isCurrent = session.key == currentSessionKey
        return WorkItem(
            icon: isCurrent ? "bubble.left.and.text.bubble.right.fill" : "bubble.left.fill",
            title: Self.sessionTitle(session),
            detail: Self.sessionDetail(session, now: now),
            state: isCurrent ? "open" : "recent",
            color: isCurrent ? OpenClawBrand.accent : OpenClawBrand.ok,
            isUnread: session.unread == true,
            isPinned: session.pinned == true,
            sessionColor: session.color)
    }

    static func sessionTitle(_ session: OpenClawChatSessionEntry) -> String {
        if let label = session.label?.trimmedNonEmpty {
            return label
        }
        if let displayName = session.displayName?.trimmedNonEmpty {
            return Self.redactedSessionTitle(for: displayName) ?? displayName
        }
        if let autoLabel = session.autoLabel?.trimmedNonEmpty {
            return autoLabel
        }
        if let subject = session.subject?.trimmedNonEmpty {
            return Self.redactedSessionTitle(for: subject) ?? subject
        }
        // Generic key placeholders only after real topic names are absent.
        return self.redactedSessionTitle(for: session.key) ?? session.key
    }

    fileprivate static func redactedSessionTitle(for key: String) -> String? {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let lowercased = trimmed.lowercased()
        guard !trimmed.isEmpty else { return nil }
        if lowercased.contains(":ios-") {
            return String(localized: "iOS chat")
        }
        if lowercased.hasPrefix("telegram:") {
            return String(localized: "Telegram chat")
        }
        if lowercased.hasPrefix("user:+") {
            return String(localized: "Direct chat")
        }
        if lowercased.hasPrefix("cron:") {
            return Self.humanizedSessionKey(String(trimmed.dropFirst("cron:".count)))
        }
        return nil
    }

    fileprivate static func humanizedSessionKey(_ key: String) -> String? {
        let words = key
            .replacingOccurrences(of: "_", with: "-")
            .split(separator: "-")
        guard !words.isEmpty else { return nil }

        return words
            .map { word in
                switch word.lowercased() {
                case "ai", "api", "ios", "qmd", "url":
                    word.uppercased()
                default:
                    word.prefix(1).uppercased() + String(word.dropFirst())
                }
            }
            .joined(separator: " ")
    }

    static func sessionDetail(_ session: OpenClawChatSessionEntry, now: Date = .now) -> String {
        if session.archived != true, session.isSnoozed(at: now), let milliseconds = session.snoozedUntil {
            let wake = OpenClawChatSessionSnooze.wakeDescription(
                Date(timeIntervalSince1970: milliseconds / 1000), now: now)
            return String(format: String(localized: "Wakes %@"), wake)
        }
        let activityAt = session.lastActivityAt ?? session.updatedAt
        if let activityAt, activityAt > 0 {
            return self.relativeTimeText(forMilliseconds: activityAt, relativeTo: now)
        }
        return session.key
    }

    static func relativeTimeText(
        forMilliseconds milliseconds: Double,
        relativeTo now: Date = .now) -> String
    {
        let date = Date(timeIntervalSince1970: milliseconds / 1000)
        guard now.timeIntervalSince(date) >= 60 else {
            return String(localized: "just now")
        }
        let formatter = RelativeDateTimeFormatter()
        formatter.dateTimeStyle = .numeric
        formatter.unitsStyle = .short
        return formatter.localizedString(for: date, relativeTo: now)
    }

    /// All Sessions includes the resolved main row; Overview still keeps it separate.
    /// Keep the configured base when an incomplete roster cannot resolve main.
    nonisolated static func isListedChatSession(
        _ key: String,
        mainSessionKey: String,
        defaultSessionKey: String) -> Bool
    {
        key.caseInsensitiveCompare(mainSessionKey) == .orderedSame ||
            self.isRecentChatSession(key, defaultSessionKey: defaultSessionKey)
    }

    nonisolated static func isRecentChatSession(_ key: String, defaultSessionKey: String) -> Bool {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return false }
        if trimmed == defaultSessionKey { return false }
        let normalized = trimmed.lowercased()
        let defaultBase = self.sessionBaseKey(defaultSessionKey)
        if !normalized.contains(":"),
           self.isDirectSessionBase(normalized, defaultBase: defaultBase)
        {
            return false
        }
        if ChatSessionSidebarModel.isHiddenInternalSession(trimmed) { return false }
        return !self.isAgentDeviceSession(trimmed, defaultSessionKey: defaultSessionKey)
    }

    private nonisolated static func isAgentDeviceSession(_ key: String, defaultSessionKey: String) -> Bool {
        let parts = key
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else { return false }
        guard parts.count == 3 || parts[3].lowercased() == "thread" else { return false }

        let base = String(parts[2]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let defaultKey = self.sessionBaseKey(defaultSessionKey)
        return self.isDirectSessionBase(base, defaultBase: defaultKey)
    }

    private nonisolated static func isDirectSessionBase(_ base: String, defaultBase: String) -> Bool {
        base == defaultBase || base == "main" || base == "global" || base.hasPrefix("node-")
    }

    private nonisolated static func sessionBaseKey(_ key: String) -> String {
        let parts = key
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .split(separator: ":", omittingEmptySubsequences: false)
        guard parts.count >= 3, parts[0].lowercased() == "agent" else {
            return key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        return String(parts[2]).trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }

    private var gatewaySubtitle: String {
        if let server = appModel.gatewayServerName?.trimmedNonEmpty {
            return String(
                format: String(localized: "%@ on %@"),
                self.appModel.activeAgentName,
                server)
        }
        if let address = appModel.gatewayRemoteAddress?.trimmedNonEmpty {
            return String(
                format: String(localized: "%@ via %@"),
                self.appModel.activeAgentName,
                address)
        }
        return self.appModel.gatewayDisplayStatusText
    }
}

enum SessionStatusScope: String, CaseIterable {
    case active
    case snoozed
    case automations
    case archived

    static func available(isConnected: Bool) -> [Self] {
        isConnected ? self.allCases : [.active, .snoozed, .automations]
    }

    var title: String {
        switch self {
        case .active: String(localized: "Active")
        case .snoozed: String(localized: "Snoozed")
        case .automations: String(localized: "Automations")
        case .archived: String(localized: "Archived")
        }
    }

    func includes(
        _ session: OpenClawChatSessionEntry,
        at now: Date,
        currentSessionKey: String? = nil) -> Bool
    {
        switch self {
        case .active:
            session.archived != true && !session.isSnoozed(at: now) &&
                (session.key == currentSessionKey || !OpenClawChatSessionListVisibility.isAutomationSession(session))
        case .snoozed: session.archived != true && session.isSnoozed(at: now)
        case .automations:
            session.archived != true && OpenClawChatSessionListVisibility.isAutomationSession(session)
        case .archived: session.archived == true
        }
    }
}

struct CommandSessionsScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.dismiss) private var dismiss
    @State private var archivedSessions: [OpenClawChatSessionEntry] = []
    @State private var archivedRosterIsComplete = false
    @State private var activityFilter: CommandSessionActivityFilter = .all
    @State private var presentedAttention: OpenClawChatAttentionPresentation?
    @State private var isLoading = false
    @State private var loadErrorText: String?
    @State private var actionErrorText: String?
    /// Notice for a partially loaded roster; rendered alongside the retained rows, never instead of them.
    @State private var partialLoadText: String?
    /// Bumped by the partial-load retry button; part of `refreshID` so `.task(id:)` refetches.
    @State private var refreshNonce = 0
    @State private var statusScope: SessionStatusScope = .active
    @State private var now: Date = .now
    let dashboardModel: RootSidebarModel
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let openChat: () -> Void

    private var sessions: [OpenClawChatSessionEntry] {
        self.statusScope == .archived ? self.archivedSessions : self.dashboardModel.sessions
    }

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    self.header
                    self.sessionsPanel
                }
                .padding(.top, 16)
                .padding(.bottom, 18)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: self.refreshID) {
            await self.refreshSessions()
        }
        .onChange(of: self.availableStatusScopes, initial: true) { _, scopes in
            if !scopes.contains(self.statusScope) {
                self.statusScope = .active
            }
        }
        .onChange(of: self.appModel.isOperatorGatewayConnected) { _, connected in
            if !connected { self.activityFilter = .all }
        }
        .onChange(of: self.appModel.chatViewModelIdentityID) { _, _ in
            self.presentedAttention = nil
            self.activityFilter = .all
        }
        .onChange(of: self.sessions) { _, _ in
            // Roster changes can age the displayed timestamps without changing any expiry deadline.
            self.now = .now
        }
        .task(id: self.expiryDeadlines) {
            self.now = .now
            while let wake = self.expiryDeadlines.filter({ $0 > self.now }).min() {
                do {
                    try await Task.sleep(for: .seconds(max(0, wake.timeIntervalSinceNow) + 0.001))
                    try Task.checkCancellation()
                } catch {
                    return
                }
                self.now = .now
            }
        }
    }

    private var header: some View {
        OpenClawAdaptiveHeaderRow(
            title: "Sessions",
            subtitle: .verbatim(self.headerDetail),
            titleFont: OpenClawType.title2,
            subtitleFont: OpenClawType.captionMedium)
        {
            if let headerSidebarAction {
                OpenClawSidebarControlButton(action: headerSidebarAction)
            }
        } accessory: {
            EmptyView()
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var sessionsPanel: some View {
        let mainKey = self.resolvedMainSessionKey
        let currentKey = self.resolvedCurrentSessionKey
        let snapshot = self.activitySnapshot
        let visible = snapshot.sessions(matching: self.activityFilter)
        let sections = CommandSessionGrouping.sections(
            from: visible,
            knownGroups: self.appModel.sessionGroups.names(for: self.sessions),
            preservesGroupOrder: true)
        let visibleSections = self.activityFilter == .all ? sections : sections.filter { !$0.entries.isEmpty }
        return ProCard(padding: 0) {
            VStack(spacing: 0) {
                HStack(spacing: 8) {
                    Text(verbatim: self.panelTitle)
                        .font(OpenClawType.subheadBold)
                    Spacer(minLength: 8)
                    if self.isLoading {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .padding(.horizontal, 12)
                .padding(.top, 10)
                .padding(.bottom, 3)

                if self.appModel.isCommandSessionListAvailable || !self.sessions.isEmpty {
                    Picker(selection: self.$statusScope) {
                        ForEach(self.availableStatusScopes, id: \.self) { scope in
                            Text(verbatim: scope.title)
                                .font(OpenClawType.captionMedium)
                                .tag(scope)
                                .accessibilityLabel(scope == .archived
                                    ? String(localized: "Show Archived") : scope.title)
                                .accessibilityIdentifier("Sessions.Status.\(scope.rawValue)")
                        }
                    } label: {
                        Text("Session status")
                            .font(OpenClawType.captionMedium)
                    }
                    .pickerStyle(.segmented)
                    .accessibilityIdentifier("Sessions.StatusScope")
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                }

                CommandSessionActivityFilterBar(selection: self.$activityFilter, snapshot: snapshot)
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)

                if !snapshot.isConnected {
                    Text("Connect to filter current activity.")
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 12)
                        .padding(.bottom, 8)
                }

                if let groupError = self.appModel.sessionGroups.failure {
                    Text(verbatim: groupError).font(OpenClawType.captionMedium).foregroundStyle(OpenClawBrand.warn)
                }
                if let actionErrorText {
                    Text(verbatim: actionErrorText)
                        .font(OpenClawType.captionMedium)
                        .foregroundStyle(OpenClawBrand.warn)
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 8)
                }

                if let partialLoadText {
                    HStack(spacing: 8) {
                        Image(systemName: "exclamationmark.triangle.fill")
                            .font(OpenClawType.captionBold)
                            .foregroundStyle(OpenClawBrand.warn)
                        // Identified for UI tests: the leading sidebar shows the same copy
                        // without an identifier, so the banner notice carries its own. A
                        // container identifier here would clobber the Refresh button's.
                        Text(verbatim: partialLoadText)
                            .font(OpenClawType.captionMedium)
                            .foregroundStyle(OpenClawBrand.warn)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityIdentifier("Sessions.PartialLoad.Notice")
                        Button {
                            self.refreshNonce += 1
                        } label: {
                            Text(String(localized: "Refresh"))
                                .font(OpenClawType.subheadSemiBold)
                        }
                        .buttonStyle(.borderless)
                        .accessibilityIdentifier("Sessions.PartialLoad.Refresh")
                    }
                    .padding(.horizontal, 12)
                    .padding(.bottom, 8)
                }

                if let loadErrorText {
                    CommandEmptyStateRow(
                        icon: "exclamationmark.triangle.fill",
                        title: "Sessions unavailable",
                        detail: .verbatim(loadErrorText))
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                } else if visible.isEmpty, visibleSections.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.appModel
                            .isCommandSessionListAvailable ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: .verbatim(self.emptyTitle),
                        detail: .verbatim(self.appModel
                            .isCommandSessionListAvailable
                            ? self.emptyDetail
                            : String(localized: "Connect to the gateway.")))
                        .padding(.horizontal, 10)
                        .padding(.bottom, 10)
                } else {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(visibleSections) { section in
                            VStack(alignment: .leading, spacing: 6) {
                                if section.showsHeader {
                                    self.sectionHeader(section)
                                }
                                if !self.isCollapsed(section) {
                                    ForEach(section.entries) { session in
                                        self.sessionRow(
                                            session,
                                            currentSessionKey: currentKey,
                                            mainSessionKey: mainKey,
                                            attention: snapshot.attention(for: session))
                                    }
                                }
                            }
                        }
                    }
                    .padding(.horizontal, 10)
                    .padding(.bottom, 10)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var headerDetail: String {
        if self.isLoading, self.sessions.isEmpty {
            switch self.statusScope {
            case .active: return String(localized: "Loading recent sessions")
            case .snoozed: return String(localized: "Loading snoozed sessions")
            case .automations: return String(localized: "Loading automation sessions")
            case .archived: return String(localized: "Loading archived sessions")
            }
        }
        let count = self.activitySnapshot.sessions(matching: self.activityFilter).count
        if count == 0 {
            return self.emptyTitle
        }
        return String(
            AttributedString(localized: "^[\(count) session](inflect: true)").characters)
    }

    private var scopedSessions: [OpenClawChatSessionEntry] {
        let mainKey = self.resolvedMainSessionKey
        let currentKey = self.resolvedCurrentSessionKey
        return self.sessions
            .filter { CommandCenterTab.isListedChatSession(
                $0.key,
                mainSessionKey: mainKey,
                defaultSessionKey: self.appModel.mainSessionKey) }
            // A stale list must still obey the selected scope while its replacement loads.
            .filter {
                self.statusScope.includes(
                    $0,
                    at: self.now,
                    currentSessionKey: currentKey)
            }
    }

    private var resolvedMainSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.sessions,
            currentSessionKey: self.appModel.mainSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var resolvedCurrentSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.sessions,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var attentionRequests: [OpenClawChatAttentionRequest] {
        let questions = self.appModel.chatPresentation.isCurrent(appModel: self.appModel)
            ? self.appModel.chatPresentation.viewModel?.pendingQuestionAttentionRequests ?? [] : []
        return questions + self.appModel.pendingApprovalAttentionRequests
    }

    private var expiryDeadlines: [Date] {
        self.attentionRequests.map { Date(timeIntervalSince1970: $0.expiresAtMs / 1000) }
            + self.sessions.compactMap { session in
                OpenClawChatSessionSnooze.nextWake(in: [session], now: self.now)
            }
    }

    private var activitySnapshot: CommandSessionActivitySnapshot {
        CommandSessionActivitySnapshot(
            sessions: self.scopedSessions,
            requests: self.attentionRequests,
            mainSessionKey: self.resolvedMainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract,
            isConnected: self.appModel.isCommandSessionListAvailable,
            isComplete: self.statusScope == .archived
                ? self.archivedRosterIsComplete : self.dashboardModel.isSessionRosterComplete,
            now: self.now)
    }

    private var sessionCategories: [String] {
        self.appModel.sessionGroups.names(for: self.sessions)
    }

    private var sessionControlsAvailable: Bool {
        !self.appModel.isLocalChatFixtureEnabled && self.appModel.isOperatorGatewayConnected
    }

    private var availableStatusScopes: [SessionStatusScope] {
        SessionStatusScope.available(isConnected: self.appModel.isOperatorGatewayConnected)
    }

    private var emptyTitle: String {
        guard self.appModel.isCommandSessionListAvailable else {
            return String(localized: "Gateway offline")
        }
        switch self.activityFilter {
        case .needsYou: return String(localized: "No sessions need you")
        case .working: return String(localized: "No sessions working")
        case .all: break
        }
        switch self.statusScope {
        case .active: return String(localized: "No recent sessions")
        case .snoozed: return String(localized: "No snoozed sessions")
        case .automations: return String(localized: "No automations")
        case .archived: return String(localized: "No archived sessions")
        }
    }

    private var emptyDetail: String {
        switch self.activityFilter {
        case .needsYou: return String(localized: "Pending questions or approvals appear here.")
        case .working: return String(localized: "Active or queued work appears here.")
        case .all: break
        }
        return switch self.statusScope {
        case .active: String(localized: "Start a chat and it will appear here.")
        case .snoozed: String(localized: "Snoozed sessions will appear here until they wake.")
        case .automations: String(localized: "Automation sessions will appear here.")
        case .archived: String(localized: "Archived sessions will appear here.")
        }
    }

    private var panelTitle: String {
        switch self.statusScope {
        case .active: String(localized: "Recent sessions")
        case .snoozed: String(localized: "Snoozed sessions")
        case .automations: String(localized: "Automation sessions")
        case .archived: String(localized: "Archived sessions")
        }
    }

    private var refreshID: String {
        "\(self.appModel.chatViewModelIdentityID):\(self.statusScope.rawValue):\(self.refreshNonce)"
    }

    @ViewBuilder
    private func sectionHeader(_ section: CommandSessionSection) -> some View {
        if case let .category(group) = section.id {
            CommandSessionGroupHeader(
                name: group,
                sessions: self.sessions,
                refresh: self.refreshSessions,
                openSession: self.openSessionKey,
                accessory: { EmptyView() })
                .foregroundStyle(.secondary)
        } else {
            Text(section.title).font(OpenClawType.captionSemiBold)
                .foregroundStyle(.secondary).padding(.horizontal, 4)
        }
    }

    private func isCollapsed(_ section: CommandSessionSection) -> Bool {
        guard case let .category(name) = section.id else { return false }
        return self.appModel.sessionGroups.collapsed.contains(name)
    }

    private func sessionRow(
        _ session: OpenClawChatSessionEntry,
        currentSessionKey: String,
        mainSessionKey: String,
        attention: OpenClawChatAttentionSummary?) -> some View
    {
        let item = CommandCenterTab.sessionWorkItem(
            for: session,
            currentSessionKey: currentSessionKey,
            now: self.now)
        return HStack(spacing: 8) {
            Button {
                self.openSessionKey(session.key)
            } label: {
                CommandSessionRow(item: item)
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("SessionDashboard.Session.\(session.key)")
            if let summary = attention {
                OpenClawChatAttentionBadge(
                    summary: summary,
                    targetID: "session:\(session.key)",
                    presentation: self.$presentedAttention)
            }
        }
        .commandSessionActions(
            session: session,
            mainSessionKey: mainSessionKey,
            categories: self.sessionCategories,
            isArchived: session.archived == true,
            isEnabled: self.sessionControlsAvailable,
            canArchive: ChatSessionSidebarModel.canArchiveSession(
                session,
                mainSessionKey: mainSessionKey),
            canDelete: ChatSessionSidebarModel.canDeleteSession(key: session.key, mainSessionKey: mainSessionKey),
            archivesSession: { self.statusScope != .archived && session.archived != true },
            performMutation: self.performMutation,
            fork: { self.forkSession(session) })
    }

    private func openSessionKey(_ key: String) {
        self.appModel.openChat(sessionKey: key)
        self.dismiss()
        self.openChat()
    }

    private func forkSession(_ session: OpenClawChatSessionEntry) {
        Task {
            do {
                let key = try await self.appModel.makeChatTransport().forkSession(
                    parentKey: session.key,
                    fromLastCompleted: session.hasActiveRun == true)
                await self.refreshSessions()
                self.openSessionKey(key)
            } catch {
                self.actionErrorText = error.localizedDescription
            }
        }
    }

    private func performMutation(
        resetActiveSessionKey: String? = nil,
        _ operation: @escaping (any OpenClawChatTransport) async throws -> Void)
    {
        Task {
            do {
                try await operation(self.appModel.makeChatTransport())
                if resetActiveSessionKey == self.appModel.chatSessionKey {
                    self.appModel.focusChatSession(nil)
                }
                await self.refreshSessions()
            } catch {
                self.actionErrorText = error.localizedDescription
            }
        }
    }

    private func refreshSessions() async {
        let requestedScope = self.statusScope
        self.isLoading = true
        self.loadErrorText = nil
        self.actionErrorText = nil
        defer {
            if requestedScope == self.statusScope { self.isLoading = false }
        }

        if requestedScope != .archived {
            await self.dashboardModel.refreshSessions(appModel: self.appModel, allowCachedFallback: true)
            guard !Task.isCancelled, requestedScope == self.statusScope else { return }
            self.loadErrorText = self.sessions.isEmpty ? self.dashboardModel.sessionErrorText : nil
            self.partialLoadText = self.sessions.isEmpty ? nil : self.dashboardModel.sessionErrorText
            return
        }

        await self.appModel.sessionGroups.refresh(appModel: self.appModel)
        do {
            let roster = try await self.appModel.loadChatSessionRoster(
                limit: CommandCenterTab.recentSessionsFetchLimit,
                archived: true)
            guard !Task.isCancelled, requestedScope == self.statusScope else { return }
            self.archivedSessions = roster.sessions
            self.archivedRosterIsComplete = roster.isComplete
            self.partialLoadText = roster.incompleteLoadMessage
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, requestedScope == self.statusScope else { return }
            self.partialLoadText = nil
            self.archivedSessions = []
            self.archivedRosterIsComplete = false
            self.loadErrorText = String(localized: "Try again after the gateway reconnects.")
        }
    }
}

extension NodeAppModel {
    fileprivate var isCommandSessionListAvailable: Bool {
        self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected
    }
}
