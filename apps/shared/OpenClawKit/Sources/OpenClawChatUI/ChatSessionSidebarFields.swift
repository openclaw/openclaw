import OpenClawProtocol

extension OpenClawChatSessionEntry {
    public struct Owner: Codable, Sendable, Hashable {
        public let actor: CreatedActor
        public let assignedBy: CreatedActor?
        public let assignedAt: Double?
    }

    public struct Participant: Codable, Sendable, Hashable {
        public let identity: AnyCodable
        public let label: String?
        public let avatarUrl: String?
    }

    public struct ForkSource: Codable, Sendable, Hashable {
        public let sessionKey: String
        public let sessionId: String
        public let entryId: String?
    }

    // src/gateway/worker-environments/placement-projector.ts:188 projects these
    // state-dependent facts; absent fields must stay unknown across lifecycle states.
    public struct Placement: Codable, Sendable, Hashable {
        public let state: SessionPlacementState
        public let generation: Int
        public let createdAtMs: Int
        public let updatedAtMs: Int
        public let stateChangedAtMs: Int
        public let providerId: String?
        public let profileId: String?
        public let machine: AnyCodable?
        public let environmentId: String?
        public let activeOwnerEpoch: Int?
        public let workerBundleHash: String?
        public let workspaceBaseManifestRef: String?
        public let remoteWorkspaceDir: String?
        public let lastTranscriptAckCursor: Int?
        public let lastLiveEventAckCursor: Int?
        public let workspaceResultConflict: AnyCodable?
        public let diskSpace: AnyCodable?
        public let workspaceResultReconciling: Bool?
        public let runner: AnyCodable?
        public let workerRuntimeInstall: AnyCodable?
        public let terminalReason: String?
        public let terminalAtMs: Int?
        public let recoveryError: String?
        public let recoveryAction: String?
        public let retryOnSend: Bool?
    }

    public struct PlacementMove: Codable, Sendable, Hashable {
        public let target: AnyCodable
        public let updatedAtMs: Int
        public let error: String?
    }
}
