import AppKit
import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OSLog

private let webChatManagerLogger = Logger(subsystem: "ai.openclaw", category: "WebChatManager")

struct WebChatSessionObserverVisibilityOwners {
    private var ownersByConnection: [ObjectIdentifier: Set<ObjectIdentifier>] = [:]

    mutating func setVisible(
        _ visible: Bool,
        owner: ObjectIdentifier,
        connection: ObjectIdentifier) -> Bool?
    {
        let changed: Bool
        if visible {
            changed = self.ownersByConnection[connection, default: []].insert(owner).inserted
        } else {
            changed = self.ownersByConnection[connection]?.remove(owner) != nil
            if self.ownersByConnection[connection]?.isEmpty == true {
                self.ownersByConnection.removeValue(forKey: connection)
            }
        }
        // A new owner may replace a retired binding without changing aggregate
        // visibility. Duplicate notifications alone need no reconciliation.
        return changed ? self.isVisible(connection: connection) : nil
    }

    func isVisible(connection: ObjectIdentifier) -> Bool {
        self.ownersByConnection[connection]?.isEmpty == false
    }
}

@MainActor
@Observable
final class WebChatManager {
    static let shared = WebChatManager()

    private struct GatewayWindowInstance {
        let target: DashboardGatewayTarget
        var route: WebChatRoute
        let connection: GatewayConnection?
        let controller: WebChatSwiftUIWindowController
        let approvals: ExecApprovalsGatewayPrompter
    }

    struct NativeGateway: Sendable {
        let gatewayID: String
        let name: String
        let profile: MacGatewayProfile?
        let chatStoreID: String
        let connection: GatewayConnection
        let lease: GatewayConnection.ServerLease
        fileprivate let windowGeneration: UInt64
        fileprivate let primaryGeneration: UInt64?
        var target: DashboardGatewayTarget = .primary

        var actions: OpenClawChatNativeActionGateway {
            self.actions(observing: nil)
        }

        func actions(observing transport: MacGatewayChatTransport?) -> OpenClawChatNativeActionGateway {
            OpenClawChatNativeActionGateway(
                gatewayID: self.gatewayID,
                gatewayName: self.name,
                supportsProfileBinding: {
                    await self.connection.supportsServerCapability(
                        .profileBinding, ifCurrentServerLease: self.lease) == true
                },
                request: { request, expectedProfileId in
                    try await self.connection.request(
                        request,
                        ifCurrentServerLease: self.lease,
                        expectedProfileId: expectedProfileId)
                },
                isCurrent: { await self.connection.isCurrentServerLease(self.lease) },
                onProfileObservation: { transport?.observeNativeProfile($0) })
        }
    }

    private var currentPrimaryWindowID: UUID?
    private(set) var frontmostGatewayTarget: DashboardGatewayTarget?
    private(set) var hasVisibleWindows = false
    private var primaryGatewayID: String?
    private let primaryConnection: GatewayConnection
    private let selection: MacGatewaySelectionPreferences
    @ObservationIgnored private var profileChangeObservers: [NSObjectProtocol] = []

