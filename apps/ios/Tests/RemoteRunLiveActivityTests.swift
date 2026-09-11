import ActivityKit
import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import Testing
@testable import OpenClaw

@MainActor
private final class RunActivityBarrier {
    private var release: CheckedContinuation<Void, Never>?
    private var arrival: CheckedContinuation<Void, Never>?
    private(set) var isFinished = false

    func pause() async {
        await withCheckedContinuation { continuation in
            self.release = continuation
            self.arrival?.resume()
            self.arrival = nil
        }
    }

    func waitUntilPaused() async {
        guard self.release == nil, !self.isFinished else { return }
        await withCheckedContinuation { self.arrival = $0 }
    }

    func finish() {
        self.isFinished = true
        self.arrival?.resume()
        self.arrival = nil
    }

    func resume() {
        self.release?.resume()
        self.release = nil
    }
}

@MainActor
private final class RunActivityLifecycleFixture {
    let run: OpenClawNativeRunRef
    let activityID: String
    var created = 0
    var ended = 0
    var immediateDismissals: [Bool] = []
    var current = true
    var activitiesEnabled = true
    var additionalActivities: [RemoteRunLiveActivity.Handle] = []
    var activityState: ActivityState = .active
    var currentToken: Data?
    var relayAvailable = true
    var nextRelayOutcome: PushRelayActivityOutcome?
    var registrationState = "active"
    var registrationExpiresAtMs: Double = 2_000_000_000_000
    var sourceIncarnation = "source"
    var relayRevision: Int64 = 0
    var gatewayRevision = 0
    var registered = false
    var loseRelayACK = false
    var loseGatewayACK = false
    var revokeGatewayFails = false
    var relayOperations: [String] = []
    var relayOwners: [PushRelayActivityOwner] = []
    var gatewayRequests: [OpenClawChatGatewayRequest] = []
    var gatewayOperations: [String] {
        self.gatewayRequests.map(\.method)
    }

    var onRelayCreate: (() -> Void)?
    var onPrepare: (() -> Void)?
    var prepareBarrier: RunActivityBarrier?
    var relayBarrier: RunActivityBarrier?
    var revokeBarrier: RunActivityBarrier?
    var endBarrier: RunActivityBarrier?
    let tokens = AsyncStream<Data>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let states = AsyncStream<ActivityState>.makeStream(bufferingPolicy: .bufferingNewest(1))
    var handle: RemoteRunLiveActivity.Handle?

    lazy var controller = RemoteRunLiveActivity(system: self.system)

    init(
        owner: OpenClawNativeOwnerRef = .init(gatewayID: "local", profileID: "profile"),
        activityID: String = "activity")
    {
        self.run = .init(
            session: .init(owner: owner, agentID: "agent", sessionKey: "agent:agent:main"),
            runID: "run")
        self.activityID = activityID
    }

    var system: RemoteRunLiveActivity.System {
        .init(
            enabled: { self.activitiesEnabled },
            activities: {
                (self.handle.map { [$0] } ?? []) + self.additionalActivities
            },
            request: { attributes, _ in
                self.created += 1
                self.activityState = .active
                let id = self.created == 1 ? self.activityID : "\(self.activityID)-\(self.created)"
                let handle = RemoteRunLiveActivity.Handle(
                    id: id,
                    attributes: attributes,
                    state: { self.activityState },
                    token: { self.currentToken },
                    tokens: { receive in
                        Task {
                            for await token in self.tokens.stream {
                                receive(token)
                            }
                        }
                    },
                    states: { receive in
                        Task {
                            for await state in self.states.stream {
                                receive(state)
                            }
                        }
                    },
                    end: { dismissImmediately in
                        if let barrier = self.endBarrier {
                            self.endBarrier = nil
                            await barrier.pause()
                        }
                        self.ended += 1
                        self.immediateDismissals.append(dismissImmediately)
                        if self.handle?.id == id {
                            self.activityState = .ended
                            self.handle = nil
                        }
                    })
                self.handle = handle
                return handle
            })
    }

