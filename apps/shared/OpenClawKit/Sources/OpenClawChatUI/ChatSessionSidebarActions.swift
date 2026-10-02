#if os(macOS)
import AppKit
import Observation
import OpenClawKit
import OpenClawProtocol

@MainActor
public struct OpenClawSessionMenuConnection {
    public let hello: HelloOk
    public let local: Bool
    public var groupDefaultsBrowser: OpenClawGroupDefaultsBrowser?
    public let selfProfileID: String?
    public let isCurrent: () -> Bool
    private let sendRequest: (OpenClawChatGatewayRequest) async throws -> Data
    public let link: (OpenClawChatSessionEntry, Bool) -> URL?
    public let openWindow: (OpenClawChatSessionEntry) -> Void

    public init(
        hello: HelloOk,
        local: Bool,
        selfProfileID: String? = nil,
        isCurrent: @escaping () -> Bool,
        request: @escaping (OpenClawChatGatewayRequest) async throws -> Data,
        link: @escaping (OpenClawChatSessionEntry, Bool) -> URL?,
        openWindow: @escaping (OpenClawChatSessionEntry) -> Void)
    {
        self.hello = hello
        self.local = local
        self.selfProfileID = selfProfileID
        self.isCurrent = isCurrent
        self.sendRequest = request
        self.link = link
        self.openWindow = openWindow
    }

    func allows(_ method: String, scope: String = "operator.write") -> Bool {
        let methods = self.hello.features["methods"]?.value as? [AnyCodable] ?? []
        let scopes = (self.hello.auth["scopes"]?.value as? [AnyCodable] ?? []).compactMap { $0.value as? String }
        let broadRead = scopes.contains("operator.read") || scopes.contains("operator.write")
        let scopedRead = broadRead || scopes.contains("operator.sessions.write")
        return self.isCurrent() && methods.contains(.init(method)) &&
            (scopes.contains("operator.admin") || scopes.contains(scope) ||
                (scope == "operator.read" && broadRead) || (scope == "operator.sessions.read" && scopedRead))
    }

    func read<T: Decodable>(_ method: String, _ params: [String: OpenClawProtocol.AnyCodable] = [:]) async throws -> T {
        try await JSONDecoder().decode(
            T.self,
            from: self.request(.init(method: method, params: params, timeoutMs: 15000)))
    }

    @discardableResult
    public func request(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        let data = try await self.sendRequest(request)
        guard self.isCurrent(), !Task.isCancelled else { throw CancellationError() }
        return data
    }
}

@MainActor
@Observable
final class ChatSessionSidebarActions {
    struct Profile: Decodable {
        let id: String
        let displayName: String?
        let emails: [String]
        let mergedInto: String?
        let githubIdentity: GitHub?
        struct GitHub: Decodable { let login: String }
    }

    struct Owner: Identifiable {
        let type: String
        let key: String
        let label: String
        var id: String {
            "\(self.type):\(self.key)"
        }
    }

    let connection: OpenClawSessionMenuConnection?
    private var profiles: [Profile]?
    private var selfID: String?
    private var worktrees: [WorktreeRecord] = []
    var directoryError: String?
    var loadingOwners = false
    @ObservationIgnored private(set) var refreshTask: Task<Void, Never>?
    @ObservationIgnored private var nextRefresh: ContinuousClock.Instant?

    init(connection: OpenClawSessionMenuConnection? = nil) {
        self.connection = connection
        self.selfID = connection?.selfProfileID
    }

    @discardableResult
    func refresh(at now: ContinuousClock.Instant = .now, ifStale: Bool = false) -> Task<Void, Never>? {
        if let refreshTask { return refreshTask }
        guard let connection, connection.isCurrent() else { return nil }
        if ifStale, let nextRefresh, now < nextRefresh { return nil }
        // Rate-limit failed automatic attempts too; read-triggered rerenders must not create a retry loop.
        self.nextRefresh = now.advanced(by: .seconds(60))
        self.refreshTask = Task {
            self.loadingOwners = true
            await self.loadOwners()
            // ui/src/components/session-menu-work.ts:51: loopback cannot prove locality (SSH tunnels).
            if connection.local, let result: WorktreesListResult = try? await connection.read("worktrees.list"),
               connection.isCurrent(), !Task.isCancelled { self.worktrees = result.worktrees }
            self.loadingOwners = false
            self.refreshTask = nil
        }
        return self.refreshTask
    }

