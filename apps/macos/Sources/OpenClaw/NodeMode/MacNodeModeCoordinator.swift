import AppKit
import Foundation
import OpenClawIPC
import OpenClawKit
import OpenClawProtocol
import OSLog

struct MacNodeGatewayTLSSessionCache {
    private var cached: (url: URL, params: GatewayTLSParams, box: WebSocketSessionBox)?

    mutating func sessionBox(url: URL, params: GatewayTLSParams) -> WebSocketSessionBox {
        if let cached, cached.url == url, cached.params == params {
            return cached.box
        }
        let box = WebSocketSessionBox(session: GatewayTLSPinningSession(params: params))
        self.cached = (url, params, box)
        return box
    }

    mutating func invalidate() {
        self.cached = nil
    }
}

private struct ConnectionAttempt {
    let endpointGeneration: UInt64
    let routeAuthorityGeneration: UInt64
    let workerUnavailable: (reason: String, diagnostic: String?)?
    let endpoint: GatewayConnection.EndpointSnapshot
    let options: GatewayConnectOptions
    let sessionBox: WebSocketSessionBox?
    let fallbackMainSessionKey: String
}

private enum RouteInvalidationMode {
    case ordinaryDisconnect
    case reconnectRefresh
    case workerRestart
    case terminalStop
}

@MainActor
final class MacNodeModeCoordinator: NSObject {
    static let shared = MacNodeModeCoordinator()

    private(set) var connectedNodeId: String?

    func connectedDeviceId() -> String? {
        self.connectedNodeId
    }

    private func recordConnectedNodeId(_ nodeId: String?, authorityGeneration: UInt64) {
        guard self.routeAuthorityGeneration == authorityGeneration else { return }
        guard self.connectedNodeId != nodeId else { return }
        self.connectedNodeId = nodeId
        NotificationCenter.default.post(name: .openclawDeviceSettingsChanged, object: nil)
    }

    static var nodeIdentityProfile: GatewayDeviceIdentityProfile {
        self.resolveNodeIdentityProfile(
            defaults: AppDefaults.standard,
            isExistingInstallation: AppStateStore.shared.onboardingSeen)
    }

    static func prepareNodeIdentityProfile(isExistingInstallation: Bool) {
        _ = self.resolveNodeIdentityProfile(
            defaults: AppDefaults.standard,
            isExistingInstallation: isExistingInstallation)
    }

    static func resolveNodeIdentityProfile(
        defaults: UserDefaults,
        isExistingInstallation: Bool) -> GatewayDeviceIdentityProfile
    {
        if let rawValue = defaults.string(forKey: macNodeIdentityProfileKey),
           let stored = GatewayDeviceIdentityProfile(rawValue: rawValue),
           stored == .primary || stored == .node
        {
            return stored
        }
        // Released builds used the primary identity for the Mac node. Persist the
        // install-era choice before onboarding can change connection state.
        let selected: GatewayDeviceIdentityProfile = isExistingInstallation ? .primary : .node
        defaults.set(selected.rawValue, forKey: macNodeIdentityProfileKey)
        return selected
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "mac-node")
    private var task: Task<Void, Never>?
    private var endpointRefreshTask: Task<Void, Never>?
    private var reconnectProbeTask: Task<Void, Never>?
    private var routeInvalidationTask: Task<Void, Never>?
    private var terminalStopTask: Task<Void, Never>?
    private var nodeHostWorkerRetryTask: Task<Void, Never>?
    private var endpointAttemptGeneration: UInt64 = 0
    private var routeAuthorityGeneration: UInt64 = 0
    private var completedRouteAuthorityGeneration: UInt64 = 0
    private var nodeHostWorkerConfigurationGeneration: UInt64 = 0
    private var nodeHostWorkerRetryTaskGeneration: UInt64 = 0
    private var pendingEndpoint: GatewayConnection.EndpointSnapshot?
    private var activeNodeHostWorkerInput: MacNodeHostWorkerLaunch?
    private var lastNodeHostWorkerStartFailure: (reason: String, diagnostic: String?)?
    private(set) var desktopSharingEnabled: Bool? {
        didSet {
            guard self.desktopSharingEnabled != oldValue else { return }
            self.notificationCenter.post(name: .openclawDeviceSettingsChanged, object: nil)
        }
    }

    private var lastObservedPaused: Bool
    private var lastObservedComputerControlEnabled: Bool
    private var lastObservedComputerControlProvider: ComputerControlProvider
    private let runtime: MacNodeRuntime
    private let session: GatewayNodeSession
    private let endpointProvider: @Sendable () async throws -> GatewayConnection.EndpointSnapshot
    private let channelStatus: MacNodeChannelStatusStore
    private let nodeHostWorker: (any MacNodeHostWorking)?
    private var appActivityMonitor: Any?
    private let presenceReporter: MacNodePresenceReporter
    private let desktopAvailability: MacDesktopAvailabilityCoordinator
    private let workerHostingEnabled: @Sendable () async -> Bool
    private var desktopRoute: GatewayNodeSessionRoute?
    private var desktopRouteGeneration: UInt64 = 0
    private var desktopRefreshGeneration: UInt64 = 0
    private var desktopPublicationTask: Task<Void, Never>?
    private let notificationCenter: NotificationCenter
    private let nodeHostWorkerRetrySleep: @Sendable (UInt64) async throws -> Void
    private let refreshEvents: AsyncStream<Void>
    private let refreshContinuation: AsyncStream<Void>.Continuation
    private var tlsSessionCache = MacNodeGatewayTLSSessionCache()
    private var nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy

    override private convenience init() {
        let session = GatewayNodeSession()
        let nodeHostWorker = MacNodeHostWorker(session: session) { generation in
            NotificationCenter.default.post(name: .openclawNodeHostWorkerFailed, object: NSNumber(value: generation))
        }
        self.init(
            session: session,
            runtime: MacNodeRuntime(
                nodeHostWorker: nodeHostWorker,
                canvasSurfaceUrl: { await session.currentCanvasHostUrl() },
                refreshCanvasSurfaceUrl: { observedURL in
                    await session.refreshCanvasHostUrl(replacing: observedURL)
                }),
            nodeHostWorker: nodeHostWorker,
            presenceReporter: MacNodePresenceReporter(),
            workerHostingEnabled: { await nodeHostWorker.isWorkerHostingEnabled() },
            observeNotifications: true,
            initialPaused: nil,
            initialComputerControlEnabled: nil)
    }

