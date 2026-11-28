import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// Session lists shared by the sidebar and All Sessions.
enum CommandCenterTab {
    static let recentSessionsFetchLimit = 200

    /// Mirrors the Control UI's `isSubagentSessionKey` (`ui/src/lib/sessions/session-key.ts:446`): a key that
    /// starts with `subagent:`, or whose part after `agent:<id>:` does, parsed as `parseAgentSessionKey` does
    /// (trimmed, lowercased, empty segments folded when present). Subagent sessions are hidden runs: the
    /// Control UI never shows them as rows (`navigation.ts:202`, `app-sidebar-session-tree.ts:142`).
    nonisolated static func isSubagentSessionKey(_ key: String) -> Bool {
        let raw = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if raw.hasPrefix("subagent:") { return true }
        let folded = raw.hasPrefix(":") || raw.hasSuffix(":") || raw.contains("::")
            ? raw.split(separator: ":").joined(separator: ":")
            : raw
        guard folded.hasPrefix("agent:") else { return false }
        let tail = folded.dropFirst("agent:".count)
        guard let colon = tail.firstIndex(of: ":") else { return false }
        let agentID = tail[..<colon].trimmingCharacters(in: .whitespaces)
        let rest = tail[tail.index(after: colon)...]
        guard !agentID.isEmpty, !rest.isEmpty, !rest.hasPrefix(":") else { return false }
        return rest.hasPrefix("subagent:")
    }

