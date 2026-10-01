#if os(macOS)
import Foundation
import Observation
import OpenClawProtocol
import SwiftUI

extension EnvironmentValues {
    @Entry public var openClawSidebarPeople: OpenClawChatSidebarPeople?
    @Entry public var openClawSidebarPeopleActions: OpenClawSidebarPeopleActions?
}

public struct OpenClawSidebarPeopleActions {
    let retry: @MainActor () -> Void
    let activity: @MainActor (String, String) -> Void
    let avatar: @MainActor (String, String?) async -> Data?

    public init(
        retry: @escaping @MainActor () -> Void,
        activity: @escaping @MainActor (String, String) -> Void,
        avatar: @escaping @MainActor (String, String?) async -> Data?)
    {
        self.retry = retry
        self.activity = activity
        self.avatar = avatar
    }
}

/// The native sidebar consumes presence independently of the conversation and roster query owners.
@MainActor
@Observable
public final class OpenClawChatSidebarPeople {
    struct User: Decodable, Sendable {
        struct Identity: Decodable, Sendable {
            let type: String
            let id: String
        }

        let id: String
        let identity: Identity?
        let name: String?
        let email: String?
        let avatarUrl: String?

        var key: String {
            self.identity.map { "profile:\($0.id)" } ?? "raw:\(self.id)"
        }
    }

    struct Person: Identifiable, Sendable {
        let user: User
        let entries: [PresenceEntry]
        let watchedSessions: Set<String>
        var id: String {
            self.user.key
        }

        var profileID: String? {
            self.user.identity?.id
        }

        var label: String {
            // ui/src/lib/presence-users.ts:43: shared credentials must not imply one identified person.
            self.user.id == "gateway-owner"
                ? String(localized: "Shared owner") : self.user.name ?? self.user.email ?? self.user.id
        }

        var lastActivity: Int? {
            self.entries.compactMap(\.lastactivityat).max()
        }

        var onlineSince: Int? {
            self.entries.compactMap(\.onlinesince).min()
        }

        // ui/src/lib/presence-users.ts:53: heartbeat timestamps are not human activity.
        func activity(at now: Date) -> Activity {
            guard let lastActivity else { return .unknown }
            return now.timeIntervalSince1970 * 1000 - Double(lastActivity) < 120_000 ? .active : .idle
        }
    }

    enum Activity: Int {
        case active, idle, unknown

        var label: String {
            switch self {
            case .active: String(localized: "Online · Active")
            case .idle: String(localized: "Online · Idle")
            case .unknown: String(localized: "Online")
            }
        }
    }

    private(set) var people: [Person] = []
    private(set) var selfKey: String?
    private(set) var counts: [String: SessionOwnerSessionCount]?
    private(set) var countsFailed = false
    public private(set) var presenceFailed = false
    public private(set) var activityTime = Date()
    private var connectionID: String?
    private var generation = 0
    private var countsRequest = 0
    private var presenceRevision = 0
    private var defaultAgentID = "main"
    private var mainKey = "main"
    private var globalScope = false

    // ui/src/components/sidebar-owner-session-counts.ts:8: never inherit the roster's agent, paging, or owner filters.
    public static var ownerCountsRequest: OpenClawChatGatewayRequest {
        OpenClawChatGatewayRequest(
            method: "sessions.list",
            params: [
                "includeOwnerSessionCounts": AnyCodable(true), "configuredAgentsOnly": AnyCodable(true),
                "limit": AnyCodable(1), "includeDerivedTitles": AnyCodable(false),
                "includeLastMessage": AnyCodable(false),
                "includeGlobal": AnyCodable(false), "includeUnknown": AnyCodable(false),
                "excludeSubagents": AnyCodable(true), "excludeCron": AnyCodable(true),
                "excludeSystem": AnyCodable(true),
            ],
            timeoutMs: 15000)
    }

    public init() {}

    public func receive(_ hello: HelloOk) {
        self.disconnect()
        let defaults = hello.snapshot.sessiondefaults
        self.defaultAgentID = Self.firstText([defaults?["defaultAgentId"]?.value as? String])?.lowercased() ?? "main"
        self.mainKey = Self.firstText([defaults?["mainKey"]?.value as? String])?.lowercased() ?? "main"
        self.globalScope = (defaults?["mainSessionKey"]?.value as? String)?.lowercased() == "global"
        self.connectionID = hello.server["connId"]?.value as? String
        self.replacePresence(hello.snapshot.presence)
    }