    init(
        session: GatewayNodeSession,
        runtime: MacNodeRuntime,
        endpointProvider: @escaping @Sendable () async throws -> GatewayConnection.EndpointSnapshot = {
            try await GatewayEndpointStore.shared.requireEndpoint()
        },
        nodeHostWorker: (any MacNodeHostWorking)? = nil,
        presenceReporter: MacNodePresenceReporter = MacNodePresenceReporter(),
        desktopAvailability: MacDesktopAvailabilityCoordinator = .shared,
        workerHostingEnabled: @escaping @Sendable () async -> Bool = { false },
        channelStatus: MacNodeChannelStatusStore = .shared,
        notificationCenter: NotificationCenter = .default,
        observeNotifications: Bool = false,
        initialPaused: Bool? = nil,
        initialComputerControlEnabled: Bool? = nil,
        initialComputerControlProvider: ComputerControlProvider? = nil,
        nodeHostWorkerRetrySleep: @escaping @Sendable (UInt64) async throws -> Void = {
            try await Task.sleep(nanoseconds: $0)
        },
        nodeHostWorkerRetryPolicy: MacNodeHostWorkerRetryPolicy = MacNodeHostWorkerRetryPolicy())
    {
        let refreshEvents = AsyncStream.makeStream(of: Void.self, bufferingPolicy: .bufferingNewest(1))
        self.session = session
        self.endpointProvider = endpointProvider
        self.runtime = runtime
        self.nodeHostWorker = nodeHostWorker
        self.presenceReporter = presenceReporter
        self.desktopAvailability = desktopAvailability
        self.workerHostingEnabled = workerHostingEnabled
        self.channelStatus = channelStatus
        self.notificationCenter = notificationCenter
        self.nodeHostWorkerRetrySleep = nodeHostWorkerRetrySleep
        self.nodeHostWorkerRetryPolicy = nodeHostWorkerRetryPolicy
        self.refreshEvents = refreshEvents.stream
        self.refreshContinuation = refreshEvents.continuation
        self.lastObservedPaused = initialPaused ?? AppLaunchRuntimePlan.current.resolvePaused(
            AppDefaults.standard.bool(forKey: pauseDefaultsKey))
        self.lastObservedComputerControlEnabled = initialComputerControlEnabled ??
            isComputerControlEnabled()
        self.lastObservedComputerControlProvider = initialComputerControlProvider ??
            ComputerControlProvider.current()
        super.init()

        guard observeNotifications else { return }
        self.desktopAvailability.onStateChanged = { [weak self] state in
            NotificationCenter.default.post(name: .openclawDeviceSettingsChanged, object: nil)
            self?.publishDesktopAvailability(state)
        }
        self.desktopAvailability.onExecutionsRevoked = { [weak self] permits, reason in
            Task { [weak self] in
                guard let self else { return }
                await self.runtime.revokeDesktopExecutions(permits, reason: reason)
            }
        }
        let observers: [(Selector, Notification.Name, Any?)] = [
            (#selector(self.desktopHostingChanged), .openclawNodeHostHostingChanged, nil),
            (#selector(self.refreshNodeConfiguration), UserDefaults.didChangeNotification, AppDefaults.standard),
            (#selector(self.refreshNodeConfiguration), NSApplication.didBecomeActiveNotification, nil),
            (#selector(self.refreshNodeConfiguration), .openclawPermissionsChanged, nil),
            (#selector(self.nodeHostManifestChanged), .openclawNodeHostManifestChanged, nil),
            (#selector(self.nodeHostWorkerFailed), .openclawNodeHostWorkerFailed, nil),
            (#selector(self.nodeHostConfigurationChanged), .openclawConfigDidChange, nil),
            (#selector(self.nodeHostConfigurationChanged), .openclawCuaDriverAvailabilityChanged, nil),
        ]
        for (selector, name, object) in observers {
            self.notificationCenter.addObserver(self, selector: selector, name: name, object: object)
        }
    }

    @objc private nonisolated func nodeHostManifestChanged() {
        Task { @MainActor [weak self] in
            self?.enqueueRouteInvalidation(mode: .reconnectRefresh)
        }
    }

    deinit {
        self.notificationCenter.removeObserver(self)
        self.refreshContinuation.finish()
    }

    func start() {
        guard self.task == nil else { return }
        self.appActivityMonitor = NSEvent.addLocalMonitorForEvents(matching: [
            .keyDown, .flagsChanged, .leftMouseDown, .rightMouseDown, .otherMouseDown,
            .mouseMoved, .leftMouseDragged, .rightMouseDragged, .otherMouseDragged, .scrollWheel,
        ]) { [weak self] event in
            self?.presenceReporter.recordAppActivity()
            return event
        }
        self.task = Task { [weak self] in
            await self?.run()
        }
        self.endpointRefreshTask = Task { [weak self] in
            let states = await GatewayEndpointStore.shared.subscribe()
            var previousState: GatewayEndpointState?
            for await state in states {
                guard let self else { return }
                let initialStateMissedAttempt = previousState == nil &&
                    self.pendingEndpoint.map { !Self.endpointState(state, matches: $0) } == true
                let endpointChanged = previousState.map {
                    Self.endpointTransitionRequiresDisconnect(from: $0, to: state)
                } ?? false
                if initialStateMissedAttempt || endpointChanged {
                    // Endpoint loss and replacement are ownership changes. Tear down the
                    // old route (including held input) before waking the connect loop.
                    self.enqueueRouteInvalidation(mode: .reconnectRefresh)
                }
                previousState = state
            }
        }
    }

    func stop() {
        self.cancelCoordinatorTasks()
        _ = self.beginTerminalStop()
    }

    func stopAndWait() async {
        self.cancelCoordinatorTasks()
        await self.beginTerminalStop().value
    }

    func prepareForCuaDaemonStop() async {
        await self.enqueueRouteInvalidation(mode: .workerRestart).value
    }

    private func beginTerminalStop() -> Task<Void, Never> {
        if let terminalStopTask = self.terminalStopTask {
            return terminalStopTask
        }
        let task = self.enqueueRouteInvalidation(mode: .terminalStop)
        self.terminalStopTask = task
        return task
    }

    private func cancelCoordinatorTasks() {
        if let appActivityMonitor = self.appActivityMonitor {
            NSEvent.removeMonitor(appActivityMonitor)
            self.appActivityMonitor = nil
        }
        self.channelStatus.record(.idle)
        self.task?.cancel()
        self.task = nil
        self.endpointRefreshTask?.cancel()
        self.endpointRefreshTask = nil
        self.reconnectProbeTask?.cancel()
        self.reconnectProbeTask = nil
    }

    func refresh() {
        self.refresh(
            isPaused: AppLaunchRuntimePlan.current.resolvePaused(
                AppDefaults.standard.bool(forKey: pauseDefaultsKey)),
            computerControlEnabled: isComputerControlEnabled(),
            computerControlProvider: ComputerControlProvider.current())
    }

    func setPresenceActivityReportingEnabled(_ enabled: Bool) async {
        await self.presenceReporter.setReportingEnabled(enabled)
    }

    private func clearPresenceActivity(
        ifCurrentRoute route: GatewayNodeSessionRoute) async -> MacNodePresenceReporter.ClearDeliveryResult
    {
        do {
            let result = try await self.session.requestEventResult(
                event: "node.presence.activity",
                payloadJSON: #"{"action":"clear"}"#,
                ifCurrentRoute: route)
            guard let result else { return .unsupported }
            return result.ok && result.handled ? .cleared : .unsupported
        } catch is GatewayResponseError {
            // Gateways predating the structured node-event result can reject the
            // new payload at the request boundary instead of returning handled=false.
            return .unsupported
        } catch {
            self.logger.error(
                "mac node presence clear failed: \(error.localizedDescription, privacy: .public)")
            return .retry
        }
    }

    private func refresh(
        isPaused: Bool,
        computerControlEnabled: Bool,
        computerControlProvider: ComputerControlProvider)
    {
        let providerChanged = self.lastObservedComputerControlProvider != computerControlProvider
        let shouldRevoke = Self.controlTransitionRequiresRouteInvalidation(
            previousPaused: self.lastObservedPaused,
            nextPaused: isPaused,
            previousComputerControlEnabled: self.lastObservedComputerControlEnabled,
            nextComputerControlEnabled: computerControlEnabled,
            previousComputerControlProvider: self.lastObservedComputerControlProvider,
            nextComputerControlProvider: computerControlProvider)
        self.lastObservedPaused = isPaused
        self.lastObservedComputerControlEnabled = computerControlEnabled
        self.lastObservedComputerControlProvider = computerControlProvider

        if shouldRevoke {
            self.enqueueRouteInvalidation(mode: providerChanged ? .workerRestart : .reconnectRefresh)
        } else {
            // Routine permission/foreground/defaults refreshes invalidate only
            // suspended setup. The installed route remains authoritative.
            self.invalidateEndpointAttempt()
            self.refreshContinuation.yield()
        }
    }

    private func invalidateEndpointAttempt() {
        self.endpointAttemptGeneration &+= 1
    }

    private func revokeRouteAuthority() {
        self.recordConnectedNodeId(nil, authorityGeneration: self.routeAuthorityGeneration)
        self.retireDesktopRoute(reason: "route-revoked")
        self.invalidateEndpointAttempt()
        self.routeAuthorityGeneration &+= 1
    }

    /// Serializes route revocation for endpoint, settings, pause, and stop flows.
    /// Generation advances synchronously; disconnect then cancels active computer
    /// invokes and runs the held-input release hook before the latest refresh wakes.
    @discardableResult
    private func enqueueRouteInvalidation(
        mode: RouteInvalidationMode) -> Task<Void, Never>
    {
        // Worker replacement advances synchronously so a queued exit from the
        // old process cannot revoke or consume retry budget from its successor.
        switch mode {
        case .workerRestart, .terminalStop:
            self.desktopSharingEnabled = nil
            self.nodeHostWorkerConfigurationGeneration &+= 1
            self.resetNodeHostWorkerRetryState()
        case .ordinaryDisconnect, .reconnectRefresh:
            break
        }
        self.revokeRouteAuthority()
        let invalidationGeneration = self.endpointAttemptGeneration
        let invalidatedRouteAuthorityGeneration = self.routeAuthorityGeneration
        let previous = self.routeInvalidationTask
        let session = self.session
        let presenceReporter = self.presenceReporter
        let nodeHostWorker = self.nodeHostWorker
        let runtime = self.runtime
        let task = Task { @MainActor [weak self] in
            await previous?.value
            await session.disconnect()
            await Self.invalidateRuntimeRoute(
                presenceReporter: presenceReporter,
                nodeHostWorker: nodeHostWorker,
                runtime: runtime,
                authorityGeneration: invalidatedRouteAuthorityGeneration)
            let yieldRefresh: Bool
            switch mode {
            case .ordinaryDisconnect:
                yieldRefresh = false
            case .reconnectRefresh:
                yieldRefresh = true
            case .workerRestart:
                await nodeHostWorker?.stop()
                yieldRefresh = true
            case .terminalStop:
                await nodeHostWorker?.stop()
                await runtime.shutdown()
                yieldRefresh = false
            }
            guard let self else { return }
            self.completedRouteAuthorityGeneration = invalidatedRouteAuthorityGeneration
            guard yieldRefresh,
                  invalidationGeneration == self.endpointAttemptGeneration,
                  !Task.isCancelled
            else { return }
            self.refreshContinuation.yield()
        }
        self.routeInvalidationTask = task
        return task
    }

    private func invalidateRuntimeRoute(authorityGeneration: UInt64) async {
        await Self.invalidateRuntimeRoute(
            presenceReporter: self.presenceReporter,
            nodeHostWorker: self.nodeHostWorker,
            runtime: self.runtime,
            authorityGeneration: authorityGeneration)
    }

    private static func invalidateRuntimeRoute(
        presenceReporter: MacNodePresenceReporter,
        nodeHostWorker: (any MacNodeHostWorking)?,
        runtime: MacNodeRuntime,
        authorityGeneration: UInt64) async
    {
        presenceReporter.stop()
        _ = await nodeHostWorker?.setRoute(nil, authorityGeneration: authorityGeneration)
        await runtime.releaseHeldComputerInput()
    }

    private func awaitStableRouteInvalidationDrain(
        onPendingSnapshot: (@Sendable () async -> Void)? = nil) async
    {
        while self.completedRouteAuthorityGeneration != self.routeAuthorityGeneration {
            let pendingInvalidation = self.routeInvalidationTask
            await onPendingSnapshot?()
            await pendingInvalidation?.value
        }
    }

    private func run() async {
        var retryDelay: UInt64 = 1_000_000_000
        var refreshIterator = self.refreshEvents.makeAsyncIterator()
        while !Task.isCancelled {
            // A stop/refresh immediately followed by start/unpause must not install
            // a successor route ahead of the serialized disconnect/input release.
            await self.awaitStableRouteInvalidationDrain()
            guard !Task.isCancelled else { return }
            let isPaused = AppStateStore.shared.isPaused
            if isPaused {
                // Pause revokes the node route, not only the outer retry loop. A
                // connected gateway was revoked before this refresh wake was emitted.
                self.channelStatus.record(.idle)
                guard await refreshIterator.next() != nil else { return }
                continue
            }

            let codexThreadCatalogEnabled = MacNodeCodexThreadCatalog.shouldAdvertise()
            let claudeSessionCatalogEnabled = MacNodeClaudeSessionCatalog.shouldAdvertise()

            do {
                let endpointAttemptGeneration = self.endpointAttemptGeneration
                let routeAuthorityGeneration = self.routeAuthorityGeneration
                let endpoint = try await self.endpointProvider()
                self.pendingEndpoint = endpoint
                guard endpointAttemptGeneration == self.endpointAttemptGeneration,
                      self.routeAuthorityAllowsInvoke(routeAuthorityGeneration, isPaused: false)
                else { continue }
                guard let attempt = try await self.prepareConnectionAttempt(
                    endpoint: endpoint,
                    endpointGeneration: endpointAttemptGeneration,
                    routeAuthorityGeneration: routeAuthorityGeneration,
                    codexThreadCatalogEnabled: codexThreadCatalogEnabled,
                    claudeSessionCatalogEnabled: claudeSessionCatalogEnabled)
                else { continue }

                guard try await self.connectWithTLSRepair(attempt) else {
                    retryDelay = 1_000_000_000
                    continue
                }
                guard try await self.validatePostConnect(attempt) else { continue }

                retryDelay = 1_000_000_000
                // GatewayNodeSession owns transport reconnects. Wait until inputs can
                // actually change instead of rereading config and TCC state every second.
                guard await refreshIterator.next() != nil else { return }
            } catch {
                if error is MacNodeHostWorkerRetryPolicy.RetryBackoffPending {
                    // The lifecycle-owned delayed wake is the only event allowed
                    // to admit this same worker input after an unexpected exit.
                    let failure = self.lastNodeHostWorkerStartFailure ?? (error.localizedDescription, nil)
                    self.channelStatus.record(.unavailable(reason: failure.reason, diagnostic: failure.diagnostic))
                    guard await refreshIterator.next() != nil else { return }
                    continue
                }
                self.logger.error("mac node gateway connect failed: \(error.localizedDescription, privacy: .public)")
                let failure = Self.nodeGatewayConnectionFailure(error)
                self.channelStatus.record(.unavailable(reason: failure.reason, diagnostic: failure.diagnostic))
                try? await Task.sleep(nanoseconds: min(retryDelay, 10_000_000_000))
                retryDelay = min(retryDelay * 2, 10_000_000_000)
            }
        }
    }

    private func prepareConnectionAttempt(
        endpoint: GatewayConnection.EndpointSnapshot,
        endpointGeneration: UInt64,
        routeAuthorityGeneration: UInt64,
        codexThreadCatalogEnabled: Bool,
        claudeSessionCatalogEnabled: Bool) async throws -> ConnectionAttempt?
    {
        let config = endpoint.config
        let provider = ComputerControlProvider.current()
        let workerConfigurationGeneration = self.nodeHostWorkerConfigurationGeneration
        let (workerManifest, workerUnavailable) =
            try await self.resolveWorkerManifestForConnection(provider: provider)
        let computerControlEnabled = isComputerControlEnabled()
        let nativeCaps = Self.resolvedCaps(
            computerControlProvider: provider,
            connectionMode: AppStateStore.shared.connectionMode,
            codexThreadCatalogEnabled: codexThreadCatalogEnabled,
            claudeSessionCatalogEnabled: claudeSessionCatalogEnabled)
        // If Computer Control was turned off, release any button the
        // computer.act service is still holding rather than waiting for
        // the idle watchdog. Discoverability does not grant execution authority.
        if !computerControlEnabled {
            await self.runtime.releaseHeldComputerInput()
        }
        let caps = Self.mergingUnique(nativeCaps, workerManifest?.caps ?? [])
        let commands = Self.mergingUnique(
            Self.resolvedCommands(caps: nativeCaps, computerControlProvider: provider),
            workerManifest?.commands ?? [])
        let permissions = await Self.advertisedPermissions(PermissionManager.authorizationStatus())
        // TCC queries suspend. An endpoint loss/replacement during that
        // hop must not let this stale continuation install old credentials.
        guard endpointGeneration == self.endpointAttemptGeneration,
              self.routeAuthorityAllowsInvoke(routeAuthorityGeneration, isPaused: false)
        else { return nil }
        // Node credentials belong to the selected endpoint, matching the operator route.
        // A missing owner must not unlock legacy role-global token storage.
        let deviceAuth = Self.nodeDeviceAuthBinding(for: endpoint)
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: caps,
            commands: commands,
            computerUse: Self.computerUseDescriptor(
                provider: provider,
                commands: commands,
                workerManifest: workerManifest),
            pathEnv: workerManifest?.pathEnv,
            permissions: permissions,
            clientId: "openclaw-macos",
            clientMode: "node",
            clientDisplayName: InstanceIdentity.displayName,
            deviceIdentityProfile: Self.nodeIdentityProfile,
            allowStoredDeviceAuth: deviceAuth.allowStoredDeviceAuth,
            deviceAuthGatewayID: deviceAuth.gatewayID)
        let sessionBox = self.buildSessionBox(url: config.url, tls: endpoint.tls)

        // Resolve compatibility fallback before node admission. Operator recovery
        // here cannot block the node lifecycle callback or its successor cleanup.
        let fallbackMainSessionKey = await GatewayConnection.shared.refreshMainSessionKey()
        let currentEndpoint = try await self.endpointProvider()
        guard workerConfigurationGeneration == self.nodeHostWorkerConfigurationGeneration,
              Self.endpointAttemptCanConnect(
                  capturedGeneration: endpointGeneration,
                  currentGeneration: self.endpointAttemptGeneration,
                  isCancelled: Task.isCancelled,
                  isPaused: AppStateStore.shared.isPaused,
                  capturedEndpoint: endpoint,
                  currentEndpoint: currentEndpoint),
              self.routeAuthorityAllowsInvoke(routeAuthorityGeneration)
        else { return nil }

        if let workerManifest {
            // The private worker declares configured intent before RFB, pairing, or Gateway policy checks.
            self.desktopSharingEnabled = workerManifest.commands.contains("desktop.stream")
        }
        return ConnectionAttempt(
            endpointGeneration: endpointGeneration,
            routeAuthorityGeneration: routeAuthorityGeneration,
            workerUnavailable: workerUnavailable,
            endpoint: endpoint,
            options: options,
            sessionBox: sessionBox,
            fallbackMainSessionKey: fallbackMainSessionKey)
    }

    private func connect(_ attempt: ConnectionAttempt) async throws {
        try await self.session.connect(
            url: attempt.endpoint.config.url,
            credentials: GatewayNodeSessionCredentials(
                token: attempt.endpoint.config.token,
                password: attempt.endpoint.config.password),
            connectOptions: attempt.options,
            sessionBox: attempt.sessionBox,
            onConnected: { [weak self] in
                guard let self else { return }
                guard await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration) else { return }
                // Capture this callback's admission before setup suspends. The
                // sender lease then drops already-captured events after replacement.
                guard let installedRoute = await self.session.currentRoute() else { return }
                let nodeId = await self.session.connectedDeviceId()
                guard await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration) else { return }
                await self.recordConnectedNodeId(nodeId, authorityGeneration: attempt.routeAuthorityGeneration)
                let workerRouteInstalled = await self.nodeHostWorker?.setRoute(
                    installedRoute,
                    authorityGeneration: attempt.routeAuthorityGeneration) ?? true
                guard workerRouteInstalled else { return }
                await self.nodeHostWorker?.gatewayConnected(ifCurrentRoute: installedRoute)
                await self.cancelReconnectProbe()
                await self.channelStatus.record(.connected(
                    workerUnavailableReason: attempt.workerUnavailable?.reason,
                    diagnostic: attempt.workerUnavailable?.diagnostic))
                self.logger.info("mac node connected to gateway")
                // The node hello owns this route's session defaults. Reusing the operator
                // connection here can trigger remote-tunnel recovery while the node connects.
                let snapshotMainSessionKey = await self.session.waitForCurrentMainSessionKey(
                    ifCurrentRoute: installedRoute)
                let mainSessionKey = snapshotMainSessionKey ?? attempt.fallbackMainSessionKey
                let routeStillAuthoritative = await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration)
                let currentRoute = await self.session.currentRoute()
                guard routeStillAuthoritative, currentRoute == installedRoute else { return }
                let desktopCommands = ["desktop.stream", "screen.snapshot", "computer.act"]
                if attempt.options.commands.contains(where: desktopCommands.contains) {
                    await self.installDesktopRoute(
                        installedRoute,
                        authorityGeneration: attempt.routeAuthorityGeneration)
                }
                await self.runtime.updateMainSessionKey(mainSessionKey)
                await self.presenceReporter.start(
                    sender: { [weak self] event, payload in
                        guard let self else { return false }
                        return await self.session.sendEvent(
                            event: event,
                            payloadJSON: payload,
                            ifCurrentRoute: installedRoute)
                    },
                    clearer: { [weak self] in
                        guard let self else { return .retry }
                        return await self.clearPresenceActivity(ifCurrentRoute: installedRoute)
                    },
                    onUnsupportedClear: { [weak self] in
                        guard let self else { return }
                        // Disconnect is the only clear operation older Gateways understand.
                        // Fresh disabled routes emit no clear, so this fallback is one-shot.
                        self.logger.info("reconnecting mac node to clear legacy presence activity")
                        _ = self.enqueueRouteInvalidation(mode: .reconnectRefresh)
                    })
            },
            onDisconnected: { [weak self] reason in
                guard let self else { return }
                await self.recordConnectedNodeId(nil, authorityGeneration: attempt.routeAuthorityGeneration)
                await self.retireDesktopRoute(
                    ifAuthorityGeneration: attempt.routeAuthorityGeneration, reason: "gateway-disconnect")
                await self.channelStatus.record(.unavailable(
                    reason: reason,
                    diagnostic: attempt.workerUnavailable?.diagnostic))
                await self.invalidateRuntimeRoute(authorityGeneration: attempt.routeAuthorityGeneration)
                await self.scheduleReconnectProbe()
                self.logger.error("mac node disconnected: \(reason, privacy: .public)")
            },
            onInvoke: { [weak self] req in
                guard let self else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(code: .unavailable, message: "UNAVAILABLE: node not ready"))
                }
                guard await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration) else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: node route changed before dispatch"))
                }
                // The connect options are this route's capability lease. A later
                // config enable must not broaden an already-admitted connection;
                // MacNodeRuntime separately rechecks current config to fail closed.
                guard Self.routeSnapshotAllowsCodexCatalogInvoke(
                    command: req.command,
                    catalogAdvertised: attempt.options.commands.contains(MacNodeCodexThreadCatalogContract.listCommand))
                else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: Codex session catalog was not advertised for this route"))
                }
                guard Self.routeSnapshotAllowsClaudeCatalogInvoke(
                    command: req.command,
                    catalogAdvertised: attempt.options.commands
                        .contains(MacNodeClaudeSessionCatalogContract.listCommand))
                else {
                    return BridgeInvokeResponse(
                        id: req.id,
                        ok: false,
                        error: OpenClawNodeError(
                            code: .unavailable,
                            message: "UNAVAILABLE: Claude session catalog was not advertised for this route"))
                }
                return await self.runtime.handleInvoke(req)
            },
            onInvokeInput: { [weak self] input in
                guard let self,
                      await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration)
                else { return }
                await self.nodeHostWorker?.handleInput(
                    invokeId: input.id,
                    seq: input.seq,
                    payloadJSON: input.payloadjson)
            },
            onInvokeCancel: { [weak self] invokeId in
                guard let self,
                      await self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration)
                else { return }
                await self.nodeHostWorker?.cancel(invokeId: invokeId)
            },
            onRouteInvalidated: { [weak self] in
                await self?.retireDesktopRoute(
                    ifAuthorityGeneration: attempt.routeAuthorityGeneration, reason: "gateway-route-invalidated")
                await self?.invalidateRuntimeRoute(authorityGeneration: attempt.routeAuthorityGeneration)
            })
    }

    private func validatePostConnect(_ attempt: ConnectionAttempt) async throws -> Bool {
        let postConnectEndpoint = try await self.endpointProvider()
        guard Self.endpointAttemptCanConnect(
            capturedGeneration: attempt.endpointGeneration,
            currentGeneration: self.endpointAttemptGeneration,
            isCancelled: Task.isCancelled,
            isPaused: AppStateStore.shared.isPaused,
            capturedEndpoint: attempt.endpoint,
            currentEndpoint: postConnectEndpoint)
        else {
            if Self.stalePostConnectRequiresDisconnect(
                capturedRouteAuthorityGeneration: attempt.routeAuthorityGeneration,
                currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
                completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
                isCancelled: Task.isCancelled,
                isPaused: AppStateStore.shared.isPaused,
                capturedEndpoint: attempt.endpoint,
                currentEndpoint: postConnectEndpoint)
            {
                await self.session.disconnect()
            }
            return false
        }
        return true
    }

    private func scheduleReconnectProbe() {
        self.reconnectProbeTask?.cancel()
        // GatewayChannel reconnects normally, but pauses after auth or pairing failures.
        // Probe only while disconnected so recovery does not restore steady idle polling.
        self.reconnectProbeTask = Task { [weak self] in
            try? await Task.sleep(for: .seconds(30))
            guard !Task.isCancelled else { return }
            self?.refresh()
        }
    }

    private func routeAuthorityAllowsInvoke(_ capturedGeneration: UInt64, isPaused: Bool? = nil) -> Bool {
        Self.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: capturedGeneration,
            currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
            completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
            isPaused: isPaused ?? AppStateStore.shared.isPaused)
    }

    #if DEBUG
    func waitForRouteInvalidationForTesting(
        onPendingSnapshot: (@Sendable () async -> Void)? = nil) async
    {
        await self.awaitStableRouteInvalidationDrain(onPendingSnapshot: onPendingSnapshot)
    }

    func refreshForTesting(
        isPaused: Bool,
        computerControlEnabled: Bool,
        computerControlProvider: ComputerControlProvider = .peekaboo)
    {
        self.refresh(
            isPaused: isPaused,
            computerControlEnabled: computerControlEnabled,
            computerControlProvider: computerControlProvider)
    }

    func enqueueRouteInvalidationForTesting() {
        self.enqueueRouteInvalidation(mode: .ordinaryDisconnect)
    }

    func generationsForTesting() -> (endpointAttempt: UInt64, routeAuthority: UInt64, completedRouteAuthority: UInt64) {
        (
            self.endpointAttemptGeneration,
            self.routeAuthorityGeneration,
            self.completedRouteAuthorityGeneration)
    }

    func routeAuthorityAllowsInvokeForTesting(_ capturedGeneration: UInt64, isPaused: Bool) -> Bool {
        Self.routeAuthorityAllowsInvoke(
            capturedRouteAuthorityGeneration: capturedGeneration,
            currentRouteAuthorityGeneration: self.routeAuthorityGeneration,
            completedRouteAuthorityGeneration: self.completedRouteAuthorityGeneration,
            isPaused: isPaused)
    }

    func prepareNodeHostWorkerRetryForTesting(command: [String]) throws {
        guard self.nodeHostWorkerRetryTask == nil else {
            throw MacNodeHostWorkerRetryPolicy.RetryBackoffPending()
        }
        let input = MacNodeHostWorkerLaunch(
            command: command,
            configurationGeneration: self.nodeHostWorkerConfigurationGeneration)
        try self.nodeHostWorkerRetryPolicy.prepareForStart(input)
        self.activeNodeHostWorkerInput = input
    }

    func handleNodeHostWorkerFailureForTesting(configurationGeneration: UInt64? = nil) {
        self.handleNodeHostWorkerFailure(
            configurationGeneration: configurationGeneration ?? self.nodeHostWorkerConfigurationGeneration)
    }

    func waitForNodeHostWorkerRetryForTesting() async {
        await self.nodeHostWorkerRetryTask?.value
    }

    func handleNodeHostConfigurationChangeForTesting() async {
        await self.handleNodeHostConfigurationChange().value
    }

    func resolveWorkerManifestForConnectionForTesting(
        provider: ComputerControlProvider = .peekaboo) async throws
        -> (manifest: MacNodeHostManifest?, unavailable: (reason: String, diagnostic: String?)?)
    {
        try await self.resolveWorkerManifestForConnection(provider: provider)
    }
    #endif

    private func cancelReconnectProbe() {
        self.reconnectProbeTask?.cancel()
        self.reconnectProbeTask = nil
    }

    @objc private nonisolated func refreshNodeConfiguration(_: Notification) {
        Task { @MainActor [weak self] in
            self?.refresh()
        }
    }

    @objc private nonisolated func nodeHostWorkerFailed(_ notification: Notification) {
        guard let generation = (notification.object as? NSNumber)?.uint64Value else { return }
        Task { @MainActor [weak self] in
            self?.handleNodeHostWorkerFailure(configurationGeneration: generation)
        }
    }

    @objc private nonisolated func nodeHostConfigurationChanged(_: Notification) {
        Task { @MainActor [weak self] in
            self?.handleNodeHostConfigurationChange()
        }
    }

    @discardableResult
    private func handleNodeHostConfigurationChange() -> Task<Void, Never> {
        // Worker code, plugin availability, and its manifest are startup-scoped.
        // Replace the process before reconnecting so updates cannot leave a stale route.
        self.enqueueRouteInvalidation(mode: .workerRestart)
    }
}

