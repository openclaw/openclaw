#if os(macOS)
import Foundation
import Observation
import OpenClawProtocol

@MainActor @Observable
final class ChatSessionSidebarChildren {
    struct Scope: Equatable {
        let owner: ObjectIdentifier
        let revision: Int
        let query: OpenClawChatSidebarQuery

        @MainActor init(_ owner: OpenClawChatSessionSidebarData) {
            self.owner = ObjectIdentifier(owner)
            self.revision = owner.scopeRevision
            self.query = owner.query
        }
    }

    private struct Window {
        let key: String
        let ids: [String]
        let sessionID: String?
        var generation: Int
    }

    struct LineageSelection: Equatable {
        let identity: String
        let sessionID: String?
        let parentKey: String?

        init(identity: String, session: OpenClawChatSessionEntry?) {
            self.identity = identity
            self.sessionID = session?.sessionId
            self.parentKey = (ChatPayloadDecoding.trimmedNonEmptyString(session?.parentSessionKey) ??
                ChatPayloadDecoding.trimmedNonEmptyString(session?.spawnedBy)).map(ChatSessionSidebarModel.sidebarKey)
        }
    }

    private var scope: Scope?
    private var windows: [String: Window] = [:]
    private var lineage: [String: [String]] = [:]
    private var rootID: String?
    private var lineageSelection: LineageSelection?
    private var demanded: Set<String> = []
    private var attempt = 0
    private(set) var errors: [String: String] = [:]
    private(set) var lineageError: String?
    private(set) var loading: Set<String> = []

    static func key(for row: OpenClawChatSessionEntry) -> String {
        OpenClawChatSessionSidebarData.identity(row)
    }

    func homeSession(model: OpenClawChatViewModel, agentID: String? = nil) -> OpenClawChatSessionEntry {
        let agent = agentID ?? model.selectedAgentID
        let key = agentID.map { model.mainSessionKey(forAgent: $0) } ?? model.selectedAgentMainSessionKey
        let rows = ["global", key, "main", model.sessionKey].compactMap {
            model.rosterEntry(key: $0, agentID: agent)
        } + model.sessions + (model.sidebarData.map { self.supplementaryRows(owner: $0) } ?? [])
        var home = rows.first { model.matchesCurrentSessionKey(
            incoming: $0.key, agentId: $0.agentId, current: key)
        } ?? .init(key: key)
        home.agentId = agent
        return home
    }

    private func currentWindows(_ owner: OpenClawChatSessionSidebarData) -> [String: Window] {
        self.windows.filter { owner.project([$0.key]).first?.sessionId == $0.value.sessionID }
    }

    func supplementaryRows(owner: OpenClawChatSessionSidebarData) -> [OpenClawChatSessionEntry] {
        guard self.owns(owner) else { return [] }
        let windows = self.currentWindows(owner)
        let ids = windows.values.flatMap(\.ids) + self.lineage.values.flatMap(\.self) + [self.rootID]
            .compactMap(\.self)
        let parents = Dictionary(windows.sorted { $0.key < $1.key }.flatMap { _, window in
            window.ids.map { ($0, window.key) }
        }, uniquingKeysWith: { first, _ in first })
        return OpenClawChatSessionListOrganizer.organize(owner.project(Array(Set(ids)).sorted())).map { row in
            var row = row
            // app-sidebar-session-parent.ts:43: child-side ancestry wins over parent-owned discovery.
            if row.parentSessionKey == nil, row.spawnedBy == nil {
                row.parentSessionKey = parents[Self.key(for: row)]
            }
            return row
        }
    }

    func childrenKeysByParent(owner: OpenClawChatSessionSidebarData) -> [String: [String]] {
        guard self.owns(owner) else { return [:] }
        return Dictionary(self.currentWindows(owner).compactMap { parent, window in
            // Only a complete, current window may erase a parent's discovery links.
            guard window.generation == (owner.queryState?.generation ?? 0),
                  !self.loading.contains(parent), self.errors[parent] == nil else { return nil }
            let ids = window.ids + (self.lineage[parent] ?? [])
            return (window.key, Array(Set(owner.project(ids).map(\.key))).sorted())
        }, uniquingKeysWith: { first, last in Array(Set(first + last)).sorted() })
    }

