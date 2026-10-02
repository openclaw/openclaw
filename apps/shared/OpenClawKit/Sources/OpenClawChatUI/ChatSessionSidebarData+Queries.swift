import Foundation
import OpenClawProtocol

extension OpenClawChatSidebarStatus {
    func includes(_ session: OpenClawChatSessionEntry, now: Date) -> Bool {
        switch self {
        case .active: !session.isArchived && !session.isSnoozed(at: now)
        case .snoozed: !session.isArchived && session.isSnoozed(at: now)
        case .archived: session.isArchived
        case .all: true
        }
    }
}

struct ChatSidebarTranscriptResult: Decodable {
    let results: [SessionsSearchHit]
    let sessions: [OpenClawChatSessionEntry]?
    let indexing: Bool?
    let archivedTranscriptsExcluded: Int?
}

struct ChatSidebarQueryState {
    let transport: any OpenClawChatSidebarTransport
    var query: OpenClawChatSidebarQuery
    var page: OpenClawChatSessionsListResponse?
    var owners: [OpenClawChatSessionEntry.CreatedActor]?
    var pageIDs: [String] = []
    var searchIDs: [String]?
    var metadataIDs: Set<String> = []
    var hits: [SessionsSearchHit] = []
    var generation = 0
    var loading = false
    var error: String?
    var indexing = false
    var excluded = 0
    var didLoad = false
    var failedAppend = false
    var refreshPending = false
}

extension OpenClawChatSessionSidebarData {
    public var isQueryEnabled: Bool {
        self.queryState != nil
    }

    public var query: OpenClawChatSidebarQuery {
        self.queryState?.query ?? .init(agentID: nil)
    }

    var owners: [OpenClawChatSessionEntry.CreatedActor]? {
        self.queryState?.owners
    }

    public var agentScope: OpenClawChatSidebarAgentScope {
        self.isQueryEnabled && self.query.agentID == nil ? .all : .selected
    }

    public var isLoading: Bool {
        self.queryState?.loading == true
    }

    public var errorText: String? {
        self.queryState?.error
    }

    public var searchIndexing: Bool {
        self.queryState?.indexing == true
    }

    public var archivedTranscriptsExcluded: Int {
        self.queryState?.excluded ?? 0
    }

    public var rows: [OpenClawChatSessionEntry] {
        self.rows(at: .now)
    }

    public func rows(at now: Date) -> [OpenClawChatSessionEntry] {
        self.queryRows.filter { self.query.status.includes($0, now: now) }
    }

    /// Cache query membership and ranking; time-dependent visibility uses the caller's clock.
    var queryRows: [OpenClawChatSessionEntry] {
        guard let state = self.queryState else { return [] }
        return self.cachedProjection(.sidebar) {
            let candidates: [OpenClawChatSessionEntry] = if let ids = state.searchIDs {
                self.project(ids)
            } else if state.page == nil, state.query.agentID != nil, state.query.wire.status == .active,
                      state.query.involvingMe != true
            {
                self.conversationRows(agentID: state.query.agentID)
            } else {
                self.project(state.pageIDs)
            }
            let rows = candidates.filter {
                state.query.involvingMe == true || state.query.ownerId == nil || $0.owner?.actor.id == state.query
                    .ownerId
            }
            return state.query.search.isEmpty ? rows : Self.ranked(rows, state: state)
        }
    }

    public var nextOffset: Int? {
        guard let state = self.queryState, state.query.agentID != nil, state.query.search.isEmpty,
              let page = state.page, page.hasMore == true else { return nil }
        // ui/src/components/session-data-controller-events.ts:197 distinguishes missing from explicit null.
        return page.nextOffsetPresent ? page.nextOffset : state.pageIDs.count
    }

    var rowsIncludingLoadedDescendants: [OpenClawChatSessionEntry] {
        guard self.query.search.isEmpty, self.query.ownerId != nil,
              self.query.involvingMe != true else { return self.queryRows }
        return self.cachedProjection(.sidebarTree) {
            var rows = self.queryRows
            var seen = Set(rows.map(Self.identity))
            var index = 0
            // Owner membership hides navigation rows, not facts from already-loaded, linked children.
            while index < rows.count {
                let parent = rows[index]
                let agentID = OpenClawChatSessionKey.agentID(from: parent.key) ?? parent.agentId ?? self.query.agentID
                for key in parent.childSessions ?? [] {
                    if let child = self.row(key: key, agentID: agentID), seen.insert(Self.identity(child)).inserted {
                        rows.append(child)
                    }
                }
                index += 1
            }
            return rows
        }
    }