    func worktreePath(for session: OpenClawChatSessionEntry, at now: ContinuousClock.Instant = .now) -> String? {
        self.refresh(at: now, ifStale: true)
        guard self.connection?.isCurrent() == true, session.execNode == nil, let id = session.worktree?.id else {
            return nil
        }
        return self.worktrees.first { $0.id == id && $0.removedat == nil }?.path
    }

    private func loadOwners() async {
        guard let connection else { return }
        struct Directory: Decodable { let profiles: [Profile] }
        struct SelfProfile: Decodable { let profile: Profile }
        let me = try? await (connection.read("users.self") as SelfProfile).profile
        var profiles: [Profile]?
        var directoryError: String?
        do {
            let directory: Directory = try await connection.read("users.list")
            profiles = directory.profiles.filter { $0.mergedInto == nil }
        } catch { directoryError = error.localizedDescription }
        guard connection.isCurrent(), !Task.isCancelled else { return }
        self.selfID = me?.id ?? self.selfID
        self.profiles = profiles ?? self.profiles
        self.directoryError = directoryError
    }

    func owners(
        session: OpenClawChatSessionEntry,
        agents: [OpenClawChatAgentChoice],
        at now: ContinuousClock.Instant = .now) -> [Owner]
    {
        self.refresh(at: now, ifStale: true)
        var humans: [Owner] = self.profiles?.map { profile in
            let label = ChatPayloadDecoding.trimmedNonEmptyString(profile.displayName) ??
                profile.githubIdentity?.login ?? profile.emails.first ?? profile.id
            return Owner(type: "human", key: profile.id, label: label)
        } ?? []
        let current = session.owner?.actor
        if self.profiles == nil, current?.type == "human", let id = Self.ownerID(current) {
            humans = [.init(type: "human", key: id, label: current?.label ?? id)]
        }
        // ui/src/components/session-owner-menu.ts:59: retain the known owner on directory failure; Me leads.
        var owners = (humans.filter { $0.key != self.selfID } + agents.map {
            Owner(type: "agent", key: $0.id, label: $0.displayName)
        }).sorted {
            if $0.type != $1.type { return $0.type < $1.type }
            let order = $0.label.localizedCompare($1.label)
            return order == .orderedSame ? $0.key < $1.key : order == .orderedAscending
        }
        if let selfID { owners.insert(.init(type: "human", key: selfID, label: String(localized: "Me")), at: 0) }
        return owners
    }

    static func canMoveToGroup(_ row: OpenClawChatSessionEntry, mainKeys: [String]) -> Bool {
        if row.category?.isEmpty == false { return true }
        guard let parent = ChatPayloadDecoding.trimmedNonEmptyString(row.parentSessionKey) ??
            ChatPayloadDecoding.trimmedNonEmptyString(row.spawnedBy) else { return true }
        let normalize = { (key: String) in key.lowercased() == "main" ? "agent:main:main" : key.lowercased() }
        let key = row.key.lowercased()
        let rest = key.hasPrefix("agent:") ? String(key.split(separator: ":", maxSplits: 2).last ?? "") : key
        // ui/src/components/app-sidebar-session-parent.ts:17: an implicit Home notice link is not visual ancestry.
        return row.createdVia == "operator" && row.spawnDepth == 0 && row.parentSessionId == nil &&
            row.spawnedBy == nil && row.forkSource == nil && row.forkedFromParent != true &&
            !rest.hasPrefix("subagent:") && mainKeys.contains { normalize($0) == normalize(parent) }
    }

    static func ownerID(_ actor: OpenClawChatSessionEntry.CreatedActor?) -> String? {
        actor?.identity.flatMap { try? GatewayPayloadDecoding.decode($0, as: [String: String].self)["id"] } ?? actor?.id
    }