extension MacNodeModeCoordinator {
    #if DEBUG
    func connectForTesting(
        endpoint: GatewayConnection.EndpointSnapshot,
        sessionBox: WebSocketSessionBox) async throws -> Bool
    {
        try await self.connectWithTLSRepair(ConnectionAttempt(
            endpointGeneration: self.endpointAttemptGeneration,
            routeAuthorityGeneration: self.routeAuthorityGeneration,
            workerUnavailable: nil,
            endpoint: endpoint,
            options: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: [],
                permissions: [:],
                clientId: "openclaw-macos",
                clientMode: "node",
                clientDisplayName: "Renewal Test",
                includeDeviceIdentity: false),
            sessionBox: sessionBox,
            fallbackMainSessionKey: "main"))
    }

    #endif

    private func connectWithTLSRepair(_ attempt: ConnectionAttempt) async throws -> Bool {
        do {
            try await self.connect(attempt)
            return true
        } catch let error as GatewayTLSValidationError {
            let currentEndpoint = try await self.endpointProvider()
            guard !Task.isCancelled,
                  attempt.endpointGeneration == self.endpointAttemptGeneration,
                  self.routeAuthorityAllowsInvoke(attempt.routeAuthorityGeneration, isPaused: self.lastObservedPaused),
                  Self.sameEndpoint(attempt.endpoint, currentEndpoint, allowLearnedPinRenewal: true)
            else { throw CancellationError() }
            // Keep owner validation and the conditional write on this executor.
            // An actor hop here could let a revoked attempt persist its old trust.
            guard GatewayTLSRepairCoordinator.repairOnCurrentExecutor(
                route: attempt.endpoint.tls,
                url: attempt.endpoint.config.url,
                failure: error.failure)
            else { throw error }
            await self.session.disconnect()
            return false
        }
    }

    /// The node-host worker is a capability superset, not a connect
    /// precondition. Backoff-pending is transient (its lifecycle-owned wake
    /// retries shortly); every other worker failure connects this Mac with
    /// native capabilities only and surfaces the reason to the operator.
    private func resolveWorkerManifestForConnection(
        provider: ComputerControlProvider) async throws
        -> (manifest: MacNodeHostManifest?, unavailable: (reason: String, diagnostic: String?)?)
    {
        do {
            let manifest = try await Self.workerManifest(
                self.startNodeHostWorkerIfConfigured(provider: provider),
                for: provider)
            return (manifest, nil)
        } catch let backoff as MacNodeHostWorkerRetryPolicy.RetryBackoffPending {
            throw backoff
        } catch {
            return (nil, self.recordNodeHostWorkerStartFailure(error))
        }
    }

    private func startNodeHostWorkerIfConfigured(
        provider: ComputerControlProvider) async throws -> MacNodeHostManifest?
    {
        guard let nodeHostWorker else { return nil }
        guard self.nodeHostWorkerRetryTask == nil else {
            throw MacNodeHostWorkerRetryPolicy.RetryBackoffPending()
        }
        if let activeInput = self.activeNodeHostWorkerInput {
            // Worker launch metadata is startup-scoped. Route retries reuse it instead of
            // resolving the bundle again until an explicit restart resets state.
            try self.nodeHostWorkerRetryPolicy.prepareForStart(activeInput)
            return try await nodeHostWorker.start(launch: activeInput)
        }
        let launch: MacNodeHostWorkerLaunch
        do {
            launch = try await CommandResolver.nodeHostWorkerLaunch(
                desktopSharingEnabled: AppDefaults.standard.object(forKey: desktopSharingEnabledKey) as? Bool)
        } catch let error as RuntimeResolutionError {
            throw MacNodeHostWorker.WorkerError.unavailable(reason: RuntimeLocator.describeFailure(error))
        }
        var workerEnvironment = launch.environment
        if provider == .cua, let endpoint = CuaDriverHostCoordinator.shared.workerEndpoint {
            workerEnvironment[CuaDriverWorkerEnvironment.endpoint] = try endpoint.environmentValue()
        }
        let effectiveLaunch = MacNodeHostWorkerLaunch(
            command: launch.command,
            currentDirectoryURL: launch.currentDirectoryURL,
            environment: workerEnvironment,
            configurationGeneration: self.nodeHostWorkerConfigurationGeneration)
        try self.nodeHostWorkerRetryPolicy.prepareForStart(effectiveLaunch)
        self.activeNodeHostWorkerInput = effectiveLaunch
        return try await nodeHostWorker.start(launch: effectiveLaunch)
    }

    /// Retry exhaustion keeps the concrete worker error it exhausted on; the
    /// bare "stopped after N unexpected exits" text cannot guide the operator.
    private func recordNodeHostWorkerStartFailure(_ error: Error) -> (reason: String, diagnostic: String?) {
        if error is MacNodeHostWorkerRetryPolicy.RetryBudgetExhausted {
            let previous = self.lastNodeHostWorkerStartFailure
            let detail = previous.map { " — \($0.reason)" } ?? ""
            return (error.localizedDescription + detail, previous?.diagnostic)
        }
        let failure = Self.nodeHostWorkerFailure(error)
        self.lastNodeHostWorkerStartFailure = failure
        return failure
    }

    private static func nodeHostWorkerFailure(_ error: Error) -> (reason: String, diagnostic: String?) {
        if let workerError = error as? MacNodeHostWorker.WorkerError,
           case let .unavailable(reason, diagnostic) = workerError
        {
            return (reason, diagnostic)
        }
        return (error.localizedDescription, nil)
    }

    static func nodeGatewayConnectionFailure(_ error: Error) -> (reason: String, diagnostic: String?) {
        guard let problem = GatewayConnectionProblemMapper.map(error: error),
              problem.needsPairingApproval
        else { return self.nodeHostWorkerFailure(error) }
        let reason = problem.actionLabel.map { "\(problem.statusText) — \($0)" } ?? problem.statusText
        return (reason, problem.message)
    }

    private func handleNodeHostWorkerFailure(configurationGeneration: UInt64) {
        guard configurationGeneration == self.nodeHostWorkerConfigurationGeneration else { return }
        self.desktopSharingEnabled = nil
        guard let input = self.activeNodeHostWorkerInput else {
            self.logger.error("node-host worker exited without an active startup input")
            self.enqueueRouteInvalidation(mode: .ordinaryDisconnect)
            return
        }

        self.cancelNodeHostWorkerRetryTask()
        let invalidation = self.enqueueRouteInvalidation(mode: .ordinaryDisconnect)
        switch self.nodeHostWorkerRetryPolicy.recordUnexpectedExit(for: input) {
        case let .retry(attempt, delayNanoseconds):
            self.nodeHostWorkerRetryTaskGeneration &+= 1
            let taskGeneration = self.nodeHostWorkerRetryTaskGeneration
            let delaySeconds = Double(delayNanoseconds) / 1_000_000_000
            self.logger.error(
                "node-host worker retry \(attempt, privacy: .public) in \(delaySeconds, privacy: .public)s")
            let retrySleep = self.nodeHostWorkerRetrySleep
            self.nodeHostWorkerRetryTask = Task { @MainActor [weak self] in
                await invalidation.value
                do {
                    try await retrySleep(delayNanoseconds)
                } catch {
                    return
                }
                guard let self,
                      self.nodeHostWorkerRetryTaskGeneration == taskGeneration,
                      self.activeNodeHostWorkerInput == input
                else { return }
                self.nodeHostWorkerRetryTask = nil
                self.refreshContinuation.yield()
            }
        case let .giveUp(unexpectedExitCount):
            self.logger.critical(
                "node-host worker gave up after \(unexpectedExitCount, privacy: .public) unexpected exits")
            self.notificationCenter.post(
                name: .openclawNodeHostWorkerRetryExhausted,
                object: self,
                userInfo: ["unexpectedExitCount": unexpectedExitCount])
            // The exhausted worker must not take the node channel with it. Wake
            // the connect loop after the disconnect drains so the next attempt
            // reconnects with native capabilities and a visible degraded reason.
            Task { @MainActor [weak self] in
                await invalidation.value
                self?.refreshContinuation.yield()
            }
        }
    }

    private func cancelNodeHostWorkerRetryTask() {
        self.nodeHostWorkerRetryTaskGeneration &+= 1
        self.nodeHostWorkerRetryTask?.cancel()
        self.nodeHostWorkerRetryTask = nil
    }

    private func resetNodeHostWorkerRetryState() {
        self.cancelNodeHostWorkerRetryTask()
        self.activeNodeHostWorkerInput = nil
        self.lastNodeHostWorkerStartFailure = nil
        self.nodeHostWorkerRetryPolicy.reset()
    }

    private func buildSessionBox(url: URL, tls: GatewayTLSRoute?) -> WebSocketSessionBox? {
        guard let tls else {
            self.tlsSessionCache.invalidate()
            return nil
        }
        return self.tlsSessionCache.sessionBox(url: url, params: tls.params)
    }
}