    public var isSettled: Bool {
        guard let state = self.queryState else { return false }
        // ui/src/components/command-palette-view.ts:286; sidebar-agent-roster.ts:256 also excludes truncated windows.
        return state.didLoad && !state.loading && state.error == nil && !state.indexing && state.excluded == 0 &&
            (!state.query.search.isEmpty || state.page?.hasMore != true)
    }

    func configureQueries(transport: any OpenClawChatSidebarTransport, query: OpenClawChatSidebarQuery) {
        guard self.queryState == nil else {
            self.setQuery(query)
            return
        }
        self.queryState = ChatSidebarQueryState(transport: transport, query: query)
        self.invalidateQueryProjection()
    }

    @discardableResult
    public func setQuery(_ query: OpenClawChatSidebarQuery) -> Bool {
        guard let state = self.queryState else { return false }
        let query = OpenClawChatSidebarQuery(
            agentID: query.agentID,
            status: query.status,
            search: query.search,
            ownerId: query.ownerId,
            involvingMe: query.involvingMe,
            excludeCron: query.excludeCron,
            excludeSystem: query.excludeSystem)
        guard state.query != query else { return false }
        let changed = state.query.wire != query.wire
        if changed {
            var previousScope = state.query, nextScope = query
            previousScope.search = ""
            nextScope.search = ""
            self.invalidateQuery(clear: previousScope.wire != nextScope.wire)
            self.queryState?.searchIDs = nil
            self.queryState?.metadataIDs = []
            self.queryState?.hits = []
        }
        self.queryState?.query = query
        self.invalidateQueryProjection()
        return changed
    }

    public func invalidateQuery(clear: Bool = false) {
        self.queryTask?.cancel()
        self.queryTask = nil
        self.queryState?.generation += 1
        self.queryState?.loading = false
        self.queryState?.error = nil
        self.queryState?.indexing = false
        self.queryState?.excluded = 0
        self.queryState?.didLoad = false
        self.queryState?.refreshPending = false
        if clear {
            self.queryState?.searchIDs = nil
            self.queryState?.metadataIDs = []
            self.queryState?.hits = []
            self.queryState?.page = nil
            self.queryState?.owners = nil
            self.queryState?.pageIDs = []
        }
        self.invalidateQueryProjection()
    }

    public func scheduleLoad(debounce: Bool = false, coalescing: Bool = false) {
        // ui/src/lib/sessions/event-refresh-coordinator.ts:18 retains one trailing invalidation.
        if coalescing, self.isLoading {
            self.queryState?.refreshPending = true
            return
        }
        self.queryTask?.cancel()
        self.queryTask = Task { [weak self] in await self?.load(debounce: debounce) }
    }

    public func retry() async {
        await self.load(append: self.queryState?.failedAppend == true)
    }

    public func load(append: Bool = false, debounce: Bool = false) async {
        guard let state = self.queryState, !append || (!state.loading && self.nextOffset != nil) else { return }
        self.queryState?.generation += 1
        let generation = self.queryState?.generation
        let query = state.query
        let allAgents = query.agentID == nil && query.search.isEmpty
        var offset = append ? self.nextOffset ?? 0 : 0
        self.queryState?.loading = true
        self.queryState?.error = nil
        self.queryState?.failedAppend = append
        defer {
            if generation == self.queryState?.generation {
                self.queryState?.loading = false
                if self.queryState?.refreshPending == true {
                    self.queryState?.refreshPending = false
                    self.scheduleLoad()
                }
            }
        }
        do {
            if debounce { try await Task.sleep(for: .milliseconds(200)) }
            guard generation == self.queryState?.generation, !Task.isCancelled else { return }
            if !query.search.isEmpty, query.search.utf16.count < 2 {
                self.queryState?.didLoad = true
                return
            }
            let request = try await state.transport.acquireSidebarRequest()
            guard generation == self.queryState?.generation, !Task.isCancelled else { return }
            let read = self.beginRead()
            async let transcript = Self.searchTranscripts(query: query, request: request)
            var page = append && offset > 0 ? state.page : nil
            var incoming: [OpenClawChatSessionEntry] = []
            var ids = page != nil ? state.pageIDs : []
            var seen = Set(ids)
            // The Gateway enriches only 100 rows per response (src/shared/session-list-limits.ts).
            // Page retained windows too; otherwise a refresh clears older titles and previews.
            let limit = !query.search.isEmpty ? 10 : allAgents ? 300 : append ? 100 :
                max(100, state.pageIDs.count, self.rows.count)
            for consumed in stride(from: 0, to: limit, by: 100) {
                let payload = try await request(OpenClawChatGatewayRequests.sidebarSessions(
                    query: query,
                    limit: min(100, limit - consumed),
                    offset: offset))
                let next = try OpenClawChatGatewayPayloadCodec.decodeSessionsList(payload, agentID: query.agentID)
                guard generation == self.queryState?.generation, !Task.isCancelled else { return }
                // ui/src/lib/sessions/session-managed-list-refresh.ts:128 discards duplicate page facts.
                incoming += next.sessions.filter { seen.insert(Self.identity($0)).inserted }
                page = Self.appendPage(next, previous: page, count: seen.count)
                if next.hasMore != true || next.sessions.isEmpty { break }
                offset = next.nextOffset ?? offset + next.sessions.count
            }
            let search = await transcript
            guard generation == self.queryState?.generation, !Task.isCancelled, var page else { return }
            // Search and browsing share the complete facet, independently of retained page membership.
            self.queryState?.owners = page.owners
            if !query.search.isEmpty {
                self.queryState?.metadataIDs = Set(incoming.map(Self.identity))
                incoming += (search.0?.sessions ?? []).filter { seen.insert(Self.identity($0)).inserted }
                self.queryState?.searchIDs = incoming.map(Self.identity)
                self.queryState?.hits = search.0?.results ?? []
                self.queryState?.indexing = search.0?.indexing == true
                self.queryState?.excluded = search.0?.archivedTranscriptsExcluded ?? 0
                self.queryState?.error = search.1
            } else {
                ids += incoming.map(Self.identity)
                page.count = ids.count
                page.sessions = []
                self.queryState?.page = page
                self.queryState?.pageIDs = ids
            }
            self.queryState?.didLoad = true
            self.invalidateQueryProjection()
            self.receive(incoming, read: read, enriched: query.search.isEmpty)
        } catch {
            guard generation == self.queryState?.generation, !Task.isCancelled else { return }
            self.queryState?.error = error.localizedDescription
        }
    }

