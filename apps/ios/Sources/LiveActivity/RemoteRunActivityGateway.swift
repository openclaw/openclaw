import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawNativeActions
import OpenClawProtocol

/// Uses one captured, profile-bound connection. Activity selectors never select
/// a replacement connection or establish authority for a later registration.
struct RemoteRunActivityGateway: Sendable {
    enum Failure: String, Error {
        case unavailable, ownerChanged, invalidResponse, terminal
    }

    struct Selection: Sendable {
        let attributes: OpenClawRunActivityAttributes
        let sourceIncarnation: String
        let binding: [String: AnyCodable]

        var expected: [String: AnyCodable] {
            ["binding": AnyCodable(self.binding), "sourceIncarnation": AnyCodable(self.sourceIncarnation)]
        }

        func matches(_ other: Self) -> Bool {
            guard self.attributes == other.attributes,
                  self.sourceIncarnation.utf8.elementsEqual(other.sourceIncarnation.utf8)
            else { return false }
            return ["nodeId", "pairingGeneration", "lifecycleRevision"].allSatisfy { key in
                if self.binding[key]?.value is NSNull { return other.binding[key]?.value is NSNull }
                guard let lhs = self.binding[key]?.value as? String,
                      let rhs = other.binding[key]?.value as? String else { return false }
                return lhs.utf8.elementsEqual(rhs.utf8)
            }
        }
    }

    struct Prepared: Sendable {
        let selection: Selection
        let content: OpenClawRunActivityAttributes.ContentState
        let gatewayIdentity: PushRelayGatewayIdentity
    }

    struct Registration: Sendable {
        enum State: String {
            case active, terminalPending = "terminal_pending", tombstone
        }

        let id: String
        let activityID: String
        let selection: Selection
        let state: State
        let revision: Int
        let expiresAt: Date
    }

    let session: OpenClawNativeSessionRef
    private let request: @Sendable (OpenClawChatGatewayRequest) async throws -> Data
    private let current: @Sendable () async -> Bool

    init(binding: IOSNativeActionBinding) {
        self.init(
            session: binding.session,
            request: { try await binding.request($0) },
            isCurrent: { await binding.isCurrent() })
    }

    init(
        session: OpenClawNativeSessionRef,
        request: @escaping @Sendable (OpenClawChatGatewayRequest) async throws -> Data,
        isCurrent: @escaping @Sendable () async -> Bool)
    {
        self.session = session
        self.request = request
        self.current = isCurrent
    }

    func selecting(_ session: OpenClawNativeSessionRef) throws -> Self {
        guard session.owner == self.session.owner else { throw Failure.ownerChanged }
        return Self(session: session, request: self.request, isCurrent: self.current)
    }

    func requireCurrent() async throws {
        try Task.checkCancellation()
        let current = await self.current()
        try Task.checkCancellation()
        guard current else { throw Failure.ownerChanged }
    }

    func identity(timeoutMs: Double = 3000) async throws -> PushRelayGatewayIdentity {
        let identity: PushRelayGatewayIdentity = try await self.call(
            "gateway.identity.get", params: [String: OpenClawProtocol.AnyCodable](), timeoutMs: timeoutMs)
        try Self.identifier(identity.deviceId, maximum: 256)
        try Self.identifier(identity.publicKey, maximum: 512)
        return identity
    }