extension MacNodeModeCoordinator {
    nonisolated static func nodeDeviceAuthBinding(
        for endpoint: GatewayConnection.EndpointSnapshot) -> (allowStoredDeviceAuth: Bool, gatewayID: String?)
    {
        (endpoint.deviceAuthGatewayID != nil, endpoint.deviceAuthGatewayID)
    }

    static func endpointTransitionRequiresDisconnect(
        from previous: GatewayEndpointState,
        to next: GatewayEndpointState) -> Bool
    {
        switch (previous, next) {
        case (.ready, .ready): previous != next
        case (.ready, _), (_, .ready): true
        default: false
        }
    }

    nonisolated static func controlTransitionRequiresRouteInvalidation(
        previousPaused: Bool,
        nextPaused: Bool,
        previousComputerControlEnabled: Bool,
        nextComputerControlEnabled: Bool,
        previousComputerControlProvider: ComputerControlProvider = .peekaboo,
        nextComputerControlProvider: ComputerControlProvider = .peekaboo) -> Bool
    {
        (!previousPaused && nextPaused) ||
            (previousComputerControlEnabled && !nextComputerControlEnabled) ||
            previousComputerControlProvider != nextComputerControlProvider
    }

    nonisolated static func endpointState(
        _ state: GatewayEndpointState,
        matches endpoint: GatewayConnection.EndpointSnapshot) -> Bool
    {
        guard case let .ready(_, url, token, password, routeRevision) = state else { return false }
        return url == endpoint.config.url &&
            token == endpoint.config.token &&
            password == endpoint.config.password &&
            routeRevision == endpoint.revision
    }

