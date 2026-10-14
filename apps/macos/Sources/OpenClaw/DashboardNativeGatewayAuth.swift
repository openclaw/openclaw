import CoreFoundation
import Foundation
import OpenClawKit
import OpenClawProtocol

/// A challenge response belongs to one live native socket, never to a browser identity.
struct DashboardNativeGatewayAuth: Sendable {
    typealias Provider = @Sendable (String, Int64) async throws -> Self

    /// The released UI startup projection retains its exact socket owner.
    struct LegacyCredentials: Sendable {
        let credentials: [String: String]
        let isCurrent: @Sendable () -> Bool
        let waitForInvalidation: (@Sendable () async -> Void)?
    }

    enum Credential: Equatable, Sendable {
        case token(String)
        case password(String)
        case deviceToken(String)

        var signatureToken: String? {
            switch self {
            case let .token(value), let .deviceToken(value): value
            case .password: nil
            }
        }

        var auth: [String: String] {
            switch self {
            case let .token(value): ["token": value]
            case let .password(value): ["password": value]
            case let .deviceToken(value): ["deviceToken": value]
            }
        }
    }

    let json: Data
    let isCurrent: @Sendable () -> Bool

    static func sign(
        identity: DeviceIdentity,
        credential: Credential,
        scopes: [String],
        nonce: String,
        signedAt: Int64,
        client: [String: String]) throws -> Data
    {
        let fields = GatewayDeviceAuthPayload.Fields(
            deviceId: identity.deviceId,
            client: .init(id: "openclaw-macos", mode: "ui"),
            role: "operator",
            scopes: scopes,
            signedAtMs: signedAt,
            token: credential.signatureToken,
            nonce: nonce)
        // Match the canonical native connection's compatibility payload.
        let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(fields: fields)
        guard let device = GatewayDeviceAuthPayload.signedDeviceDictionary(
            payload: payload, identity: identity, signedAtMs: signedAt, nonce: nonce)
        else { throw CancellationError() }
        let result: [String: OpenClawProtocol.AnyCodable] = [
            "client": .init(client),
            "scopes": .init(scopes),
            "auth": .init(credential.auth),
            "device": .init(device),
        ]
        return try JSONEncoder().encode(result)
    }
}

struct DashboardNativeGatewayAuthRequest {
    let id: String
    let nonce: String
    let signedAt: Int64

    init?(_ body: Any) {
        // The challenge uses the server clock. Validate representation here;
        // the gateway owns nonce and freshness checks even when this Mac is skewed.
        guard let value = body as? [String: Any],
              Set(value.keys) == ["id", "nonce", "signedAt"],
              let id = value["id"] as? String, !id.isEmpty, id.utf8.count <= 128,
              let nonce = value["nonce"] as? String, !nonce.isEmpty, nonce.utf8.count <= 1024,
              !nonce.contains("|"),
              let timestamp = value["signedAt"] as? NSNumber,
              CFGetTypeID(timestamp) != CFBooleanGetTypeID(),
              timestamp.doubleValue.isFinite,
              timestamp.doubleValue.rounded() == timestamp.doubleValue,
              timestamp.doubleValue > 0, timestamp.doubleValue <= 9_007_199_254_740_991
        else { return nil }
        self.id = id
        self.nonce = nonce
        self.signedAt = timestamp.int64Value
    }
}