    /// Session lists show what a person can open. Hidden subagent runs are never rows; like the Control UI's
    /// tree (`app-sidebar-session-tree.ts:142`, `summarizeChildren`), a running one folds into its nearest
    /// listed ancestor, which then reads as working through `hasActiveSubagentRun`.
    nonisolated static func listedSessions(_ rows: [OpenClawChatSessionEntry]) -> [OpenClawChatSessionEntry] {
        func normalized(_ key: String) -> String {
            key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        }
        let byKey = Dictionary(rows.map { (normalized($0.key), $0) }, uniquingKeysWith: { first, _ in first })
        var listedParent: [String: String] = [:]
        for row in rows {
            for child in row.childSessions ?? [] where listedParent[normalized(child)] == nil {
                listedParent[normalized(child)] = normalized(row.key)
            }
        }
        // `resolveUiSessionNavigationParentKey`: the child's own backref wins over the parent's list.
        func parent(of key: String) -> String? {
            let row = byKey[key]
            return (row?.parentSessionKey?.trimmedNonEmpty ?? row?.spawnedBy?.trimmedNonEmpty)
                .map(normalized) ?? listedParent[key]
        }
        var workingAncestors = Set<String>()
        for row in rows where self.isSubagentSessionKey(row.key) &&
            (row.hasActiveRun == true || row.hasActiveSubagentRun == true)
        {
            var cursor = parent(of: normalized(row.key))
            var seen = Set<String>()
            while let key = cursor, seen.insert(key).inserted {
                if !self.isSubagentSessionKey(key) {
                    workingAncestors.insert(key)
                    break
                }
                cursor = parent(of: key)
            }
        }
        return rows.compactMap { row in
            guard !self.isSubagentSessionKey(row.key) else { return nil }
            guard workingAncestors.contains(normalized(row.key)), row.hasActiveSubagentRun != true else { return row }
            var folded = row
            folded.hasActiveSubagentRun = true
            return folded
        }
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
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    /// Live roster owner: the sidebar model keeps the active list current from session events.
    let sidebarModel: RootSidebarModel
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let openChat: () -> Void

    /// Archived rows are not in the live roster; this screen reads them when that filter is on.
    @State private var archived: [OpenClawChatSessionEntry] = []
    @State private var isLoadingArchived = false
    @State private var archiveLoadFailed = false
    /// Notice for a partially loaded archive; rendered alongside the retained rows, never instead of them.
    @State private var actionErrorText: String?
    @State private var partialLoadText: String?
    /// Bumped by the partial-load retry button; part of `refreshID` so `.task(id:)` refetches.
    @State private var refreshNonce = 0
    @State private var statusScope: SessionStatusScope = .active
    @State private var now: Date = .now
    @State private var scrollAnchor = RootSidebarScrollAnchor()
    /// Where each row stood when a finger landed on the list; moves wait until it lifts.
    @State private var heldPlacement: [String: SessionListSection.ID]?
    @AppStorage(SessionListGroup.needsYou.collapsedStorageKey) private var needsYouCollapsed = false
    @AppStorage(SessionListGroup.working.collapsedStorageKey) private var workingCollapsed = false
    @AppStorage(SessionListGroup.pinned.collapsedStorageKey) private var pinnedCollapsed = false
    @AppStorage(SessionListGroup.recent.collapsedStorageKey) private var recentCollapsed = false
    /// From the center of a title's first line to its baseline, so the icon and the trailing mark sit on
    /// that line whether the title wraps or a state line follows.
    @ScaledMetric(relativeTo: .body) private var firstLineCenterToBaseline: CGFloat = 6

    var body: some View {
        let sections = self.sections
        ScrollView {
            // A plain stack, like the card it replaces: rows move between groups live, and a lazy stack
            // drew group headers over the wrong rows when groups came and went.
            VStack(alignment: .leading, spacing: 0) {
                self.notices
                if self.loadFailed {
                    self.loadFailure
                } else if self.isLoading, self.visibleSessions.isEmpty {
                    ProgressView()
                        .frame(maxWidth: .infinity, minHeight: 88)
                } else if sections.isEmpty {
                    CommandEmptyStateRow(
                        icon: self.appModel
                            .isCommandSessionListAvailable ? "bubble.left.and.text.bubble.right.fill" : "wifi.slash",
                        title: .verbatim(self.emptyTitle),
                        detail: .verbatim(self.appModel
                            .isCommandSessionListAvailable
                            ? self.emptyDetail
                            : String(localized: "Connect to OpenClaw.")))
                } else {
                    ForEach(sections) { section in
                        self.sectionView(section)
                    }
                }
            }
            .padding(.horizontal, 10)
            .padding(.bottom, 8)
            .modifier(RootSidebarAnchoredContent(anchor: self.scrollAnchor))
        }
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        // Rows change group live, but never under a finger: the scroll view's own touch state decides,
        // since SwiftUI also reports scroll phases for offset changes nobody made.
        .onScrollPhaseChange { _, _ in
            self.updateHeldPlacement(sections)
        }
        .onChange(of: self.visibleSessions) { _, _ in
            self.updateHeldPlacement(sections)
        }
        .safeAreaBar(edge: .top, spacing: 0) {
            self.topBar
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            self.bottomBar
        }
        .background(OpenClawProBackground())
        .navigationTitle("Sessions")
        .navigationBarTitleDisplayMode(.inline)
        .toolbar(.hidden, for: .navigationBar)
        .task(id: self.refreshID) {
            await self.appModel.sessionGroups.refresh(appModel: self.appModel)
            if self.statusScope == .archived {
                await self.loadArchived()
            }
        }
        .onChange(of: self.availableStatusScopes, initial: true) { _, scopes in
            if !scopes.contains(self.statusScope) {
                self.statusScope = .active
            }
        }
        .task(id: self.visibleSessions) {
            self.now = .now
            while let wake = OpenClawChatSessionSnooze.nextWake(in: self.visibleSessions, now: self.now) {
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

    // MARK: Bars

    private var topBar: some View {
        HStack(spacing: 8) {
            if let action = self.sidebarAction {
                OpenClawSidebarControlButton(action: action)
            }
            Spacer(minLength: 8)
            self.filterMenu
        }
        .overlay {
            Text(verbatim: self.title)
                .font(OpenClawType.headline)
                .lineLimit(1)
                .padding(.horizontal, 64)
                .accessibilityAddTraits(.isHeader)
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
        .padding(.vertical, 6)
    }

    /// The header's approval dot, minus the approvals the Needs you section already lists.
    private var sidebarAction: OpenClawSidebarHeaderAction? {
        guard var action = self.headerSidebarAction,
              action.hasApprovalAttention else { return self.headerSidebarAction }
        action.hasApprovalAttention = SessionListGrouping.hasApprovalOutsideNeedsYou(
            self.appModel.pendingApprovalAttentionRequests,
            sections: self.sections,
            targets: self.approval(_:targets:))
        return action
    }

    /// Only what the list really filters by today: the status scopes, in their own words.
    private var filterMenu: some View {
        let isFiltered = self.statusScope != .active
        return Menu {
            Picker(selection: self.$statusScope) {
                ForEach(self.availableStatusScopes, id: \.self) { scope in
                    Text(verbatim: scope.title)
                        .font(OpenClawType.body)
                        .tag(scope)
                }
            } label: {
                Text("Filter sessions")
                    .font(OpenClawType.captionMedium)
            }
            .pickerStyle(.inline)
        } label: {
            Image(systemName: "line.3.horizontal.decrease")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(isFiltered ? OpenClawBrand.canvas : OpenClawBrand.textStrong)
                .frame(width: 44, height: 44)
                .background(isFiltered ? OpenClawBrand.textStrong : Color.clear, in: Circle())
                .contentShape(Circle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
        .accessibilityLabel(String(localized: "Filter sessions"))
        .accessibilityValue(Text(verbatim: self.statusScope.title))
        .accessibilityIdentifier("Sessions.StatusScope")
    }

    private var bottomBar: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                Spacer(minLength: 8)

                Button {
                    self.appModel.requestNewChat()
                    self.openChat()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: "plus")
                            .font(.system(size: 16, weight: .medium))
                            .accessibilityHidden(true)
                        Text(String(localized: "New Chat"))
                            .font(OpenClawType.subheadSemiBold)
                            .lineLimit(1)
                    }
                    .foregroundStyle(OpenClawBrand.textStrong)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 48)
                    .contentShape(Capsule())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: Capsule())
                .disabled(!self.appModel.isOperatorGatewayConnected)
                .accessibilityIdentifier("Sessions.NewChat")
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }

    // MARK: List

    @ViewBuilder
    private var notices: some View {
        if let groupError = self.appModel.sessionGroups.failure {
            self.noticeText(groupError)
        }
        if let partial = self.partialNoticeText {
            HStack(spacing: 8) {
                Image(systemName: "exclamationmark.triangle.fill")
                    .font(OpenClawType.captionBold)
                    .foregroundStyle(OpenClawBrand.warn)
                // Identified for UI tests: the leading sidebar shows the same copy without an identifier.
                Text(verbatim: partial)
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(OpenClawBrand.warn)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .accessibilityIdentifier("Sessions.PartialLoad.Notice")
                Button(action: self.retry) {
                    Text(String(localized: "Try again"))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(OpenClawBrand.textStrong)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityIdentifier("Sessions.PartialLoad.Refresh")
            }
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
        }
    }

    private func noticeText(_ text: String) -> some View {
        Text(verbatim: text)
            .font(OpenClawType.captionMedium)
            .foregroundStyle(OpenClawBrand.warn)
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
    }

    @ViewBuilder
    private func sectionView(_ section: SessionListSection) -> some View {
        switch section.id {
        case let .group(group):
            let collapsed = self.collapsedBinding(group)
            Section {
                if !collapsed.wrappedValue {
                    ForEach(section.sessions) { session in
                        self.sessionRow(session)
                    }
                }
            } header: {
                SessionSectionHeader(
                    title: group.title,
                    isCollapsed: collapsed,
                    id: "Sessions.Group.\(group.rawValue)")
                    .padding(.top, 8)
            }
        case let .category(name):
            Section {
                if !self.appModel.sessionGroups.collapsed.contains(name) {
                    ForEach(section.sessions) { session in
                        self.sessionRow(session)
                    }
                }
            } header: {
                CommandSessionGroupHeader(
                    name: name,
                    sessions: self.sourceSessions,
                    refresh: self.refreshSessions,
                    openSession: self.openSessionKey,
                    accessory: { EmptyView() })
                    .padding(.top, 8)
            }
        }
    }

    private func sessionRow(_ session: OpenClawChatSessionEntry) -> some View {
        let stateLine = SessionListGrouping.stateLine(session, approval: self.approval(for: session))
        let title = SessionPresentation.title(session)
        let mark = SessionRowActivityMark(session: session)
        let isUnread = session.unread == true
        let mainSessionKey = self.resolvedMainSessionKey
        return Button {
            self.openSessionKey(session.key)
        } label: {
            HStack(alignment: .firstTextBaseline, spacing: 10) {
                RootSidebarIcon.listMark(systemName: RootSidebarIcon.sessionSymbol)
                    .alignmentGuide(.firstTextBaseline) {
                        $0[VerticalAlignment.center] + self.firstLineCenterToBaseline
                    }
                VStack(alignment: .leading, spacing: 1) {
                    Text(verbatim: title)
                        .font(mark == .unread ? OpenClawType.headline : OpenClawType.body)
                        .foregroundStyle(OpenClawBrand.textStrong)
                        // At accessibility sizes one line would leave a word or two of either.
                        .lineLimit(stateLine == nil || self.dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                    if let stateLine {
                        Text(Self.stateLineText(stateLine))
                            .lineLimit(self.dynamicTypeSize.isAccessibilitySize ? 2 : 1)
                            .truncationMode(.tail)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                SessionRowActivityIndicator(mark: mark)
                    .alignmentGuide(.firstTextBaseline) {
                        $0[VerticalAlignment.center] + self.firstLineCenterToBaseline
                    }
            }
            .padding(.vertical, 6)
            .frame(minHeight: 44)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: session.color)
        }
        .accessibilityLabel(Text(verbatim: ([title] + (stateLine.map(Self.spokenStateLine) ?? []))
                .joined(separator: ", ")))
        .accessibilityIdentifier("SessionDashboard.Session.\(session.key)")
        // The label already reads the approval and "Subagents working" from the state line.
        .accessibilityValue(RootSidebar.sessionAccessibilityValue(
            isPinned: session.pinned == true,
            isUnread: isUnread,
            isWorking: mark == .working && stateLine != .subagentsWorking))
        .commandSessionActions(
            session: session,
            mainSessionKey: mainSessionKey,
            categories: self.sessionCategories,
            isArchived: session.archived == true,
            isEnabled: self.sessionControlsAvailable,
            canArchive: ChatSessionSidebarModel.canArchiveSession(session, mainSessionKey: mainSessionKey),
            canDelete: ChatSessionSidebarModel.canDeleteSession(key: session.key, mainSessionKey: mainSessionKey),
            archivesSession: { self.statusScope != .archived && session.archived != true },
            performMutation: self.performMutation,
            fork: { self.forkSession(session) })
        .modifier(RootSidebarAnchoredRow(id: session.key, anchor: self.scrollAnchor))
    }

    /// One footnote line: the state in its color, then " · " and the detail, truncated at the tail.
    private static func stateLineText(_ line: SessionRowStateLine) -> AttributedString {
        func run(_ text: String, _ font: Font, _ color: Color) -> AttributedString {
            var run = AttributedString(text)
            run.font = font
            run.foregroundColor = color
            return run
        }
        // When large text wraps the line, the state and its dot stay whole and the detail starts the next.
        func label(_ text: String, _ font: Font, _ color: Color) -> AttributedString {
            run(text.replacingOccurrences(of: " ", with: "\u{00A0}"), font, color)
        }
        let state: AttributedString
        let detail: AttributedString?
        switch line {
        case let .needsApproval(command):
            state = label(String(localized: "Needs approval"), OpenClawType.footnoteMedium, OpenClawBrand.warn)
            detail = command.map { run($0, OpenClawType.monoFootnote, OpenClawBrand.text) }
        case let .failed(reason):
            state = label(String(localized: "Failed"), OpenClawType.footnoteMedium, OpenClawBrand.danger)
            detail = reason.map { run($0, OpenClawType.footnote, OpenClawBrand.textSecondary) }
        case .subagentsWorking:
            state = label(String(localized: "Subagents working"), OpenClawType.footnote, OpenClawBrand.textSecondary)
            detail = nil
        }
        guard let detail else { return state }
        return state + run("\u{00A0}· ", OpenClawType.footnote, OpenClawBrand.textSecondary) + detail
    }

    private static func spokenStateLine(_ line: SessionRowStateLine) -> [String] {
        switch line {
        case let .needsApproval(command): [String(localized: "Needs approval")] + (command.map { [$0] } ?? [])
        case let .failed(reason): [String(localized: "Failed")] + (reason.map { [$0] } ?? [])
        case .subagentsWorking: [String(localized: "Subagents working")]
        }
    }

    // MARK: Data

    private var sourceSessions: [OpenClawChatSessionEntry] {
        self.statusScope == .archived ? self.archived : self.sidebarModel.sessions
    }

    private var visibleSessions: [OpenClawChatSessionEntry] {
        let mainKey = self.resolvedMainSessionKey
        let currentKey = self.resolvedCurrentSessionKey
        return self.sourceSessions
            .filter { CommandCenterTab.isListedChatSession(
                $0.key,
                mainSessionKey: mainKey,
                defaultSessionKey: self.appModel.mainSessionKey) }
            .filter { self.statusScope.includes($0, at: self.now, currentSessionKey: currentKey) }
    }

    private var sections: [SessionListSection] {
        SessionListGrouping.sections(
            self.visibleSessions,
            knownCategories: self.sessionCategories,
            needsApproval: { self.approval(for: $0) != nil },
            held: self.heldPlacement,
            personalPins: self.appModel.displayedSidebarPins)
    }

    private func updateHeldPlacement(_ shown: [SessionListSection]) {
        if self.scrollAnchor.isScrolling {
            if self.heldPlacement == nil {
                self.heldPlacement = Self.placements(shown)
            }
        } else {
            self.heldPlacement = nil
        }
    }

    static func placements(_ sections: [SessionListSection]) -> [String: SessionListSection.ID] {
        var placement: [String: SessionListSection.ID] = [:]
        for section in sections {
            for session in section.sessions {
                placement[session.key] = section.id
            }
        }
        return placement
    }

    private func collapsedBinding(_ group: SessionListGroup) -> Binding<Bool> {
        switch group {
        case .needsYou: self.$needsYouCollapsed
        case .working: self.$workingCollapsed
        case .pinned: self.$pinnedCollapsed
        case .recent: self.$recentCollapsed
        }
    }

    /// The pending approval this row asks for; the oldest to expire when there are several.
    private func approval(for session: OpenClawChatSessionEntry) -> OpenClawChatAttentionRequest? {
        self.appModel.pendingApprovalAttentionRequests.first { self.approval($0, targets: session) }
    }

    private func approval(_ request: OpenClawChatAttentionRequest, targets session: OpenClawChatSessionEntry) -> Bool {
        self.appModel.approvalTargetsSession(
            sourceSessionKey: request.sessionKey,
            sourceAgentID: request.agentID,
            sessionKey: session.key,
            agentID: session.agentId ?? self.appModel.chatAgentId)
    }

    private var isLoading: Bool {
        self.statusScope == .archived
            ? self.isLoadingArchived
            : self.sidebarModel.isRefreshing && self.sidebarModel.sessions.isEmpty
    }

    /// A roster that failed with nothing to show is an error; with rows kept, the same text is a notice.
    /// The list failed with nothing to show. A failure that keeps rows is the partial-load notice instead.
    private var loadFailed: Bool {
        if self.statusScope == .archived { return self.archiveLoadFailed }
        return self.sidebarModel.sessions.isEmpty && !self.sidebarModel.isRefreshing &&
            self.sidebarModel.sessionErrorText != nil
    }

    private var loadFailure: some View {
        VStack(alignment: .leading, spacing: 8) {
            CommandEmptyStateRow(
                icon: "exclamationmark.triangle.fill",
                title: "Couldn’t load sessions",
                detail: .verbatim(String(localized: "Check your connection and try again.")))
            Button(action: self.retry) {
                Text(String(localized: "Try again"))
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawBrand.textStrong)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: Capsule())
            .accessibilityIdentifier("Sessions.LoadFailure.Retry")
        }
        .padding(.horizontal, 4)
    }

    /// Reloads whichever list is on screen: the archive here, the live roster through its owner.
    private func retry() {
        self.refreshNonce += 1
        if self.statusScope != .archived {
            Task { await self.sidebarModel.refreshSessions(appModel: self.appModel) }
        }
    }

    private var partialNoticeText: String? {
        if self.statusScope == .archived { return self.partialLoadText }
        return self.sidebarModel.sessions.isEmpty ? nil : self.sidebarModel.sessionErrorText
    }

    private var title: String {
        switch self.statusScope {
        case .active: String(localized: "Sessions")
        case .snoozed: String(localized: "Snoozed sessions")
        case .automations: String(localized: "Automation sessions")
        case .archived: String(localized: "Archived sessions")
        }
    }

    private var resolvedMainSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.sourceSessions,
            currentSessionKey: self.appModel.mainSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var resolvedCurrentSessionKey: String {
        ChatSessionSidebarModel.selectedSessionKey(
            sessions: self.sourceSessions,
            currentSessionKey: self.appModel.chatSessionKey,
            mainSessionKey: self.appModel.mainSessionKey,
            activeAgentID: self.appModel.chatAgentId,
            sessionRoutingContract: self.appModel.chatSessionRoutingContract)
    }

    private var sessionCategories: [String] {
        self.appModel.sessionGroups.names(for: self.sourceSessions)
    }

    private var sessionControlsAvailable: Bool {
        !self.appModel.isLocalChatFixtureEnabled && self.appModel.isOperatorGatewayConnected
    }

    private var availableStatusScopes: [SessionStatusScope] {
        SessionStatusScope.available(isConnected: self.appModel.isOperatorGatewayConnected)
    }

    private var emptyTitle: String {
        guard self.appModel.isCommandSessionListAvailable else {
            return String(localized: "Offline")
        }
        switch self.statusScope {
        case .active: return String(localized: "No sessions")
        case .snoozed: return String(localized: "No snoozed sessions")
        case .automations: return String(localized: "No automation sessions")
        case .archived: return String(localized: "No archived sessions")
        }
    }

    private var emptyDetail: String {
        switch self.statusScope {
        case .active: String(localized: "Start a chat to see it here.")
        case .snoozed: String(localized: "Snoozed sessions appear here until they wake.")
        case .automations: String(localized: "Automation sessions appear here.")
        case .archived: String(localized: "Archived sessions appear here.")
        }
    }

    private var refreshID: String {
        "\(self.appModel.chatViewModelIdentityID):\(self.statusScope.rawValue):\(self.refreshNonce)"
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
        if self.statusScope == .archived {
            await self.appModel.sessionGroups.refresh(appModel: self.appModel)
            await self.loadArchived()
        } else {
            // The roster owner also refreshes the session groups.
            await self.sidebarModel.refreshSessions(appModel: self.appModel)
        }
    }

    private func loadArchived() async {
        let sourceGatewayID = self.appModel.chatTranscriptCacheGatewayID
        self.isLoadingArchived = true
        self.archiveLoadFailed = false
        defer { self.isLoadingArchived = false }
        do {
            let roster = try await self.appModel.loadChatSessionRoster(
                limit: CommandCenterTab.recentSessionsFetchLimit,
                archived: true)
            guard !Task.isCancelled, self.statusScope == .archived,
                  self.appModel.chatTranscriptCacheGatewayID == sourceGatewayID else { return }
            self.archived = CommandCenterTab.listedSessions(roster.sessions)
            self.partialLoadText = roster.incompleteLoadMessage
        } catch is CancellationError {
            return
        } catch {
            guard !Task.isCancelled, self.statusScope == .archived else { return }
            self.partialLoadText = nil
            self.archived = []
            self.archiveLoadFailed = true
        }
    }
}

extension NodeAppModel {
    fileprivate var isCommandSessionListAvailable: Bool {
        self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected
    }
}