    nonisolated static func endpointAttemptCanConnect(
        capturedGeneration: UInt64,
        currentGeneration: UInt64,
        isCancelled: Bool,
        isPaused: Bool,
        capturedEndpoint: GatewayConnection.EndpointSnapshot,
        currentEndpoint: GatewayConnection.EndpointSnapshot) -> Bool
    {
        capturedGeneration == currentGeneration &&
            !isCancelled &&
            !isPaused &&
            self.sameEndpoint(capturedEndpoint, currentEndpoint)
    }

    nonisolated static func routeAuthorityAllowsInvoke(
        capturedRouteAuthorityGeneration: UInt64,
        currentRouteAuthorityGeneration: UInt64,
        completedRouteAuthorityGeneration: UInt64,
        isPaused: Bool) -> Bool
    {
        capturedRouteAuthorityGeneration == currentRouteAuthorityGeneration &&
            currentRouteAuthorityGeneration == completedRouteAuthorityGeneration &&
            !isPaused
    }

    nonisolated static func routeSnapshotAllowsCodexCatalogInvoke(
        command: String,
        catalogAdvertised: Bool) -> Bool
    {
        !MacNodeCodexThreadCatalogContract.commands.contains(command) || catalogAdvertised
    }

    nonisolated static func routeSnapshotAllowsClaudeCatalogInvoke(
        command: String,
        catalogAdvertised: Bool) -> Bool
    {
        !MacNodeClaudeSessionCatalogContract.commands.contains(command) || catalogAdvertised
    }