    func prepare(run: OpenClawNativeRunRef, sessionID: String?) async throws -> Prepared {
        guard run.session == self.session else { throw Failure.ownerChanged }
        try Self.identifier(run.runID, maximum: 256)
        let deadline = ContinuousClock.now.advanced(by: .seconds(3))
        let identity = try await self.identity(timeoutMs: Self.remaining(deadline))
        let generation: String
        if let sessionID {
            try Self.identifier(sessionID, maximum: 128)
            generation = sessionID
        } else {
            // Status without a generation cannot query an exact run. It resolves
            // only the selector; prepare below proves the accepted run binding.
            let status: SessionsStatusResult = try await self.call(
                "sessions.status",
                params: SessionsStatusParams(key: self.session.sessionKey, agentid: self.session.agentID),
                timeoutMs: Self.remaining(deadline))
            guard !(status.session.value is NSNull) else { throw Failure.unavailable }
            let selected = try GatewayPayloadDecoding.decode(status.session, as: SessionStatus.self)
            guard selected.key.utf8.elementsEqual(self.session.sessionKey.utf8),
                  selected.agentid.utf8.elementsEqual(self.session.agentID.utf8)
            else { throw Failure.ownerChanged }
            try Self.identifier(selected.sessionid, maximum: 128)
            generation = selected.sessionid
        }
        for attempt in 0..<4 {
            do {
                let result: PushLiveActivityPrepareResult = try await self.call(
                    "push.liveActivity.prepare",
                    params: PushLiveActivityPrepareParams(
                        key: self.session.sessionKey,
                        agentid: self.session.agentID,
                        sessionid: generation,
                        publicrunid: run.runID),
                    timeoutMs: Self.remaining(deadline))
                _ = try Self.remaining(deadline)
                let selection = try self.selection(result.binding, source: result.sourceincarnation)
                guard selection.attributes.gatewayDeviceId.utf8.elementsEqual(identity.deviceId.utf8),
                      selection.attributes.sessionId.utf8.elementsEqual(generation.utf8),
                      selection.attributes.runId.utf8.elementsEqual(run.runID.utf8)
                else { throw Failure.ownerChanged }
                let content = try Self.content(result.snapshot, source: result.sourceincarnation)
                guard !content.status.isTerminal else { throw Failure.terminal }
                return Prepared(selection: selection, content: content, gatewayIdentity: identity)
            } catch let error as GatewayResponseError {
                guard error.code == "UNAVAILABLE", error.details["retryable"]?.value as? Bool == true,
                      attempt < 3 else { throw Failure.unavailable }
                let delay = try error.details["retryAfterMs"].map { try Self.number($0) } ?? 250
                let remaining = try Self.remaining(deadline)
                guard delay > 0, delay < remaining else { throw Failure.unavailable }
                try await Task.sleep(for: .milliseconds(delay))
                try await self.requireCurrent()
            }
        }
        throw Failure.unavailable
    }

    func register(
        activityID: String,
        prepared: Selection,
        grant: PushRelayActivityGrant) async throws -> Registration
    {
        try Self.identifier(activityID, maximum: 256)
        let result: PushLiveActivityRegistrationResult = try await self.call(
            "push.liveActivity.register",
            params: PushLiveActivityRegisterParams(
                activityid: activityID, expected: prepared.expected, destination: Self.destination(grant)))
        let registration = try self.registration(result)
        guard registration.activityID.utf8.elementsEqual(activityID.utf8),
              registration.selection.matches(prepared)
        else { throw Failure.ownerChanged }
        return registration
    }

    func discover(
        activityID: String,
        attributes: OpenClawRunActivityAttributes) async throws -> Registration?
    {
        try self.requireSelection(attributes)
        try Self.identifier(activityID, maximum: 256)
        let result: PushLiveActivityDiscoverResult = try await self.call(
            "push.liveActivity.discover",
            params: PushLiveActivityDiscoverParams(activityid: activityID, selectors: [
                "gatewayDeviceId": AnyCodable(attributes.gatewayDeviceId),
                "deviceId": AnyCodable(attributes.deviceId),
                "profileId": AnyCodable(attributes.profileId),
                "agentId": AnyCodable(attributes.agentId),
                "sessionKey": AnyCodable(attributes.sessionKey),
                "sessionId": AnyCodable(attributes.sessionId),
                "runId": AnyCodable(attributes.runId),
            ]))
        switch result {
        case .unknown:
            return nil
        case let .found(found):
            let registration = try self.registration(found.registration)
            guard registration.activityID.utf8.elementsEqual(activityID.utf8),
                  registration.selection.attributes == attributes
            else { throw Failure.ownerChanged }
            return registration
        }
    }

