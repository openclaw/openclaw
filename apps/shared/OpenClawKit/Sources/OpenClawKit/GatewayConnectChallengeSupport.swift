import Foundation
import OpenClawProtocol

struct GatewayConnectChallenge: Sendable, Equatable {
    let nonce: String
    let issuedAtMs: Int64

    init(nonce: String, issuedAtMs: Int64) {
        self.nonce = nonce
        self.issuedAtMs = issuedAtMs
    }

    init?(payload: [String: OpenClawProtocol.AnyCodable]?) {
        guard let nonce = payload?["nonce"]?.value as? String else { return nil }
        let trimmed = nonce.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let rawTimestamp = payload?["ts"]?.value,
              let issuedAtMs = Self.integerMilliseconds(rawTimestamp),
              issuedAtMs >= 0
        else { return nil }
        self.init(nonce: trimmed, issuedAtMs: issuedAtMs)
    }

    private static func integerMilliseconds(_ value: Any?) -> Int64? {
        switch value {
        case let value as Int:
            Int64(exactly: value)
        case let value as Int64:
            value
        case let value as Double where value.isFinite && value.rounded() == value:
            Int64(exactly: value)
        default:
            nil
        }
    }
}