    nonisolated static func stalePostConnectRequiresDisconnect(
        capturedRouteAuthorityGeneration: UInt64,
        currentRouteAuthorityGeneration: UInt64,
        completedRouteAuthorityGeneration: UInt64,
        isCancelled: Bool,
        isPaused: Bool,
        capturedEndpoint: GatewayConnection.EndpointSnapshot,
        currentEndpoint: GatewayConnection.EndpointSnapshot) -> Bool
    {
        capturedRouteAuthorityGeneration != currentRouteAuthorityGeneration ||
            currentRouteAuthorityGeneration != completedRouteAuthorityGeneration ||
            isCancelled ||
            isPaused ||
            !self.sameEndpoint(capturedEndpoint, currentEndpoint)
    }

    private nonisolated static func sameEndpoint(
        _ lhs: GatewayConnection.EndpointSnapshot,
        _ rhs: GatewayConnection.EndpointSnapshot,
        allowLearnedPinRenewal: Bool = false) -> Bool
    {
        let sameTLS = allowLearnedPinRenewal
            ? GatewayTLSRoute.hasSameTrustPolicy(lhs.tls, rhs.tls)
            : GatewayTLSRoute.hasSameConnectionIdentity(lhs.tls, rhs.tls)
        return lhs.config.url == rhs.config.url &&
            lhs.config.token == rhs.config.token &&
            lhs.config.password == rhs.config.password &&
            sameTLS &&
            lhs.routeAuthority == rhs.routeAuthority &&
            lhs.deviceAuthGatewayID == rhs.deviceAuthGatewayID &&
            lhs.revision == rhs.revision
    }

