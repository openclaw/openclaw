import Foundation

@MainActor
final class GatewayMenuStatusStore {
    typealias Probe = (version: String?, buildId: String?, latencyMs: Double)

    struct Facts: Equatable, Sendable {
        var version: String?
        var buildId: String?
        var latencyMs: Double?
        var health: DashboardGatewayHealth = .unknown
        var lastSeen: Date?
        var probedAt: Date?
    }

    private(set) var facts: [DashboardGatewayTarget: Facts] = [:]
    private var probingTargets: Set<DashboardGatewayTarget> = []
    private var startedTargets: Set<DashboardGatewayTarget> = []
    private var generation: UInt64 = 0
    private var probeTask: Task<Void, Never>?
    private var cleanupTasks: [DashboardGatewayTarget: (generation: UInt64, task: Task<Void, Never>)] = [:]
    private let primaryProbe: @MainActor @Sendable () async throws -> Probe
    private let localProbe: @MainActor @Sendable () async throws -> Probe
    private let disconnectLocal: @MainActor @Sendable () async -> Void
    private let profileProbe: @MainActor @Sendable (String) async throws -> Probe
    private let disconnectProfile: @MainActor @Sendable (String) async -> Void

    init(
        primaryProbe: @escaping @MainActor @Sendable () async throws -> Probe = {
            let start = Date()
            _ = try await ControlChannel.shared.health(timeout: 3)
            let latency = ControlChannel.shared.lastPingMs ?? Date().timeIntervalSince(start) * 1000
            let snapshot = GatewayConnection.shared.lastSnapshot
            return (
                snapshot?.server["version"]?.value as? String,
                snapshot?.server["buildId"]?.value as? String,
                latency)
        },
        profileProbe: @escaping @MainActor @Sendable (String) async throws -> Probe = { profileID in
            let connection = await MacGatewayConnectionFleet.shared.connection(profileID: profileID)
            return try await GatewayMenuStatusStore.probeConnection(connection)
        },
        localProbe: @escaping @MainActor @Sendable () async throws -> Probe = {
            let connection = await MacGatewayConnectionFleet.shared.localConnection()
            return try await GatewayMenuStatusStore.probeConnection(connection)
        },
        disconnectLocal: @escaping @MainActor @Sendable () async -> Void = {
            await MacGatewayConnectionFleet.shared.disconnectLocal(ifCurrent: { !Task.isCancelled })
        },
        disconnectProfile: @escaping @MainActor @Sendable (String) async -> Void = { profileID in
            await MacGatewayConnectionFleet.shared.disconnect(profileID: profileID, ifCurrent: { !Task.isCancelled })
        })
    {
        self.primaryProbe = primaryProbe
        self.localProbe = localProbe
        self.disconnectLocal = disconnectLocal
        self.profileProbe = profileProbe
        self.disconnectProfile = disconnectProfile
    }

    private static func probeConnection(_ connection: GatewayConnection) async throws -> Probe {
        try Task.checkCancellation()
        // Warm the connection before timing the round trip.
        _ = try await connection.request(
            method: "health", params: nil, timeoutMs: 3000, retryTransportFailures: false)
        try Task.checkCancellation()
        let start = Date()
        _ = try await connection.request(
            method: "health", params: nil, timeoutMs: 3000, retryTransportFailures: false)
        let snapshot = await connection.lastSnapshot
        return (
            snapshot?.server["version"]?.value as? String,
            snapshot?.server["buildId"]?.value as? String,
            Date().timeIntervalSince(start) * 1000)
    }

    func isProbing(_ target: DashboardGatewayTarget) -> Bool {
        self.probingTargets.contains(target)
    }

    func beginProbing(targets: [DashboardGatewayTarget], onChange: @escaping @MainActor () -> Void) {
        guard self.probeTask == nil else { return }
        self.generation &+= 1
        let generation = self.generation
        self.probingTargets = Set(targets)
        self.startedTargets.removeAll()
        for target in targets where target != .primary {
            self.cleanupTasks.removeValue(forKey: target)?.task.cancel()
        }
        self.probeTask = Task {
            await withTaskGroup(of: Void.self) { group in
                for target in Set(targets) {
                    group.addTask {
                        await self.probe(target, generation: generation, onChange: onChange)
                    }
                }
            }
            if self.generation == generation {
                self.probeTask = nil
            }
        }
    }

    func endProbing(openWindowCount: @escaping @MainActor (DashboardGatewayTarget) -> Int) {
        let task = self.probeTask
        task?.cancel()
        self.probeTask = nil
        self.generation &+= 1
        let generation = self.generation
        self.probingTargets.removeAll()
        let targets = self.startedTargets
        self.startedTargets.removeAll()
        for target in targets where target != .primary {
            self.cleanupTasks[target]?.task.cancel()
            let cleanup = Task {
                // Drain canceled probes before disconnecting: a delayed profile
                // lookup must not establish a socket after menu cleanup finishes.
                await task?.value
                guard !Task.isCancelled else { return }
                if openWindowCount(target) == 0 {
                    switch target {
                    case .primary: break
                    case .local: await self.disconnectLocal()
                    case let .profile(profileID): await self.disconnectProfile(profileID)
                    }
                }
                if self.cleanupTasks[target]?.generation == generation {
                    self.cleanupTasks.removeValue(forKey: target)
                }
            }
            self.cleanupTasks[target] = (generation, cleanup)
        }
    }

    private func probe(
        _ target: DashboardGatewayTarget,
        generation: UInt64,
        onChange: @MainActor () -> Void) async
    {
        guard self.generation == generation, !Task.isCancelled else { return }
        self.startedTargets.insert(target)
        let result: Result<Probe, Error>
        do {
            let probe = switch target {
            case .primary: try await self.primaryProbe()
            case .local: try await self.localProbe()
            case let .profile(profileID): try await self.profileProbe(profileID)
            }
            result = .success(probe)
        } catch {
            result = .failure(error)
        }
        guard self.generation == generation, !Task.isCancelled else { return }
        var facts = self.facts[target] ?? Facts()
        let now = Date()
        facts.probedAt = now
        switch result {
        case let .success(probe):
            facts.version = probe.version
            facts.buildId = probe.buildId
            facts.latencyMs = probe.latencyMs
            facts.health = .ok
            facts.lastSeen = now
        case .failure:
            facts.health = .error
            facts.latencyMs = nil
        }
        self.facts[target] = facts
        self.probingTargets.remove(target)
        onChange()
    }
}
