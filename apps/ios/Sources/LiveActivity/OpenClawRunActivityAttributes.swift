import ActivityKit
import Foundation

/// Captured selectors, never credentials or authority. The manager must verify
/// the live owner before registering or opening this exact run.
struct OpenClawRunActivityAttributes: ActivityAttributes, Hashable, Sendable {
    static let maximumActivityBytes = 4096
    static let maximumContentBytes = 2048

    let gatewayId: String
    let gatewayDeviceId: String
    let deviceId: String
    let profileId: String
    let agentId: String
    let sessionKey: String
    let sessionId: String
    let runId: String

    enum ValidationError: Error, Equatable {
        case invalidIdentity
        case invalidContent
        case payloadTooLarge
    }

    init(
        gatewayId: String,
        gatewayDeviceId: String,
        deviceId: String,
        profileId: String,
        agentId: String,
        sessionKey: String,
        sessionId: String,
        runId: String) throws
    {
        self.gatewayId = gatewayId
        self.gatewayDeviceId = gatewayDeviceId
        self.deviceId = deviceId
        self.profileId = profileId
        self.agentId = agentId
        self.sessionKey = sessionKey
        self.sessionId = sessionId
        self.runId = runId

        let limits = [256, 256, 256, 128, 64, 512, 128, 256]
        guard zip(self.identityValues, limits).allSatisfy({ Self.boundedNonblank($0.0, maximum: $0.1) }),
              agentId.range(of: #"\A[A-Za-z0-9][A-Za-z0-9_-]{0,63}\z"#, options: .regularExpression) != nil
        else {
            throw ValidationError.invalidIdentity
        }
        // Attributes cannot shrink after creation. Reserve the entire server
        // content budget now, counting JSON escapes and UTF-8 bytes, not scalars.
        guard try JSONEncoder().encode(self).count <= Self.maximumActivityBytes - Self.maximumContentBytes else {
            throw ValidationError.payloadTooLarge
        }
    }

    private enum CodingKeys: String, CodingKey {
        case gatewayId, gatewayDeviceId, deviceId, profileId, agentId, sessionKey, sessionId, runId
    }

    init(from decoder: Decoder) throws {
        let fields = try decoder.container(keyedBy: CodingKeys.self)
        try self.init(
            gatewayId: fields.decode(String.self, forKey: .gatewayId),
            gatewayDeviceId: fields.decode(String.self, forKey: .gatewayDeviceId),
            deviceId: fields.decode(String.self, forKey: .deviceId),
            profileId: fields.decode(String.self, forKey: .profileId),
            agentId: fields.decode(String.self, forKey: .agentId),
            sessionKey: fields.decode(String.self, forKey: .sessionKey),
            sessionId: fields.decode(String.self, forKey: .sessionId),
            runId: fields.decode(String.self, forKey: .runId))
    }

    private var identityValues: [String] {
        [
            self.gatewayId, self.gatewayDeviceId, self.deviceId, self.profileId,
            self.agentId, self.sessionKey, self.sessionId, self.runId,
        ]
    }

    /// Match NativeActions UTF-8 identity without linking the full app package
    /// into the widget. Swift String equality merges distinct Unicode spellings.
    static func == (lhs: Self, rhs: Self) -> Bool {
        zip(lhs.identityValues, rhs.identityValues).allSatisfy { $0.0.utf8.elementsEqual($0.1.utf8) }
    }

    func hash(into hasher: inout Hasher) {
        for value in self.identityValues {
            hasher.combine(Data(value.utf8))
        }
    }

    private static func boundedNonblank(_ value: String, maximum: Int) -> Bool {
        let scalars = value.unicodeScalars
        // Activity destinations also require the store's ASCII-control exclusion.
        guard !scalars.isEmpty, scalars.count <= maximum,
              !scalars.contains(where: { $0.value <= 0x001F })
        else { return false }
        return scalars.contains {
            // Same ECMAScript whitespace contract as NativeSessionStatus.
            switch $0.value {
            case 0x0009...0x000D, 0x0020, 0x00A0, 0x1680, 0x2000...0x200A,
                 0x2028, 0x2029, 0x202F, 0x205F, 0x3000, 0xFEFF:
                false
            default:
                true
            }
        }
    }

    struct ContentState: Codable, Hashable, Sendable {
        enum Status: String, Codable, CaseIterable, Hashable, Sendable {
            case running, toolRunning, approvalNeeded, completed, failed, cancelled, timedOut

            var isTerminal: Bool {
                switch self {
                case .running, .toolRunning, .approvalNeeded: false
                case .completed, .failed, .cancelled, .timedOut: true
                }
            }
        }

        enum Presentation: Equatable, Sendable {
            case status(Status)
            case updateDelayed
        }

        let status: Status
        let observedAt: Date
        let startedAt: Date?
        let endedAt: Date?

        init(status: Status, observedAt: Date, startedAt: Date? = nil, endedAt: Date? = nil) throws {
            guard Self.validDate(observedAt),
                  startedAt.map({ Self.validDate($0) && $0 <= observedAt }) ?? true,
                  endedAt.map({ end in
                      status.isTerminal && Self.validDate(end) && end <= observedAt &&
                          (startedAt.map { $0 <= end } ?? true)
                  }) ?? true
            else {
                throw ValidationError.invalidContent
            }
            self.status = status
            self.observedAt = observedAt
            self.startedAt = startedAt
            self.endedAt = endedAt
            guard try JSONEncoder().encode(self).count <= OpenClawRunActivityAttributes.maximumContentBytes else {
                throw ValidationError.payloadTooLarge
            }
        }

        private enum CodingKeys: String, CodingKey {
            case status, observedAt, startedAt, endedAt
        }

        init(from decoder: Decoder) throws {
            let fields = try decoder.container(keyedBy: CodingKeys.self)
            // Use Date's default Apple-reference-epoch codec. APNs envelope
            // timestamps are Unix seconds and never enter this content shape.
            try self.init(
                status: fields.decode(Status.self, forKey: .status),
                observedAt: fields.decode(Date.self, forKey: .observedAt),
                startedAt: fields.contains(.startedAt) ? fields.decode(Date.self, forKey: .startedAt) : nil,
                endedAt: fields.contains(.endedAt) ? fields.decode(Date.self, forKey: .endedAt) : nil)
        }

        func presentation(isStale: Bool) -> Presentation {
            isStale && !self.status.isTerminal ? .updateDelayed : .status(self.status)
        }

        private static func validDate(_ date: Date) -> Bool {
            let seconds = date.timeIntervalSince1970
            return seconds.isFinite && seconds >= 0 && seconds <= 9_007_199_254_740_991 / 1000.0
        }
    }
}
