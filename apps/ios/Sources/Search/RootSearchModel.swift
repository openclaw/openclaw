import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol

/// What a search result opens. Search never pretends to open an item it cannot reach:
/// automations, skills and plugins open their page.
enum RootSearchTarget: Equatable {
    case destination(RootTabs.SidebarDestination)
    /// `query` presets the Skills or Plugins search so a named item opens filtered to itself.
    case settings(SettingsRoute, query: String = "")
    case newChat
    case session(OpenClawChatSessionEntry)
}

struct RootSearchPage: Identifiable, Equatable {
    enum Kind: Equatable {
        /// Sidebar pages and commands; the name says it all.
        case page
        case settings
        case automation
        case skill
        case plugin

        var label: String? {
            switch self {
            case .page: nil
            case .settings: String(localized: "Settings")
            case .automation: String(localized: "Automations")
            case .skill: String(localized: "Skills")
            case .plugin: String(localized: "Plugins")
            }
        }
    }

    let id: String
    let title: String
    let systemImage: String
    let kind: Kind
    let target: RootSearchTarget
}

struct RootSearchMessage: Identifiable, Equatable {
    let session: OpenClawChatSessionEntry
    let snippet: String

    var id: String {
        self.session.key
    }
}

enum RootSearchTab: CaseIterable, Hashable {
    case all, pages, sessions, messages

    var title: String {
        switch self {
        case .all: String(localized: "All")
        case .sessions: String(localized: "Sessions")
        case .messages: String(localized: "Messages")
        case .pages: String(localized: "Pages")
        }
    }
}

/// Result order follows the desktop command palette on main
/// (`ui/src/components/command-palette-catalog-search.ts`, `filterCommandPaletteItems`):
/// pages and commands whose name matches, then sessions, then archived sessions, then message text.
enum RootSearchRanking {
    static let catalogLimit = 10
    static let sessionLimit = 10
    static let archivedLimit = 3
    static let messageLimit = 10

    static func normalized(_ text: String) -> String {
        text.trimmingCharacters(in: .whitespacesAndNewlines).precomposedStringWithCanonicalMapping.lowercased()
    }

    /// 3 exact name, 2 prefix, 1 contains, 0 no match.
    static func rank(_ title: String, query: String) -> Int {
        let title = self.normalized(title)
        let query = self.normalized(query)
        guard !query.isEmpty else { return 0 }
        if title == query { return 3 }
        if title.hasPrefix(query) { return 2 }
        return title.contains(query) ? 1 : 0
    }

    /// Commands first, then at most ten catalog items; inside a rank, base items keep their
    /// alphabetical lead over catalog items, as the palette's stable sort does.
    static func pages(base: [RootSearchPage], catalog: [RootSearchPage], query: String) -> [RootSearchPage] {
        func ranked(_ items: [RootSearchPage]) -> [(page: RootSearchPage, rank: Int)] {
            items.map { (page: $0, rank: self.rank($0.title, query: query)) }
                .filter { $0.rank > 0 }
                .sorted {
                    if $0.rank != $1.rank { return $0.rank > $1.rank }
                    return $0.page.title.localizedStandardCompare($1.page.title) == .orderedAscending
                }
        }
        let matches = ranked(base) + ranked(catalog).prefix(self.catalogLimit)
        return matches.enumerated()
            .sorted { $0.element.rank == $1.element.rank ? $0.offset < $1.offset : $0.element.rank > $1.element.rank }
            .map(\.element.page)
    }

    /// Session titles are sentences: only an exact title outranks recency
    /// (`command-palette-session-search.ts`, `exactThenRecent`).
    static func sessions(
        _ sessions: [OpenClawChatSessionEntry],
        query: String,
        limit: Int = Self.sessionLimit) -> [OpenClawChatSessionEntry]
    {
        sessions.compactMap { session -> (session: OpenClawChatSessionEntry, exact: Bool)? in
            let rank = self.rank(CommandCenterTab.sessionTitle(session), query: query)
            return rank > 0 ? (session, rank == 3) : nil
        }
        .sorted {
            if $0.exact != $1.exact { return $0.exact }
            return ($0.session.updatedAt ?? 0) > ($1.session.updatedAt ?? 0)
        }
        .prefix(limit)
        .map(\.session)
    }

    /// One row per session whose text matched but whose title did not, best match first.
    static func messages(
        hits: [RootSearchTranscriptHit],
        sessions: [OpenClawChatSessionEntry],
        excluding titleMatches: Set<String>) -> [RootSearchMessage]
    {
        var seen = titleMatches
        let byKey = Dictionary(sessions.map { ($0.key, $0) }, uniquingKeysWith: { first, _ in first })
        return hits.sorted { $0.score > $1.score }.compactMap { hit in
            guard let session = byKey[hit.sessionKey], seen.insert(hit.sessionKey).inserted else { return nil }
            let snippet = hit.snippet.split(whereSeparator: \.isWhitespace).joined(separator: " ")
            return RootSearchMessage(session: session, snippet: snippet)
        }
        .prefix(self.messageLimit)
        .map(\.self)
    }

    /// A tab shows a number only when it is above zero and its search has returned.
    static func tabCount(_ count: Int, isSettled: Bool) -> Int? {
        isSettled && count > 0 ? count : nil
    }
}

struct RootSearchTranscriptHit: Decodable, Equatable {
    let sessionKey: String
    let snippet: String
    let score: Double
}

@MainActor
@Observable
final class RootSearchModel {
    enum Phase: Equatable {
        /// Not asked: the query is too short, or the app is offline.
        case idle
        case loading
        case failed
        case done
    }

    var query = "" {
        didSet {
            guard self.normalizedQuery != Self.serverQuery(oldValue) else { return }
            self.resetServerResults()
        }
    }

