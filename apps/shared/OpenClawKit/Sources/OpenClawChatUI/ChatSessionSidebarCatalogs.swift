#if os(macOS)
import Foundation
import Observation
import OpenClawProtocol

@MainActor
@Observable
final class ChatSessionSidebarCatalogs {
    enum Grouping: String, CaseIterable { case project, person, none }
    private enum RefreshPhase { case idle, reading, invalidated }
    struct Group: Identifiable {
        let id: String
        let label: String?
        var rows: [SessionCatalogSession]
    }

    private struct PageFailure: Error {
        let host: SessionCatalogHost?
        let message: String?
    }

    private struct Discovery {
        let head: String
        let cursor: String
        let depth: Int
        let cursors: Set<String>
    }

    private(set) var catalogs: [SessionCatalog] = []
    private(set) var connection: OpenClawSidebarCatalogConnection?
    private(set) var loading: Set<String> = []
    private(set) var errors: [String: String] = [:]
    private(set) var hidden: Set<String> = []
    private(set) var grouping = Grouping.project
    private(set) var agentID = ""
    var isRendered = false
    @ObservationIgnored var hasVisibleRows: (SessionCatalog) -> Bool = { $0.hosts.contains { !$0.sessions.isEmpty } }
    private var generation = UUID()
    private var observation = UUID()
    private var pageDepths: [String: [String: Int]] = [:]
    private var visited: [String: [String: Set<String>]] = [:]
    private var discovery: [String: [String: Discovery]] = [:]
    private var refreshTask: Task<Void, Never>?
    private var refreshPhase = RefreshPhase.idle
    private var refreshAfterPages = false
    private var preferenceKey: String?
    private let defaults: UserDefaults
    private let sleep: (Duration) async throws -> Void
    var scopeID: UUID {
        self.generation
    }

    init(defaults: UserDefaults = .standard, sleep: @escaping (Duration) async throws -> Void = {
        try await Task.sleep(for: $0)
    }) {
        self.defaults = defaults
        self.sleep = sleep
    }

    func observe(_ events: AsyncStream<OpenClawSidebarCatalogEvent>, agentID: String) async {
        self.stop()
        let observation = UUID()
        self.observation = observation
        if self.agentID != agentID { self.resetCatalogs() }
        self.agentID = agentID
        defer { if self.observation == observation { self.stop() } }
        for await event in events {
            guard !Task.isCancelled else { return }
            switch event {
            case let .connected(connection):
                self.stop()
                let key = "openclaw.chat.sidebar.catalogs.\(connection.profileID)"
                if self.preferenceKey != key {
                    self.resetCatalogs()
                    self.preferenceKey = key
                }
                self.reloadPreferences()
                self.connection = connection
                self.scheduleRefresh()
            case let .changed(agent):
                if self.connection?.changedEvents == true, agent == nil || agent?.lowercased() == self.agentID {
                    self.scheduleRefresh()
                }
            case .disconnected: self.stop()
            case .unavailable:
                self.stop()
                self.resetCatalogs()
                self.preferenceKey = nil
                self.hidden = []
                self.grouping = .project
            }
        }
    }

    func stop() {
        self.generation = UUID()
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.refreshPhase = .idle
        self.refreshAfterPages = false
        self.connection = nil
        self.loading = []
        self.discovery = [:]
    }

    private func resetCatalogs() {
        self.catalogs = []
        self.pageDepths = [:]
        self.visited = [:]
        self.errors = [:]
    }

    func scheduleRefresh() {
        // app-sidebar-session-catalog-live.ts:374 keeps the active cycle and records one trailing invalidation.
        if self.refreshPhase != .idle {
            self.refreshPhase = .invalidated
            return
        }
        self.refreshTask?.cancel()
        guard let connection else { return }
        let generation = self.generation
        self.refreshTask = Task {
            // app-sidebar-session-catalog-live.ts:494: advertised events retain a ten-minute safety refresh.
            while self.current(generation) {
                self.refreshPhase = .reading
                await self.refresh()
                guard self.current(generation) else { return }
                let invalidated = self.refreshPhase == .invalidated
                self.refreshPhase = .idle
                if invalidated { continue }
                do { try await self.sleep(.seconds(connection.changedEvents ? 600 : 30)) } catch { return }
            }
        }
    }

