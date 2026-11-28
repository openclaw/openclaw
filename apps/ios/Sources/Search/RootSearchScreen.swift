import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// Full-screen search over the sidebar: the field sits on the keyboard, tabs appear with results.
struct RootSearchScreen: View {
    @Environment(NodeAppModel.self) private var appModel
    let sidebarModel: RootSidebarModel
    let open: (RootSearchTarget) -> Void
    let close: () -> Void

    @State private var model = RootSearchModel()
    @State private var tab: RootSearchTab = .all
    @State private var sessionKeys: [String]?
    @State private var pageIDs: [String] = []
    @FocusState private var isFieldFocused: Bool
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Namespace private var tabSelection

    private static let allSectionLimit = 5

    var body: some View {
        let results = self.results
        let hasMoreResults = self.tab == .all &&
            max(results.pages.count, results.sessionCount, results.messages.count) > Self.allSectionLimit
        ScrollView {
            VStack(alignment: .leading, spacing: 0) {
                self.content(results)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 10)
            .padding(.bottom, 4)
        }
        // A capped All preview belongs under the filters; genuinely short lists stay beside the field.
        .defaultScrollAnchor(hasMoreResults ? .top : .bottom, for: .alignment)
        .scrollDismissesKeyboard(.interactively)
        .scrollEdgeEffectStyle(.soft, for: .vertical)
        .safeAreaBar(edge: .top, spacing: 0) {
            if results.hasAny { self.tabs(results) }
        }
        .safeAreaBar(edge: .bottom, spacing: 0) {
            self.fieldRow
        }
        .background(OpenClawSidebarPalette.background.ignoresSafeArea())
        .foregroundStyle(OpenClawSidebarPalette.text)
        .onAppear { self.isFieldFocused = true }
        .onChange(of: self.appModel.isOperatorGatewayConnected, initial: true) { _, connected in
            self.model.setOffline(!connected)
        }
        .onChange(of: self.model.query, initial: true) { _, _ in
            self.tab = .all
            self.captureSessionOrder()
            self.pageIDs = self.rankedPages.map(\.id)
        }
        .onChange(of: self.rankedPages.map(\.id)) { _, ranked in
            // Late catalog answers can fill vacant places, not displace a visible page.
            let seen = Set(self.pageIDs)
            self.pageIDs += ranked.filter { !seen.contains($0) }.prefix(max(0, ranked.count - seen.count))
        }
        .onChange(of: self.sidebarModel.sessions.isEmpty) { _, empty in
            if !empty, self.sessionKeys == nil { self.captureSessionOrder() }
        }
        .task(id: self.model.serverSearchID) {
            await self.model.runServerSearch(appModel: self.appModel) {
                Set(self.results.sessions.map(\.key))
            }
        }
        .task(id: self.appModel.operatorAuthorityGeneration) {
            await self.model.loadCatalog(appModel: self.appModel)
        }
    }

    // MARK: Results

    struct Results {
        var pages: [RootSearchPage] = []
        var sessions: [OpenClawChatSessionEntry] = []
        var archived: [OpenClawChatSessionEntry] = []
        var messages: [RootSearchMessage] = []
        var sessionsLoading = false
        var messagePhase: RootSearchModel.Phase = .idle

        var sessionCount: Int {
            self.sessions.count + self.archived.count
        }

        var allSections: [RootSearchTab] {
            RootSearchTab.allCases.filter { tab in
                switch tab {
                case .all: false
                case .pages: !self.pages.isEmpty
                case .sessions: self.sessionCount > 0 || self.sessionsLoading
                case .messages: !self.messages.isEmpty || self.messagePhase == .loading || self.messagePhase == .failed
                }
            }
        }

        var allCount: Int {
            self.pages.count + self.sessionCount + self.messages.count
        }

        var hasAny: Bool {
            self.allCount > 0
        }

        var isSettled: Bool {
            !self.sessionsLoading && self.messagePhase != .loading
        }
    }

    private var results: Results {
        let query = self.model.normalizedQuery
        guard !query.isEmpty else { return Results() }
        let pages = Dictionary(
            (self.basePages + self.catalogPages).map { ($0.id, $0) },
            uniquingKeysWith: { first, _ in first })
        let sessions = self.sessionsByKey
        return Results(
            pages: self.pageIDs.compactMap { pages[$0] },
            sessions: (self.sessionKeys ?? []).compactMap { sessions[$0] },
            archived: self.model.archived.filter { sessions[$0.key]?.isArchived != false },
            messages: self.model.messages,
            sessionsLoading: self.sidebarModel.isRefreshing && self.sidebarModel.sessions.isEmpty,
            messagePhase: self.model.messagePhase)
    }

