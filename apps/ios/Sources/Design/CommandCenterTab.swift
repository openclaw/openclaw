import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// Session presentation shared by the sidebar and All Sessions.
enum CommandCenterTab {
    static let recentSessionsFetchLimit = 200

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
        self.sessionTitle(session, includesRoutingFallback: true) ?? session.key
    }

    static func sessionTitle(_ session: OpenClawChatSessionEntry, includesRoutingFallback: Bool) -> String? {
        func titleFrom(_ value: String) -> String? {
            guard let placeholder = Self.redactedSessionTitle(for: value) else { return value }
            return includesRoutingFallback ? placeholder : nil
        }

        // web `resolveSessionDisplayName`: a key copied into a name field is not a name.
        if let label = session.label?.trimmedNonEmpty, label != session.key {
            return label
        }
        if let displayName = session.displayName?.trimmedNonEmpty,
           displayName != session.key,
           let title = titleFrom(displayName)
        {
            return title
        }
        if let autoLabel = session.autoLabel?.trimmedNonEmpty, includesRoutingFallback || autoLabel != session.key {
            return autoLabel
        }
        if let subject = session.subject?.trimmedNonEmpty,
           includesRoutingFallback || subject != session.key,
           let title = titleFrom(subject)
        {
            return title
        }
        // Keep key-based placeholders for lists; an unnamed chat header can show its agent instead.
        return includesRoutingFallback ? Self.redactedSessionTitle(for: session.key) : nil
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

    /// All Sessions includes the resolved main row alongside other visible sessions.
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
    @State private var sessions: [OpenClawChatSessionEntry] = []
    @State private var isLoading = false
    @State private var loadErrorText: String?
    @State private var actionErrorText: String?
    /// Notice for a partially loaded roster; rendered alongside the retained rows, never instead of them.
    @State private var partialLoadText: String?
    /// Bumped by the partial-load retry button; part of `refreshID` so `.task(id:)` refetches.
    @State private var refreshNonce = 0
    @State private var statusScope: SessionStatusScope = .active
    @State private var now: Date = .now
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let openChat: () -> Void

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
        .task(id: self.sessions) {
            self.now = .now
            while let wake = OpenClawChatSessionSnooze.nextWake(in: self.sessions, now: self.now) {
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
                } else if self.visibleSessions.isEmpty, self.sessionSections.isEmpty {
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
                        ForEach(self.sessionSections) { section in
                            VStack(alignment: .leading, spacing: 6) {
                                if section.showsHeader {
                                    self.sectionHeader(section)
                                }
                                if !self.isCollapsed(section) {
                                    ForEach(section.entries) { session in
                                        self.sessionRow(session, currentSessionKey: currentKey, mainSessionKey: mainKey)
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
        let count = self.visibleSessions.count
        if count == 0 {
            return self.emptyTitle
        }
        return String(
            AttributedString(localized: "^[\(count) session](inflect: true)").characters)
    }

    private var visibleSessions: [OpenClawChatSessionEntry] {
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

    private var sessionSections: [CommandSessionSection] {
        CommandSessionGrouping.sections(
            from: self.visibleSessions,
            knownGroups: self.appModel.sessionGroups.names(for: self.sessions),
            preservesGroupOrder: true)
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
        switch self.statusScope {
        case .active: return String(localized: "No recent sessions")
        case .snoozed: return String(localized: "No snoozed sessions")
        case .automations: return String(localized: "No automations")
        case .archived: return String(localized: "No archived sessions")
        }
    }

    private var emptyDetail: String {
        switch self.statusScope {
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
        mainSessionKey: String) -> some View
    {
        let item = CommandCenterTab.sessionWorkItem(
            for: session,
            currentSessionKey: currentSessionKey,
            now: self.now)
        return Button {
            self.openSessionKey(session.key)
        } label: {
            CommandSessionRow(item: item)
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("SessionDashboard.Session.\(session.key)")
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
        // Pick up groups stored by other surfaces (for example the per-session
        // New Group editor) alongside the fresh session list.
        await self.appModel.sessionGroups.refresh(appModel: self.appModel)
        let requestedScope = self.statusScope
        let requestsArchived = requestedScope == .archived
        let sourceGatewayID = self.appModel.chatTranscriptCacheGatewayID
        let sourceAgentID = self.appModel.chatDeliveryAgentId
        self.isLoading = true
        self.loadErrorText = nil
        self.actionErrorText = nil
        defer {
            if requestedScope == self.statusScope { self.isLoading = false }
        }

        do {
            let roster = try await self.appModel.loadChatSessionRoster(
                limit: CommandCenterTab.recentSessionsFetchLimit,
                archived: requestsArchived)
            guard !Task.isCancelled, requestedScope == self.statusScope else { return }
            self.sessions = roster.sessions
            self.partialLoadText = roster.incompleteLoadMessage
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, requestedScope == self.statusScope else { return }
            self.partialLoadText = nil
            let cached = requestsArchived ? [] : await self.appModel.loadCachedChatSessions(
                gatewayID: sourceGatewayID,
                agentID: sourceAgentID)
            guard !Task.isCancelled, requestedScope == self.statusScope else { return }
            self.sessions = cached
            self.loadErrorText = self.sessions.isEmpty ? "Try again after the gateway reconnects." : nil
        }
    }
}

extension NodeAppModel {
    fileprivate var isCommandSessionListAvailable: Bool {
        self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected
    }
}
