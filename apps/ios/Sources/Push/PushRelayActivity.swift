import Foundation

struct PushRelayActivityRevision: Equatable, Sendable {
    static let maximum: Int64 = 9_007_199_254_740_991
    let rawValue: Int64

    init(_ rawValue: Int64) throws {
        guard (1...Self.maximum).contains(rawValue) else {
            throw PushRelayError.relayMisconfigured("Invalid activity revision")
        }
        self.rawValue = rawValue
    }
}

enum PushRelayActivityOperation: Sendable {
    case create(token: String)
    case rotate(revision: PushRelayActivityRevision, token: String)
    case discover
    case revoke(revision: PushRelayActivityRevision)

    var name: String {
        switch self {
        case .create: "create"
        case .rotate: "rotate"
        case .discover: "discover"
        case .revoke: "revoke"
        }
    }

    var expectedRevision: Int64? {
        switch self {
        case .create: 0
        case let .rotate(revision, _), let .revoke(revision): revision.rawValue
        case .discover: nil
        }
    }

    var token: String? {
        switch self {
        case let .create(token), let .rotate(_, token): token
        case .discover, .revoke: nil
        }
    }
}

/// Captured route context, not proof of current authenticated Gateway ownership.
struct PushRelayActivityOwner: Sendable {
    let activityId: String
    let profileId: String
    let gatewayIdentity: PushRelayGatewayIdentity
}

struct PushRelayActivityMetadata: Equatable, Sendable {
    enum Status: String, Decodable, Sendable {
        case active
        case terminalPending
    }

    let status: Status
    let revision: PushRelayActivityRevision
    let expiresAtMs: Int64
}

/// Transient credentials for the activity owner; never ordinary registration-cache state.
struct PushRelayActivityGrant: Equatable, Sendable {
    let metadata: PushRelayActivityMetadata
    let relayHandle: String
    let sendGrant: String
    let installationId: String
    let topic: String
    let environment: String
    let relayOrigin: String
}

enum PushRelayActivityOutcome: Equatable, Sendable {
    case live(PushRelayActivityMetadata)
    case grant(PushRelayActivityGrant)
    case unknown
    /// Also acknowledges an authenticated revoke, including an already-retired activity.
    case gone
    case conflict
    case unauthorized
    case rateLimited
    case unavailable
    case operationOutcomeUnknown
    case freshAttestationUnacknowledged
}

struct PushRelayActivityInput: Sendable {
    let owner: PushRelayActivityOwner
    let installationId: String
    let bundleId: String
    let environment: PushAPNsEnvironment
    let relayProfile: PushRelayProfile
    let proofPolicy: PushProofPolicy
}

struct PushRelayActivityRequest: Encodable {
    let purpose = "liveActivity"
    let activityId: String
    let installationId: String
    let profileId: String
    let bundleId: String
    let relayProfile: String
    let apnsEnvironment: String
    let proofPolicy: String
    let distribution = "official"
    let gateway: PushRelayGatewayIdentity
    let operation: String
    let expectedRevision: Int64?
    let apnsToken: String?
    let challengeId: String
    // Only the signed envelope has these two fields; the outer request carries the proof.
    var appAttestKeyId: String?
    var challenge: String?
    var appAttest: PushRelayAppAttestProof?
    var receipt: PushRelayReceiptPayload?

    init(operation: PushRelayActivityOperation, input: PushRelayActivityInput, challengeId: String) throws {
        try Self.validate(operation: operation, input: input)
        guard !challengeId.isEmpty, challengeId.utf16.count <= 512 else {
            throw PushRelayError.invalidResponse("Invalid activity relay challenge")
        }
        self.activityId = input.owner.activityId
        self.installationId = input.installationId
        self.profileId = input.owner.profileId
        self.bundleId = input.bundleId
        self.relayProfile = input.relayProfile.rawValue
        self.apnsEnvironment = input.environment.rawValue
        self.proofPolicy = input.proofPolicy.rawValue
        self.gateway = input.owner.gatewayIdentity
        self.operation = operation.name
        self.expectedRevision = operation.expectedRevision
        self.apnsToken = operation.token
        self.challengeId = challengeId
    }