    private var catalogPages: [RootSearchPage] {
        self.settingsPages + self.automationPages + self.model.skills + self.model.plugins
    }

    private var rankedPages: [RootSearchPage] {
        RootSearchRanking.pages(base: self.basePages, catalog: self.catalogPages, query: self.model.normalizedQuery)
    }

    private var sessionsByKey: [String: OpenClawChatSessionEntry] {
        Dictionary(self.sidebarModel.sessions.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
    }

    /// Capture the identities selected by the ranking limit, not a copy of the row content.
    /// A later roster can rename a match, but cannot move it or evict it from the top ten.
    private func captureSessionOrder() {
        guard !self.sidebarModel.sessions.isEmpty else {
            self.sessionKeys = nil
            return
        }
        let rows = self.model.normalizedQuery.isEmpty ? self.recentSessions :
            RootSearchRanking.sessions(self.searchableSessions, query: self.model.normalizedQuery)
        self.sessionKeys = rows.map(\.key)
    }

    private var searchableSessions: [OpenClawChatSessionEntry] {
        self.sidebarModel.sessions.filter {
            !$0.isArchived && !ChatSessionSidebarModel.isHiddenInternalSession($0.key)
        }
    }

    private var recentSessions: [OpenClawChatSessionEntry] {
        let now = self.sidebarModel.now
        return Array(self.searchableSessions
            .filter { !$0.isSnoozed(at: now) && !OpenClawChatSessionListVisibility.isAutomationSession($0) }
            .sorted { ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            .prefix(3))
    }

    /// Sidebar pages and the one command the app runs from anywhere.
    private var basePages: [RootSearchPage] {
        let pages = RootTabs.sidebarDestinations
            .filter { $0 != .chat && ($0 != .desktop || self.appModel.isDesktopObserveAvailable) }
            .map { destination in
                RootSearchPage(
                    id: "page:\(destination.rawValue)",
                    title: destination.sidebarTitle,
                    systemImage: RootSidebarIcon.symbolName(for: destination),
                    kind: .page,
                    target: .destination(destination))
            }
        return pages + [
            RootSearchPage(
                id: "page:settings",
                title: String(localized: "Settings"),
                systemImage: "gearshape",
                kind: .page,
                target: .destination(.settings)),
            RootSearchPage(
                id: "command:new-chat",
                title: String(localized: "New Chat"),
                systemImage: "plus",
                kind: .page,
                target: .newChat),
        ]
    }

    /// The Settings screens the hub links to, by their own names.
    private var settingsPages: [RootSearchPage] {
        let routes: [(SettingsRoute, String, String)] = [
            (.gateway, String(localized: "Connection"), "antenna.radiowaves.left.and.right"),
            (.voiceAndTalk, String(localized: "Voice & Talk"), "mic"),
            (.permissions, String(localized: "Permissions"), "checkmark.shield"),
            (.accessories, String(localized: "Accessories"), "applewatch"),
            (.storage, String(localized: "Storage"), "internaldrive"),
            (.chatPreferences, String(localized: "Chat"), "bubble.left"),
            (.sidebarPages, String(localized: "Sidebar"), "sidebar.left"),
            (.skills, String(localized: "Skills"), "book"),
            (.plugins, String(localized: "Plugins"), "shippingbox"),
            (.advanced, String(localized: "Advanced"), "slider.horizontal.3"),
            (.about, String(localized: "About"), "info.circle"),
        ]
        return routes.map { route, title, symbol in
            RootSearchPage(
                id: "settings:\(title)",
                title: title,
                systemImage: symbol,
                kind: .settings,
                target: .settings(route))
        }
    }

    private var automationPages: [RootSearchPage] {
        self.sidebarModel.cronJobs.map { job in
            RootSearchPage(
                id: "cron:\(job.id)",
                title: job.name,
                systemImage: "clock",
                kind: .automation,
                target: .destination(.cron))
        }
    }

    // MARK: Content

    @ViewBuilder
    private func content(_ results: Results) -> some View {
        let query = self.model.normalizedQuery
        if query.isEmpty {
            let sessions = self.sessionsByKey
            let recent = (self.sessionKeys ?? []).compactMap { sessions[$0] }
            if !recent.isEmpty {
                Text(String(localized: "Recent"))
                    .font(OpenClawType.headlineBold)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .padding(.horizontal, 10)
                    .padding(.bottom, 4)
                    .accessibilityAddTraits(.isHeader)
                ForEach(recent.reversed()) { session in
                    if session.key != recent.last?.key {
                        Divider().padding(.leading, 42)
                    }
                    self.sessionRow(session, query: "", quiet: false)
                }
            }
        } else {
            if !self.appModel.isOperatorGatewayConnected {
                self.notice(String(localized: "Offline. Searching what’s on this device."))
            }
            if !results.hasAny, results.isSettled, self.model.messagePhase != .failed {
                self.noResults(query)
            } else {
                switch self.tab {
                case .all: self.allContent(results, query: query)
                case .sessions: self.sessionsContent(results, query: query, limit: nil)
                case .messages: self.messagesContent(results, query: query, limit: nil)
                case .pages: self.pagesContent(results.pages, query: query, limit: nil)
                }
            }
        }
    }

    @ViewBuilder
    private func allContent(_ results: Results, query: String) -> some View {
        ForEach(results.allSections, id: \.self) { section in
            switch section {
            case .pages:
                self.sectionHeader(section.title, more: results.pages.count > Self.allSectionLimit ? .pages : nil)
                self.pagesContent(results.pages, query: query, limit: Self.allSectionLimit)
            case .sessions:
                if !results.sessions.isEmpty || results.sessionsLoading {
                    self.sectionHeader(
                        section.title,
                        more: results.sessionCount > Self.allSectionLimit ? .sessions : nil)
                    self.sessionsContent(results, query: query, limit: Self.allSectionLimit)
                }
            case .messages:
                if results.messages.contains(where: { !$0.session.isArchived }) || results.messagePhase != .done {
                    self.sectionHeader(
                        section.title,
                        more: results.messages.count > Self.allSectionLimit ? .messages : nil)
                    self.messagesContent(results, query: query, limit: Self.allSectionLimit)
                }
            case .all:
                EmptyView()
            }
        }
        let archived = results.archived.prefix(max(0, Self.allSectionLimit - results.sessions.count))
        let archivedMessages = results.messages.prefix(Self.allSectionLimit).filter(\.session.isArchived)
        if !archived.isEmpty || !archivedMessages.isEmpty {
            let moreMessages = results.messages.count > Self.allSectionLimit && archivedMessages.count == Self
                .allSectionLimit
            self.sectionHeader(String(localized: "Archived"), more: moreMessages ? .messages : nil)
            ForEach(archived) { self.sessionRow($0, query: query, quiet: true) }
            ForEach(archivedMessages) { self.messageRow($0, query: query) }
        }
    }

    private func pagesContent(_ pages: [RootSearchPage], query: String, limit: Int?) -> some View {
        ForEach(pages.prefix(limit ?? pages.count)) { page in
            self.resultButton(target: page.target, title: page.title) {
                self.rowLabel(systemImage: page.systemImage, title: page.title, query: query, quiet: false) {
                    if let kind = page.kind.label {
                        Text(verbatim: kind)
                            .font(OpenClawType.footnote)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .lineLimit(1)
                            .fixedSize()
                    }
                }
            }
        }
    }

    @ViewBuilder
    private func sessionsContent(_ results: Results, query: String, limit: Int?) -> some View {
        if results.sessionsLoading, results.sessions.isEmpty {
            self.loadingRow(String(localized: "Searching sessions…"))
        }
        ForEach(results.sessions.prefix(limit ?? results.sessions.count)) { session in
            self.sessionRow(session, query: query, quiet: false)
        }
        if limit == nil, !results.archived.isEmpty {
            self.sectionHeader(String(localized: "Archived"))
            ForEach(results.archived) { self.sessionRow($0, query: query, quiet: true) }
        }
    }

    @ViewBuilder
    private func messagesContent(_ results: Results, query: String, limit: Int?) -> some View {
        switch results.messagePhase {
        case .loading where results.messages.isEmpty:
            self.loadingRow(String(localized: "Searching messages…"))
        case .failed:
            HStack(spacing: 8) {
                Text(String(localized: "Couldn’t search messages."))
                    .font(OpenClawType.subhead)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                Spacer(minLength: 8)
                Button {
                    self.model.retryMessages()
                } label: {
                    Text(String(localized: "Try again"))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, 10)
        default:
            ForEach(results.messages.prefix(limit ?? results.messages.count)) { message in
                if limit == nil || !message.session.isArchived { self.messageRow(message, query: query) }
            }
        }
    }

    private func messageRow(_ match: RootSearchMessage, query: String) -> some View {
        let session = self.sidebarModel.sessions.first { $0.key == match.id } ?? match.session
        return self.resultButton(target: .session(session), title: SessionPresentation.title(session)) {
            self.messageLabel(RootSearchMessage(session: session, snippet: match.snippet), query: query)
        }
    }

    // MARK: Rows

    private func sessionRow(_ session: OpenClawChatSessionEntry, query: String, quiet: Bool) -> some View {
        let title = SessionPresentation.title(session)
        return self.resultButton(target: .session(session), title: title) {
            self.rowLabel(systemImage: RootSidebarIcon.sessionSymbol, title: title, query: query, quiet: quiet) {
                EmptyView()
            }
        }
    }

    private func rowLabel(
        systemImage: String,
        title: String,
        query: String,
        quiet: Bool,
        @ViewBuilder trailing: () -> some View) -> some View
    {
        HStack(spacing: 10) {
            RootSidebarIcon.listMark(systemName: systemImage)
            Text(Self.highlighted(title, query: query))
                .font(OpenClawType.subhead)
                .foregroundStyle(quiet ? OpenClawSidebarPalette.muted : OpenClawSidebarPalette.textStrong)
                .lineLimit(1)
                .truncationMode(.tail)
                .frame(maxWidth: .infinity, alignment: .leading)
            trailing()
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
    }

    private func messageLabel(_ message: RootSearchMessage, query: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            RootSidebarIcon.listMark(systemName: "text.bubble")
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: SessionPresentation.title(message.session))
                    .font(OpenClawType.subhead)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .lineLimit(1)
                Text(Self.highlighted(message.snippet, query: query))
                    .font(OpenClawType.footnote)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .lineLimit(1)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
        .padding(.vertical, 6)
        .frame(minHeight: 44)
        .padding(.horizontal, 10)
        .contentShape(Rectangle())
    }

    private func resultButton(
        target: RootSearchTarget,
        title: String,
        @ViewBuilder label: () -> some View) -> some View
    {
        Button {
            self.isFieldFocused = false
            self.open(target)
        } label: {
            label()
        }
        .buttonStyle(.plain)
        .accessibilityLabel(Text(verbatim: title))
    }

    static func highlighted(_ text: String, query: String) -> AttributedString {
        var attributed = AttributedString(text)
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty,
              let range = text.range(of: query, options: [.caseInsensitive, .diacriticInsensitive]),
              let lower = AttributedString.Index(range.lowerBound, within: attributed),
              let upper = AttributedString.Index(range.upperBound, within: attributed)
        else { return attributed }
        attributed[lower..<upper].backgroundColor = OpenClawSidebarPalette.selection
        attributed[lower..<upper].foregroundColor = OpenClawSidebarPalette.textStrong
        return attributed
    }

    private func sectionHeader(_ title: String, more: RootSearchTab? = nil) -> some View {
        HStack {
            Text(verbatim: title)
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .accessibilityAddTraits(.isHeader)
            Spacer()
            if let more {
                Button {
                    self.tab = more
                } label: {
                    Text(String(localized: "Show more"))
                        .font(OpenClawType.footnoteSemiBold)
                        .foregroundStyle(OpenClawSidebarPalette.text)
                        .frame(minHeight: 44)
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
            }
        }
        .frame(minHeight: 28)
        .padding(.horizontal, 10)
    }

    private func loadingRow(_ text: String) -> some View {
        HStack(spacing: 9) {
            ProgressView()
                .controlSize(.small)
                .tint(OpenClawSidebarPalette.muted)
            Text(verbatim: text)
                .font(OpenClawType.subhead)
                .foregroundStyle(OpenClawSidebarPalette.muted)
        }
        .frame(minHeight: 44)
        .padding(.horizontal, 10)
    }

    private func notice(_ text: String) -> some View {
        HStack(spacing: 8) {
            Image(systemName: "wifi.slash")
                .font(OpenClawType.footnote)
                .accessibilityHidden(true)
            Text(verbatim: text)
                .font(OpenClawType.footnote)
        }
        .foregroundStyle(OpenClawSidebarPalette.muted)
        .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
        .padding(.horizontal, 10)
    }

    private func noResults(_ query: String) -> some View {
        VStack(spacing: 12) {
            Text(String(format: String(localized: "No results for “%@”"), query))
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .multilineTextAlignment(.center)
            Button {
                self.model.query = ""
                self.isFieldFocused = true
            } label: {
                Text(String(localized: "Clear search"))
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .padding(.horizontal, 16)
                    .frame(minHeight: 44)
                    .contentShape(Capsule())
            }
            .buttonStyle(.plain)
            .glassEffect(.regular.interactive(), in: Capsule())
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 20)
        .padding(.horizontal, 16)
    }

    // MARK: Tabs and field

    private func tabs(_ results: Results) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 0) {
                ForEach(RootSearchTab.allCases, id: \.self) { tab in
                    self.tabButton(tab, results: results)
                }
            }
            .padding(.horizontal, 4)
            .animation(self.reduceMotion ? nil : .snappy(duration: 0.25), value: self.tab)
        }
        .defaultScrollAnchor(.center, for: .alignment)
        .scrollEdgeEffectStyle(.soft, for: .horizontal)
        .clipShape(Capsule())
        // Same glass and height as the field row below, edges aligned with it.
        .glassEffect(.regular.interactive(), in: Capsule())
        .padding(.horizontal, 12)
        .padding(.bottom, 4)
    }

    private func tabButton(_ tab: RootSearchTab, results: Results) -> some View {
        let (count, settled): (Int, Bool) = switch tab {
        case .all: (results.allCount, true)
        case .sessions: (results.sessionCount, !results.sessionsLoading)
        case .messages: (results.messages.count, results.messagePhase == .done)
        case .pages: (results.pages.count, true)
        }
        let number = RootSearchRanking.tabCount(count, isSettled: settled)
        let isSelected = self.tab == tab
        return Button {
            self.tab = tab
        } label: {
            HStack(spacing: 4) {
                // The semibold width is always reserved, so selecting a tab never nudges its neighbors.
                ZStack {
                    Text(verbatim: tab.title)
                        .font(OpenClawType.subheadSemiBold)
                        .hidden()
                        .accessibilityHidden(true)
                    Text(verbatim: tab.title)
                        .font(isSelected ? OpenClawType.subheadSemiBold : OpenClawType.subheadMedium)
                }
                if let number {
                    Text(verbatim: "\(number)")
                        .font(OpenClawType.subhead)
                        .monospacedDigit()
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
            }
            .foregroundStyle(isSelected ? OpenClawSidebarPalette.textStrong : OpenClawSidebarPalette.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 40)
            .background {
                // An ink tint lifts the selection off the glass in both themes; the opaque
                // sidebar selection color reads as a hole in dark glass.
                if isSelected {
                    Capsule()
                        .fill(OpenClawSidebarPalette.textStrong.opacity(0.1))
                        .matchedGeometryEffect(id: "selection", in: self.tabSelection)
                }
            }
            .frame(minHeight: 48)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // No results, or not returned yet: the tab keeps its place, dimmed, with no number.
        .disabled(number == nil)
        .opacity(number == nil ? 0.4 : 1)
        .accessibilityValue(number.map { Text(verbatim: "\($0)") } ?? Text(verbatim: ""))
        .accessibilityAddTraits(isSelected ? .isSelected : [])
        .accessibilityIdentifier("Search.Tab.\(tab)")
    }

    private var fieldRow: some View {
        GlassEffectContainer(spacing: 8) {
            HStack(spacing: 8) {
                HStack(spacing: 8) {
                    Image(systemName: "magnifyingglass")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                        .accessibilityHidden(true)
                    TextField(
                        "",
                        text: self.$model.query,
                        prompt: Text(String(localized: "Search OpenClaw"))
                            .font(OpenClawType.body)
                            .foregroundStyle(OpenClawSidebarPalette.muted))
                        .font(OpenClawType.body)
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .submitLabel(.search)
                        .focused(self.$isFieldFocused)
                        .accessibilityLabel(String(localized: "Search OpenClaw"))
                        .accessibilityIdentifier("Search.Field")
                    if !self.model.query.isEmpty {
                        Button {
                            self.model.query = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .font(OpenClawType.body)
                                .foregroundStyle(OpenClawSidebarPalette.muted)
                                .frame(width: 32, height: 44)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .accessibilityLabel(String(localized: "Clear search"))
                    }
                }
                .padding(.leading, 14)
                .padding(.trailing, 6)
                .frame(minHeight: 48)
                .glassEffect(.regular.interactive(), in: Capsule())

                Button(action: self.close) {
                    Image(systemName: "xmark")
                        .font(.system(size: 17, weight: .medium))
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .frame(width: 48, height: 48)
                        .contentShape(Circle())
                }
                .buttonStyle(.plain)
                .glassEffect(.regular.interactive(), in: Circle())
                .accessibilityLabel(String(localized: "Close search"))
                .accessibilityIdentifier("Search.Close")
            }
        }
        .padding(.horizontal, 12)
        .padding(.top, 6)
        .padding(.bottom, 8)
    }
}