    init(primaryConnection: GatewayConnection = .shared, selection: MacGatewaySelectionPreferences = .shared) {
        self.primaryConnection = primaryConnection
        self.selection = selection
        self.profileChangeObservers = [
            MacGatewayProfileStore.willChangePrincipalNotification,
            MacGatewayProfileStore.didChangeNotification,
        ].map { name in
            NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) { [weak self] note in
                guard let id = note.userInfo?[MacGatewayProfileStore.changedProfileIDKey] as? String else { return }
                let removed = note.userInfo?[MacGatewayProfileStore.removedProfileKey] as? Bool == true
                MainActor.assumeIsolated {
                    if name == MacGatewayProfileStore.willChangePrincipalNotification {
                        self?.closeGatewayWindows(profileID: id)
                    } else if removed {
                        self?.selection.forget(profileID: id)
                        self?.closeGatewayWindows(profileID: id)
                    } else {
                        self?.gatewayProfileDidSave(profileID: id)
                    }
                }
            }
        }
    }

    isolated deinit {
        for observer in self.profileChangeObservers {
            NotificationCenter.default.removeObserver(observer)
        }
    }

    @ObservationIgnored private var primaryGeneration: UInt64 = 0
    @ObservationIgnored private var primaryOpenTask: Task<Void, Never>?
    @ObservationIgnored private var windowGeneration: UInt64 = 0
    @ObservationIgnored private var fleetShutdownTask: Task<Void, Never>?
    private var gatewayWindows: [UUID: GatewayWindowInstance] = [:]
    private var gatewayWindowOrder: [UUID] = []
    @ObservationIgnored private var unavailableProfileIDs: Set<String> = []
    @ObservationIgnored private var sessionObserverOwners = WebChatSessionObserverVisibilityOwners()
    @ObservationIgnored private var sessionObserverMonitors: [ObjectIdentifier: Task<Void, Never>] = [:]
    @ObservationIgnored private var sessionObserverRequests: [ObjectIdentifier: (
        id: UUID, task: Task<Void, Never>, nativeBinding: MacGatewayChatTransport.NativeBinding?)] = [:]
    @ObservationIgnored private var sessionObserverDeclarations:
        [ObjectIdentifier: (
            lease: GatewayConnection.ServerLease, visible: Bool,
            nativeBinding: MacGatewayChatTransport.NativeBinding?)] = [:]

    var onChatWindowVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        guard let id = self.currentPrimaryWindowID,
              let instance = self.gatewayWindows[id], instance.controller.isWindowOpen
        else { return nil }
        return instance.route.sessionKey
    }

    @discardableResult
    private func showExistingWindow(for target: DashboardGatewayTarget) -> Bool {
        guard let instance = self.gatewayWindowOrder.reversed().lazy.compactMap({ self.gatewayWindows[$0] })
            .first(where: { $0.target == target })
        else { return false }
        instance.controller.show()
        return true
    }

    func show(sessionKey: String? = nil, agentID: String? = nil, draft: String? = nil) {
        self.primaryOpenTask?.cancel()
        self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
            root: OpenClawConfigFile.loadDict()))
        if sessionKey == nil, agentID == nil, draft == nil, self.showExistingWindow(for: .primary) { return }
        if let sessionKey {
            self.presentChat(sessionKey: sessionKey, agentID: agentID, draft: draft)
            return
        }

        let generation = self.primaryGeneration
        let connection = self.primaryConnection
        self.primaryOpenTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled, let self else { return }
            do {
                let resolved = try await Self.resolveMainSession(connection: connection)
                try Task.checkCancellation()
                self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
                    root: OpenClawConfigFile.loadDict()))
                guard generation == self.primaryGeneration else { throw CancellationError() }
                if let lease = resolved.lease, !connection.serverLeaseMatchesCurrentState(lease) {
                    throw CancellationError()
                }
                self.presentChat(sessionKey: resolved.sessionKey, agentID: agentID, draft: draft)
            } catch {
                webChatManagerLogger
                    .debug("Cancelled native chat open after its Gateway lease or window lifetime changed")
            }
        }
    }

    private static func resolveMainSession(connection: GatewayConnection) async throws
    -> (sessionKey: String, lease: GatewayConnection.ServerLease?) {
        let lease: GatewayConnection.ServerLease
        if let current = await connection.captureServerLease() {
            lease = current
        } else {
            do {
                lease = try await connection.acquireServerLease()
            } catch {
                try Task.checkCancellation()
                // Offline windows can start at the literal main alias; never
                // carry a retired socket's resolved key into that fallback.
                return ("main", nil)
            }
        }
        return try await (connection.mainSessionKey(ifCurrentServerLease: lease), lease)
    }

    func show(
        sessionKey: String,
        ifCurrentRouteFrom lease: GatewayConnection.ServerLease,
        onRejected: @escaping @MainActor () -> Void)
    {
        self.primaryOpenTask?.cancel()
        let root = OpenClawConfigFile.loadDict()
        guard self.primaryConnection.serverLeaseMatchesCurrentRoute(lease),
              let owner = lease.route.deviceAuthGatewayID,
              owner == GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root),
              let cacheID = MacChatTranscriptCache.gatewayID(root: root)
        else {
            onRejected()
            return
        }
        self.preparePrimaryGateway(gatewayID: owner)
        let generation = self.primaryGeneration
        let connection = self.primaryConnection
        // Resolve the complete route before presentation: its storage identity
        // intentionally omits credential rotations and TLS pin changes.
        self.primaryOpenTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            let current = await connection.isCurrentRoute(lease.route)
            guard !Task.isCancelled, let self, generation == self.primaryGeneration else { return }
            guard current, connection.serverLeaseMatchesCurrentRoute(lease) else {
                onRejected()
                return
            }
            self.presentChat(sessionKey: sessionKey, agentID: nil, draft: nil, gatewayID: cacheID)
        }
    }

    private func presentChat(
        sessionKey: String,
        agentID: String?,
        draft: String?,
        gatewayID: String? = nil,
        newWindow: Bool = false)
    {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        if !newWindow,
           let instance = self.gatewayWindowOrder.reversed().lazy.compactMap({ self.gatewayWindows[$0] })
               .first(where: { $0.target == .primary && $0.route == route })
        {
            instance.controller.applyDraftIfEmpty(draft)
            instance.controller.show()
            return
        }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            initialDraft: draft,
            connection: self.primaryConnection,
            gatewayID: gatewayID)
        self.install(controller, target: .primary, route: route, connection: self.primaryConnection)
    }

    #if DEBUG
    func showSwarmFixture() {
        let transport = MacSwarmFixtureChatTransport()
        let controller = WebChatSwiftUIWindowController(
            sessionKey: transport.sessionKey,
            transport: transport,
            windowTitle: "OpenClaw Swarm Fixture",
            windowAutosaveName: "OpenClawSwarmFixture")
        self.install(
            controller,
            target: .primary,
            route: WebChatRoute(sessionKey: transport.sessionKey, agentID: nil),
            connection: nil)
    }
    #endif

    @discardableResult
    func openGatewayWindow(for target: DashboardGatewayTarget, newWindow: Bool = false) -> Task<Void, Never> {
        if target == .primary {
            self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
                root: OpenClawConfigFile.loadDict()))
        }
        let generation = self.windowGeneration
        let primaryGeneration = self.primaryGeneration
        return Task { @MainActor [weak self] in
            guard let self, generation == self.windowGeneration,
                  target != .primary || primaryGeneration == self.primaryGeneration
            else { return }
            do {
                let name: String
                switch target {
                case .primary: name = "OpenClaw Chat"
                case .local: name = "This Mac"
                case let .profile(id):
                    guard let profile = try await MacGatewayProfileStore.shared.profiles().first(where: { $0.id == id })
                    else { throw MacGatewayProfileError.profileNotFound }
                    name = profile.name
                }
                guard generation == self.windowGeneration else { return }
                try await self.showGateway(target: target, name: name, newWindow: newWindow)
            } catch is CancellationError {
                webChatManagerLogger.debug("Cancelled native Gateway window open after its owner changed")
            } catch {
                guard generation == self.windowGeneration else { return }
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    private func showGateway(target: DashboardGatewayTarget, name: String, newWindow: Bool) async throws {
        let generation = self.windowGeneration
        let primaryGeneration = self.primaryGeneration
        // An older close must finish retiring the fleet before this open can acquire its successor.
        await self.fleetShutdownTask?.value
        try self.requireCurrentWindowRequest(generation, target: target)
        guard target != .primary || primaryGeneration == self.primaryGeneration else { throw CancellationError() }
        if !newWindow, self.showExistingWindow(for: target) { return }
        let connection: GatewayConnection
        let chatStoreID: String?
        let autosaveID: String
        switch target {
        case .primary:
            connection = self.primaryConnection
            chatStoreID = nil
            autosaveID = "primary"
        case .local:
            let binding = await MacGatewayConnectionFleet.shared.localBinding()
            connection = binding.connection
            chatStoreID = binding.chatStoreID
            autosaveID = "local"
        case let .profile(profileID):
            let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: profileID)
            connection = binding.connection
            chatStoreID = binding.chatStoreID
            autosaveID = profileID
        }
        try self.requireCurrentWindowRequest(generation, target: target)
        let resolved = try await Self.resolveMainSession(connection: connection)
        try self.requireCurrentWindowRequest(generation, target: target)
        if target == .primary {
            self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
                root: OpenClawConfigFile.loadDict()))
            guard primaryGeneration == self.primaryGeneration else { throw CancellationError() }
        }
        if let lease = resolved.lease, !connection.serverLeaseMatchesCurrentState(lease) {
            throw CancellationError()
        }
        // Another admission can finish while connection setup is suspended.
        // Recheck at the presentation boundary to keep ordinary opens single-window.
        if !newWindow, self.showExistingWindow(for: target) { return }
        if target == .primary {
            self.presentChat(sessionKey: resolved.sessionKey, agentID: nil, draft: nil, newWindow: newWindow)
            return
        }
        let route = WebChatRoute(sessionKey: resolved.sessionKey, agentID: nil)
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            connection: connection,
            gatewayID: chatStoreID,
            windowTitle: "\(name) — OpenClaw",
            windowAutosaveName: "OpenClawChatWindow-\(autosaveID)")
        self.install(controller, target: target, route: route, connection: connection)
    }

    private func install(
        _ controller: WebChatSwiftUIWindowController,
        target: DashboardGatewayTarget,
        route: WebChatRoute,
        connection: GatewayConnection?)
    {
        let windowID = UUID()
        let previousController = self.gatewayWindowOrder.reversed().lazy
            .compactMap { self.gatewayWindows[$0] }
            .first { $0.target == target }?.controller
        let ownsApprovals = connection != nil && connection !== self.primaryConnection
        let approvals: ExecApprovalsGatewayPrompter = if let connection, ownsApprovals {
            self.gatewayWindows.values.first { $0.connection === connection }?.approvals
                ?? ExecApprovalsGatewayPrompter(gateway: connection) { [weak self, weak connection] in
                    guard let connection else { return nil }
                    return self?.approvalContext(connection: connection)
                }
        } else {
            .shared
        }
        controller.onBecameKey = { [weak self] in
            guard let self, let instance = self.gatewayWindows[windowID] else { return }
            self.gatewayWindowOrder.removeAll { $0 == windowID }
            self.gatewayWindowOrder.append(windowID)
            self.frontmostGatewayTarget = instance.target
            self.selection.select(instance.target)
            if instance.target == .primary { self.currentPrimaryWindowID = windowID }
        }
        controller.onVisibilityChanged = { [weak self, weak controller] visible in
            guard let self, let controller else { return }
            if let connection { self.setSessionObserverVisible(visible, owner: controller, connection: connection) }
            self.updateWindowVisibility()
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            if let connection { self.setSessionObserverVisible(false, owner: controller, connection: connection) }
            guard self.gatewayWindows[windowID]?.controller === controller else { return }
            if target == .primary { self.cancelPrimaryOpen() }
            self.gatewayWindows.removeValue(forKey: windowID)
            self.gatewayWindowOrder.removeAll { $0 == windowID }
            if ownsApprovals, !self.gatewayWindows.values.contains(where: { $0.connection === connection }) {
                approvals.stop()
            }
            self.frontmostGatewayTarget = self.gatewayWindowOrder.reversed()
                .compactMap { self.gatewayWindows[$0] }.first { $0.controller.isWindowOpen }?.target
            if self.currentPrimaryWindowID == windowID {
                self.currentPrimaryWindowID = self.gatewayWindowOrder.reversed().first {
                    self.gatewayWindows[$0]?.target == .primary && self.gatewayWindows[$0]?.controller
                        .isWindowOpen == true
                }
            }
            self.updateWindowVisibility()
        }
        controller.onSessionTargetChanged = { [weak self] target in
            // Only the current primary window can supply Mac-wide voice/session
            // ownership. Saved Gateways and background windows retain their own routes.
            guard let self, let previous = self.gatewayWindows[windowID]?.route else { return }
            self.gatewayWindows[windowID]?.route = WebChatRoute(
                sessionKey: target.sessionKey, agentID: target.agentID, nativeOwner: previous.nativeOwner)
        }
        self.gatewayWindows[windowID] = GatewayWindowInstance(
            target: target,
            route: route,
            connection: connection,
            controller: controller,
            approvals: approvals)
        self.gatewayWindowOrder.append(windowID)
        if ownsApprovals { approvals.start() }
        controller.cascade(from: previousController)
        controller.show()
    }

    private func updateWindowVisibility() {
        let visible = self.gatewayWindows.values.contains { $0.controller.isWindowOpen }
        guard visible != self.hasVisibleWindows else { return }
        self.hasVisibleWindows = visible
        self.onChatWindowVisibilityChanged?(visible)
    }

    func hideWindows() {
        self.windowGeneration &+= 1
        self.cancelPrimaryOpen()
        let order = self.gatewayWindowOrder
        let target = self.frontmostGatewayTarget
        for instance in self.gatewayWindows.values {
            instance.controller.hide()
        }
        self.gatewayWindowOrder = order
        self.frontmostGatewayTarget = target
        self.currentPrimaryWindowID = nil
        self.updateWindowVisibility()
    }

    func approvalContext(connection: GatewayConnection) -> ExecApprovalsGatewayPrompter.PresentationContext? {
        let selected = self.gatewayWindowOrder.reversed().lazy
            .compactMap { self.gatewayWindows[$0] }
            .first { $0.connection === connection && $0.controller.isVisible }
        if let selected, let binding = selected.controller.gatewayTransport?.nativeBinding,
           selected.controller.isKeyWindow ||
           ExecApprovalsPromptPresenter.ownsKeyWindow(for: ObjectIdentifier(selected.controller))
        {
            guard !selected.controller.nativeRouteLost else { return nil }
            return .init(
                mode: connection === self.primaryConnection ? AppStateStore.shared.connectionMode : .remote,
                sessionKey: selected.controller.viewModel.sessionKey,
                agentID: selected.controller.currentAgentID,
                windowID: ObjectIdentifier(selected.controller),
                nativeBinding: binding)
        }
        if connection === self.primaryConnection {
            // The primary last-active key also serves Talk and QuickChat.
            // Do not attribute another surface's agent from the full chat window.
            return .init(
                mode: AppStateStore.shared.connectionMode,
                sessionKey: self.activeSessionKey,
                agentID: OpenClawChatSessionKey.agentID(from: self.activeSessionKey),
                windowID: self.currentPrimaryWindowID.flatMap { self.gatewayWindows[$0]?.controller }
                    .map(ObjectIdentifier.init))
        }
        guard let instance = selected, instance.controller.gatewayTransport?.nativeBinding == nil
        else { return nil }
        return .init(
            mode: .remote,
            sessionKey: instance.controller.viewModel.sessionKey,
            agentID: instance.controller.currentAgentID,
            windowID: ObjectIdentifier(instance.controller))
    }

    func captureNativeGateway(gatewayID requestedID: String? = nil) async throws -> NativeGateway {
        try Task.checkCancellation()
        let generation = self.windowGeneration
        let root = OpenClawConfigFile.loadDict()
        let primaryID = GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root)
        // Catalogs use the selected Gateway; saved action selectors never
        // fall back to that selection or the primary connection.
        guard requestedID != nil || self.selection.target != .local else {
            throw OpenClawNativeActionError("Select the primary or a saved Gateway for this native action.")
        }
        let gatewayID = requestedID ?? self.selection.profileID ?? primaryID
        guard let gatewayID, !gatewayID.isEmpty else {
            throw OpenClawNativeActionError("Connect a Gateway in OpenClaw, then select the session again.")
        }
        if primaryID?.utf8.elementsEqual(gatewayID.utf8) == true {
            self.preparePrimaryGateway(gatewayID: gatewayID)
            let primaryGeneration = self.primaryGeneration
            guard let chatStoreID = MacChatTranscriptCache.gatewayID(root: root) else {
                throw OpenClawNativeActionError("Select the primary Gateway account in OpenClaw, then try again.")
            }
            let lease = try await self.primaryConnection.acquireServerLease()
            try Task.checkCancellation()
            guard lease.route.deviceAuthGatewayID?.utf8.elementsEqual(gatewayID.utf8) == true,
                  generation == self.windowGeneration, primaryGeneration == self.primaryGeneration
            else { throw CancellationError() }
            return NativeGateway(
                gatewayID: gatewayID,
                name: "Primary Gateway",
                profile: nil,
                chatStoreID: chatStoreID,
                connection: self.primaryConnection,
                lease: lease,
                windowGeneration: generation,
                primaryGeneration: primaryGeneration)
        }
        guard AppLaunchRuntimePlan.current.allowsGatewayUIKeychainAccess else {
            throw OpenClawNativeActionError("Open OpenClaw interactively to use a saved Gateway account.")
        }
        let profiles = try await MacGatewayProfileStore.shared.profiles()
        try self.requireCurrentWindowRequest(generation, target: .profile(gatewayID))
        guard let profile = profiles.first(where: { $0.id.utf8.elementsEqual(gatewayID.utf8) }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        // Initial acquisition may connect. Once this returns, all action work
        // retains this lease and cannot acquire a successor after confirmation.
        await self.fleetShutdownTask?.value
        try self.requireCurrentWindowRequest(generation, target: .profile(profile.id))
        let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
        try self.requireCurrentWindowRequest(generation, target: .profile(profile.id))
        let lease = try await binding.connection.acquireServerLease()
        try self.requireCurrentWindowRequest(generation, target: .profile(profile.id))
        return NativeGateway(
            gatewayID: profile.id,
            name: profile.name,
            profile: profile,
            chatStoreID: binding.chatStoreID,
            connection: binding.connection,
            lease: lease,
            windowGeneration: generation,
            primaryGeneration: nil,
            target: .profile(profile.id))
    }

    func presentNative(
        _ request: OpenClawNativeOpenRequest,
        gateway: NativeGateway) throws -> WebChatSwiftUIWindowController
    {
        try Task.checkCancellation()
        guard gateway.windowGeneration == self.windowGeneration,
              gateway.connection.serverLeaseMatchesCurrentState(gateway.lease),
              gateway.gatewayID.utf8.elementsEqual(request.session.owner.gatewayID.utf8)
        else { throw CancellationError() }
        if let profile = gateway.profile {
            try self.requireCurrentWindowRequest(gateway.windowGeneration, target: .profile(profile.id))
        } else {
            guard gateway.primaryGeneration == self.primaryGeneration else { throw CancellationError() }
        }
        // An ordinary window may hold a draft and Gateway-only cache state.
        // Native owners share its socket, never retrofit that view model.
        let existing = self.gatewayWindowOrder.reversed().lazy
            .compactMap { self.gatewayWindows[$0] }
            .first {
                $0.connection === gateway.connection && $0.controller.isVisible &&
                    $0.controller.gatewayTransport?.nativeBinding?.lease == gateway.lease &&
                    $0.controller.matchesNativeSession(request.session)
            }?.controller
        let controller: WebChatSwiftUIWindowController
        if let existing {
            controller = existing
        } else {
            controller = WebChatSwiftUIWindowController(
                nativeSession: request.session,
                connection: gateway.connection,
                lease: gateway.lease,
                windowTitle: "\(gateway.name) — OpenClaw")
            self.install(
                controller, target: gateway.target,
                route: WebChatRoute(
                    sessionKey: request.session.sessionKey, agentID: request.session.agentID,
                    nativeOwner: request.session.owner),
                connection: gateway.connection)
        }
        guard self.nativePresentationIsCurrent(controller, gateway: gateway, session: request.session) else {
            throw CancellationError()
        }
        try controller.presentNative(request)
        return controller
    }

    func nativePresentationIsCurrent(
        _ controller: WebChatSwiftUIWindowController,
        gateway: NativeGateway,
        session: OpenClawNativeSessionRef) -> Bool
    {
        guard gateway.connection.serverLeaseMatchesCurrentState(gateway.lease),
              gateway.gatewayID.utf8.elementsEqual(session.owner.gatewayID.utf8),
              controller.matchesNativeSession(session), controller.isVisible,
              controller.gatewayTransport?.connection === gateway.connection,
              controller.gatewayTransport?.nativeBinding?.lease == gateway.lease
        else { return false }
        guard gateway.windowGeneration == self.windowGeneration,
              gateway.primaryGeneration == nil || gateway.primaryGeneration == self.primaryGeneration
        else { return false }
        return self.gatewayWindows.values.contains {
            $0.controller === controller && $0.connection === gateway.connection &&
                $0.target == gateway.target
        }
    }

    private func requireCurrentWindowRequest(_ generation: UInt64, target: DashboardGatewayTarget) throws {
        try Task.checkCancellation()
        guard generation == self.windowGeneration else { throw CancellationError() }
        switch target {
        case .primary: break
        case .local:
            let state = AppStateStore.shared
            guard state.connectionMode == .remote, state.hostsLocalGatewayWithRemotePrimary,
                  state.gatewayConfigIsCurrentForRouting else { throw CancellationError() }
        case let .profile(profileID):
            guard !self.unavailableProfileIDs.contains(profileID) else { throw MacGatewayProfileError.profileNotFound }
        }
    }

    func openWindowCount(for target: DashboardGatewayTarget) -> Int {
        self.gatewayWindowOrder.count { self.gatewayWindows[$0]?.target == target }
    }

    func closeGatewayWindows(profileID: String) {
        self.unavailableProfileIDs.insert(profileID)
        self.closeGatewayWindows(target: .profile(profileID))
    }

    func closeLocalGatewayWindows() {
        self.closeGatewayWindows(target: .local)
    }

    private func closeGatewayWindows(target: DashboardGatewayTarget) {
        // Fence in-flight opens before retiring windows or their connection.
        self.windowGeneration &+= 1
        let instances = self.gatewayWindows.values.filter { $0.target == target }
        for instance in instances {
            instance.controller.close()
            if let connection = instance.connection { self.retireSessionObserver(connection: connection) }
        }
    }

    func gatewayProfileDidSave(profileID: String) {
        self.unavailableProfileIDs.remove(profileID)
    }

    func recordActiveSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let id = self.currentPrimaryWindowID,
              let instance = self.gatewayWindows[id], instance.controller.isWindowOpen
        else { return }
        self.gatewayWindows[id]?.route = instance.route.replacingSessionKey(trimmed)
    }

    private func cancelPrimaryOpen() {
        self.primaryGeneration &+= 1
        self.primaryOpenTask?.cancel()
        self.primaryOpenTask = nil
    }

    func resetPrimaryConnections() {
        self.cancelPrimaryOpen()
        self.currentPrimaryWindowID = nil
        for instance in self.gatewayWindows.values.filter({ $0.target == .primary }) {
            instance.controller.close()
        }
    }

    func preparePrimaryGateway(gatewayID: String?) {
        guard self.primaryGatewayID != gatewayID else { return }
        self.resetPrimaryConnections()
        self.primaryGatewayID = gatewayID
    }

    func close() {
        // Invalidate admitted opens before closing windows or awaiting fleet retirement.
        self.windowGeneration &+= 1
        self.resetPrimaryConnections()
        let controllers = self.gatewayWindows.values.map(\.controller)
        for controller in controllers {
            controller.close()
        }
        let previousShutdown = self.fleetShutdownTask
        self.fleetShutdownTask = Task {
            await previousShutdown?.value
            for connection in await MacGatewayConnectionFleet.shared.shutdown() {
                self.retireSessionObserver(connection: connection)
            }
        }
    }

    private func retireSessionObserver(connection: GatewayConnection) {
        let connectionID = ObjectIdentifier(connection)
        // A retired profile has no future socket on which to declare hidden.
        // Its subscription must end even when the final hide cannot acquire a lease.
        self.sessionObserverMonitors.removeValue(forKey: connectionID)?.cancel()
        self.sessionObserverRequests.removeValue(forKey: connectionID)?.task.cancel()
        self.sessionObserverDeclarations.removeValue(forKey: connectionID)
    }

    private func setSessionObserverVisible(
        _ visible: Bool,
        owner: WebChatSwiftUIWindowController,
        connection: GatewayConnection)
    {
        let connectionID = ObjectIdentifier(connection)
        guard let aggregateVisibility = self.sessionObserverOwners.setVisible(
            visible,
            owner: ObjectIdentifier(owner),
            connection: connectionID)
        else { return }

        if aggregateVisibility, self.sessionObserverMonitors[connectionID] == nil {
            // Visibility and subscriptions belong to a physical socket; a reconnect
            // must redeclare both while any window on that connection remains open.
            self.sessionObserverMonitors[connectionID] = Task { @MainActor [weak self] in
                let pushes = await connection.subscribe(bufferingNewest: 1)
                for await delivery in pushes {
                    guard !Task.isCancelled else { return }
                    guard delivery.isCurrent, case .snapshot = delivery.push else { continue }
                    guard let self else { return }
                    self.scheduleSessionObserverVisibility(
                        self.sessionObserverOwners.isVisible(connection: connectionID),
                        connection: connection)
                }
            }
        }
        self.scheduleSessionObserverVisibility(aggregateVisibility, connection: connection)
    }

    private func scheduleSessionObserverVisibility(
        _ visible: Bool,
        connection: GatewayConnection)
    {
        let connectionID = ObjectIdentifier(connection)
        let previous = self.sessionObserverRequests[connectionID]
        let controller = self.sessionObserverController(connection: connection)
        let transport = controller?.gatewayTransport
        guard visible ? controller != nil : previous != nil else { return }
        let nativeBinding = if let controller {
            controller.gatewayTransport?.nativeBinding
        } else {
            previous?.nativeBinding
        }
        let requestID = UUID()
        let task = Task { @MainActor [weak self, weak controller] in
            await previous?.task.value
            guard !Task.isCancelled, let self,
                  self.sessionObserverRequests[connectionID]?.id == requestID
            else { return }
            let ownerIsCurrent = {
                !Task.isCancelled &&
                    self.sessionObserverRequests[connectionID]?.id == requestID &&
                    self.sessionObserverOwners.isVisible(connection: connectionID) == visible &&
                    (!visible || (controller?.isVisible == true && controller?.nativeRouteLost == false))
            }
            guard ownerIsCurrent() else { return }
            let capturedLease: GatewayConnection.ServerLease? = if let nativeBinding {
                await connection.isCurrentServerLease(nativeBinding.lease) ? nativeBinding.lease : nil
            } else {
                await connection.captureServerLease()
            }
            guard let lease = capturedLease, ownerIsCurrent() else { return }

            if let declaration = self.sessionObserverDeclarations[connectionID],
               declaration.visible == visible,
               declaration.nativeBinding == nativeBinding,
               await connection.isCurrentServerLease(declaration.lease)
            { return }

            // A timed-out mutation may already have changed the Gateway. Clear
            // the old confirmation before dispatch so reopening retries truthfully.
            guard ownerIsCurrent() else { return }
            self.sessionObserverDeclarations.removeValue(forKey: connectionID)
            let visibilityRequest = OpenClawChatGatewayRequests.setSessionObserverVisibility(visible)
            let requests = visible
                ? [OpenClawChatGatewayRequests.subscribeSessions(), visibilityRequest] : [visibilityRequest]
            // A hidden retry belongs to this attempt's lease and account even
            // after the confirmed declaration is cleared and every window closes.
            for attempt in 0..<(visible ? 1 : 2) {
                do {
                    for request in requests {
                        guard ownerIsCurrent(), await connection.isCurrentServerLease(lease), ownerIsCurrent()
                        else { return }
                        if visible {
                            guard let transport else { return }
                            _ = try await transport.requestChatGateway(request, ifCurrentServerLease: lease)
                        } else {
                            _ = try await connection.request(
                                request,
                                ifCurrentServerLease: lease,
                                expectedProfileId: nativeBinding?.owner.profileID)
                        }
                    }
                    guard ownerIsCurrent(), await connection.isCurrentServerLease(lease), ownerIsCurrent()
                    else { return }
                    if visible {
                        self.sessionObserverDeclarations[connectionID] = (
                            lease: lease, visible: true, nativeBinding: nativeBinding)
                    } else {
                        self.sessionObserverDeclarations.removeValue(forKey: connectionID)
                        self.sessionObserverMonitors.removeValue(forKey: connectionID)?.cancel()
                        self.sessionObserverRequests.removeValue(forKey: connectionID)
                    }
                    return
                } catch {
                    guard !visible, attempt == 0 else { return }
                }
            }
        }
        self.sessionObserverRequests[connectionID] = (id: requestID, task: task, nativeBinding: nativeBinding)
    }

    private func sessionObserverController(connection: GatewayConnection) -> WebChatSwiftUIWindowController? {
        let controllers = self.gatewayWindowOrder.reversed()
            .compactMap { self.gatewayWindows[$0] }
            .filter { $0.connection === connection }
            .map(\.controller)
        let eligible = controllers.filter { $0.isVisible && !$0.nativeRouteLost }
        // Ordinary siblings keep their unbound observer semantics. Otherwise use
        // activation order, never a retired window or dictionary iteration order.
        return eligible.first { $0.gatewayTransport?.nativeBinding == nil } ?? eligible.first
    }

    static func shouldReuseController(
        currentRoute: WebChatRoute?,
        requestedRoute: WebChatRoute) -> Bool
    {
        currentRoute == requestedRoute
    }

    enum GatewayProfileSelection {
        case local
        case profile(MacGatewayProfile)
        case manage
    }

    static func promptForGatewayProfile(
        profiles: [MacGatewayProfile],
        preferredID: String?,
        local: DashboardGatewayEntry? = nil) -> GatewayProfileSelection?
    {
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 28), pullsDown: false)
        if let local { popup.addItem(withTitle: local.name) }
        popup.addItems(withTitles: profiles.map(Self.profilePickerTitle))
        let offset = local == nil ? 0 : 1
        popup.selectItem(at: profiles.isEmpty || (preferredID == "local" && local != nil) ? 0
            : Self.preferredProfileIndex(profiles: profiles, preferredID: preferredID) + offset)

        let alert = NSAlert()
        alert.messageText = "New Gateway Window"
        alert.informativeText = "Choose a Gateway. You can open more than one window for the same Gateway."
        alert.accessoryView = popup
        alert.addButton(withTitle: "Open Window")
        alert.addButton(withTitle: "Manage Gateways…")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            if local != nil, popup.indexOfSelectedItem == 0 { return .local }
            let index = popup.indexOfSelectedItem - offset
            guard profiles.indices.contains(index) else { return nil }
            return .profile(profiles[index])
        case .alertSecondButtonReturn:
            return .manage
        default:
            return nil
        }
    }

    nonisolated static func preferredProfileIndex(profiles: [MacGatewayProfile], preferredID: String?) -> Int {
        profiles.firstIndex { $0.id == preferredID } ?? 0
    }

    private static func profilePickerTitle(_ profile: MacGatewayProfile) -> String {
        "\(profile.name) — \(profile.url.absoluteString)"
    }

    private static func showProfileError(_ error: Error, message: String) {
        let alert = NSAlert(error: error)
        alert.messageText = message
        alert.runModal()
    }

    #if DEBUG
    func _testProfileWindowCount(profileID: String) -> Int {
        self.openWindowCount(for: .profile(profileID))
    }

    func _testSessionObserverVisible(connection: GatewayConnection) -> Bool {
        self.sessionObserverOwners.isVisible(connection: ObjectIdentifier(connection))
    }

    #endif
}