    private(set) var archived: [OpenClawChatSessionEntry] = []
    private(set) var archivedPhase: Phase = .idle
    private(set) var messages: [RootSearchMessage] = []
    private(set) var messagePhase: Phase = .idle
    private(set) var skills: [RootSearchPage] = []
    private(set) var plugins: [RootSearchPage] = []
    private var isOffline = false
    private var retryNonce = 0

    var normalizedQuery: String {
        Self.serverQuery(self.query)
    }

    /// The task identity for server searches; bumping `retryNonce` re-runs a failed one.
    var serverSearchID: String {
        "\(self.normalizedQuery)\u{0}\(self.retryNonce)\u{0}\(self.isOffline)"
    }

    private static func serverQuery(_ query: String) -> String {
        query.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    /// Messages and archived sessions are asked of the server from two characters, like the web palette.
    private var asksServer: Bool {
        !self.isOffline && self.normalizedQuery.utf16.count >= 2
    }

    func setOffline(_ offline: Bool) {
        guard self.isOffline != offline else { return }
        self.isOffline = offline
        self.resetServerResults()
    }

    func retryMessages() {
        self.retryNonce += 1
        self.resetServerResults()
    }

    private func resetServerResults() {
        self.archived = []
        self.messages = []
        let phase: Phase = self.asksServer ? .loading : .idle
        self.archivedPhase = phase
        self.messagePhase = phase
    }

    func runServerSearch(appModel: NodeAppModel, titleMatches: @escaping () -> Set<String>) async {
        guard self.asksServer else { return }
        let query = self.normalizedQuery
        // Typing pauses before the server is asked; each keystroke cancels the previous wait.
        do {
            try await Task.sleep(for: .milliseconds(250))
        } catch {
            return
        }
        let agentID = appModel.chatDeliveryAgentId
        let session = appModel.operatorSession
        async let archivedRows = Self.loadArchived(query: query, agentID: agentID, session: session)
        async let transcript = Self.searchTranscripts(query: query, agentID: agentID, session: session)
        let archived = await archivedRows
        guard !Task.isCancelled, query == self.normalizedQuery else { return }
        // Archived rows match by title only and stay few, so they never crowd out live results.
        self.archived = RootSearchRanking.sessions(archived ?? [], query: query, limit: RootSearchRanking.archivedLimit)
        self.archivedPhase = archived == nil ? .failed : .done
        let result = await transcript
        guard !Task.isCancelled, query == self.normalizedQuery else { return }
        switch result {
        case let .success(found):
            self.messages = RootSearchRanking.messages(
                hits: found.results,
                sessions: (found.sessions ?? []).filter { !ChatSessionSidebarModel.isHiddenInternalSession($0.key) },
                excluding: titleMatches().union(self.archived.map(\.key)))
            self.messagePhase = .done
        case .failure:
            self.messages = []
            self.messagePhase = .failed
        }
    }

    /// Skill and plugin names, once per opening; a failed read only leaves them out.
    func loadCatalog(appModel: NodeAppModel) async {
        let session = appModel.operatorSession
        guard let route = await session.currentRoute() else { return }
        let agentID = appModel.chatAgentId
        if await session.supportsServerMethod("skills.status", ifCurrentRoute: route) == true,
           let data = try? await session.request(
               method: "skills.status",
               params: ["agentId": AnyCodable(agentID)],
               ifCurrentRoute: route),
           let report = try? JSONDecoder().decode(NamedReport.self, from: data)
        {
            self.skills = (report.skills ?? []).map {
                RootSearchPage(
                    id: "skill:\($0.name)",
                    title: $0.name,
                    systemImage: "book",
                    kind: .skill,
                    target: .settings(.skills, query: $0.name))
            }
        }
        guard !Task.isCancelled else { return }
        if await session.supportsServerMethod("plugins.list", ifCurrentRoute: route) == true,
           let data = try? await session.request(method: "plugins.list", params: [:], ifCurrentRoute: route),
           let report = try? JSONDecoder().decode(NamedReport.self, from: data)
        {
            self.plugins = (report.plugins ?? []).map {
                RootSearchPage(
                    id: "plugin:\($0.name)",
                    title: $0.name,
                    systemImage: "shippingbox",
                    kind: .plugin,
                    target: .settings(.plugins, query: $0.name))
            }
        }
    }

    private struct NamedReport: Decodable {
        struct Named: Decodable {
            let name: String
        }

        let skills: [Named]?
        let plugins: [Named]?
    }

    private struct TranscriptResult: Decodable {
        let results: [RootSearchTranscriptHit]
        let sessions: [OpenClawChatSessionEntry]?
    }

    private static func loadArchived(
        query: String,
        agentID: String?,
        session: GatewayNodeSession) async -> [OpenClawChatSessionEntry]?
    {
        let request = OpenClawChatGatewayRequests.sessionsList(
            limit: RootSearchRanking.sessionLimit,
            search: query,
            archived: true,
            agentID: agentID)
        do {
            let data = try await session.request(
                method: request.method, params: request.params, timeoutMs: request.timeoutMs)
            return try await GatewayPayloadDecoding.decode(OpenClawChatSessionsListResponse.self, from: data).sessions
        } catch {
            return nil
        }
    }

    private static func searchTranscripts(
        query: String,
        agentID: String?,
        session: GatewayNodeSession) async -> Result<TranscriptResult, Error>
    {
        let request = OpenClawChatGatewayRequests.sidebarTranscriptSearch(
            query: OpenClawChatSidebarQuery(agentID: agentID, search: query))
        do {
            let data = try await session.request(
                method: request.method, params: request.params, timeoutMs: request.timeoutMs)
            return try .success(JSONDecoder().decode(TranscriptResult.self, from: data))
        } catch {
            return .failure(error)
        }
    }
}
