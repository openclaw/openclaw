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
    @FocusState private var isFieldFocused: Bool

    private static let allSectionLimit = 5

    var body: some View {
        let results = self.results
        VStack(alignment: .leading, spacing: 0) {
            Text(String(localized: "Search"))
                .font(OpenClawType.headline)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .accessibilityAddTraits(.isHeader)
                .padding(.horizontal, 16)
                .frame(minHeight: 44, alignment: .leading)
            if results.hasAny {
                self.tabs(results)
            }
            ScrollView {
                VStack(alignment: .leading, spacing: 0) {
                    self.content(results)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(.horizontal, 10)
                .padding(.bottom, 12)
            }
            .scrollDismissesKeyboard(.interactively)
            .scrollEdgeEffectStyle(.soft, for: .vertical)
        }
        .safeAreaInset(edge: .bottom, spacing: 0) {
            self.fieldRow
        }
        .background(OpenClawSidebarPalette.background.ignoresSafeArea())
        .foregroundStyle(OpenClawSidebarPalette.text)
        .onAppear { self.isFieldFocused = true }
        .onChange(of: self.appModel.isOperatorGatewayConnected, initial: true) { _, connected in
            self.model.setOffline(!connected)
        }
        .onChange(of: self.model.normalizedQuery) { _, _ in
            self.tab = .all
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

    private struct Results {
        var pages: [RootSearchPage] = []
        var sessions: [OpenClawChatSessionEntry] = []
        var archived: [OpenClawChatSessionEntry] = []
        var messages: [RootSearchMessage] = []
        var sessionsLoading = false
        var messagePhase: RootSearchModel.Phase = .idle

        var sessionCount: Int {
            self.sessions.count + self.archived.count
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
        let catalog = self.settingsPages + self.automationPages + self.model.skills + self.model.plugins
        return Results(
            pages: RootSearchRanking.pages(base: self.basePages, catalog: catalog, query: query),
            sessions: RootSearchRanking.sessions(self.searchableSessions, query: query),
            archived: self.model.archived.filter { archived in
                !self.searchableSessions.contains { $0.key == archived.key }
            },
            messages: self.model.messages,
            sessionsLoading: self.sidebarModel.isRefreshing && self.sidebarModel.sessions.isEmpty,
            messagePhase: self.model.messagePhase)
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
            let recent = self.recentSessions
            if !recent.isEmpty {
                self.sectionHeader(String(localized: "Recent"))
                ForEach(recent) { session in
                    self.sessionRow(session, query: "", quiet: true)
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
        if !results.pages.isEmpty {
            self.sectionHeader(String(localized: "Pages"))
            self.pagesContent(results.pages, query: query, limit: Self.allSectionLimit)
        }
        if results.sessionCount > 0 || results.sessionsLoading {
            self.sectionHeader(String(localized: "Sessions"))
            self.sessionsContent(results, query: query, limit: Self.allSectionLimit)
        }
        if !results.messages.isEmpty || results.messagePhase == .loading || results.messagePhase == .failed {
            self.sectionHeader(String(localized: "Messages"))
            self.messagesContent(results, query: query, limit: Self.allSectionLimit)
        }
    }

    @ViewBuilder
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
        if let limit, pages.count > limit {
            self.showMore(tab: .pages)
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
        if let limit, results.sessions.count > limit {
            self.showMore(tab: .sessions)
        } else if !results.archived.isEmpty {
            if limit == nil {
                self.sectionHeader(String(localized: "Archived"))
            }
            ForEach(results.archived) { session in
                self.sessionRow(session, query: query, quiet: true)
            }
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
                self.resultButton(
                    target: .session(message.session),
                    title: CommandCenterTab.sessionTitle(message.session))
                {
                    self.messageLabel(message, query: query)
                }
            }
            if let limit, results.messages.count > limit {
                self.showMore(tab: .messages)
            }
        }
    }

    // MARK: Rows

    private func sessionRow(_ session: OpenClawChatSessionEntry, query: String, quiet: Bool) -> some View {
        let title = CommandCenterTab.sessionTitle(session)
        return self.resultButton(target: .session(session), title: title) {
            self.rowLabel(systemImage: "bubble.left", title: title, query: query, quiet: quiet) {
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
            RootSidebarIcon(systemName: systemImage, pointSize: 15)
                .foregroundStyle(OpenClawSidebarPalette.muted)
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
            RootSidebarIcon(systemName: "text.bubble", pointSize: 15)
                .foregroundStyle(OpenClawSidebarPalette.muted)
                .alignmentGuide(.firstTextBaseline) { $0[VerticalAlignment.center] + 5 }
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: CommandCenterTab.sessionTitle(message.session))
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

    private func sectionHeader(_ title: String) -> some View {
        Text(verbatim: title)
            .font(OpenClawType.captionMedium)
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .bottomLeading)
            .padding(.horizontal, 10)
            .padding(.top, 8)
            .accessibilityAddTraits(.isHeader)
    }

    private func showMore(tab: RootSearchTab) -> some View {
        Button {
            self.tab = tab
        } label: {
            Text(String(localized: "Show more"))
                .font(OpenClawType.subheadMedium)
                .foregroundStyle(OpenClawSidebarPalette.text)
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .padding(.horizontal, 10)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
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
        .padding(.top, 48)
        .padding(.horizontal, 16)
    }

    // MARK: Tabs and field

    private func tabs(_ results: Results) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                ForEach(RootSearchTab.allCases, id: \.self) { tab in
                    self.tabButton(tab, results: results)
                }
            }
            .padding(.horizontal, 10)
        }
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
                Text(verbatim: tab.title)
                    .font(isSelected ? OpenClawType.subheadSemiBold : OpenClawType.subheadMedium)
                if let number {
                    Text(verbatim: "\(number)")
                        .font(OpenClawType.subhead)
                        .foregroundStyle(OpenClawSidebarPalette.muted)
                }
            }
            .foregroundStyle(isSelected ? OpenClawSidebarPalette.textStrong : OpenClawSidebarPalette.text)
            .padding(.horizontal, 12)
            .frame(minHeight: 36)
            .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: Capsule())
            .frame(minHeight: 44)
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