    @discardableResult
    public func receivePresence(_ data: Data) throws -> Bool {
        guard self.connectionID != nil else { return false }
        struct Payload: Decodable { let presence: [PresenceEntry] }
        let generation = self.generation
        try self.replacePresence(JSONDecoder().decode(Payload.self, from: data).presence)
        return generation != self.generation
    }

    public func disconnect() {
        self.generation += 1
        self.presenceRevision += 1
        self.connectionID = nil
        self.selfKey = nil
        self.people = []
        self.counts = nil
        self.countsFailed = false
        self.presenceFailed = false
    }

    public func resynchronizePresence(load: () async throws -> Data) async {
        guard self.connectionID != nil else { return }
        self.replacePresence([])
        let revision = self.presenceRevision
        do {
            let data = try await load()
            guard !Task.isCancelled, revision == self.presenceRevision else { return }
            try self.replacePresence(JSONDecoder().decode([PresenceEntry].self, from: data))
        } catch {
            guard !Task.isCancelled, revision == self.presenceRevision else { return }
            self.presenceFailed = true
        }
    }

    public func refreshActivity(at now: Date = .now) {
        self.activityTime = now
    }

    public func nextActivityDeadline(after now: Date) -> Date? {
        self.people.compactMap { $0.lastActivity.map { Date(timeIntervalSince1970: Double($0) / 1000 + 120) } }
            .filter { $0 > now }.min()
    }

    private func replacePresence(_ entries: [PresenceEntry]) {
        self.presenceRevision += 1
        self.presenceFailed = false
        self.refreshActivity()
        let identified = entries.compactMap { entry -> (PresenceEntry, User)? in
            guard entry.reason != "disconnect", let value = entry.user,
                  let data = try? JSONEncoder().encode(value),
                  let user = try? JSONDecoder().decode(User.self, from: data), !user.id.isEmpty else { return nil }
            return (entry, user)
        }
        let selfKey = self.connectionID.flatMap { id in identified.first { $0.0.connectionid == id }?.1.key }
        let hasProfiles = identified.contains(where: { $0.1.identity != nil })
        if selfKey != self.selfKey || !hasProfiles || hasProfiles != self.people
            .contains(where: { $0.profileID != nil })
        {
            self.generation += 1
            self.counts = nil
            self.countsFailed = false
        }
        self.selfKey = selfKey
        // src/shared/presence-user.ts:30: raw and authenticated profile IDs occupy separate namespaces.
        self.people = Dictionary(grouping: identified, by: { $0.1.key }).sorted { $0.key < $1.key }.map { _, group in
            let first = group[0].1
            let user = User(
                id: first.id,
                identity: first.identity,
                name: Self.firstText(group.map(\.1.name)),
                email: Self.firstText(group.map(\.1.email)),
                avatarUrl: Self.firstText(group.map(\.1.avatarUrl)))
            return Person(
                user: user,
                entries: group.map(\.0),
                watchedSessions: Set(group.flatMap { $0.0.watchedsessions ?? [] }))
        }
    }