    private func current(_ generation: UUID) -> Bool {
        !Task.isCancelled && generation == self.generation && self.connection?.isCurrent() == true
    }

    private func resumeRefreshAfterPages() {
        guard self.refreshAfterPages, self.loading.isEmpty else { return }
        self.refreshAfterPages = false
        self.scheduleRefresh()
    }

    private func request(_ request: OpenClawChatGatewayRequest) async throws -> [SessionCatalog] {
        guard let connection, connection.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        return try await JSONDecoder().decode(SessionsCatalogListResult.self, from: connection.request(request))
            .catalogs
    }

    func refresh() async {
        let generation = self.generation
        // A catalog refreshed while paging may briefly show an older window; the next refresh repairs it.
        func eligible(_ id: String) -> Bool {
            !self.loading.contains(id)
        }
        do {
            var fresh = try await self.request(.catalogList(agentID: self.agentID))
            var errors: [String: String] = [:]
            var visited: [String: [String: Set<String>]] = [:]
            // app-sidebar-session-catalog-state.ts:143 replays expanded windows before replacing visible rows.
            for index in fresh.indices {
                let catalog = fresh[index]
                guard eligible(catalog.id) else { continue }
                let previous = self.catalogs.first { $0.id == catalog.id }
                var hosts: [SessionCatalogHost] = []
                for host in catalog.hosts {
                    var expanded = host
                    var seen = Set<String>()
                    do {
                        if catalog.error != nil || host.error != nil {
                            throw self.pageError(host: host, catalogError: catalog.error)
                        }
                        for _ in 0..<(self.pageDepths[catalog.id]?[host.hostid] ?? 0) {
                            guard self.current(generation) else { return }
                            guard eligible(catalog.id) else { break }
                            guard let cursor = expanded.nextcursor, !cursor.isEmpty else { break }
                            guard seen.insert(cursor).inserted else { throw self.pageError() }
                            let page = try await self.request(.catalogList(
                                agentID: self.agentID, catalogID: catalog.id, cursors: [host.hostid: cursor]))
                            let next = try self.pageHost(page, catalogID: catalog.id, hostID: host.hostid)
                            if let cursor = next.nextcursor, seen.contains(cursor) { throw self.pageError() }
                            expanded = Self.replacing(
                                next,
                                rows: Self.merge(expanded.sessions, next.sessions),
                                cursor: next.nextcursor)
                        }
                    } catch {
                        if let message = self.errorText(error) { errors[catalog.id] = message }
                        let retained = previous?.hosts.first { $0.hostid == host.hostid } ?? expanded
                        expanded = Self.replacing(
                            (error as? PageFailure)?.host ?? host,
                            rows: retained.sessions,
                            cursor: retained.nextcursor)
                        seen = self.visited[catalog.id]?[host.hostid] ?? []
                    }
                    visited[catalog.id, default: [:]][host.hostid] = seen
                    hosts.append(expanded)
                }
                fresh[index] = Self.replacing(catalog, hosts: hosts)
            }
            guard self.current(generation) else { return }
            let retained = self.catalogs.filter { !eligible($0.id) }
            // A skipped window still owns the event invalidation; retry once paging settles, not on its safety timer.
            self.refreshAfterPages = self.refreshAfterPages || !retained.isEmpty
            self.catalogs = fresh.compactMap { catalog in
                eligible(catalog.id) ? self.resumeDiscovery(catalog) : retained.first { $0.id == catalog.id }
            } + retained.filter { old in !fresh.contains { $0.id == old.id } }
            self.discovery = self.discovery.filter { id, _ in self.catalogs.contains { $0.id == id } }
            self.errors = self.errors.filter { !$0.key.isEmpty && !eligible($0.key) }
            self.errors.merge(errors.filter { eligible($0.key) }, uniquingKeysWith: { _, next in next })
            for catalog in fresh where eligible(catalog.id) {
                self.visited[catalog.id] = visited[catalog.id]
            }
            await self.discoverHiddenPages(generation: generation)
            if self.current(generation) { self.resumeRefreshAfterPages() }
        } catch {
            guard self.current(generation) else { return }
            self.errors[""] = error.localizedDescription
        }
    }

