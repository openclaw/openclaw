import Foundation
import OSLog

/// Manages the SSH tunnel that forwards the remote gateway/control port to localhost.
actor RemoteTunnelManager {
    static let shared = RemoteTunnelManager()

    struct Route: Equatable, Sendable {
        let localPort: UInt16
        let generation: UInt64
    }

    private enum RouteLookupResult {
        case none
        case retired(UInt64)
        case staleConfiguration
        case route(Route)
    }

    private struct ActiveTunnel {
        let tunnel: RemotePortTunnel
        let configuration: RemotePortTunnel.Configuration
        let route: Route
    }

    private struct TunnelCreation {
        let token: UUID
        let configuration: RemotePortTunnel.Configuration
        let lifecycleGeneration: UInt64
        let task: Task<RemotePortTunnel, Error>
    }

    private struct SandboxForwardAttempt {
        let token: UUID
        let route: Route
        let task: Task<RemotePortTunnel?, Never>
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "remote-tunnel")
    private var controlTunnel: ActiveTunnel?
    /// Widget sandbox forward for the current control route, in its own SSH process.
    private var sandboxForward: RemotePortTunnel?
    private var sandboxForwardAttempt: SandboxForwardAttempt?
    private var lastSandboxForwardAttemptAt: Date?
    private let sandboxForwardRetrySeconds: TimeInterval = 30
    private var createInFlight: TunnelCreation?
    private var retirementInFlight: (token: UUID, task: Task<Void, Never>)?
    private var tunnelGeneration: UInt64 = 0
    private var lifecycleGeneration: UInt64 = 0
    private var isShutDown = false
    private var lastRestartAt: Date?
    private let restartBackoffSeconds: TimeInterval = 2.0

    func controlTunnelStatus() -> (running: Bool, localPort: UInt16?) {
        guard !self.isShutDown, self.retirementInFlight == nil,
              let active = self.controlTunnel, active.tunnel.isRunning
        else { return (false, nil) }
        return (true, active.tunnel.localPort)
    }

    func controlTunnelRouteIfRunning() async -> Route? {
        guard !self.isShutDown, self.retirementInFlight == nil else { return nil }
        guard let configuration = try? RemotePortTunnel.configuration()
        else {
            self.beginRetirement()
            await self.waitForRetirement()
            return nil
        }
        switch await self.lookupControlTunnelRoute(
            configuration: configuration,
            lifecycleGeneration: self.lifecycleGeneration)
        {
        case let .route(route):
            return route
        case .none, .retired, .staleConfiguration:
            return nil
        }
    }

    /// Retire a tunnel opened or opening for an older configuration and wait for its SSH process
    /// to exit, without opening a replacement.
    func retireStaleControlTunnel() async {
        await self.waitForRetirement()
        guard !self.isShutDown else { return }
        let current = try? RemotePortTunnel.configuration()
        let stale = [self.controlTunnel?.configuration, self.createInFlight?.configuration]
            .contains { $0 != nil && $0 != current }
        guard stale else { return }
        self.beginRetirement()
        await self.waitForRetirement()
    }

    func isCurrentRoute(_ route: Route) async -> Bool {
        await self.controlTunnelRouteIfRunning() == route
    }

    private func lookupControlTunnelRoute(
        configuration: RemotePortTunnel.Configuration,
        lifecycleGeneration: UInt64) async -> RouteLookupResult
    {
        await self.waitForRetirement()
        guard self.lifecycleGeneration == lifecycleGeneration else { return .none }
        guard let currentConfiguration = try? RemotePortTunnel.configuration(),
              configuration == currentConfiguration
        else {
            return .staleConfiguration
        }
        if let active = controlTunnel {
            guard active.configuration == configuration else {
                self.logger.info("configured SSH route changed; replacing control tunnel")
                let replacementGeneration = self.beginRetirement()
                await self.waitForRetirement()
                return .retired(replacementGeneration)
            }
            guard active.tunnel.isRunning else {
                let replacementGeneration = self.beginRetirement()
                await self.waitForRetirement()
                return .retired(replacementGeneration)
            }
            let local = active.tunnel.localPort
            let pid = active.tunnel.processIdentifier
            let isListening = await PortGuardian.shared.isListening(port: Int(local), pid: pid)
            // PortGuardian suspends this actor. A concurrent stop or replacement
            // must win; never return or retire the captured tunnel afterward.
            guard let current = controlTunnel,
                  current.tunnel === active.tunnel,
                  current.configuration == active.configuration,
                  current.route == active.route
            else { return .none }
            if (try? RemotePortTunnel.configuration()) != configuration {
                return .staleConfiguration
            }
            if isListening {
                self.logger.info("reusing active SSH tunnel localPort=\(local, privacy: .public)")
                self.refreshSandboxForward(configuration: configuration, route: current.route)
                return .route(current.route)
            }
            self.logger.error(
                "active SSH tunnel on port \(local, privacy: .public) is not listening; restarting")
            let replacementGeneration = self.beginRetirement()
            self.lastRestartAt = Date()
            await self.waitForRetirement()
            return .retired(replacementGeneration)
        }
        return .none
    }

    private func resolveLookup(
        _ result: RouteLookupResult,
        lifecycleGeneration: UInt64) async throws -> Route?
    {
        try Task.checkCancellation()
        let currentGeneration = if case let .retired(replacementGeneration) = result {
            replacementGeneration
        } else {
            lifecycleGeneration
        }
        guard self.lifecycleGeneration == currentGeneration else { throw CancellationError() }
        switch result {
        case let .route(route):
            return route
        case .retired, .staleConfiguration:
            // Another caller may have installed the replacement during retirement.
            return try await self.ensureControlTunnelRoute(lifecycleGeneration: currentGeneration)
        case .none:
            return nil
        }
    }

    func ensureControlTunnelRoute() async throws -> Route {
        guard !self.isShutDown else { throw CancellationError() }
        return try await self.ensureControlTunnelRoute(
            lifecycleGeneration: self.lifecycleGeneration)
    }

    private func ensureControlTunnelRoute(
        lifecycleGeneration: UInt64) async throws -> Route
    {
        var waitedForBackoff = false
        while true {
            try Task.checkCancellation()
            guard self.lifecycleGeneration == lifecycleGeneration else {
                throw CancellationError()
            }
            let configuration = try RemotePortTunnel.configuration()
            if let route = try await self.resolveLookup(
                self.lookupControlTunnelRoute(
                    configuration: configuration,
                    lifecycleGeneration: lifecycleGeneration),
                lifecycleGeneration: lifecycleGeneration)
            {
                return route
            }
            if let route = try await self.resolveLookup(
                self.joinCreateInFlight(
                    configuration: configuration,
                    lifecycleGeneration: lifecycleGeneration),
                lifecycleGeneration: lifecycleGeneration)
            {
                return route
            }
            if !waitedForBackoff {
                try await self.waitForRestartBackoffIfNeeded()
                waitedForBackoff = true
                continue
            }

            // Every suspension can admit another owner. Check all slots and the
            // current configuration in the same actor turn that claims creation.
            try Task.checkCancellation()
            guard self.lifecycleGeneration == lifecycleGeneration else { throw CancellationError() }
            let currentConfiguration = try RemotePortTunnel.configuration()
            guard self.retirementInFlight == nil, self.controlTunnel == nil,
                  self.createInFlight == nil, currentConfiguration == configuration
            else { continue }

            let token = UUID()
            let task = Task {
                try await RemotePortTunnel.create(configuration: configuration)
            }
            let create = TunnelCreation(
                token: token,
                configuration: configuration,
                lifecycleGeneration: lifecycleGeneration,
                task: task)
            self.createInFlight = create
            return try await self.finishCreation(create)
        }
    }

    private func joinCreateInFlight(
        configuration: RemotePortTunnel.Configuration,
        lifecycleGeneration: UInt64) async throws -> RouteLookupResult
    {
        await self.waitForRetirement()
        guard self.lifecycleGeneration == lifecycleGeneration else { throw CancellationError() }
        guard let create = createInFlight else { return .none }
        guard create.configuration == configuration else {
            let currentConfiguration = try RemotePortTunnel.configuration()
            guard configuration == currentConfiguration else {
                return .staleConfiguration
            }

            // A suspended create owns the prior SSH route. It must not become
            // the loopback endpoint for the replacement Gateway.
            let replacementGeneration = self.beginRetirement()
            await self.waitForRetirement()
            return .retired(replacementGeneration)
        }

        self.logger.info("control tunnel create in flight; joining")
        return try await .route(self.finishCreation(create))
    }

    /// Keeps the widget sandbox forward of the current route open when its port allows. Every outcome
    /// stays inside the forward's own SSH process: a failure is logged and retried later, never
    /// propagated to the Gateway route. Attempts start only after the probe passes, at most every 30 s.
    private func refreshSandboxForward(configuration: RemotePortTunnel.Configuration, route: Route) {
        guard self.sandboxForwardAttempt == nil else { return }
        if let forward = self.sandboxForward {
            if forward.isRunning { return }
            self.sandboxForward = nil
            Task { await forward.terminate() }
        }
        if let last = self.lastSandboxForwardAttemptAt,
           Date().timeIntervalSince(last) < self.sandboxForwardRetrySeconds
        {
            return
        }
        guard let port = RemotePortTunnel.availableSandboxForwardPort(
            localPort: route.localPort,
            remotePort: configuration.remotePort,
            reservedLocalPorts: configuration.reservedLocalPorts)
        else { return }
        self.lastSandboxForwardAttemptAt = Date()
        let token = UUID()
        let logger = self.logger
        let task = Task<RemotePortTunnel?, Never> {
            do {
                return try await RemotePortTunnel.createSandboxForward(configuration: configuration, port: port)
            } catch {
                logger.error(
                    "widget sandbox forward on port \(port, privacy: .public) failed; " +
                        "the Gateway tunnel is unaffected: \(error.localizedDescription, privacy: .public)")
                return nil
            }
        }
        self.sandboxForwardAttempt = SandboxForwardAttempt(token: token, route: route, task: task)
        Task { await self.finishSandboxForward(token: token) }
    }

    private func finishSandboxForward(token: UUID) async {
        guard let attempt = self.sandboxForwardAttempt, attempt.token == token else { return }
        let forward = await attempt.task.value
        // Retirement took the attempt during the await and terminates its result itself.
        guard self.sandboxForwardAttempt?.token == token else { return }
        self.sandboxForwardAttempt = nil
        guard let forward else { return }
        guard self.controlTunnel?.route == attempt.route else {
            await forward.terminate()
            return
        }
        self.sandboxForward = forward
    }

    @discardableResult
    private func beginRetirement() -> UInt64 {
        self.lifecycleGeneration &+= 1
        let active = self.controlTunnel?.tunnel
        let create = self.createInFlight?.task
        let sandbox = self.sandboxForward
        let sandboxAttempt = self.sandboxForwardAttempt?.task
        guard active != nil || create != nil || sandbox != nil || sandboxAttempt != nil
        else { return self.lifecycleGeneration }
        self.controlTunnel = nil
        self.createInFlight = nil
        self.sandboxForward = nil
        self.sandboxForwardAttempt = nil
        self.tunnelGeneration &+= 1
        create?.cancel()

        // Publish cleanup ownership before suspending the actor. Reentrant ensures
        // must join this barrier before reserving the ledger for a replacement.
        let previous = self.retirementInFlight?.task
        self.retirementInFlight = (UUID(), Task {
            await previous?.value
            if let tunnel = try? await create?.value { await tunnel.terminate() }
            if let forward = await sandboxAttempt?.value { await forward.terminate() }
            await sandbox?.terminate()
            await active?.terminate()
        })
        return self.lifecycleGeneration
    }

    private func waitForRetirement() async {
        while let retirement = self.retirementInFlight {
            await retirement.task.value
            if self.retirementInFlight?.token == retirement.token {
                self.retirementInFlight = nil
            }
        }
    }

    private func finishCreation(_ create: TunnelCreation) async throws -> Route {
        let tunnel: RemotePortTunnel
        do {
            tunnel = try await create.task.value
        } catch {
            if self.createInFlight?.token == create.token { self.createInFlight = nil }
            throw error
        }
        guard self.lifecycleGeneration == create.lifecycleGeneration else {
            await self.waitForRetirement()
            throw CancellationError()
        }
        if let active = controlTunnel, active.tunnel === tunnel {
            return active.route
        }
        guard self.createInFlight?.token == create.token else {
            await self.waitForRetirement()
            throw CancellationError()
        }
        let currentConfiguration: RemotePortTunnel.Configuration
        do {
            currentConfiguration = try RemotePortTunnel.configuration()
        } catch {
            self.beginRetirement()
            await self.waitForRetirement()
            throw error
        }
        guard currentConfiguration == create.configuration else {
            let replacementGeneration = self.beginRetirement()
            await self.waitForRetirement()
            try Task.checkCancellation()
            guard self.lifecycleGeneration == replacementGeneration else {
                throw CancellationError()
            }
            return try await self.ensureControlTunnelRoute(
                lifecycleGeneration: replacementGeneration)
        }
        self.createInFlight = nil
        self.tunnelGeneration &+= 1
        let resolvedPort = tunnel.localPort
        let route = Route(localPort: resolvedPort, generation: tunnelGeneration)
        self.controlTunnel = ActiveTunnel(
            tunnel: tunnel,
            configuration: create.configuration,
            route: route)
        self.lastSandboxForwardAttemptAt = nil
        self.refreshSandboxForward(configuration: create.configuration, route: route)
        self.logger.info(
            "ssh tunnel ready localPort=\(resolvedPort, privacy: .public) " +
                "generation=\(route.generation, privacy: .public)")
        return route
    }

    func shutdown() async {
        // Quit closes admission permanently; reconnect and mode changes still use stopAll.
        self.isShutDown = true
        await self.stopAll()
    }

    func stopAll(ifCurrent: @Sendable () -> Bool = { true }) async {
        // A queued reset cannot retire a successor selected before this actor admits it.
        guard ifCurrent() else { return }
        // Invalidate every captured route before terminating processes. Delayed
        // health checks and create completions cannot resurrect this epoch.
        self.beginRetirement()
        await self.waitForRetirement()
    }

    #if DEBUG
    static func _testWaitForRestartBackoff(
        seconds: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void) async throws
    {
        try await self.waitForRestartBackoff(seconds: seconds, sleep: sleep)
    }
    #endif

    private func waitForRestartBackoffIfNeeded() async throws {
        guard let last = lastRestartAt else { return }
        let elapsed = Date().timeIntervalSince(last)
        let remaining = self.restartBackoffSeconds - elapsed
        guard remaining > 0 else { return }
        self.logger.info(
            "control tunnel restart backoff \(remaining, privacy: .public)s")
        try await Self.waitForRestartBackoff(seconds: remaining)
    }

    private nonisolated static func waitForRestartBackoff(
        seconds: TimeInterval,
        sleep: @escaping @Sendable (UInt64) async throws -> Void = { try await Task.sleep(nanoseconds: $0) })
        async throws
    {
        try Task.checkCancellation()
        try await sleep(UInt64(seconds * 1_000_000_000))
        try Task.checkCancellation()
    }
}
