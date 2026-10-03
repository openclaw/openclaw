#if os(macOS)
import Foundation
import Observation
import struct OpenClawKit.GatewayResponseError
import OpenClawProtocol

public struct OpenClawSessionPullRequestSnapshot: Codable, Sendable {
    public struct Repository: Codable, Sendable {
        public let owner: String
        public let repo: String
    }

    public struct Checks: Codable, Sendable {
        public let state: String
        public let passed: Int
        public let failed: Int
        public let skipped: Int
        public let running: Int
    }

    public struct PullRequest: Codable, Sendable {
        public let number: Int
        public let owner: String
        public let repo: String
        public let branch: String
        public let title: String
        public let url: String
        public let state: String
        public let additions: Int?
        public let deletions: Int?
        public let changedFiles: Int?
        public let checks: Checks?
    }

    public struct Branch: Codable, Sendable {
        public let owner: String
        public let repo: String
        public let branch: String
        public let additions: Int?
        public let deletions: Int?
        public let changedFiles: Int?
        public let createUrl: String?
    }

    public var pullRequests: [PullRequest]
    public var repository: Repository?
    public var branch: Branch?
    public let rateLimited: Bool
    public let status: String

    private var repositoryID: String? {
        let owner = self.repository?.owner ?? self.branch?.owner ?? self.pullRequests.first?.owner
        let repo = self.repository?.repo ?? self.branch?.repo ?? self.pullRequests.first?.repo
        return owner.flatMap { owner in repo.map { "\(owner)/\($0)" } }
    }

    func retaining(_ previous: Self?) -> Self {
        var result = self
        // ui/src/lib/session-pull-requests.ts:299: transient failures retain only the same checkout's facts.
        if let previous, self.pullRequests.isEmpty, ["unavailable", "rate-limited"].contains(self.status),
           self.repositoryID == nil || self.repositoryID == previous.repositoryID,
           self.branch == nil || (previous.branch?.branch ?? previous.pullRequests.first?.branch) == nil ||
           self.branch?.branch == (previous.branch?.branch ?? previous.pullRequests.first?.branch)
        {
            result.pullRequests = previous.pullRequests
            result.branch = self.branch ?? previous.branch
            result.repository = self.repository ?? previous.repository
        }
        return result
    }
}

@MainActor public protocol OpenClawChatSidebarHoverTransport {
    var sidebarHoverFacts: OpenClawChatSidebarHoverFacts { get }
    func sidebarHoverChannelAvatar(session: OpenClawChatSessionEntry, sessionAgentID: String?) async -> Data?
    func sidebarHoverAgentAvatar(
        session: OpenClawChatSessionEntry, sessionAgentID: String?, agentID: String, advertised: String) async -> Data?
}

@MainActor @Observable public final class OpenClawChatSidebarHoverFacts {
    private typealias Target = OpenClawChatSessionTarget
    public typealias Request = @Sendable (OpenClawChatGatewayRequest) async throws -> Data
    public enum AvatarResult: Sendable { case image(Data), notFound, unavailable }
    public enum AvatarResource: Hashable, Sendable { case channel, agent(String) }
    private struct Avatar {
        let version: String
        let id = UUID()
        let task: Task<AvatarResult, Never>
        var retryAt: Date?
    }

    private var avatars: [Target: [AvatarResource: Avatar]] = [:]
    private var pulls: [String: OpenClawSessionPullRequestSnapshot] = [:]
    private var cards: [Target: ProgressCard] = [:]
    private var progressNeedsReload: Set<Target> = []
    private var owners: [UUID: Target] = [:]
    private var lifetimes: [Target: UUID] = [:]
    private var dirty: Set<Target> = []
    private enum Revision { case unknown, atLeast(Int) }
    private var pending: [Target: Revision] = [:]
    private var generation = UUID()
    var avatarGeneration: UUID {
        self.generation
    }

    private var request: Request?
    private var pullRequestsAvailable = false
    private var subscribedKeys: [String]?
    private var evictedPullKeys: Set<String> = []
    private let activate: @MainActor (Bool) -> Void
    @ObservationIgnored private var subscription: Task<Void, Never>?
    @ObservationIgnored private var reads: [Target: Task<Void, Never>] = [:]
    @ObservationIgnored private var refreshTasks: [String: Task<Void, Never>] = [:]
    @ObservationIgnored private var retryTask: Task<Void, Never>?
    private var retryRefreshKeys: Set<String> = []

    public init(activate: @escaping @MainActor (Bool) -> Void = { _ in }) {
        self.activate = activate
    }