    static func validate(operation: PushRelayActivityOperation, input: PushRelayActivityInput) throws {
        guard (input.relayProfile == .production && input.environment == .production
            && input.proofPolicy == .appleStrict)
            || (input.relayProfile == .deviceSandbox && input.environment == .sandbox
                && input.proofPolicy == .appleDevelopment)
        else {
            throw PushRelayError.relayMisconfigured("Activity relay requires device App Attest")
        }
        let identifiers = [
            input.owner.activityId, input.installationId, input.owner.profileId, input.bundleId,
            input.owner.gatewayIdentity.deviceId, input.owner.gatewayIdentity.publicKey,
        ]
        guard identifiers.allSatisfy({
            !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty && $0.utf16.count <= 512
        }) else {
            throw PushRelayError.relayMisconfigured("Invalid activity relay identity")
        }
        if let token = operation.token {
            guard (32...512).contains(token.utf8.count),
                  token.utf8.allSatisfy({ (48...57).contains($0) || (65...70).contains($0) || (97...102).contains($0) })
            else {
                throw PushRelayError.relayMisconfigured("Invalid activity push token")
            }
        }
    }

    func signedPayload(keyId: String, challenge: String) throws -> Data {
        struct RetainedIdentity: Encodable {
            let activityId: String
            let owner: [String: String]
        }
        let encoder = JSONEncoder()
        encoder.outputFormatting = .withoutEscapingSlashes
        let identity = RetainedIdentity(activityId: self.activityId, owner: [
            "installationId": self.installationId, "appAttestKeyId": keyId,
            "profileId": self.profileId, "bundleId": self.bundleId,
            "relayProfile": self.relayProfile, "environment": self.apnsEnvironment,
            "proofPolicy": self.proofPolicy, "gatewayDeviceId": self.gateway.deviceId,
            "gatewayPublicKey": self.gateway.publicKey,
        ])
        // Match the relay's retained-identity cap before consuming a one-time attestation.
        guard try encoder.encode(identity).count <= 1024 else {
            throw PushRelayError.relayMisconfigured("Activity relay identity exceeds 1024 bytes")
        }
        var signed = self
        signed.appAttestKeyId = keyId
        signed.challenge = challenge
        return try encoder.encode(signed)
    }
}

struct PushRelayActivityResponse: Decodable {
    let status: String
    let revision: Int64?
    let expiresAtMs: Int64?
    let relayHandle: String?
    let sendGrant: String?

    func outcome(
        httpStatus: Int,
        operation: PushRelayActivityOperation,
        input: PushRelayActivityInput,
        relayOrigin: String) throws -> PushRelayActivityOutcome
    {
        let invalid = PushRelayError.invalidResponse("Invalid activity relay response")
        let hasGrant = self.relayHandle != nil || self.sendGrant != nil
        guard httpStatus == 200 || !hasGrant else { throw invalid }
        if let revision, !(1...PushRelayActivityRevision.maximum).contains(revision) { throw invalid }
        if let expiresAtMs, !(0...PushRelayActivityRevision.maximum).contains(expiresAtMs) { throw invalid }
        switch (httpStatus, self.status) {
        case (200, "active"), (200, "terminalPending"):
            guard let revision, let expiresAtMs,
                  let status = PushRelayActivityMetadata.Status(rawValue: self.status)
            else { throw invalid }
            let metadata = try PushRelayActivityMetadata(
                status: status, revision: PushRelayActivityRevision(revision), expiresAtMs: expiresAtMs)
            switch operation {
            case .discover:
                guard !hasGrant else { throw invalid }
                return .live(metadata)
            case .create, .rotate:
                guard let relayHandle, let sendGrant,
                      let expectedRevision = operation.expectedRevision,
                      !relayHandle.isEmpty, !sendGrant.isEmpty,
                      relayHandle.utf8.count <= 512, sendGrant.utf8.count <= 512,
                      expectedRevision < PushRelayActivityRevision.maximum, revision == expectedRevision + 1
                else { throw invalid }
                return .grant(PushRelayActivityGrant(
                    metadata: metadata,
                    relayHandle: relayHandle,
                    sendGrant: sendGrant,
                    installationId: input.installationId,
                    topic: input.bundleId,
                    environment: input.environment.rawValue,
                    relayOrigin: relayOrigin))
            case .revoke:
                throw invalid
            }
        case (404, "unknown"): return .unknown
        case (410, "gone"): return .gone
        case (409, "conflict"): return .conflict
        case (401, "unauthorized"), (403, "unauthorized"): return .unauthorized
        case (429, "rate_limited"): return .rateLimited
        case (503, "unavailable"): return .unavailable
        default: throw invalid
        }
    }
}
