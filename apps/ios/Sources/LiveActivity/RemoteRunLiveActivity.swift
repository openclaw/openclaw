@preconcurrency import ActivityKit
import Foundation
import OpenClawKit
import os

/// The remote slot belongs to LiveActivityManager. These adapters isolate OS
/// presentation and the existing relay owner, not a second registration service.
@MainActor
final class RemoteRunLiveActivity {
    struct Relay: Sendable {
        let available: @Sendable () async -> Bool
        let perform: @Sendable (
            PushRelayActivityOperation, PushRelayActivityOwner) async throws -> PushRelayActivityOutcome

        init(manager: PushRegistrationManager) {
            self.available = { await manager.activityOperationsAvailable() }
            self.perform = { try await manager.performActivityOperation($0, owner: $1) }
        }

        init(
            available: @escaping @Sendable () async -> Bool,
            perform: @escaping @Sendable (
                PushRelayActivityOperation, PushRelayActivityOwner) async throws -> PushRelayActivityOutcome)
        {
            self.available = available
            self.perform = perform
        }
    }

    struct Handle {
        let id: String
        let attributes: OpenClawRunActivityAttributes
        let state: @MainActor () -> ActivityState
        let token: @MainActor () -> Data?
        let tokens: @MainActor (@escaping @MainActor @Sendable (Data) -> Void) -> Task<Void, Never>
        let states: @MainActor (@escaping @MainActor @Sendable (ActivityState) -> Void) -> Task<Void, Never>
        let end: @MainActor (_ dismissImmediately: Bool) async -> Void

        init(
            id: String,
            attributes: OpenClawRunActivityAttributes,
            state: @escaping @MainActor () -> ActivityState,
            token: @escaping @MainActor () -> Data?,
            tokens: @escaping @MainActor (@escaping @MainActor @Sendable (Data) -> Void) -> Task<Void, Never>,
            states: @escaping @MainActor (@escaping @MainActor @Sendable (ActivityState) -> Void) -> Task<Void, Never>,
            end: @escaping @MainActor (_ dismissImmediately: Bool) async -> Void)
        {
            self.id = id
            self.attributes = attributes
            self.state = state
            self.token = token
            self.tokens = tokens
            self.states = states
            self.end = end
        }

        init(_ activity: Activity<OpenClawRunActivityAttributes>) {
            self.init(
                id: activity.id,
                attributes: activity.attributes,
                state: { activity.activityState },
                token: { activity.pushToken },
                tokens: { receive in
                    Task {
                        for await token in activity.pushTokenUpdates {
                            guard !Task.isCancelled else { return }
                            receive(token)
                        }
                    }
                },
                states: { receive in
                    Task {
                        for await state in activity.activityStateUpdates {
                            guard !Task.isCancelled else { return }
                            receive(state)
                        }
                    }
                },
                end: { dismissImmediately in
                    // Retirement is not a run outcome. Preserve actual content
                    // while explicit owner erasure also removes terminal tiles.
                    await activity.end(
                        ActivityContent(
                            state: activity.content.state,
                            staleDate: activity.content.staleDate,
                            relevanceScore: 10),
                        dismissalPolicy: dismissImmediately || !activity.content.state.status.isTerminal
                            ? .immediate : .default)
                })
        }
    }

    struct System {
        let enabled: @MainActor () -> Bool
        let activities: @MainActor () -> [Handle]
        let request: @MainActor (
            OpenClawRunActivityAttributes, OpenClawRunActivityAttributes.ContentState) throws -> Handle

        static var live: Self {
            Self(
                enabled: { ActivityAuthorizationInfo().areActivitiesEnabled },
                activities: { Activity<OpenClawRunActivityAttributes>.activities.map(Handle.init) },
                request: { attributes, content in
                    // Match the server payload's 240-second observation freshness;
                    // retries and foreground recovery never renew that timestamp.
                    let staleDate = Date(
                        timeIntervalSince1970: floor(content.observedAt.timeIntervalSince1970) + 240)
                    let activity = try Activity.request(
                        attributes: attributes,
                        content: ActivityContent(
                            state: content, staleDate: staleDate, relevanceScore: 10),
                        pushType: .token)
                    return Handle(activity)
                })
        }
    }

    enum Phase: String {
        case idle, preparing, awaitingToken, registering, active, recovering, retiring, unavailable
    }