    isolated deinit {
        self.avatars.values.flatMap(\.values).forEach { $0.task.cancel() }
        self.subscription?.cancel()
        self.reads.values.forEach { $0.cancel() }
        self.refreshTasks.values.forEach { $0.cancel() }
        self.retryTask?.cancel()
        self.activate(false)
    }

    private static func target(sessionKey: String, agentID: String?) -> Target {
        let target = Target.resolve(
            sessionKey,
            selectedAgentID: nil,
            overrideAgentID: agentID,
            policy: .scopeBareKeysToSelectedAgent)
        return Target(
            sessionKey: target.sessionKey,
            agentID: target.agentID == OpenClawChatSessionKey.agentID(from: target.sessionKey)?
                .lowercased() ? nil : target.agentID)
    }

    private static func wireKey(_ target: Target) -> String {
        guard OpenClawChatSessionKey.agentID(from: target.sessionKey) == nil,
              let agent = target.agentID else { return target.sessionKey }
        return "agent:\(agent):\(target.sessionKey)"
    }

    private var wireKeys: Set<String> {
        Set(self.owners.values.map { Self.wireKey($0) })
    }

    public func pullRequests(sessionKey: String, agentID: String?) -> OpenClawSessionPullRequestSnapshot? {
        self.pulls[Self.wireKey(Self.target(sessionKey: sessionKey, agentID: agentID))]
    }

    public func progress(sessionKey: String, agentID: String?) -> ProgressCard? {
        self.cards[Self.target(sessionKey: sessionKey, agentID: agentID)]
    }

    public func avatar(
        sessionKey: String,
        agentID: String?,
        version: String,
        resource: AvatarResource = .channel,
        load: @escaping @MainActor @Sendable () async -> AvatarResult) async -> Data?
    {
        let target = Self.target(sessionKey: sessionKey, agentID: agentID)
        guard let lifetime = self.lifetimes[target] else { return nil }
        let cached = self.avatars[target]?[resource]
        if cached?.version != version || cached?.retryAt.map({ $0 <= .now }) == true {
            cached?.task.cancel()
            self.avatars[target, default: [:]][resource] = Avatar(version: version, task: Task { await load() })
        }
        guard let avatar = self.avatars[target]?[resource] else { return nil }
        let generation = self.generation
        let result = await avatar.task.value
        guard generation == self.generation, self.lifetimes[target] == lifetime,
              self.avatars[target]?[resource]?.id == avatar.id, !Task.isCancelled else { return nil }
        // ui/src/lib/authenticated-avatar-route.ts:128: share images/404s while watched; other misses remain retryable.
        switch result {
        case let .image(data): return data
        case .notFound where resource == .channel: return nil
        default:
            // ui/src/lib/identity-avatar-loader.ts:95 lets unversioned agent uploads recover after a cached miss.
            if case .agent = resource, self.avatars[target]?[resource]?.retryAt == nil {
                self.avatars[target]?[resource]?.retryAt = .now.addingTimeInterval(60)
            } else if resource == .channel { self.avatars[target]?[resource] = nil }
            return nil
        }
    }

    public func watch(sessionKey: String, agentID: String?) -> UUID {
        let owner = UUID()
        let key = Self.target(sessionKey: sessionKey, agentID: agentID)
        let wireKey = Self.wireKey(key)
        let refresh: Set<String> = self.evictedPullKeys.remove(wireKey) == nil ? [] : [wireKey]
        let first = self.owners.isEmpty
        self.owners[owner] = key
        let newKey = self.lifetimes[key] == nil
        if newKey {
            self.lifetimes[key] = UUID()
        }
        if first { self.activate(true) }
        self.synchronize(refresh: refresh)
        if newKey || self.progressNeedsReload.contains(key) { self.loadProgress(key) }
        return owner
    }

    public func unwatch(_ owner: UUID) {
        guard let key = self.owners.removeValue(forKey: owner) else { return }
        if !self.owners.values.contains(key) {
            self.avatars.removeValue(forKey: key)?.values.forEach { $0.task.cancel() }
            self.lifetimes[key] = nil
            self.cards[key] = nil
            self.progressNeedsReload.remove(key)
            self.dirty.remove(key)
            self.pending[key] = nil
            self.reads.removeValue(forKey: key)?.cancel()
        }
        let wireKey = Self.wireKey(key)
        if !self.wireKeys.contains(wireKey) {
            self.pulls[wireKey] = nil
            self.evictedPullKeys.insert(wireKey)
            self.refreshTasks.removeValue(forKey: wireKey)?.cancel()
        }
        self.synchronize()
        if self.owners.isEmpty, self.request == nil { self.activate(false) }
    }