    static func editorURL(_ editor: String, path: String) -> URL? {
        guard ["cursor", "vscode", "windsurf", "zed"].contains(editor), path.hasPrefix("/") else { return nil }
        let segments = path.replacingOccurrences(of: "\\", with: "/").split(
            separator: "/",
            omittingEmptySubsequences: false).map {
            String($0)
                .addingPercentEncoding(
                    withAllowedCharacters: CharacterSet(
                        charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()")) ??
                ""
        }
        return URL(string: "\(editor)://file\(segments.joined(separator: "/"))")
    }
}

extension OpenClawChatViewModel {
    func performSidebarAction(
        refresh: Bool = true, _ operation: @escaping () async throws -> Void)
    {
        Task {
            do {
                try await operation()
                if refresh { self.refreshSessions(limit: Self.sessionListFetchLimit) }
            } catch { NSAlert(error: error).runModal() }
        }
    }

    func sidebarMarkdown(
        session: OpenClawChatSessionEntry, connection: OpenClawSessionMenuConnection) async throws -> String
    {
        struct Page: Decodable {
            let sessionId: String?
            let totalMessages: Int?
            let deltaCursor: String?
            let sessionInfo: Info?
            let messages: [OpenClawKit.AnyCodable]?
            let hasMore: Bool?
            let nextOffset: Int?
            struct Info: Decodable { let activeLeafEntryId: String? }
        }
        func page(_ offset: Int, limit: Int = 1000) async throws -> Page {
            var params = OpenClawChatGatewayRequests.sessionMenuTarget(session)
            params["sessionKey"] = params.removeValue(forKey: "key")
            params["offset"] = .init(offset)
            params["limit"] = .init(limit)
            params["maxChars"] = .init(500_000)
            return try await connection.read("chat.history", params)
        }
        let changed = NSError(domain: "SessionMenu", code: 1, userInfo: [NSLocalizedDescriptionKey:
                String(localized: "The transcript changed. Try copying it again.")])
        let first = try await page(0)
        guard session.sessionId == nil || session.sessionId == first.sessionId else { throw changed }
        var current = first
        var offset = 0
        var pages: [[OpenClawKit.AnyCodable]] = []
        var seen: [OpenClawKit.AnyCodable: Int] = [:]
        // ui/src/lib/sessions/session-menu-navigation.ts:90: tail-relative pages must share one incarnation and branch.
        while true {
            var counts: [OpenClawKit.AnyCodable: Int] = [:]
            pages.append((current.messages ?? []).filter { message in
                guard var record = message.value as? [String: OpenClawKit.AnyCodable] else { return true }
                var metadata = record["__openclaw"]?.value as? [String: OpenClawKit.AnyCodable] ?? [:]
                guard (metadata["seq"]?.value as? Int ?? 0) > 0 ||
                    ChatPayloadDecoding
                    .trimmedNonEmptyString((metadata["id"] ?? record["messageId"])?.value as? String) != nil
                else { return true }
                metadata.removeValue(forKey: "recordTimestampMs")
                if record["__openclaw"] != nil { record["__openclaw"] = .init(metadata) }
                let identity = OpenClawKit.AnyCodable(record)
                counts[identity, default: 0] += 1
                return counts[identity, default: 0] > seen[identity, default: 0]
            })
            seen.merge(counts, uniquingKeysWith: max)
            guard current.hasMore == true else { break }
            guard let next = current.nextOffset, next > offset else { throw changed }
            offset = next
            current = try await page(offset)
            guard current.sessionId == first.sessionId,
                  current.totalMessages == first.totalMessages else { throw changed }
        }
        if pages.count > 1 {
            let tail = try await page(0, limit: 1)
            guard tail.sessionId == first.sessionId, tail.totalMessages == first.totalMessages,
                  tail.deltaCursor == first.deltaCursor,
                  tail.sessionInfo?.activeLeafEntryId == first.sessionInfo?.activeLeafEntryId else { throw changed }
        }
        let messages = pages.reversed().flatMap(\.self).compactMap {
            try? GatewayPayloadDecoding.decode($0, as: OpenClawChatMessage.self)
        }.map(Self.stripInboundMetadata)
        guard !messages.isEmpty else {
            throw NSError(domain: "SessionMenu", code: 2, userInfo: [NSLocalizedDescriptionKey:
                    String(localized: "There are no messages to copy.")])
        }
        return ChatTranscriptExporter.markdown(
            sessionTitle: ChatSessionSidebarModel.displayName(for: session),
            sessionKey: session.key,
            messages: messages)
    }
}

#endif