    private static func appendPage(
        _ page: OpenClawChatSessionsListResponse, previous: OpenClawChatSessionsListResponse?, count: Int)
        -> OpenClawChatSessionsListResponse
    {
        guard let previous else { return page }
        var page = page
        // ui/src/lib/sessions/reconcile.ts:76 normalizes cursors only when appending to a held page.
        page.totalCount = page.totalCount ?? previous.totalCount
        page.hasMore = page.hasMore ?? page.totalCount.map { count < $0 } ?? false
        page.nextOffset = page.nextOffset ?? (page.hasMore == true ? count : nil)
        page.nextOffsetPresent = true
        return page
    }

    private static func searchTranscripts(
        query: OpenClawChatSidebarQuery,
        request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data) async
        -> (ChatSidebarTranscriptResult?, String?)
    {
        guard !query.search.isEmpty else { return (nil, nil) }
        do {
            let data = try await request(OpenClawChatGatewayRequests.sidebarTranscriptSearch(query: query))
            return try (JSONDecoder().decode(ChatSidebarTranscriptResult.self, from: data), nil)
        } catch { return (nil, error.localizedDescription) }
    }

    private static func ranked(
        _ rows: [OpenClawChatSessionEntry],
        state: ChatSidebarQueryState) -> [OpenClawChatSessionEntry]
    {
        let query = state.query.search.lowercased()
        // Preserve the existing offline matcher only until authoritative search membership arrives.
        let metadataIDs = state.searchIDs == nil ?
            Set(OpenClawChatSessionListOrganizer.filter(rows, search: query).map(Self.identity)) : state.metadataIDs
        var hits: [String: Double] = [:]
        for hit in state.hits where hits["\(hit.sessionkey)\u{0}\(hit.sessionid)"] == nil {
            hits["\(hit.sessionkey)\u{0}\(hit.sessionid)"] = hit.score
        }
        // ui/src/components/command-palette-session-search.ts:13; labels use the native title owner.
        return rows.map { row in
            let fields = [
                ChatSessionSidebarModel.displayName(for: row),
                row.key,
                row.label,
                row.subject,
                row.category,
                row.kind,
                row.model,
                row.modelProvider,
                row.owner?.actor.label,
                row.owner?.actor.id,
                row.createdActor?.label,
                row.createdActor?.id,
            ]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() }
            let rank = fields.contains(query) ? 3 : fields.contains { $0.hasPrefix(query) } ? 2 :
                fields.contains { $0.contains(query) } ? 1 : 0
            return (
                row: row,
                rank: max(rank, metadataIDs.contains(Self.identity(row)) ? 1 : 0),
                score: row.sessionId.flatMap { hits["\(row.key)\u{0}\($0)"] })
        }.filter { $0.rank > 0 || $0.score != nil }.sorted {
            if $0.rank != $1.rank { return $0.rank > $1.rank }
            if $0.score != $1.score { return ($0.score ?? -.infinity) > ($1.score ?? -.infinity) }
            return ($0.row.updatedAt ?? 0) > ($1.row.updatedAt ?? 0)
        }.map(\.row)
    }
}