    private struct Accepted {
        let run: OpenClawNativeRunRef
        let sessionID: String?
        let gateway: RemoteRunActivityGateway
        let relay: Relay
    }

    private final class Slot {
        let activity: Handle
        var gateway: RemoteRunActivityGateway
        var relay: Relay
        let identity: PushRelayGatewayIdentity
        var selection: RemoteRunActivityGateway.Selection?
        var registration: RemoteRunActivityGateway.Registration?
        var relayMetadata: PushRelayActivityMetadata?
        var grant: PushRelayActivityGrant?
        var grantToken: Data?
        var pendingToken: Data?
        var registeredToken: Data?
        var discoverGateway = false
        var discoverRelay = false
        var requiresExistingRegistration = false
        var relayMayExist = false
        var blocked = false
        var retiring = false
        var dismissImmediately = false

        init(
            activity: Handle,
            gateway: RemoteRunActivityGateway,
            relay: Relay,
            identity: PushRelayGatewayIdentity,
            selection: RemoteRunActivityGateway.Selection?)
        {
            self.activity = activity
            self.gateway = gateway
            self.relay = relay
            self.identity = identity
            self.selection = selection
        }

        var owner: OpenClawNativeOwnerRef {
            self.gateway.session.owner
        }

        var relayOwner: PushRelayActivityOwner {
            .init(activityId: self.activity.id, profileId: self.owner.profileID, gatewayIdentity: self.identity)
        }
    }

    private let system: System
    private let logger = Logger(subsystem: "ai.openclawfoundation.app", category: "RemoteRunActivity")
    private(set) var phase: Phase = .idle
    private var foreground = false
    private var allowedOwner: OpenClawNativeOwnerRef?
    private var generation: UInt64 = 0
    private var slot: Slot?
    private var pending: Accepted?
    private var preparingOwner: OpenClawNativeOwnerRef?
    private var recovery: (RemoteRunActivityGateway, Relay)?
    private var lastObservedRun: OpenClawNativeRunRef?
    private var worker: Task<Void, Never>?
    private var tokenObserver: Task<Void, Never>?
    private var stateObserver: Task<Void, Never>?

    init(system: System = .live) {
        self.system = system
    }

    func observeAcceptedRun(
        _ run: OpenClawNativeRunRef,
        sessionID: String?,
        gateway: RemoteRunActivityGateway,
        relay: Relay)
    {
        guard self.foreground, self.allowedOwner == run.session.owner, gateway.session == run.session else {
            self.record("accepted_activity_unavailable")
            return
        }
        guard self.lastObservedRun != run else { return }
        self.lastObservedRun = run
        self.generation &+= 1
        self.pending = Accepted(run: run, sessionID: sessionID, gateway: gateway, relay: relay)
        self.recovery = nil
        if self.phase != .retiring { self.worker?.cancel() }
        self.kick()
    }

    func resume(gateway: RemoteRunActivityGateway, relay: Relay) {
        let preservesPreparation = self.foreground && self.allowedOwner == gateway.session.owner
            && self.preparingOwner == gateway.session.owner
        self.foreground = true
        self.allowedOwner = gateway.session.owner
        self.recovery = (gateway, relay)
        // Repeated foreground notifications do not cancel an accepted request.
        // Its captured binding still checks the actual route after every await.
        if !preservesPreparation {
            self.generation &+= 1
            if self.phase != .retiring { self.worker?.cancel() }
        }
        self.kick()
    }

    func suspend() {
        self.foreground = false
        self.generation &+= 1
        self.pending = nil
        self.recovery = nil
        if self.phase != .retiring { self.worker?.cancel() }
        self.tokenObserver?.cancel()
        self.stateObserver?.cancel()
    }

    func retire(owner: OpenClawNativeOwnerRef) async {
        let retiringSlot = self.slot.flatMap { $0.owner == owner ? $0 : nil }
        let coldActivities = self.system.activities().filter { activity in
            owner == .init(gatewayID: activity.attributes.gatewayId, profileID: activity.attributes.profileId)
                && retiringSlot?.activity.id.utf8.elementsEqual(activity.id.utf8) != true
        }
        let wasAllowed = self.allowedOwner == owner
        if wasAllowed {
            self.allowedOwner = nil
            self.generation &+= 1
            if self.phase != .retiring { self.worker?.cancel() }
        }
        if self.pending?.run.session.owner == owner { self.pending = nil }
        if self.recovery?.0.session.owner == owner { self.recovery = nil }
        if let retiringSlot { self.requestRetirement(retiringSlot, dismissImmediately: true) }
        if wasAllowed || retiringSlot != nil { await self.finishPendingOperations() }
        await self.endColdActivities(coldActivities)
    }