    var gateway: RemoteRunActivityGateway {
        RemoteRunActivityGateway(
            session: self.run.session,
            request: { try await self.request($0) },
            isCurrent: { await self.current })
    }

    var relay: RemoteRunLiveActivity.Relay {
        .init(
            available: { await self.relayAvailable },
            perform: { try await self.relayOperation($0, owner: $1) })
    }

    var binding: [String: AnyCodable] {
        [
            "gatewayId": AnyCodable("gateway"), "deviceId": AnyCodable("phone"),
            "nodeId": AnyCodable("node"), "pairingGeneration": AnyCodable(String(repeating: "a", count: 64)),
            "profileId": AnyCodable(self.run.session.owner.profileID), "agentId": AnyCodable("agent"),
            "sessionKey": AnyCodable("agent:agent:main"), "sessionId": AnyCodable("generation"),
            "lifecycleRevision": AnyCodable(NSNull()), "publicRunId": AnyCodable("run"),
        ]
    }

    func request(_ request: OpenClawChatGatewayRequest) async throws -> Data {
        self.gatewayRequests.append(request)
        switch request.method {
        case "gateway.identity.get":
            return Data(#"{"deviceId":"gateway","publicKey":"public-key"}"#.utf8)
        case "push.liveActivity.prepare":
            if let barrier = self.prepareBarrier {
                self.prepareBarrier = nil
                await barrier.pause()
            }
            self.onPrepare?()
            var binding = self.binding
            binding["publicRunId"] = request.params["publicRunId"]
            return try JSONEncoder().encode(PushLiveActivityPrepareResult(
                binding: binding,
                sourceincarnation: self.sourceIncarnation,
                snapshot: AnyCodable([
                    "sourceIncarnation": self.sourceIncarnation, "sequence": 1, "status": "running",
                    "observedAtMs": 1_900_000_000_000,
                ] as [String: Any])))
        case "push.liveActivity.discover":
            if !self.registered { return Data(#"{"status":"unknown"}"#.utf8) }
            return try JSONEncoder().encode(
                PushLiveActivityDiscoverResult.found(.init(registration: self.registration())))
        case "push.liveActivity.register", "push.liveActivity.rotate":
            self.registered = true
            if request.method.hasSuffix("rotate") { self.gatewayRevision += 1 }
            if self.loseGatewayACK {
                self.loseGatewayACK = false
                throw URLError(.networkConnectionLost)
            }
            return try JSONEncoder().encode(self.registration())
        case "push.liveActivity.revoke":
            if let barrier = self.revokeBarrier {
                self.revokeBarrier = nil
                await barrier.pause()
            }
            if self.revokeGatewayFails { throw URLError(.notConnectedToInternet) }
            self.registered = false
            return Data(#"{"removed":true}"#.utf8)
        default:
            throw URLError(.unsupportedURL)
        }
    }

    func registration() -> PushLiveActivityRegistrationResult {
        .init(
            registrationid: "registration",
            activityid: "activity",
            binding: self.binding,
            sourceincarnation: self.sourceIncarnation,
            state: AnyCodable(self.registrationState),
            rotationrevision: self.gatewayRevision,
            leaseexpiresatms: self.registrationExpiresAtMs)
    }

    func relayOperation(
        _ operation: PushRelayActivityOperation, owner: PushRelayActivityOwner) async throws -> PushRelayActivityOutcome
    {
        self.relayOperations.append(operation.name)
        self.relayOwners.append(owner)
        if let outcome = self.nextRelayOutcome {
            self.nextRelayOutcome = nil
            return outcome
        }
        switch operation {
        case .discover:
            return try self.relayRevision == 0 ? .unknown : .live(self.metadata())
        case .revoke:
            self.relayRevision = 0
            return .gone
        case .create, .rotate:
            self.relayRevision += 1
            if case .create = operation {
                if let barrier = self.relayBarrier {
                    self.relayBarrier = nil
                    await barrier.pause()
                }
                self.onRelayCreate?()
            }
            if self.loseRelayACK {
                self.loseRelayACK = false
                return .operationOutcomeUnknown
            }
            return try .grant(PushRelayActivityGrant(
                metadata: self.metadata(),
                relayHandle: "handle",
                sendGrant: "grant",
                installationId: "installation",
                topic: "ai.openclaw.tests",
                environment: "sandbox",
                relayOrigin: "https://relay.example.invalid"))
        }
    }

    func metadata() throws -> PushRelayActivityMetadata {
        try .init(
            status: .active,
            revision: PushRelayActivityRevision(self.relayRevision),
            expiresAtMs: 2_000_000_000_000)
    }

    func start() async {
        self.controller.resume(gateway: self.gateway, relay: self.relay)
        await self.controller.finishPendingOperations()
        self.controller.observeAcceptedRun(self.run, sessionID: "generation", gateway: self.gateway, relay: self.relay)
        await self.controller.finishPendingOperations()
    }

    func close() async {
        await self.controller.retire(owner: self.run.session.owner)
        self.tokens.continuation.finish()
        self.states.continuation.finish()
    }

    func suspendAndJoin() async {
        self.controller.suspend()
        await self.controller.finishPendingOperations()
        self.tokens.continuation.finish()
        self.states.continuation.finish()
    }
}

@Suite(.timeLimit(.minutes(1)))
@MainActor
struct RemoteRunLiveActivityTests {
    @Test func `initial nil token waits and duplicate tokens do not renew registrations`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        #expect(fixture.created == 1)
        #expect(fixture.relayOperations.isEmpty)
        fixture.controller.receiveToken(Data(repeating: 0xAB, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.registered)
        #expect(fixture.relayOwners.first?.activityId == "activity")
        #expect(fixture.relayOwners.first?.profileId == fixture.run.session.owner.profileID)
        #expect(fixture.relayOwners.first?.gatewayIdentity.deviceId == "gateway")
        #expect(fixture.relayOwners.first?.gatewayIdentity.publicKey == "public-key")
        let operations = fixture.relayOperations
        fixture.controller.receiveToken(Data(repeating: 0xAB, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.relayOperations == operations)
        await fixture.close()
    }

    @Test(arguments: [true, false])
    func `lost acknowledgements recover through discovery without another activity`(relayACK: Bool) async {
        let fixture = RunActivityLifecycleFixture()
        fixture.loseRelayACK = relayACK
        fixture.loseGatewayACK = !relayACK
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 1, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.created == 1)
        #expect(fixture.registered)
        #expect(fixture.relayOperations.contains("discover"))
        #expect(fixture.relayOperations.filter { $0 == "create" }.count == 1)
        if !relayACK { #expect(fixture.gatewayOperations.contains("push.liveActivity.discover")) }
        await fixture.close()
    }

    @Test func `suspension during a relay grant fences publication and still permits old owner cleanup`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.onRelayCreate = { fixture.controller.suspend() }
        fixture.controller.receiveToken(Data(repeating: 2, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(!fixture.registered)
        #expect(fixture.ended == 0)
        fixture.current = false
        await fixture.close()
        #expect(fixture.relayOperations.last == "revoke")
        #expect(fixture.ended == 1)
    }

    @Test func `gateway cleanup failure cannot skip relay retirement`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 3, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        fixture.revokeGatewayFails = true
        await fixture.close()
        #expect(fixture.gatewayOperations.last == "push.liveActivity.revoke")
        #expect(fixture.relayOperations.last == "revoke")
        #expect(fixture.ended == 1)
    }

    @Test func `different owner retirement leaves the exact live slot alone`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        await fixture.controller.retire(owner: .init(gatewayID: "local", profileID: "other-profile"))
        #expect(fixture.ended == 0)
        await fixture.close()
    }

    @Test func `suspension during preparation cannot create an activity`() async {
        let fixture = RunActivityLifecycleFixture()
        fixture.onPrepare = { fixture.controller.suspend() }
        await fixture.start()
        #expect(fixture.created == 0)
        #expect(fixture.relayOperations.isEmpty)
        await fixture.close()
    }

    @Test func `newest token supersedes an in flight grant before gateway publication`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.onRelayCreate = {
            fixture.controller.receiveToken(Data(repeating: 5, count: 32), activityID: "activity")
        }
        fixture.controller.receiveToken(Data(repeating: 4, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.relayOperations == ["create", "rotate"])
        #expect(fixture.gatewayOperations.filter { $0 == "push.liveActivity.register" }.count == 1)
        #expect(fixture.gatewayRevision == 0)
        #expect(fixture.relayRevision == 2)
        await fixture.close()
    }

    @Test func `stale OS activity recovers through both discoveries and same token rotation`() async throws {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.currentToken = Data(repeating: 6, count: 32)
        try fixture.controller.receiveToken(#require(fixture.currentToken), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        fixture.controller.suspend()
        await fixture.controller.finishPendingOperations()
        fixture.activityState = .stale
        fixture.controller = RemoteRunLiveActivity(system: fixture.system)
        fixture.controller.resume(gateway: fixture.gateway, relay: fixture.relay)
        await fixture.controller.finishPendingOperations()
        #expect(fixture.created == 1)
        #expect(fixture.ended == 0)
        #expect(fixture.relayOperations.suffix(2) == ["discover", "rotate"])
        #expect(fixture.gatewayOperations.contains("push.liveActivity.discover"))
        #expect(fixture.gatewayRevision == 1)
        await fixture.close()
    }

    @Test func `terminal pending is not locally revoked before actual terminal delivery`() async {
        let fixture = RunActivityLifecycleFixture()
        fixture.registrationState = "terminal_pending"
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 7, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.ended == 0)
        #expect(!fixture.relayOperations.contains("revoke"))
        fixture.controller.receiveState(.stale, activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.ended == 0)
        fixture.controller.receiveState(.ended, activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.ended == 1)
        #expect(fixture.relayOperations.last == "revoke")
        #expect(fixture.immediateDismissals == [false])
        await fixture.close()
    }

    @Test func `unknown recovered registration does not create another relay destination`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 8, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        fixture.registered = false
        fixture.controller.suspend()
        fixture.controller.resume(gateway: fixture.gateway, relay: fixture.relay)
        await fixture.controller.finishPendingOperations()
        #expect(fixture.ended == 1)
        #expect(fixture.relayOperations.filter { $0 == "create" }.count == 1)
        await fixture.close()
    }

    @Test func `unsupported relay build cannot request an OS activity`() async {
        let fixture = RunActivityLifecycleFixture()
        fixture.relayAvailable = false
        await fixture.start()
        #expect(fixture.created == 0)
        #expect(fixture.gatewayOperations.isEmpty)
        #expect(fixture.relayOperations.isEmpty)
        await fixture.close()
    }

    @Test func `fresh attestation acknowledgement loss stops without another enrollment`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.nextRelayOutcome = .freshAttestationUnacknowledged
        fixture.controller.receiveToken(Data(repeating: 9, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.relayOperations == ["create"])
        #expect(!fixture.registered)
        await fixture.close()
    }

    @Test func `actual end during grant fences publication before the state observer catches up`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.onRelayCreate = { fixture.activityState = .ended }
        fixture.controller.receiveToken(Data(repeating: 10, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(!fixture.registered)
        #expect(fixture.relayOperations.last == "revoke")
        #expect(fixture.ended == 1)
        await fixture.close()
    }

    @Test func `duplicate token during held relay create does not renew either registration`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        let barrier = RunActivityBarrier()
        fixture.relayBarrier = barrier
        let token = Data(repeating: 11, count: 32)
        fixture.controller.receiveToken(token, activityID: "activity")
        await barrier.waitUntilPaused()
        fixture.controller.receiveToken(token, activityID: "activity")
        barrier.resume()
        await fixture.controller.finishPendingOperations()
        #expect(fixture.relayOperations == ["create"])
        #expect(fixture.gatewayOperations.filter { $0 == "push.liveActivity.register" }.count == 1)
        #expect(!fixture.gatewayOperations.contains("push.liveActivity.rotate"))
        #expect(fixture.relayRevision == 1)
        #expect(fixture.gatewayRevision == 0)
        await fixture.close()
    }

    @Test(arguments: ["ended", "dismissed", "foreground"])
    func `new accepted preparation survives old slot retirement or repeated foreground`(event: String) async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        let barrier = RunActivityBarrier()
        fixture.prepareBarrier = barrier
        let nextRun = OpenClawNativeRunRef(session: fixture.run.session, runID: "next-run")
        fixture.controller.observeAcceptedRun(
            nextRun, sessionID: "generation", gateway: fixture.gateway, relay: fixture.relay)
        await barrier.waitUntilPaused()
        if event == "foreground" {
            fixture.controller.resume(gateway: fixture.gateway, relay: fixture.relay)
            fixture.controller.resume(gateway: fixture.gateway, relay: fixture.relay)
        } else {
            fixture.controller.receiveState(event == "ended" ? .ended : .dismissed, activityID: "activity")
        }
        barrier.resume()
        await fixture.controller.finishPendingOperations()
        #expect(fixture.created == 2)
        #expect(fixture.handle?.attributes.runId == "next-run")
        #expect(fixture.ended == 1)
        #expect(fixture.relayOperations.isEmpty)
        await fixture.close()
    }

    @Test(arguments: [true, false])
    func `lost rotation acknowledgements keep relay and Gateway revisions distinct`(relayACK: Bool) async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 12, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        fixture.loseRelayACK = relayACK
        fixture.loseGatewayACK = !relayACK
        fixture.controller.receiveToken(Data(repeating: 13, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        let rotations = fixture.gatewayRequests.filter { $0.method == "push.liveActivity.rotate" }
        #expect(rotations.map { $0.params["expectedRevision"]?.value as? Int } == (relayACK ? [0] : [0, 1]))
        let destination = rotations.last?.params["destination"]?.value as? [String: AnyCodable]
        #expect(destination?["relayRevision"]?.value as? Int == 3)
        #expect(fixture.relayOperations.filter { $0 == "create" }.count == 1)
        #expect(fixture.gatewayOperations.filter { $0 == "push.liveActivity.register" }.count == 1)
        #expect(fixture.created == 1)
        await fixture.close()
    }

    @Test func `new accepted work cannot cancel an older owner's in flight cleanup`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 14, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        let barrier = RunActivityBarrier()
        fixture.revokeBarrier = barrier
        let retirement = Task { await fixture.controller.retire(owner: fixture.run.session.owner) }
        await barrier.waitUntilPaused()
        fixture.controller.resume(gateway: fixture.gateway, relay: fixture.relay)
        fixture.controller.observeAcceptedRun(
            .init(session: fixture.run.session, runID: "replacement-run"),
            sessionID: "generation",
            gateway: fixture.gateway,
            relay: fixture.relay)
        barrier.resume()
        await retirement.value
        #expect(fixture.relayOperations.last == "revoke")
        #expect(fixture.created == 2)
        #expect(fixture.ended == 1)
        #expect(fixture.handle?.attributes.runId == "replacement-run")
        await fixture.close()
    }

    @Test func `selecting another owner fences token work without ending the old activity`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        let other = RemoteRunActivityGateway(
            session: .init(
                owner: .init(gatewayID: "local", profileID: "other-profile"),
                agentID: "agent",
                sessionKey: "agent:agent:main"),
            request: { try await fixture.request($0) },
            isCurrent: { true })
        fixture.controller.resume(gateway: other, relay: fixture.relay)
        fixture.controller.receiveToken(Data(repeating: 15, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.relayOperations.isEmpty)
        #expect(fixture.ended == 0)
        await fixture.controller.forget(gatewayID: "different-local")
        #expect(fixture.ended == 0)
        await fixture.controller.forget(gatewayID: "local")
        #expect(fixture.ended == 1)
        await fixture.close()
    }

    @Test(arguments: [true, false])
    func `expired or tombstoned registration retires both destinations`(expired: Bool) async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        if expired {
            fixture.registrationExpiresAtMs = 0
        } else {
            fixture.registrationState = "tombstone"
        }
        fixture.controller.receiveToken(Data(repeating: 16, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.ended == 1)
        #expect(fixture.relayOperations.last == "revoke")
        #expect(!fixture.registered)
        await fixture.close()
    }

    @Test func `a replaced execution source cannot receive the first relay grant`() async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        fixture.sourceIncarnation = "replaced-source"
        fixture.controller.receiveToken(Data(repeating: 17, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        #expect(fixture.relayOperations.isEmpty)
        #expect(!fixture.registered)
        await fixture.close()
    }

    @Test(arguments: ["active", "stale", "ended"])
    func `cold forget ends only exact gateway handles without a connection or new registration`(
        state: String) async throws
    {
        let fixture = RunActivityLifecycleFixture(owner: .init(gatewayID: "caf\u{E9}", profileID: "profile"))
        let unrelated = RunActivityLifecycleFixture(
            owner: .init(gatewayID: "cafe\u{301}", profileID: "profile"),
            activityID: "unrelated")
        await fixture.start()
        await unrelated.start()
        await fixture.suspendAndJoin()
        await unrelated.suspendAndJoin()
        fixture.additionalActivities = try [#require(unrelated.handle)]
        fixture.activityState = state == "active" ? .active : state == "stale" ? .stale : .ended
        fixture.current = false
        fixture.relayAvailable = false
        fixture.activitiesEnabled = false
        fixture.controller = RemoteRunLiveActivity(system: fixture.system)
        let gatewayOperations = fixture.gatewayOperations
        let relayOperations = fixture.relayOperations
        await fixture.controller.forget(gatewayID: fixture.run.session.owner.gatewayID)
        #expect(fixture.ended == 1)
        #expect(fixture.immediateDismissals == [true])
        #expect(unrelated.ended == 0)
        #expect(fixture.created == 1)
        #expect(fixture.gatewayOperations == gatewayOperations)
        #expect(fixture.relayOperations == relayOperations)
        await unrelated.close()
    }

    @Test func `cold owner retirement matches both gateway and profile bytes`() async throws {
        let owner = OpenClawNativeOwnerRef(gatewayID: "caf\u{E9}", profileID: "profil\u{E9}")
        let fixture = RunActivityLifecycleFixture(owner: owner)
        let otherOwners = [
            OpenClawNativeOwnerRef(gatewayID: "other", profileID: owner.profileID),
            OpenClawNativeOwnerRef(gatewayID: owner.gatewayID, profileID: "other"),
            OpenClawNativeOwnerRef(gatewayID: "cafe\u{301}", profileID: owner.profileID),
            OpenClawNativeOwnerRef(gatewayID: owner.gatewayID, profileID: "profile\u{301}"),
        ]
        let unrelated = otherOwners.enumerated().map {
            RunActivityLifecycleFixture(owner: $0.element, activityID: "unrelated-\($0.offset)")
        }
        for item in [fixture] + unrelated {
            await item.start()
            await item.suspendAndJoin()
            item.current = false
            item.activitiesEnabled = false
        }
        fixture.additionalActivities = try unrelated.map { try #require($0.handle) }
        fixture.controller = RemoteRunLiveActivity(system: fixture.system)
        let gatewayOperations = fixture.gatewayOperations
        await fixture.controller.retire(owner: owner)
        #expect(fixture.ended == 1)
        #expect(fixture.immediateDismissals == [true])
        #expect(unrelated.allSatisfy { $0.ended == 0 })
        #expect(fixture.created == 1)
        #expect(fixture.gatewayOperations == gatewayOperations)
        #expect(fixture.relayOperations.isEmpty)
        for item in unrelated {
            await item.close()
        }
    }

    @Test func `forget captures cold handles before hydrated cleanup and never ends the slot twice`() async throws {
        let fixture = RunActivityLifecycleFixture()
        let cold = RunActivityLifecycleFixture(activityID: "cold")
        let later = RunActivityLifecycleFixture(activityID: "later")
        await fixture.start()
        fixture.controller.receiveToken(Data(repeating: 18, count: 32), activityID: "activity")
        await fixture.controller.finishPendingOperations()
        for item in [cold, later] {
            await item.start()
            await item.suspendAndJoin()
        }
        fixture.additionalActivities = try [#require(cold.handle)]
        let laterHandle = try #require(later.handle)
        let barrier = RunActivityBarrier()
        fixture.revokeBarrier = barrier
        let forgetting = Task { await fixture.controller.forget(gatewayID: "local") }
        await barrier.waitUntilPaused()
        fixture.additionalActivities.append(laterHandle)
        barrier.resume()
        await forgetting.value
        #expect(fixture.ended == 1)
        #expect(cold.ended == 1)
        #expect(fixture.immediateDismissals == [true])
        #expect(cold.immediateDismissals == [true])
        #expect(later.ended == 0)
        #expect(fixture.gatewayOperations.filter { $0 == "push.liveActivity.revoke" }.count == 1)
        #expect(fixture.relayOperations.filter { $0 == "revoke" }.count == 1)
        fixture.additionalActivities = []
        await fixture.close()
        await later.close()
    }

    @Test(arguments: [true, false])
    func `cold ending preserves a newer owner and its pending work`(holdPreparation: Bool) async {
        let fixture = RunActivityLifecycleFixture()
        await fixture.start()
        await fixture.suspendAndJoin()
        fixture.current = false
        fixture.controller = RemoteRunLiveActivity(system: fixture.system)
        let ending = RunActivityBarrier()
        fixture.endBarrier = ending
        let forgetting = Task {
            await fixture.controller.forget(gatewayID: "local")
            ending.finish()
        }
        await ending.waitUntilPaused()
        if ending.isFinished {
            await forgetting.value
            Issue.record("Forget returned without ending the captured activity")
            return
        }
        let next = RunActivityLifecycleFixture(owner: .init(gatewayID: "next", profileID: "next-profile"))
        let preparing = RunActivityBarrier()
        if holdPreparation { next.prepareBarrier = preparing }
        fixture.controller.resume(gateway: next.gateway, relay: next.relay)
        fixture.controller.observeAcceptedRun(
            next.run,
            sessionID: "generation",
            gateway: next.gateway,
            relay: next.relay)
        if holdPreparation {
            await preparing.waitUntilPaused()
        } else {
            await fixture.controller.finishPendingOperations()
        }
        ending.resume()
        await forgetting.value
        #expect(fixture.ended == 1)
        #expect(fixture.created == (holdPreparation ? 1 : 2))
        preparing.resume()
        await fixture.controller.finishPendingOperations()
        #expect(fixture.created == 2)
        #expect(fixture.handle?.attributes.gatewayId == "next")
        #expect(fixture.handle?.attributes.profileId == "next-profile")
        #expect(fixture.controller.phase == .awaitingToken)
        await fixture.controller.retire(owner: next.run.session.owner)
        await next.close()
    }
}