    func lineageRootKey(owner: OpenClawChatSessionSidebarData) -> String? {
        self.owns(owner) ? self.rootID.flatMap { owner.project([$0]).first?.key } : nil
    }

    private func owns(_ owner: OpenClawChatSessionSidebarData) -> Bool {
        self.scope == Scope(owner)
    }

    func invalidate() {
        self.attempt += 1
        self.scope = nil
        self.windows = [:]
        self.lineage = [:]
        self.rootID = nil
        self.lineageSelection = nil
        self.lineageError = nil
        self.demanded = []
        self.errors = [:]
        self.loading = []
    }

    func synchronize(model: OpenClawChatViewModel, requiredParents: [OpenClawChatSessionEntry]) async {
        guard let owner = model.sidebarData, owner.query.search.isEmpty, model.healthOK,
              !model.isTransportDetached
        else {
            self.invalidate()
            return
        }
        let scope = Scope(owner)
        if self.scope != scope {
            self.invalidate()
            self.scope = scope
        }
        self.attempt += 1
        let attempt = self.attempt
        let generation = owner.queryState?.generation ?? 0
        let selection = model.currentSessionSnapshot()
        self.demanded = Set(requiredParents.map(Self.key))
        self.loading = []
        // Root refreshes invalidate successful child windows, not explicit retry errors.
        // ui/src/components/app-sidebar-child-session-data.ts:313 retains routed ancestry on retirement.
        self.windows = self.windows.filter {
            self.demanded.contains($0.key) || $0.value.generation == generation || self.errors[$0.key] != nil
        }
        guard !owner.isLoading else { return }
        let isCurrent = {
            !Task.isCancelled && self.attempt == attempt && model.sidebarData === owner && model.healthOK &&
                model.isCurrentSession(selection) && Scope(owner) == scope &&
                (owner.queryState?.generation ?? 0) == generation
        }
        let selectedID = Self.identity(key: selection.key, agentID: selection.deliveryAgentID)
        let selectedRow = owner.project([selectedID]).first ??
            (owner.rows + self.supplementaryRows(owner: owner)).first { model.matchesCurrentSessionKey(
                incoming: $0.key, agentId: $0.agentId, current: selection.key) }
        let lineageSelection = LineageSelection(identity: selectedID, session: selectedRow)
        // ui/src/components/session-lineage-controller.ts:302 retires failures on incarnation or parent changes.
        if self.lineageSelection != lineageSelection {
            self.lineage = [:]
            self.rootID = nil
            self.lineageError = nil
        }
        self.lineageSelection = lineageSelection
        if self.lineageError == nil {
            await self.discoverLineage(model: model, owner: owner, isCurrent: isCurrent)
            guard isCurrent() else { return }
        }
        for parent in requiredParents {
            guard isCurrent() else { return }
            let id = Self.key(for: parent)
            if let held = self.windows[id], held.sessionID != parent.sessionId {
                self.windows[id] = nil
                self.errors[id] = nil
            }
            guard self.errors[id] == nil, self.windows[id]?.generation != generation else { continue }
            if self.windows[id] == nil {
                self.windows[id] = Window(key: parent.key, ids: [], sessionID: parent.sessionId, generation: -1)
            }
            self.loading.insert(id)
            defer { if self.attempt == attempt { self.loading.remove(id) } }
            let read = owner.beginRead()
            let valid = {
                isCurrent() && self.demanded.contains(id) &&
                    (owner.project([id]).first.map { $0.sessionId == parent.sessionId } ?? (parent.sessionId == nil))
            }
            do {
                // ui/src/lib/sessions/child-session-data.ts:9 keeps child owners unscoped.
                let lease = await model.defaultTransport.acquireSwarmRouteLease()
                guard valid() else { continue }
                guard let lease else {
                    self.errors[id] = String(localized: "Could not load child sessions. Try again.")
                    continue
                }
                let result = try await lease.listChildSessions(parentKey: parent.key)
                guard valid() else { continue }
                guard result.isComplete else {
                    // ui/src/lib/sessions/child-session-data.ts:54: partial pages never certify a child window.
                    self.errors[id] = String(localized: "The child session list kept changing. Try again.")
                    continue
                }
                let ids = owner.receive(result.rows, read: read)
                self.windows[id] = Window(
                    key: parent.key,
                    ids: ids,
                    sessionID: parent.sessionId,
                    generation: generation)
            } catch {
                guard valid() else { continue }
                self.errors[id] = error.localizedDescription
            }
        }
    }