    func rotate(
        registration: Registration,
        grant: PushRelayActivityGrant) async throws -> Registration
    {
        let result: PushLiveActivityRegistrationResult = try await self.call(
            "push.liveActivity.rotate",
            params: PushLiveActivityRotateParams(
                registrationid: registration.id,
                expectedrevision: registration.revision,
                destination: Self.destination(grant)))
        let updated = try self.registration(result)
        guard updated.id.utf8.elementsEqual(registration.id.utf8),
              updated.activityID.utf8.elementsEqual(registration.activityID.utf8),
              updated.selection.matches(registration.selection),
              updated.revision == registration.revision + 1
        else { throw Failure.ownerChanged }
        return updated
    }

    func revoke(_ registration: Registration) async throws -> Bool {
        try self.requireSelection(registration.selection.attributes)
        let result: PushLiveActivityRevokeResult = try await self.call(
            "push.liveActivity.revoke",
            params: PushLiveActivityRevokeParams(
                registrationid: registration.id, expectedrevision: registration.revision))
        return result.removed
    }

    private func call<Response: Decodable>(
        _ method: String, params: some Encodable, timeoutMs: Double = 3000) async throws -> Response
    {
        try await self.requireCurrent()
        let encoded = try JSONEncoder().encode(params)
        let fields = try JSONDecoder().decode([String: OpenClawProtocol.AnyCodable].self, from: encoded)
        let data = try await self.request(.init(method: method, params: fields, timeoutMs: timeoutMs))
        try await self.requireCurrent()
        guard data.count <= 16384 else { throw Failure.invalidResponse }
        do {
            return try JSONDecoder().decode(Response.self, from: data)
        } catch {
            // Decoder diagnostics may include credentials or private selectors.
            throw Failure.invalidResponse
        }
    }

    private func requireSelection(_ attributes: OpenClawRunActivityAttributes) throws {
        let selected = OpenClawNativeSessionRef(
            owner: .init(gatewayID: attributes.gatewayId, profileID: attributes.profileId),
            agentID: attributes.agentId,
            sessionKey: attributes.sessionKey)
        guard selected == self.session else { throw Failure.ownerChanged }
    }

    private func selection(_ fields: [String: AnyCodable], source: String) throws -> Selection {
        guard Set(fields.keys) == [
            "gatewayId", "deviceId", "nodeId", "pairingGeneration", "profileId", "agentId",
            "sessionKey", "sessionId", "lifecycleRevision", "publicRunId",
        ] else { throw Failure.invalidResponse }
        try Self.identifier(source, maximum: 1024)
        _ = try Self.string(fields, "nodeId", maximum: 256)
        let pairing = try Self.string(fields, "pairingGeneration", maximum: 64)
        guard pairing.utf8.count == 64,
              pairing.utf8.allSatisfy({ (48...57).contains($0) || (97...102).contains($0) })
        else { throw Failure.invalidResponse }
        if !(fields["lifecycleRevision"]?.value is NSNull) {
            _ = try Self.string(fields, "lifecycleRevision", maximum: 256)
        }
        let attributes = try OpenClawRunActivityAttributes(
            gatewayId: self.session.owner.gatewayID,
            gatewayDeviceId: Self.string(fields, "gatewayId", maximum: 256),
            deviceId: Self.string(fields, "deviceId", maximum: 256),
            profileId: Self.string(fields, "profileId", maximum: 128),
            agentId: Self.string(fields, "agentId", maximum: 64),
            sessionKey: Self.string(fields, "sessionKey", maximum: 512),
            sessionId: Self.string(fields, "sessionId", maximum: 128),
            runId: Self.string(fields, "publicRunId", maximum: 256))
        try self.requireSelection(attributes)
        return Selection(attributes: attributes, sourceIncarnation: source, binding: fields)
    }