    nonisolated static func advertisedPermissions(
        _ statuses: [Capability: CapabilityAuthorizationStatus]) -> [String: Bool]
    {
        // Unknown TCC state is not denial. Omitting it keeps the node surface
        // narrow without turning a later confirmed grant into a false upgrade.
        Dictionary(uniqueKeysWithValues: statuses.compactMap { capability, status in
            guard status != .unknown else { return nil }
            return (capability.rawValue, status == .granted)
        })
    }

    nonisolated static func resolvedCaps(
        computerControlProvider: ComputerControlProvider = .peekaboo,
        connectionMode: AppState.ConnectionMode,
        codexThreadCatalogEnabled: Bool = false,
        claudeSessionCatalogEnabled: Bool = false) -> [String]
    {
        var caps: [String] = [
            OpenClawCapability.canvas.rawValue,
            OpenClawCapability.screen.rawValue,
        ]
        caps.append(OpenClawCapability.camera.rawValue)
        // Discoverability lets first use explain missing consent. Runtime gates
        // and the Gateway command allowlist still authorize every operation.
        if computerControlProvider == .peekaboo {
            caps.append(OpenClawCapability.computer.rawValue)
        }
        caps.append(OpenClawCapability.location.rawValue)
        // A local Gateway already catalogs this user's Codex home. Advertise the
        // node-owned catalog only when this Mac supplies it to a remote Gateway.
        if codexThreadCatalogEnabled, connectionMode == .remote {
            caps.append(MacNodeCodexThreadCatalogContract.capability)
        }
        if claudeSessionCatalogEnabled, connectionMode == .remote {
            caps.append(MacNodeClaudeSessionCatalogContract.capability)
        }
        return caps
    }