    func retry(parent: OpenClawChatSessionEntry, model: OpenClawChatViewModel) async {
        guard let owner = model.sidebarData, self.owns(owner), !owner.isLoading else { return }
        let id = Self.key(for: parent)
        let selectedID = Self.identity(key: model.sessionKey, agentID: model.currentSessionSnapshot().deliveryAgentID)
        guard self.errors[id] != nil || (id == selectedID && self.lineageError != nil),
              self.demanded.contains(id) || id == selectedID,
              owner.project([id]).first.map({ $0.sessionId == parent.sessionId }) ?? (parent.sessionId == nil)
        else { return }
        self.errors[id] = nil
        self.windows[id]?.generation = -1
        if id == selectedID { self.lineageError = nil }
        let parents = owner.project(Array(self.demanded.subtracting([id])).sorted())
        await self.synchronize(model: model, requiredParents: parents + [parent])
    }

    private func discoverLineage(
        model: OpenClawChatViewModel, owner: OpenClawChatSessionSidebarData, isCurrent: () -> Bool) async
    {
        struct Descriptor: Decodable { let session: OpenClawChatSessionEntry? }
        guard let transport = model.defaultTransport as? any OpenClawChatSidebarTransport else { return }
        var key = model.sessionKey
        var agentID = model.currentSessionSnapshot().deliveryAgentID
        let selectedID = Self.identity(key: key, agentID: agentID)
        let known = Set((owner.rows + self.supplementaryRows(owner: owner)).map(Self.key))
        var visited = Set<String>(), links: [String: [String]] = [:]
        var root: String?
        do {
            let request = try await transport.acquireSidebarRequest()
            guard isCurrent() else { return }
            // ui/src/components/app-sidebar-child-session-data.ts:78 bounds persisted ancestry and cycles.
            for _ in 0..<16 {
                let id = Self.identity(key: key, agentID: agentID)
                guard visited.insert(id).inserted else { break }
                var row = known.contains(id) ? owner.project([id]).first : nil
                if row == nil {
                    var params = ["key": AnyCodable(key)]
                    if OpenClawChatSessionKey.agentID(from: key) == nil, let agentID {
                        params["agentId"] = AnyCodable(agentID)
                    }
                    let read = owner.beginRead()
                    let data = try await request(.init(method: "sessions.describe", params: params, timeoutMs: 15000))
                    guard isCurrent() else { return }
                    guard var described = try JSONDecoder().decode(Descriptor.self, from: data).session else { break }
                    described.agentId = described.agentId ?? agentID
                    row = owner.project(owner.receive([described], read: read)).first
                }
                guard let row else { break }
                if visited.count == 1 {
                    self.lineageSelection = LineageSelection(identity: selectedID, session: row)
                }
                let rowID = Self.key(for: row)
                root = rowID
                guard let parent = ChatPayloadDecoding.trimmedNonEmptyString(row.parentSessionKey) ??
                    ChatPayloadDecoding.trimmedNonEmptyString(row.spawnedBy) else { break }
                agentID = OpenClawChatSessionKey.agentID(from: parent) ??
                    OpenClawChatSessionKey.agentID(from: row.key) ?? row.agentId ?? agentID
                links[Self.identity(key: parent, agentID: agentID), default: []].append(rowID)
                key = parent
            }
        } catch {
            guard isCurrent() else { return }
            self.lineageError = error.localizedDescription
        }
        guard isCurrent() else { return }
        self.lineage = links
        self.rootID = root
    }

    private static func identity(key: String, agentID: String?) -> String {
        var row = OpenClawChatSessionEntry(key: key)
        row.agentId = agentID
        return Self.key(for: row)
    }
}
#endif