    private func resumeDiscovery(_ catalog: SessionCatalog) -> SessionCatalog {
        self.discovery[catalog.id] = self.discovery[catalog.id]?
            .filter { id, _ in catalog.hosts.contains { $0.hostid == id } }
        return Self.replacing(catalog, hosts: catalog.hosts.map { host in
            guard let sweep = self.discovery[catalog.id]?[host.hostid],
                  catalog.error == nil, host.error == nil, host.pending != true else { return host }
            // app-sidebar-session-catalog-live.ts:157 rechecks the head instead of replaying an empty prefix.
            guard host.sessions.isEmpty, host.nextcursor == sweep.head else {
                self.discovery[catalog.id]?[host.hostid] = nil
                return host
            }
            return Self.replacing(host, rows: host.sessions, cursor: sweep.cursor)
        })
    }

    private func discoverHiddenPages(generation: UUID) async {
        var stopped: [String: Set<String>] = [:]
        while self.current(generation) {
            var requested = false
            for catalog in self.catalogs where !self.hidden.contains(catalog.id) && catalog.error == nil &&
                !self.loading.contains(catalog.id) && !self.hasVisibleRows(catalog)
            {
                let hosts = Set(catalog.hosts.filter {
                    $0.nextcursor?.isEmpty == false && $0.pending != true && $0.error == nil &&
                        stopped[catalog.id]?.contains($0.hostid) != true
                }.map(\.hostid))
                guard !hosts.isEmpty else { continue }
                requested = true
                let advanced = await self.loadMore(catalog.id, hostIDs: hosts, discovering: true)
                guard self.current(generation) else { return }
                stopped[catalog.id, default: []].formUnion(hosts.subtracting(advanced))
            }
            if !requested { return }
        }
    }

    @discardableResult
    func loadMore(_ catalogID: String, hostIDs: Set<String>? = nil, discovering: Bool = false) async -> Set<String> {
        guard let catalog = self.catalogs.first(where: { $0.id == catalogID }),
              !self.loading.contains(catalogID), self.connection != nil else { return [] }
        let cursors: [String: String] = Dictionary(uniqueKeysWithValues: catalog.hosts.compactMap { host in
            guard hostIDs?.contains(host.hostid) != false, let cursor = host.nextcursor,
                  !cursor.isEmpty else { return nil }
            return (host.hostid, cursor)
        })
        guard !cursors.isEmpty else { return [] }
        var advanced = Set<String>()
        self.loading.insert(catalogID)
        let generation = self.generation
        defer {
            if self.generation == generation {
                self.loading.remove(catalogID)
                self.resumeRefreshAfterPages()
            }
        }
        do {
            let page = try await self.request(.catalogList(
                agentID: self.agentID, catalogID: catalogID, cursors: cursors))
            guard self.current(generation) else { return [] }
            self.errors.removeValue(forKey: catalogID)
            let hosts = catalog.hosts.map { host in
                guard let cursor = cursors[host.hostid] else { return host }
                do {
                    let next = try self.pageHost(page, catalogID: catalogID, hostID: host.hostid)
                    let sweep = self.discovery[catalogID]?[host.hostid]
                    var seen = sweep?.cursors ?? self.visited[catalogID]?[host.hostid] ?? []
                    seen.insert(cursor)
                    let repeated = next.nextcursor.map(seen.contains) == true
                    if repeated {
                        self.errors[catalogID] = self.pageError().message
                        self.discovery[catalogID]?[host.hostid] = nil
                    } else {
                        advanced.insert(host.hostid)
                        let depth = (sweep?.depth ?? self.pageDepths[catalogID]?[host.hostid] ?? 0) + 1
                        // session-data-controller-catalog.ts:452 keeps wholly empty discovery pages out of replay depth.
                        self.discovery[catalogID]?[host.hostid] = nil
                        if discovering, host.sessions.isEmpty, next.sessions.isEmpty,
                           self.pageDepths[catalogID]?[host.hostid] == nil
                        {
                            if let nextCursor = next.nextcursor, !nextCursor.isEmpty {
                                self.discovery[catalogID, default: [:]][host.hostid] = Discovery(
                                    head: sweep?.head ?? cursor, cursor: nextCursor, depth: depth, cursors: seen)
                            }
                        } else { self.pageDepths[catalogID, default: [:]][host.hostid] = depth }
                    }
                    self.visited[catalogID, default: [:]][host.hostid] = seen
                    return Self.replacing(
                        next,
                        rows: Self.merge(host.sessions, next.sessions),
                        cursor: next.nextcursor,
                        error: repeated ? [
                            "code": .init("PAGINATION_FAILED"),
                            "message": .init(self.pageError().message ?? ""),
                        ] : nil)
                } catch {
                    if let message = self.errorText(error) { self.errors[catalogID] = message }
                    return Self.replacing(
                        (error as? PageFailure)?.host ?? host,
                        rows: host.sessions,
                        cursor: host.nextcursor)
                }
            }
            self.catalogs = self.catalogs.map { $0.id == catalogID ? Self.replacing($0, hosts: hosts) : $0 }
        } catch {
            if self.current(generation) {
                self.errors[catalogID] = error.localizedDescription
            }
        }
        return advanced
    }