    func forget(gatewayID: String) async {
        let retiringSlot = self.slot.flatMap { $0.owner.gatewayID.utf8.elementsEqual(gatewayID.utf8) ? $0 : nil }
        let coldActivities = self.system.activities().filter { activity in
            activity.attributes.gatewayId.utf8.elementsEqual(gatewayID.utf8)
                && retiringSlot?.activity.id.utf8.elementsEqual(activity.id.utf8) != true
        }
        let wasAllowed = self.allowedOwner?.gatewayID.utf8.elementsEqual(gatewayID.utf8) == true
        if wasAllowed {
            self.allowedOwner = nil
            self.generation &+= 1
            if self.phase != .retiring { self.worker?.cancel() }
        }
        if self.pending?.run.session.owner.gatewayID.utf8.elementsEqual(gatewayID.utf8) == true {
            self.pending = nil
        }
        if self.recovery?.0.session.owner.gatewayID.utf8.elementsEqual(gatewayID.utf8) == true {
            self.recovery = nil
        }
        if let retiringSlot { self.requestRetirement(retiringSlot, dismissImmediately: true) }
        if wasAllowed || retiringSlot != nil { await self.finishPendingOperations() }
        await self.endColdActivities(coldActivities)
    }

    private func endColdActivities(_ activities: [Handle]) async {
        // This pre-await snapshot cannot acquire a newer slot. Cold selectors
        // lack the authenticated Gateway key needed to prove remote revocation.
        for activity in activities {
            self.record("remote_cleanup_unconfirmed")
            await activity.end(true)
        }
    }

    /// Retirement callers join both an interrupted operation and its subsequent
    /// cleanup worker. No detached revocation outlives the ownership handoff.
    func finishPendingOperations() async {
        while let worker = self.worker {
            await worker.value
        }
    }

    func receiveToken(_ token: Data, activityID: String) {
        guard let slot, slot.activity.id.utf8.elementsEqual(activityID.utf8), !slot.retiring,
              (16...256).contains(token.count)
        else { return }
        guard token != slot.registeredToken || slot.discoverGateway || slot.discoverRelay else { return }
        if slot.pendingToken != token { slot.blocked = false }
        slot.pendingToken = token
        self.kick()
    }

    func receiveState(_ state: ActivityState, activityID: String) {
        guard let slot, slot.activity.id.utf8.elementsEqual(activityID.utf8) else { return }
        if state == .ended || state == .dismissed { self.requestRetirement(slot) }
    }

    private var hasWork: Bool {
        if self.slot?.retiring == true { return true }
        guard self.foreground else { return false }
        if self.pending != nil || self.recovery != nil { return true }
        return self.slot.map {
            $0.owner == self.allowedOwner && !$0.blocked && $0.pendingToken != nil
        } ?? false
    }

    private func kick() {
        guard self.worker == nil, self.hasWork else { return }
        self.worker = Task { [weak self] in
            guard let self else { return }
            await self.drain()
            self.worker = nil
            self.kick()
        }
    }

    private func drain() async {
        while !Task.isCancelled, self.hasWork {
            if let slot, slot.retiring {
                await self.cleanUp(slot)
                continue
            }
            let generation = self.generation
            let handlesExistingSlot = self.pending == nil
            do {
                if let accepted = self.pending {
                    self.pending = nil
                    try await self.start(accepted, generation: generation)
                } else if let (gateway, relay) = self.recovery {
                    self.recovery = nil
                    try await self.recover(gateway: gateway, relay: relay, generation: generation)
                } else if let slot, let token = slot.pendingToken {
                    slot.pendingToken = nil
                    try await self.synchronize(slot, token: token, generation: generation)
                }
            } catch {
                if handlesExistingSlot, let slot, !slot.retiring {
                    slot.blocked = true
                }
                if error is CancellationError {
                    self.record("activity_work_suspended")
                } else {
                    self.phase = .unavailable
                    self.record("activity_operation_unavailable")
                }
            }
        }
    }