    nonisolated static func resolvedCommands(
        caps: [String],
        computerControlProvider: ComputerControlProvider = .peekaboo) -> [String]
    {
        var commands: [String] = [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
        ]

        if computerControlProvider == .peekaboo {
            commands.append(OpenClawScreenCommand.snapshot.rawValue)
        }
        commands.append(OpenClawScreenCommand.record.rawValue)
        commands.append(OpenClawSystemCommand.notify.rawValue)

        let capsSet = Set(caps)
        if capsSet.contains(OpenClawCapability.camera.rawValue) {
            commands.append(OpenClawCameraCommand.list.rawValue)
            commands.append(OpenClawCameraCommand.snap.rawValue)
            commands.append(OpenClawCameraCommand.clip.rawValue)
            commands.append(OpenClawCameraCommand.ptzStatus.rawValue)
            commands.append(OpenClawCameraCommand.ptzControl.rawValue)
        }
        if capsSet.contains(OpenClawCapability.location.rawValue) {
            commands.append(OpenClawLocationCommand.get.rawValue)
        }
        if capsSet.contains(MacNodeCodexThreadCatalogContract.capability) {
            commands.append(contentsOf: MacNodeCodexThreadCatalogContract.commands)
        }
        if capsSet.contains(MacNodeClaudeSessionCatalogContract.capability) {
            commands.append(contentsOf: MacNodeClaudeSessionCatalogContract.commands)
        }
        if capsSet.contains(OpenClawCapability.computer.rawValue) {
            commands.append(OpenClawComputerCommand.act.rawValue)
        }

        return commands
    }

    nonisolated static func workerManifest(
        _ manifest: MacNodeHostManifest?,
        for provider: ComputerControlProvider) -> MacNodeHostManifest?
    {
        guard let manifest else { return nil }
        guard provider == .peekaboo else { return manifest }
        let providerCommands = Set([
            OpenClawScreenCommand.snapshot.rawValue,
            OpenClawComputerCommand.act.rawValue,
        ])
        return MacNodeHostManifest(
            version: manifest.version,
            caps: manifest.caps.filter { $0 != OpenClawCapability.computer.rawValue },
            commands: manifest.commands.filter { !providerCommands.contains($0) },
            computerUse: nil,
            pathEnv: manifest.pathEnv)
    }

    nonisolated static func computerUseDescriptor(
        provider: ComputerControlProvider,
        commands: [String],
        workerManifest: MacNodeHostManifest?) -> OpenClawProtocol.AnyCodable?
    {
        guard commands.contains(OpenClawScreenCommand.snapshot.rawValue),
              commands.contains(OpenClawComputerCommand.act.rawValue)
        else { return nil }
        return switch provider {
        case .peekaboo: ComputerControlProvider.peekabooComputerUseDescriptor
        case .cua: workerManifest?.computerUse
        }
    }

    nonisolated static func mergingUnique(_ primary: [String], _ additional: [String]) -> [String] {
        var seen = Set<String>()
        return (primary + additional).filter { seen.insert($0).inserted }
    }
}

extension MacNodeModeCoordinator {
    private func installDesktopRoute(_ route: GatewayNodeSessionRoute, authorityGeneration: UInt64) async {
        guard self.routeAuthorityAllowsInvoke(authorityGeneration) else { return }
        if self.desktopRoute != route {
            self.desktopRouteGeneration &+= 1
            self.desktopRoute = route
        }
        let desktopGeneration = self.desktopRouteGeneration
        self.desktopRefreshGeneration &+= 1
        let refreshGeneration = self.desktopRefreshGeneration
        let hosting = await self.workerHostingEnabled()
        let currentRoute = await self.session.currentRoute()
        guard currentRoute == route, !Task.isCancelled,
              desktopGeneration == self.desktopRouteGeneration,
              refreshGeneration == self.desktopRefreshGeneration,
              self.desktopRoute == route,
              self.routeAuthorityAllowsInvoke(authorityGeneration)
        else { return }
        self.desktopAvailability.setRoute(
            generation: self.desktopRouteGeneration, connected: true, hostingEnabled: hosting)
        self.publishDesktopAvailability(self.desktopAvailability.state)
    }

    private func retireDesktopRoute(reason: String) {
        self.desktopPublicationTask?.cancel()
        self.desktopPublicationTask = nil
        self.desktopRefreshGeneration &+= 1
        self.desktopAvailability.revoke(generation: self.desktopRouteGeneration, reason: reason)
        self.desktopRouteGeneration &+= 1
        self.desktopRoute = nil
    }

    private func retireDesktopRoute(ifAuthorityGeneration generation: UInt64, reason: String) {
        guard generation == self.routeAuthorityGeneration else { return }
        self.retireDesktopRoute(reason: reason)
    }

    private func publishDesktopAvailability(_ state: MacDesktopAvailabilityCoordinator.State) {
        guard let route = self.desktopRoute else { return }
        let generation = self.desktopRouteGeneration
        let previous = self.desktopPublicationTask
        self.desktopPublicationTask = Task { [weak self] in
            await previous?.value
            guard let self, !Task.isCancelled,
                  self.desktopRoute == route, self.desktopRouteGeneration == generation,
                  self.desktopAvailability.state == state,
                  let data = try? JSONEncoder().encode(DeviceSettingsSnapshot.DesktopAvailability(state: state)),
                  let payload = String(data: data, encoding: .utf8)
            else { return }
            _ = await self.session.sendEvent(
                event: "node.desktop.availability", payloadJSON: payload, ifCurrentRoute: route)
        }
    }

    @objc private nonisolated func desktopHostingChanged() {
        Task { @MainActor [weak self] in
            guard let self, let route = self.desktopRoute else { return }
            await self.installDesktopRoute(route, authorityGeneration: self.routeAuthorityGeneration)
        }
    }
}