    @discardableResult
    func archive(_ catalog: SessionCatalog, host: SessionCatalogHost, row: SessionCatalogSession) async -> Bool {
        guard let connection, connection.isCurrent(), connection.allowsArchive, !Task.isCancelled,
              catalog.capabilities.archive, row.canarchive else { return false }
        let generation = self.generation
        do {
            _ = try await connection.request(.catalogArchive(
                agentID: self.agentID, catalogID: catalog.id, hostID: host.hostid, row: row))
            guard self.current(generation) else { return false }
            self.catalogs = self.catalogs.map { entry in
                entry.id != catalog.id ? entry : Self.replacing(entry, hosts: entry.hosts.map {
                    $0.hostid != host.hostid ? $0 : Self.replacing(
                        $0,
                        rows: $0.sessions.filter { $0.threadid != row.threadid },
                        cursor: $0.nextcursor)
                })
            }
            self.errors.removeValue(forKey: catalog.id)
            return true
        } catch {
            if self.current(generation) { self.errors[catalog.id] = error.localizedDescription }
            return false
        }
    }

    func setHidden(_ id: String, _ hidden: Bool) {
        self.reloadPreferences()
        if hidden { self.hidden.insert(id) } else { self.hidden.remove(id) }
        if let key = self.preferenceKey { self.defaults.set(self.hidden.sorted(), forKey: key + ".hidden") }
    }

    func setGrouping(_ grouping: Grouping) {
        self.grouping = grouping
        if let key = self.preferenceKey { self.defaults.set(grouping.rawValue, forKey: key + ".grouping") }
    }

    func reloadPreferences() {
        guard let key = self.preferenceKey else { return }
        self.hidden = Set(self.defaults.stringArray(forKey: key + ".hidden") ?? [])
        self.grouping = Grouping(rawValue: self.defaults.string(forKey: key + ".grouping") ?? "") ?? .project
    }

    func visible(archived: Bool) -> [SessionCatalog] {
        archived ? [] : self.catalogs.filter { !self.hidden.contains($0.id) }
    }

    func adoptedKeys(archived: Bool) -> Set<String> {
        // app-sidebar-session-catalogs.ts:95: the catalog wins; hiding it returns adopted rows to the ordinary roster.
        // A data-only host must not remove rows until its catalog presentation mounts.
        guard self.isRendered else { return [] }
        return Set(self.visible(archived: archived).flatMap(\.hosts).flatMap(\.sessions).compactMap(\.sessionkey))
    }

    static func filtered(_ rows: [SessionCatalogSession], owner: String?, live: [String: OpenClawChatSessionEntry])
        -> [SessionCatalogSession]
    {
        guard let owner else { return rows }
        return rows.filter { row in
            // app-sidebar-session-catalogs.ts:157: an unset live owner also overrides cached creator metadata.
            if let key = row.sessionkey, let live = live[key] {
                return live.owner?.actor.id == owner
            }
            return row.createdactor?.id == owner
        }
    }