    private func requireActive(_ gateway: RemoteRunActivityGateway, generation: UInt64) async throws {
        guard self.foreground, self.allowedOwner == gateway.session.owner, self.generation == generation,
              self.system.enabled()
        else {
            throw CancellationError()
        }
        try await gateway.requireCurrent()
        guard self.foreground, self.allowedOwner == gateway.session.owner, self.generation == generation,
              self.system.enabled()
        else {
            throw CancellationError()
        }
    }

    private func start(_ accepted: Accepted, generation: UInt64) async throws {
        self.preparingOwner = accepted.run.session.owner
        defer { self.preparingOwner = nil }
        self.phase = .preparing
        guard self.system.enabled(), await accepted.relay.available() else {
            throw RemoteRunActivityGateway.Failure.unavailable
        }
        try await self.requireActive(accepted.gateway, generation: generation)
        let prepared = try await accepted.gateway.prepare(run: accepted.run, sessionID: accepted.sessionID)
        try await self.requireActive(accepted.gateway, generation: generation)
        if let old = self.slot {
            old.retiring = true
            await self.cleanUp(old)
            try await self.requireActive(accepted.gateway, generation: generation)
        }
        guard self.system.enabled() else { throw RemoteRunActivityGateway.Failure.unavailable }
        let activity = try self.system.request(prepared.selection.attributes, prepared.content)
        let slot = Slot(
            activity: activity,
            gateway: accepted.gateway,
            relay: accepted.relay,
            identity: prepared.gatewayIdentity,
            selection: prepared.selection)
        self.slot = slot
        self.phase = .awaitingToken
        await self.observe(slot)
    }

    private func recover(
        gateway: RemoteRunActivityGateway, relay: Relay, generation: UInt64) async throws
    {
        // Changing the selected Gateway is not a request to end its accepted run.
        if let slot, slot.owner != gateway.session.owner { return }
        guard await relay.available() else { throw RemoteRunActivityGateway.Failure.unavailable }
        try await self.requireActive(gateway, generation: generation)
        self.phase = .recovering
        let slot: Slot
        if let existing = self.slot {
            slot = existing
            slot.gateway = try gateway.selecting(existing.gateway.session)
            slot.relay = relay
        } else {
            guard let activity = self.system.activities().sorted(by: { $0.id < $1.id }).first(where: {
                let attributes = $0.attributes
                return gateway.session.owner == .init(gatewayID: attributes.gatewayId, profileID: attributes.profileId)
                    && ($0.state() == .active || $0.state() == .stale)
            }) else {
                self.phase = .idle
                return
            }
            let selected = try gateway.selecting(.init(
                owner: gateway.session.owner,
                agentID: activity.attributes.agentId,
                sessionKey: activity.attributes.sessionKey))
            let identity = try await selected.identity()
            try await self.requireActive(selected, generation: generation)
            guard identity.deviceId.utf8.elementsEqual(activity.attributes.gatewayDeviceId.utf8) else {
                throw RemoteRunActivityGateway.Failure.ownerChanged
            }
            slot = Slot(activity: activity, gateway: selected, relay: relay, identity: identity, selection: nil)
            slot.requiresExistingRegistration = true
            slot.relayMayExist = true
            self.slot = slot
        }
        slot.discoverGateway = true
        slot.discoverRelay = true
        slot.blocked = false
        try await self.discoverRegistration(slot, generation: generation)
        try await self.requireActive(slot, generation: generation)
        slot.pendingToken = slot.activity.token() ?? slot.pendingToken ?? slot.registeredToken
        self.phase = slot.registration == nil ? .awaitingToken : .active
        await self.observe(slot)
    }

    private func observe(_ slot: Slot) async {
        await self.stopObservers()
        guard self.foreground, self.slot === slot, !slot.retiring else { return }
        let id = slot.activity.id
        self.tokenObserver = slot.activity.tokens { [weak self] token in
            self?.receiveToken(token, activityID: id)
        }
        self.stateObserver = slot.activity.states { [weak self] state in
            self?.receiveState(state, activityID: id)
        }
        if let token = slot.activity.token() { self.receiveToken(token, activityID: id) }
    }