    public func connect(request: @escaping Request, pullRequestsAvailable: Bool = true) {
        self.disconnect()
        self.request = request
        self.pullRequestsAvailable = pullRequestsAvailable
        self.synchronize()
        self.lifetimes.keys.forEach { self.loadProgress($0) }
    }

    public func disconnect() {
        self.generation = UUID()
        self.avatars.values.flatMap(\.values).forEach { $0.task.cancel() }
        self.avatars.removeAll()
        self.request = nil
        self.subscribedKeys = nil
        self.evictedPullKeys.removeAll()
        self.subscription?.cancel()
        self.subscription = nil
        self.pulls.removeAll()
        self.cards.removeAll()
        self.progressNeedsReload.removeAll()
        self.dirty.removeAll()
        self.pending.removeAll()
        self.reads.values.forEach { $0.cancel() }
        self.reads.removeAll()
        self.refreshTasks.values.forEach { $0.cancel() }
        self.refreshTasks.removeAll()
        self.retryTask?.cancel()
        self.retryTask = nil
        self.retryRefreshKeys.removeAll()
    }

    private func synchronize(refresh: Set<String> = []) {
        // ui/src/lib/session-pull-requests.ts:430: each connection replaces one set; windows share its union.
        guard let request = self.request else { return }
        let previous = self.subscription
        let generation = self.generation
        self.subscription = Task {
            _ = await previous?.result
            guard generation == self.generation, !Task.isCancelled else { return }
            let keys = Array(self.wireKeys.sorted().prefix(200))
            let refreshKeys = refresh.intersection(keys)
            if self.pullRequestsAvailable, !refreshKeys.isEmpty || self.subscribedKeys != keys {
                var params: [String: AnyCodable] = ["sessionKeys": .init(keys)]
                if !refreshKeys.isEmpty { params["refreshSessionKeys"] = .init(refreshKeys.sorted()) }
                do {
                    _ = try await request(.init(
                        method: "controlUi.sessionPullRequests.subscribe",
                        params: params,
                        timeoutMs: 15000))
                    if generation == self.generation {
                        self.subscribedKeys = keys
                        // Retain eviction intent until the server has acknowledged removing that key.
                        self.evictedPullKeys.formIntersection(keys)
                    }
                } catch {
                    guard generation == self.generation else { return }
                    for key in keys where self.wireKeys.contains(key) {
                        self.pulls[key] = OpenClawSessionPullRequestSnapshot(
                            pullRequests: [], rateLimited: false, status: "unavailable").retaining(self.pulls[key])
                    }
                    self.scheduleRetry(refresh: refreshKeys)
                }
            }
            // A previous nonempty request can finish after the final owner leaves. Its queued unsubscribe still owns
            // cleanup.
            if generation == self.generation, keys.isEmpty, self.owners.isEmpty,
               !self.pullRequestsAvailable || self.subscribedKeys == keys
            {
                self.retryTask?.cancel()
                self.retryTask = nil
                self.retryRefreshKeys.removeAll()
                self.activate(false)
            }
        }
    }

    private func loadProgress(_ target: Target, revision: Int? = nil) {
        guard let request = self.request, let lifetime = self.lifetimes[target] else { return }
        self.dirty.insert(target)
        if self.reads[target] != nil {
            if case .unknown = self.pending[target] { return }
            let previous: Int = if case let .atLeast(value) = self.pending[target] {
                value
            } else { 0 }
            self.pending[target] = revision.map { .atLeast(max(previous, $0)) } ?? .unknown
            return
        }
        let generation = self.generation
        self.reads[target] = Task {
            while self.generation == generation, self.lifetimes[target] == lifetime, !Task.isCancelled,
                  self.dirty.remove(target) != nil
            {
                let outcome: Result<Data, Error>
                do {
                    outcome = try await .success(request(OpenClawChatGatewayRequests.progressCardGet(
                        sessionKey: target.sessionKey, agentID: target.agentID)))
                } catch { outcome = .failure(error) }
                guard self.generation == generation, self.lifetimes[target] == lifetime,
                      !Task.isCancelled else { return }
                self.progressNeedsReload.insert(target)
                // session-progress-cards.ts:234: denial retires content; transient errors retain the last useful card.
                if case let .failure(error) = outcome, let response = error as? GatewayResponseError,
                   response.details["code"]?.stringValue == "SESSION_PARTICIPATION_REQUIRED"
                {
                    self.cards[target] = nil
                }
                // session-progress-cards.ts:327: only a revisioned card can satisfy an overlapping invalidation.
                if case let .success(data) = outcome,
                   let result = try? JSONDecoder().decode(ProgressCardGetResult.self, from: data)
                {
                    if result.card.value is NSNull, self.pending[target] == nil {
                        self.cards[target] = nil
                        self.progressNeedsReload.remove(target)
                    } else if let card = try? OpenClawChatGatewayPayloadCodec.decodeProgressCard(data, agentID: nil),
                              card.sessionkey == Self.wireKey(target)
                    {
                        self.cards[target] = card
                        self.progressNeedsReload.remove(target)
                        if case let .atLeast(revision) = self.pending[target],
                           card.revision >= revision { self.dirty.remove(target) }
                    }
                }
                self.pending[target] = nil
            }
            if self.generation == generation, self.lifetimes[target] == lifetime { self.reads[target] = nil }
        }
    }

