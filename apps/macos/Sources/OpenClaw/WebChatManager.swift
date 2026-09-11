import AppKit
import Foundation
import OpenClawChatUI
import OpenClawKit

struct WebChatRoute: Equatable, Sendable {
    let sessionKey: String
    let agentID: String?
    let nativeOwner: OpenClawNativeOwnerRef?

    init(sessionKey: String, agentID: String?, nativeOwner: OpenClawNativeOwnerRef? = nil) {
        self.sessionKey = sessionKey
        self.agentID = nativeOwner == nil ? Self.normalizedAgentID(agentID) : agentID
        self.nativeOwner = nativeOwner
    }

    func replacingSessionKey(_ sessionKey: String) -> Self {
        Self(sessionKey: sessionKey, agentID: self.agentID, nativeOwner: self.nativeOwner)
    }

    static func normalizedAgentID(_ agentID: String?) -> String? {
        let normalized = agentID?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized?.isEmpty == false ? normalized : nil
    }
}

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
final class WebChatManager {
    static let shared = WebChatManager()

    private struct ProfileWindowInstance {
        let profileID: String?
        let chatStoreID: String
        let connection: GatewayConnection
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

        var actions: OpenClawChatNativeActionGateway {
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
                isCurrent: { await self.connection.isCurrentServerLease(self.lease) })
        }
    }

    private var windowController: WebChatSwiftUIWindowController?
    private var windowRoute: WebChatRoute?
    private var currentChatRoute: WebChatRoute?
    private var cachedPreferredSessionKey: String?
    private var primaryGatewayID: String?
    private let primaryConnection: GatewayConnection
    private let selection: MacGatewaySelectionPreferences
    private var profileChangeObservers: [NSObjectProtocol] = []

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

    private var primaryGeneration: UInt64 = 0
    private var primaryOpenTask: Task<Void, Never>?
    private var windowGeneration: UInt64 = 0
    private var fleetShutdownTask: Task<Void, Never>?
    private var profileWindows: [UUID: ProfileWindowInstance] = [:]
    private var profileWindowOrder: [UUID] = []
    private var unavailableProfileIDs: Set<String> = []
    private var sessionObserverOwners = WebChatSessionObserverVisibilityOwners()
    private var sessionObserverMonitors: [ObjectIdentifier: Task<Void, Never>] = [:]
    /// Keep attempted ownership through completion or failure until hidden ACK
    /// or retirement. An ordinary owner's nil binding must stay unbound.
    private var sessionObserverRequests:
        [ObjectIdentifier: (
            id: UUID,
            task: Task<Void, Never>,
            nativeBinding: MacGatewayChatTransport.NativeBinding?)] = [:]
    private var sessionObserverDeclarations:
        [ObjectIdentifier: (
            lease: GatewayConnection.ServerLease,
            visible: Bool,
            nativeBinding: MacGatewayChatTransport.NativeBinding?)] = [:]

    var onChatWindowVisibilityChanged: ((Bool) -> Void)?

    var activeSessionKey: String? {
        self.currentChatRoute?.sessionKey ?? self.windowRoute?.sessionKey
    }

    func show(sessionKey: String? = nil, agentID: String? = nil, draft: String? = nil) {
        self.primaryOpenTask?.cancel()
        self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
            root: OpenClawConfigFile.loadDict()))
        if let sessionKey = sessionKey ?? self.cachedPreferredSessionKey {
            self.presentChat(sessionKey: sessionKey, agentID: agentID, draft: draft)
            return
        }

        let generation = self.primaryGeneration
        let connection = self.primaryConnection
        self.primaryOpenTask = Task { @MainActor [weak self] in
            guard !Task.isCancelled else { return }
            let sessionKey = await connection.mainSessionKey()
            guard !Task.isCancelled, let self else { return }
            self.preparePrimaryGateway(gatewayID: GatewayDiscoveryPreferences.deviceAuthGatewayID(
                root: OpenClawConfigFile.loadDict()))
            guard generation == self.primaryGeneration else { return }
            self.cachedPreferredSessionKey = sessionKey
            self.presentChat(sessionKey: sessionKey, agentID: agentID, draft: draft)
        }
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

    private func presentChat(sessionKey: String, agentID: String?, draft: String?, gatewayID: String? = nil) {
        let route = WebChatRoute(sessionKey: sessionKey, agentID: agentID)
        if let controller = windowController {
            // The window shell switches sessions in place (sidebar, /new);
            // full route identity tracks those switches and the global owner.
            if Self.shouldReuseController(currentRoute: self.windowRoute, requestedRoute: route) {
                controller.applyDraftIfEmpty(draft)
                controller.show()
                return
            }

            // Detach before closing so the retired controller's callback cannot
            // cancel this already-admitted successor.
            self.windowController = nil
            self.windowRoute = nil
            controller.close()
        }
        let controller = WebChatSwiftUIWindowController(
            sessionKey: route.sessionKey,
            agentID: route.agentID,
            initialDraft: draft,
            connection: self.primaryConnection,
            gatewayID: gatewayID)
        controller.onVisibilityChanged = { [weak self, weak controller] visible in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(visible, owner: controller, connection: self.primaryConnection)
            self.onChatWindowVisibilityChanged?(visible)
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(false, owner: controller, connection: self.primaryConnection)
            guard self.windowController === controller else { return }
            self.cancelPrimaryOpen()
            if self.currentChatRoute == self.windowRoute {
                self.currentChatRoute = nil
            }
            self.windowController = nil
            self.windowRoute = nil
        }
        controller.onSessionKeyChanged = { [weak self, weak controller] key in
            guard let self, let controller, self.windowController === controller else { return }
            // Retaining the agent is safe: this surface has no in-window agent switcher,
            // and the controller pins explicit agents against gateway-default changes.
            let updatedRoute = (self.windowRoute ?? route).replacingSessionKey(key)
            self.windowRoute = updatedRoute
            self.currentChatRoute = updatedRoute
        }
        controller.onBecameKey = { [weak self] in self?.selection.select(.primary) }
        self.windowController = controller
        self.windowRoute = route
        self.currentChatRoute = route
        controller.show()
    }

    #if DEBUG
    func showSwarmFixture() {
        self.windowController?.close()
        let transport = MacSwarmFixtureChatTransport()
        let controller = WebChatSwiftUIWindowController(
            sessionKey: transport.sessionKey,
            transport: transport,
            windowTitle: "OpenClaw Swarm Fixture",
            windowAutosaveName: "OpenClawSwarmFixture")
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller, self.windowController === controller else { return }
            self.windowController = nil
            self.windowRoute = nil
        }
        self.windowController = controller
        self.windowRoute = WebChatRoute(sessionKey: transport.sessionKey, agentID: nil)
        controller.show()
    }
    #endif

    func newGatewayWindow() {
        let generation = self.windowGeneration
        Task { @MainActor [weak self] in
            guard let self else { return }
            do {
                let profiles = try await MacGatewayProfileStore.shared.profiles()
                guard generation == self.windowGeneration else { return }
                guard !profiles.isEmpty else {
                    AppNavigationActions.openConnection(tab: .gateways)
                    return
                }
                let preferredID = self.selection.profileID
                switch Self.promptForGatewayProfile(profiles: profiles, preferredID: preferredID) {
                case let .profile(profile):
                    guard generation == self.windowGeneration else { return }
                    try await self.show(profile: profile)
                case .manage:
                    AppNavigationActions.openConnection(tab: .gateways)
                case nil:
                    break
                }
            } catch is CancellationError {
            } catch {
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    func openGatewayWindow(profile: MacGatewayProfile) {
        let generation = self.windowGeneration
        Task { @MainActor [weak self] in
            guard let self, generation == self.windowGeneration else { return }
            do {
                try await self.show(profile: profile)
            } catch is CancellationError {
            } catch {
                Self.showProfileError(error, message: "Could Not Open Gateway Window")
            }
        }
    }

    func show(profile: MacGatewayProfile) async throws {
        let generation = self.windowGeneration
        // An older close must finish retiring the fleet before this open can acquire its successor.
        await self.fleetShutdownTask?.value
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
        let connection = binding.connection
        let chatStoreID = binding.chatStoreID
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        let sessionKey = await connection.mainSessionKey()
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        _ = self.presentProfile(
            profile,
            connection: connection,
            chatStoreID: chatStoreID,
            route: WebChatRoute(sessionKey: sessionKey, agentID: nil))
    }

    private func presentProfile(
        _ profile: MacGatewayProfile?,
        connection: GatewayConnection,
        chatStoreID: String,
        route: WebChatRoute,
        nativeLease: GatewayConnection.ServerLease? = nil) -> WebChatSwiftUIWindowController
    {
        let windowID = UUID()
        let previous = self.profileWindowOrder.reversed().lazy
            .compactMap { self.profileWindows[$0] }
            .first { $0.connection === connection }
        let ownsApprovals = connection !== self.primaryConnection
        let approvals = ownsApprovals
            ? previous?.approvals ?? ExecApprovalsGatewayPrompter(gateway: connection) { [weak self] in
                self?.approvalContext(connection: connection)
            }
            : ExecApprovalsGatewayPrompter.shared
        let title = "\(profile?.name ?? "Primary Gateway") — OpenClaw"
        let controller = if let owner = route.nativeOwner, let agentID = route.agentID, let nativeLease {
            WebChatSwiftUIWindowController(
                nativeSession: .init(owner: owner, agentID: agentID, sessionKey: route.sessionKey),
                connection: connection,
                lease: nativeLease,
                windowTitle: title)
        } else {
            WebChatSwiftUIWindowController(
                sessionKey: route.sessionKey,
                agentID: route.agentID,
                connection: connection,
                gatewayID: chatStoreID,
                windowTitle: title,
                windowAutosaveName: "OpenClawChatWindow-\(profile?.id ?? "primary")")
        }
        controller.onVisibilityChanged = { [weak self, weak controller] visible in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(visible, owner: controller, connection: connection)
        }
        controller.onClosed = { [weak self, weak controller] in
            guard let self, let controller else { return }
            self.setSessionObserverVisible(false, owner: controller, connection: connection)
            guard self.profileWindows[windowID]?.controller === controller else { return }
            self.profileWindows.removeValue(forKey: windowID)
            self.profileWindowOrder.removeAll { $0 == windowID }
            if ownsApprovals, !self.profileWindows.values.contains(where: { $0.connection === connection }) {
                approvals.stop()
            }
        }
        controller.onBecameKey = { [weak self] in
            guard let self, self.profileWindows[windowID] != nil else { return }
            self.profileWindowOrder.removeAll { $0 == windowID }
            self.profileWindowOrder.append(windowID)
            self.selection.select(profile.map { .profile($0.id) } ?? .primary)
        }
        self.profileWindows[windowID] = ProfileWindowInstance(
            profileID: profile?.id,
            chatStoreID: chatStoreID,
            connection: connection,
            controller: controller,
            approvals: approvals)
        self.profileWindowOrder.append(windowID)
        if ownsApprovals { approvals.start() }
        controller.cascade(from: previous?.controller)
        controller.show()
        self.selection.select(profile.map { .profile($0.id) } ?? .primary)
        return controller
    }

    func approvalContext(connection: GatewayConnection) -> ExecApprovalsGatewayPrompter.PresentationContext? {
        let selected = self.profileWindowOrder.reversed().lazy
            .compactMap { self.profileWindows[$0] }
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
                windowID: self.windowController.map(ObjectIdentifier.init))
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
        try self.requireCurrentWindowRequest(generation, profileID: gatewayID)
        guard let profile = profiles.first(where: { $0.id.utf8.elementsEqual(gatewayID.utf8) }) else {
            throw MacGatewayProfileError.profileNotFound
        }
        // Initial acquisition may connect. Once this returns, all action work
        // retains this lease and cannot acquire a successor after confirmation.
        await self.fleetShutdownTask?.value
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        let binding = try await MacGatewayConnectionFleet.shared.binding(profileID: profile.id)
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        let lease = try await binding.connection.acquireServerLease()
        try self.requireCurrentWindowRequest(generation, profileID: profile.id)
        return NativeGateway(
            gatewayID: profile.id,
            name: profile.name,
            profile: profile,
            chatStoreID: binding.chatStoreID,
            connection: binding.connection,
            lease: lease,
            windowGeneration: generation,
            primaryGeneration: nil)
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
            try self.requireCurrentWindowRequest(gateway.windowGeneration, profileID: profile.id)
        } else {
            guard gateway.primaryGeneration == self.primaryGeneration else { throw CancellationError() }
        }
        // An ordinary window may hold a draft and Gateway-only cache state.
        // Native owners share its socket, never retrofit that view model.
        let controller = self.profileWindowOrder.reversed().lazy
            .compactMap { self.profileWindows[$0] }
            .first {
                $0.connection === gateway.connection &&
                    $0.controller.isVisible &&
                    $0.controller.gatewayTransport?.nativeBinding?.lease == gateway.lease &&
                    $0.controller.matchesNativeSession(request.session)
            }?.controller ?? self.presentProfile(
                gateway.profile,
                connection: gateway.connection,
                chatStoreID: gateway.chatStoreID,
                route: WebChatRoute(
                    sessionKey: request.session.sessionKey,
                    agentID: request.session.agentID,
                    nativeOwner: request.session.owner),
                nativeLease: gateway.lease)
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
        return self.profileWindows.values.contains {
            $0.controller === controller && $0.connection === gateway.connection &&
                $0.profileID == gateway.profile?.id
        }
    }

    private func requireCurrentWindowRequest(_ generation: UInt64, profileID: String) throws {
        try Task.checkCancellation()
        guard generation == self.windowGeneration else { throw CancellationError() }
        guard !self.unavailableProfileIDs.contains(profileID) else {
            throw MacGatewayProfileError.profileNotFound
        }
    }

    /// Open native chat windows bound to a saved profile's shared fleet connection.
    func openWindowCount(profileID: String) -> Int {
        self.profileWindowOrder.count { self.profileWindows[$0]?.profileID == profileID }
    }

    func closeGatewayWindows(profileID: String) {
        // Removal fences in-flight window creation before awaiting connection
        // shutdown, so an old picker selection cannot resurrect this profile.
        self.unavailableProfileIDs.insert(profileID)
        self.windowGeneration &+= 1
        let windowIDs = self.profileWindowOrder.filter { self.profileWindows[$0]?.profileID == profileID }
        let instances = windowIDs.compactMap { self.profileWindows.removeValue(forKey: $0) }
        let windowIDSet = Set(windowIDs)
        self.profileWindowOrder.removeAll { windowIDSet.contains($0) }
        for instance in instances {
            if instance.connection !== self.primaryConnection { instance.approvals.stop() }
            instance.controller.close()
            self.retireSessionObserver(connection: instance.connection)
        }
    }

    func gatewayProfileDidSave(profileID: String) {
        self.unavailableProfileIDs.remove(profileID)
    }

    func recordActiveSessionKey(_ sessionKey: String) {
        let trimmed = sessionKey.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let route = self.currentChatRoute ?? self.windowRoute
        self.currentChatRoute = route?.replacingSessionKey(trimmed)
            ?? WebChatRoute(sessionKey: trimmed, agentID: nil)
    }

    private func cancelPrimaryOpen() {
        self.primaryGeneration &+= 1
        self.primaryOpenTask?.cancel()
        self.primaryOpenTask = nil
    }

    func resetPrimaryConnections() {
        self.cancelPrimaryOpen()
        let controller = self.windowController
        self.windowController = nil
        self.windowRoute = nil
        self.currentChatRoute = nil
        self.cachedPreferredSessionKey = nil
        controller?.close()
        let nativeIDs = self.profileWindowOrder.filter { self.profileWindows[$0]?.profileID == nil }
        for id in nativeIDs {
            self.profileWindows[id]?.controller.close()
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
        let instances = Array(self.profileWindows.values)
        self.profileWindows.removeAll()
        self.profileWindowOrder.removeAll()
        for instance in instances {
            if instance.connection !== self.primaryConnection { instance.approvals.stop() }
            instance.controller.close()
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
        var controllers = self.profileWindowOrder.reversed()
            .compactMap { self.profileWindows[$0] }
            .filter { $0.connection === connection }
            .map(\.controller)
        if connection === self.primaryConnection, let controller = self.windowController {
            controllers.insert(controller, at: 0)
        }
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
        case profile(MacGatewayProfile)
        case manage
    }

    static func promptForGatewayProfile(
        profiles: [MacGatewayProfile],
        preferredID: String?) -> GatewayProfileSelection?
    {
        let popup = NSPopUpButton(frame: NSRect(x: 0, y: 0, width: 360, height: 28), pullsDown: false)
        popup.addItems(withTitles: profiles.map(Self.profilePickerTitle))
        popup.selectItem(at: Self.preferredProfileIndex(profiles: profiles, preferredID: preferredID))

        let alert = NSAlert()
        alert.messageText = "New Gateway Window"
        alert.informativeText = "Choose a saved Gateway. You can open more than one window for the same Gateway."
        alert.accessoryView = popup
        alert.addButton(withTitle: "Open Window")
        alert.addButton(withTitle: "Manage Gateways…")
        alert.addButton(withTitle: "Cancel")
        switch alert.runModal() {
        case .alertFirstButtonReturn:
            guard profiles.indices.contains(popup.indexOfSelectedItem) else { return nil }
            return .profile(profiles[popup.indexOfSelectedItem])
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
    func _testSessionObserverVisible(connection: GatewayConnection) -> Bool {
        self.sessionObserverOwners.isVisible(connection: ObjectIdentifier(connection))
    }

    func _testProfileWindowCount(profileID: String) -> Int {
        self.profileWindows.values.count { $0.profileID == profileID }
    }
    #endif
}