    private func stopObservers() async {
        let tokens = self.tokenObserver
        let states = self.stateObserver
        self.tokenObserver = nil
        self.stateObserver = nil
        tokens?.cancel()
        states?.cancel()
        await tokens?.value
        await states?.value
    }

    private func requireActive(_ slot: Slot, generation: UInt64) async throws {
        try await self.requireActive(slot.gateway, generation: generation)
        guard self.slot === slot, !slot.retiring else { throw CancellationError() }
        // Async state delivery may lag a token or RPC completion. Stale remains
        // live; an actually ended activity cannot receive a new registration.
        let state = slot.activity.state()
        guard state == .active || state == .stale else {
            self.requestRetirement(slot)
            throw CancellationError()
        }
    }

    private func discoverRegistration(_ slot: Slot, generation: UInt64) async throws {
        let discovered = try await slot.gateway.discover(
            activityID: slot.activity.id, attributes: slot.activity.attributes)
        try await self.requireActive(slot, generation: generation)
        if let discovered {
            if let selection = slot.selection, !discovered.selection.matches(selection) {
                throw RemoteRunActivityGateway.Failure.ownerChanged
            }
            slot.registration = discovered
            slot.selection = discovered.selection
            slot.requiresExistingRegistration = true
            if discovered.state == .tombstone || discovered.expiresAt <= .now {
                slot.retiring = true
                throw RemoteRunActivityGateway.Failure.unavailable
            }
        } else if slot.requiresExistingRegistration {
            slot.retiring = true
            throw RemoteRunActivityGateway.Failure.unavailable
        }
        slot.discoverGateway = false
    }

    private func synchronize(_ slot: Slot, token: Data, generation: UInt64) async throws {
        self.phase = .registering
        // One reconciliation pass after a lost Gateway acknowledgement; never an
        // unbounded retry loop or a second ActivityKit/relay create on recovery.
        for attempt in 0..<2 {
            try await self.requireActive(slot, generation: generation)
            if slot.discoverGateway || slot.registration != nil {
                try await self.discoverRegistration(slot, generation: generation)
            }
            if slot.registration == nil {
                let attributes = slot.activity.attributes
                let prepared: RemoteRunActivityGateway.Prepared
                do {
                    prepared = try await slot.gateway.prepare(
                        run: .init(session: slot.gateway.session, runID: attributes.runId),
                        sessionID: attributes.sessionId)
                } catch let failure as RemoteRunActivityGateway.Failure {
                    if failure == .unavailable || failure == .terminal {
                        slot.retiring = true
                        self.record("activity_not_registered")
                    }
                    throw failure
                }
                try await self.requireActive(slot, generation: generation)
                guard let selection = slot.selection, prepared.selection.matches(selection) else {
                    throw RemoteRunActivityGateway.Failure.ownerChanged
                }
            }
            let grant = try await self.obtainGrant(slot, token: token, generation: generation)
            try await self.requireActive(slot, generation: generation)
            if let newer = slot.pendingToken, newer != token { return }
            guard let selection = slot.selection else { throw RemoteRunActivityGateway.Failure.unavailable }
            slot.discoverGateway = true
            do {
                let result: RemoteRunActivityGateway.Registration = if let registration = slot.registration {
                    try await slot.gateway.rotate(registration: registration, grant: grant)
                } else {
                    try await slot.gateway.register(
                        activityID: slot.activity.id, prepared: selection, grant: grant)
                }
                // Keep late ownership receipts for cleanup before testing whether
                // this generation is still allowed to publish anything further.
                slot.registration = result
                slot.requiresExistingRegistration = true
                slot.discoverGateway = false
                try await self.requireActive(slot, generation: generation)
                if result.state == .tombstone || result.expiresAt <= .now {
                    slot.retiring = true
                    throw RemoteRunActivityGateway.Failure.unavailable
                }
                slot.registeredToken = token
                // A duplicate arriving during publication is already settled;
                // retain only a genuinely newer token for the next worker pass.
                if slot.pendingToken == token { slot.pendingToken = nil }
                slot.grant = nil
                slot.grantToken = nil
                self.phase = .active
                return
            } catch {
                slot.discoverRelay = true
                slot.grant = nil
                slot.grantToken = nil
                try await self.requireActive(slot, generation: generation)
                if attempt == 1 { throw error }
            }
        }
    }