    private static func firstText(_ values: [String?]) -> String? {
        values.compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }.min()
    }

    public func refreshCounts(load: () async throws -> [SessionOwnerSessionCount]?) async {
        guard self.people.contains(where: { $0.profileID != nil }) else { return }
        let generation = self.generation
        self.countsRequest += 1
        let request = self.countsRequest
        do {
            let counts = try await load()
            guard !Task.isCancelled, generation == self.generation, request == self.countsRequest else { return }
            self.counts = counts
                .map { Dictionary($0.map { ($0.profileid, $0) }, uniquingKeysWith: { _, last in last }) }
            self.countsFailed = false
        } catch {
            guard !Task.isCancelled, generation == self.generation, request == self.countsRequest else { return }
            // ui/src/components/sidebar-owner-session-counts.ts:60: retain a successful facet on refresh failure.
            self.countsFailed = true
        }
    }

    func workload(for person: Person) -> SessionOwnerSessionCount? {
        guard let counts, let id = person.profileID else { return nil }
        return counts[id] ?? SessionOwnerSessionCount(profileid: id, _open: 0, running: 0)
    }

    func online(at now: Date? = nil, expanded: Bool) -> [Person] {
        let now = now ?? self.activityTime
        return self.people.sorted { lhs, rhs in
            let leftActivity = lhs.activity(at: now).rawValue
            let rightActivity = rhs.activity(at: now).rawValue
            if leftActivity != rightActivity { return leftActivity < rightActivity }
            if expanded {
                let leftRunning = (self.workload(for: lhs)?.running ?? 0) > 0
                let rightRunning = (self.workload(for: rhs)?.running ?? 0) > 0
                if leftRunning != rightRunning { return leftRunning }
                let order = lhs.label.compare(
                    rhs.label,
                    options: [.caseInsensitive, .diacriticInsensitive],
                    locale: .current)
                if order != .orderedSame { return order == .orderedAscending }
            }
            // app-sidebar-online.ts:33 keeps the original projection order when collation ties.
            if lhs.label.lowercased() != rhs.label.lowercased() {
                return lhs.label.lowercased() < rhs.label.lowercased()
            }
            return lhs.id < rhs.id
        }
    }

    func viewers(for sessionKey: String, excludingProfileIDs: Set<String> = []) -> [Person] {
        self.people.filter {
            $0.id != self.selfKey && $0.watchedSessions.contains(sessionKey) &&
                !($0.profileID.map(excludingProfileIDs.contains) ?? false)
        }
    }

    public static func activityPath(for profileID: String) -> String? {
        // ui/src/app-route-paths.ts:252: a retained ID's trailing hyphen must not become a short profile reference.
        let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789_~")
        return profileID.addingPercentEncoding(withAllowedCharacters: allowed).map { "/activity/\($0)" }
    }

    func cardSessions(
        for person: Person,
        sessions: [OpenClawChatSessionEntry],
        recentKeys: [String]? = nil)
        -> (
            viewing: [OpenClawChatSessionEntry], viewingKeys: [String],
            recent: [OpenClawChatSessionEntry], recentKeys: [String])
    {
        func identity(_ key: String, _ owner: String?) -> String {
            let parsedAgent = OpenClawChatSessionKey.agentID(from: key.lowercased())
            let scope = parsedAgent ?? owner?.lowercased() ?? self.defaultAgentID
            let raw = key.trimmingCharacters(in: .whitespacesAndNewlines)
            let tail = parsedAgent == nil ? raw.lowercased() :
                String(raw.split(separator: ":", maxSplits: 2).last ?? "").lowercased()
            let canonical: String = if tail == "main" || tail == self.mainKey {
                self.globalScope ? "global" : "agent:\(scope):\(self.mainKey)"
            } else {
                OpenClawChatSessionKey.comparisonKey(parsedAgent != nil || raw.lowercased() == "global"
                    ? raw : "agent:\(scope):\(raw)")
            }
            return "\(scope)\0\(canonical)"
        }
        let watched = Set(person.watchedSessions.map { identity($0, nil) })
        var seen = Set<String>()
        // ui/src/components/person-activity-card.ts:243: watched keys are hints, never permission to reveal a title.
        let rows = sessions.filter { seen.insert(identity($0.key, $0.agentId)).inserted }.sorted {
            if ($0.updatedAt ?? 0) != ($1.updatedAt ?? 0) { return ($0.updatedAt ?? 0) > ($1.updatedAt ?? 0) }
            return identity($0.key, $0.agentId).localizedCompare(identity($1.key, $1.agentId)) == .orderedAscending
        }
        let viewing = rows.filter { watched.contains(identity($0.key, $0.agentId)) }
        let candidates = recentKeys.map { keys in
            keys.compactMap { key in rows.first { identity($0.key, $0.agentId) == key } }
        } ?? rows
        let recent = candidates.filter { row in
            !watched.contains(identity(row.key, row.agentId)) && [row.owner?.actor, row.createdActor]
                .contains { actor in
                    guard let identity = actor?.identity?.value as? [String: AnyCodable] else { return false }
                    return identity["type"]?.value as? String == "profile" &&
                        person.profileID != nil && identity["id"]?.value as? String == person.profileID
                }
        }
        // person-activity-card.ts:262: an open card retires ineligible recent links without reordering or backfilling.
        let visible = Array(viewing.prefix(3))
        let selected = Array(recent.prefix(3))
        return (
            visible, visible.map { identity($0.key, $0.agentId) },
            selected, selected.map { identity($0.key, $0.agentId) })
    }
}

#endif