    public func refresh() {
        self.synchronize(refresh: self.wireKeys)
        self.lifetimes.keys.forEach { self.loadProgress($0) }
    }

    private func scheduleRetry(refresh: Set<String>) {
        self.retryRefreshKeys.formUnion(refresh)
        // Subscription recovery owns a deadline independent of the activity debounce below.
        guard self.retryTask == nil else { return }
        self.retryTask = Task {
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard !Task.isCancelled else { return }
            self.retryTask = nil
            let refresh = self.retryRefreshKeys
            self.retryRefreshKeys.removeAll()
            self.synchronize(refresh: refresh)
        }
    }

    private func scheduleRefresh(_ key: String) {
        // session-pull-requests.ts:513: activity in one session must not postpone another session's refresh.
        self.refreshTasks[key]?.cancel()
        self.refreshTasks[key] = Task {
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard !Task.isCancelled, self.wireKeys.contains(key) else { return }
            self.refreshTasks[key] = nil
            self.synchronize(refresh: [key])
        }
    }

    public func receive(event: String, payload: Data) {
        guard self.request != nil else { return }
        if event == "controlUi.sessionPullRequests.changed" {
            struct Changed: Decodable { let sessions: [String: OpenClawSessionPullRequestSnapshot] }
            guard let changed = try? JSONDecoder().decode(Changed.self, from: payload) else { return }
            let watched = self.wireKeys
            for (key, snapshot) in changed.sessions where watched.contains(key) {
                self.pulls[key] = snapshot.retaining(self.pulls[key])
            }
        } else if event == "progressCard.changed" {
            guard let change = try? JSONDecoder().decode(ProgressCardChangedEvent.self, from: payload) else { return }
            // session-progress-cards.ts:203,449: global and ordinary targets share invalidations, never cached cards or reads.
            for target in self.lifetimes.keys where Self.wireKey(target) == change.sessionkey {
                if (change.revision.value as? Int).map({ (self.cards[target]?.revision ?? 0) < $0 }) ?? true {
                    self.loadProgress(target, revision: change.revision.value as? Int)
                }
            }
        } else if let data = try? JSONSerialization.jsonObject(with: payload) as? [String: Any],
                  let rawKey = (data["key"] ?? data["sessionKey"]) as? String
        {
            let target = Self.target(sessionKey: rawKey, agentID: data["agentId"] as? String)
            let key = Self.wireKey(target)
            guard self.wireKeys.contains(key) else { return }
            if event == "sessions.changed", self.lifetimes[target] != nil,
               ["reset", "delete"].contains(data["reason"] as? String ?? "")
            {
                self.lifetimes[target] = UUID()
                self.reads.removeValue(forKey: target)?.cancel()
                self.pending[target] = nil
                self.cards[target] = nil
                self.pulls[key] = nil
                self.loadProgress(target)
            }
            let phase = (data["data"] as? [String: Any])?["phase"] as? String
            let stream = data["stream"] as? String
            if event == "sessions.changed",
               ["new", "reset", "branch-switch", "fork", "rewind"].contains(data["reason"] as? String ?? "")
            {
                self.pulls[key] = nil
                self.scheduleRefresh(key)
            } else if event == "agent" || event == "session.tool",
                      (stream == "tool" && phase == "result") ||
                      (stream == "lifecycle" && ["end", "error"].contains(phase ?? ""))
            {
                self.scheduleRefresh(key)
            }
        }
    }
}

#endif