    func groups(_ rows: [SessionCatalogSession]) -> [Group] {
        var groups: [Group] = []
        for row in rows {
            var id = "", label: String?
            if self.grouping == .project {
                let custom = row.customgroup?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
                let cwd = row.cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
                    .replacingOccurrences(of: #"[\\/]+$"#, with: "", options: .regularExpression) ?? ""
                // ui/src/lib/sessions/catalog-project-grouping.ts:27 folds nested worktrees to the outermost repository.
                let path = cwd.replacingOccurrences(
                    of: #"^(.*?)[\\/]\.claude[\\/]worktrees[\\/][^\\/].*$"#, with: "$1", options: .regularExpression)
                if !custom.isEmpty { id = "custom:" + custom
                    label = custom
                } else if !path.isEmpty { id = "project:" + path
                    label = path.split(whereSeparator: { $0 == "/" || $0 == "\\" }).last.map(String.init)
                }
            } else if self.grouping == .person, let actor = row.createdactor, let identity = actor.identity {
                switch identity {
                case let .profile(value): id = "profile:" + value.id
                    label = value.id
                case let .agent(value): id = "agent:" + value.id
                    label = value.id
                default:
                    let encoder = JSONEncoder()
                    encoder.outputFormatting = .sortedKeys
                    id = (try? encoder.encode(identity)).flatMap { String(data: $0, encoding: .utf8) } ?? ""
                }
                label = ChatPayloadDecoding.trimmedNonEmptyString(actor.label) ?? label
                id = "person:" + id
            }
            if let index = groups.firstIndex(where: { $0.id == id }) {
                groups[index].rows.append(row)
            } else {
                groups.append(Group(id: id, label: label, rows: [row]))
            }
        }
        return groups.sorted {
            if $0.id.isEmpty || $1.id.isEmpty { return !$0.id.isEmpty && $1.id.isEmpty }
            if self
                .grouping == .person { return ($0.label ?? "").localizedCompare($1.label ?? "") == .orderedAscending }
            return $0.id.hasPrefix("custom:") && !$1.id.hasPrefix("custom:")
        }
    }

    private func pageError(host: SessionCatalogHost? = nil, catalogError: [String: AnyCodable]? = nil) -> PageFailure {
        let error = catalogError ?? host?.error
        let code = error?["code"]?.value as? String
        let text = [code.map { "[\($0)]" }, error?["message"]?.value as? String].compactMap(\.self)
            .joined(separator: " ")
        // app-sidebar-session-catalogs.ts:111: offline hosts retain their badge, without a catalog failure banner.
        return PageFailure(
            host: host,
            message: catalogError == nil && code == "NODE_OFFLINE" ? nil :
                (text.isEmpty ? String(localized: "Could not load the next catalog page. Retry.") : text))
    }

    private func errorText(_ error: Error) -> String? {
        if let failure = error as? PageFailure { return failure.message }
        return error.localizedDescription
    }

    private func pageHost(_ page: [SessionCatalog], catalogID: String, hostID: String) throws -> SessionCatalogHost {
        guard let catalog = page.first(where: { $0.id == catalogID }) else { throw self.pageError() }
        let host = catalog.hosts.first(where: { $0.hostid == hostID })
        guard let host, catalog.error == nil, host.error == nil else {
            throw self.pageError(host: host, catalogError: catalog.error)
        }
        return host
    }

    private static func merge(
        _ first: [SessionCatalogSession],
        _ second: [SessionCatalogSession]) -> [SessionCatalogSession]
    {
        var seen = Set(first.map(\.threadid))
        return first + second.filter { seen.insert($0.threadid).inserted }
    }

    private static func replacing(_ catalog: SessionCatalog, hosts: [SessionCatalogHost]) -> SessionCatalog {
        .init(
            id: catalog.id,
            label: catalog.label,
            capabilities: catalog.capabilities,
            shareroute: catalog.shareroute,
            hosts: hosts,
            error: catalog.error)
    }

    // app-sidebar-session-catalog-state.ts:61 retains only the loaded window, never stale host capabilities.
    private static func replacing(
        _ host: SessionCatalogHost,
        rows: [SessionCatalogSession],
        cursor: String?,
        error: [String: AnyCodable]? = nil) -> SessionCatalogHost
    {
        .init(
            hostid: host.hostid,
            label: host.label,
            kind: host.kind,
            connected: host.connected,
            pending: host.pending,
            nodeid: host.nodeid,
            canstartterminal: host.canstartterminal,
            sessions: rows,
            nextcursor: cursor,
            error: error ?? host.error)
    }
}
#endif