    private func registration(_ result: PushLiveActivityRegistrationResult) throws -> Registration {
        try Self.identifier(result.registrationid, maximum: 256)
        try Self.identifier(result.activityid, maximum: 256)
        let selection = try self.selection(result.binding, source: result.sourceincarnation)
        guard let rawState = result.state.value as? String,
              let state = Registration.State(rawValue: rawState),
              (0...Int(PushRelayActivityRevision.maximum)).contains(result.rotationrevision)
        else { throw Failure.invalidResponse }
        try Self.timestamp(result.leaseexpiresatms)
        return Registration(
            id: result.registrationid,
            activityID: result.activityid,
            selection: selection,
            state: state,
            revision: result.rotationrevision,
            expiresAt: Date(timeIntervalSince1970: result.leaseexpiresatms / 1000))
    }

    private static func content(
        _ payload: AnyCodable, source: String) throws -> OpenClawRunActivityAttributes.ContentState
    {
        let fields = try GatewayPayloadDecoding.decode(payload, as: [String: OpenClawProtocol.AnyCodable].self)
        let rawStatus = try Self.string(fields, "status", maximum: 32)
        let statuses: [String: OpenClawRunActivityAttributes.ContentState.Status] = [
            "running": .running, "toolRunning": .toolRunning, "approvalNeeded": .approvalNeeded,
            "done": .completed, "failed": .failed, "killed": .cancelled, "timeout": .timedOut,
        ]
        guard let status = statuses[rawStatus],
              Set(fields.keys).isSubset(of: [
                  "sourceIncarnation", "sequence", "status", "observedAtMs", "startedAtMs", "endedAtMs",
              ]),
              try Self.string(fields, "sourceIncarnation", maximum: 1024).utf8.elementsEqual(source.utf8),
              let sequenceValue = fields["sequence"], let observedValue = fields["observedAtMs"]
        else { throw Failure.invalidResponse }
        let sequence = try Self.number(sequenceValue)
        guard sequence.rounded(.down) == sequence else { throw Failure.invalidResponse }
        let observed = try Self.number(observedValue)
        let started = try fields["startedAtMs"].map(Self.number)
        let ended = try fields["endedAtMs"].map(Self.number)
        return try .init(
            status: status,
            observedAt: Date(timeIntervalSince1970: observed / 1000),
            startedAt: started.map { Date(timeIntervalSince1970: $0 / 1000) },
            endedAt: ended.map { Date(timeIntervalSince1970: $0 / 1000) })
    }

    private static func destination(_ grant: PushRelayActivityGrant) -> AnyCodable {
        AnyCodable([
            "transport": "relay", "topic": grant.topic, "environment": grant.environment,
            "relayHandle": grant.relayHandle, "sendGrant": grant.sendGrant,
            "installationId": grant.installationId, "relayOrigin": grant.relayOrigin,
            "relayRevision": grant.metadata.revision.rawValue,
        ] as [String: Any])
    }

    private static func remaining(_ deadline: ContinuousClock.Instant) throws -> Double {
        let duration = ContinuousClock.now.duration(to: deadline).components
        let milliseconds = Double(duration.seconds) * 1000 + Double(duration.attoseconds) / 1e15
        guard milliseconds > 0 else { throw Failure.unavailable }
        return min(3000, milliseconds)
    }

    private static func string(_ fields: [String: AnyCodable], _ key: String, maximum: Int) throws -> String {
        guard let value = fields[key]?.value as? String else { throw Failure.invalidResponse }
        try Self.identifier(value, maximum: maximum)
        return value
    }

    private static func identifier(_ value: String, maximum: Int) throws {
        guard !value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
              value.unicodeScalars.count <= maximum,
              !value.unicodeScalars.contains(where: { $0.value <= 31 })
        else { throw Failure.invalidResponse }
    }

    private static func number(_ value: AnyCodable) throws -> Double {
        let number = try GatewayPayloadDecoding.decode(value, as: Double.self)
        try Self.timestamp(number)
        return number
    }

    private static func timestamp(_ value: Double) throws {
        guard value.isFinite, value >= 0, value <= Double(PushRelayActivityRevision.maximum) else {
            throw Failure.invalidResponse
        }
    }
}