    private func obtainGrant(_ slot: Slot, token: Data, generation: UInt64) async throws -> PushRelayActivityGrant {
        if !slot.discoverRelay, slot.grantToken == token, let grant = slot.grant { return grant }
        let hex = token.map { String(format: "%02x", $0) }.joined()
        for attempt in 0..<2 {
            if slot.discoverRelay {
                let outcome = try await slot.relay.perform(.discover, slot.relayOwner)
                if case let .live(metadata) = outcome { slot.relayMetadata = metadata }
                try await self.requireActive(slot, generation: generation)
                switch outcome {
                case .live:
                    slot.discoverRelay = false
                case .unknown where !slot.requiresExistingRegistration && !slot.relayMayExist:
                    slot.discoverRelay = false
                case .gone, .unauthorized:
                    slot.retiring = true
                    throw RemoteRunActivityGateway.Failure.unavailable
                default:
                    throw RemoteRunActivityGateway.Failure.unavailable
                }
            }
            if let metadata = slot.relayMetadata, Double(metadata.expiresAtMs) / 1000 <= Date().timeIntervalSince1970 {
                slot.retiring = true
                throw RemoteRunActivityGateway.Failure.unavailable
            }
            try await self.requireActive(slot, generation: generation)
            let operation: PushRelayActivityOperation = if let metadata = slot.relayMetadata {
                .rotate(revision: metadata.revision, token: hex)
            } else {
                .create(token: hex)
            }
            slot.relayMayExist = true
            slot.discoverRelay = true
            let outcome = try await slot.relay.perform(operation, slot.relayOwner)
            if case let .grant(grant) = outcome {
                slot.relayMetadata = grant.metadata
                slot.grant = grant
                slot.grantToken = token
                slot.discoverRelay = false
            }
            try await self.requireActive(slot, generation: generation)
            switch outcome {
            case let .grant(grant):
                return grant
            case .conflict, .operationOutcomeUnknown:
                if attempt == 1 { throw RemoteRunActivityGateway.Failure.unavailable }
            case .gone, .unauthorized:
                slot.retiring = true
                throw RemoteRunActivityGateway.Failure.unavailable
            default:
                // In particular, never retry first-key attestation or reset a key.
                throw RemoteRunActivityGateway.Failure.unavailable
            }
        }
        throw RemoteRunActivityGateway.Failure.unavailable
    }

    private func requestRetirement(_ slot: Slot, dismissImmediately: Bool = false) {
        if dismissImmediately { slot.dismissImmediately = true }
        guard !slot.retiring else { return }
        slot.retiring = true
        // The old slot does not own a newer accepted run's preparation. The
        // single worker retires it before publishing the replacement activity.
        if self.preparingOwner == nil, self.phase != .retiring {
            self.generation &+= 1
            self.worker?.cancel()
        }
        self.tokenObserver?.cancel()
        self.stateObserver?.cancel()
        self.kick()
    }

    private func cleanUp(_ slot: Slot) async {
        self.phase = .retiring
        await self.stopObservers()
        // Gateway unavailability is not permission to skip installation-owned
        // relay revocation. Each side gets its own bounded attempt.
        do {
            if slot.discoverGateway {
                slot.registration = try await slot.gateway.discover(
                    activityID: slot.activity.id, attributes: slot.activity.attributes)
            }
            if let registration = slot.registration { _ = try await slot.gateway.revoke(registration) }
        } catch {
            self.record("gateway_cleanup_unconfirmed")
        }
        if slot.relayMayExist {
            do {
                let discovered = try await slot.relay.perform(.discover, slot.relayOwner)
                switch discovered {
                case let .live(metadata):
                    let revoked = try await slot.relay.perform(.revoke(revision: metadata.revision), slot.relayOwner)
                    if revoked != .gone { self.record("relay_cleanup_unconfirmed") }
                case .gone, .unknown:
                    break
                default:
                    self.record("relay_cleanup_unconfirmed")
                }
            } catch {
                self.record("relay_cleanup_unconfirmed")
            }
        }
        await slot.activity.end(slot.dismissImmediately)
        slot.grant = nil
        slot.grantToken = nil
        slot.pendingToken = nil
        slot.registeredToken = nil
        if self.slot === slot { self.slot = nil }
        self.phase = .idle
    }

    private func record(_ reason: String) {
        self.logger.info("\(reason, privacy: .public)")
    }
}
