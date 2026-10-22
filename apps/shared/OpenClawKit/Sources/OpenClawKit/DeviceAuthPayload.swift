import Foundation
import OpenClawProtocol

public enum GatewayDeviceAuthPayload {
    public struct Client: Sendable {
        public let id: String
        public let mode: String

        public init(id: String, mode: String) {
            self.id = id
            self.mode = mode
        }
    }

    public struct Fields: Sendable {
        public let deviceId: String
        public let client: Client
        public let role: String
        public let scopes: [String]
        public let signedAtMs: Int64
        public let token: String?
        public let nonce: String

        public init(
            deviceId: String,
            client: Client,
            role: String,
            scopes: [String],
            signedAtMs: Int64,
            token: String?,
            nonce: String)
        {
            self.deviceId = deviceId
            self.client = client
            self.role = role
            self.scopes = scopes
            self.signedAtMs = signedAtMs
            self.token = token
            self.nonce = nonce
        }
    }

    public static func buildConnectCompatibilityPayload(
        fields: Fields) -> String
    {
        // Managed gateways deployed before v3 metadata payload support still
        // verify v2 signatures. Swift connect signers temporarily omit signed
        // metadata until managed and supported self-managed gateways verify v3.
        (["v2"] + self.components(fields)).joined(separator: "|")
    }

    public static func buildV3(
        fields: Fields,
        platform: String?,
        deviceFamily: String?) -> String
    {
        (["v3"] + self.components(fields) + [
            self.normalizeMetadataField(platform),
            self.normalizeMetadataField(deviceFamily),
        ]).joined(separator: "|")
    }

    private static func components(_ fields: Fields) -> [String] {
        [
            fields.deviceId,
            fields.client.id,
            fields.client.mode,
            fields.role,
            fields.scopes.joined(separator: ","),
            String(fields.signedAtMs),
            fields.token ?? "",
            fields.nonce,
        ]
    }

    static func normalizeMetadataField(_ value: String?) -> String {
        guard let value else { return "" }
        let trimmed = value.trimmingCharacters(in: .whitespacesAndNewlines)
        // Keep cross-runtime normalization deterministic (TS/Swift/Kotlin):
        // lowercase ASCII A-Z only for auth payload metadata fields.
        var output = String()
        output.reserveCapacity(trimmed.count)
        for scalar in trimmed.unicodeScalars {
            let codePoint = scalar.value
            if codePoint >= 65, codePoint <= 90, let lowered = UnicodeScalar(codePoint + 32) {
                output.unicodeScalars.append(lowered)
            } else {
                output.unicodeScalars.append(scalar)
            }
        }
        return output
    }

    public static func signedDeviceDictionary(
        payload: String,
        identity: DeviceIdentity,
        signedAtMs: Int64,
        nonce: String) -> [String: OpenClawProtocol.AnyCodable]?
    {
        guard let signature = DeviceIdentityStore.signPayload(payload, identity: identity),
              let publicKey = DeviceIdentityStore.publicKeyBase64Url(identity)
        else {
            return nil
        }
        return [
            "id": OpenClawProtocol.AnyCodable(identity.deviceId),
            "publicKey": OpenClawProtocol.AnyCodable(publicKey),
            "signature": OpenClawProtocol.AnyCodable(signature),
            "signedAt": OpenClawProtocol.AnyCodable(signedAtMs),
            "nonce": OpenClawProtocol.AnyCodable(nonce),
        ]
    }
}
