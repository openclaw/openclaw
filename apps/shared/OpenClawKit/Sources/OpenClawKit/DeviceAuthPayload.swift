import Foundation
import OpenClawMobileCore
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
        OpenClawMobileCore.DeviceAuthPayload.shared.buildV2(
            deviceId: fields.deviceId,
            clientId: fields.client.id,
            clientMode: fields.client.mode,
            role: fields.role,
            scopes: fields.scopes,
            signedAtMs: fields.signedAtMs,
            token: fields.token,
            nonce: fields.nonce)
    }

    /// Keeps the flat overload source-compatible while `Fields` owns canonical serialization.
    public static func buildConnectCompatibilityPayload(
        deviceId: String,
        clientId: String,
        clientMode: String,
        role: String,
        scopes: [String],
        signedAtMs: Int64,
        token: String? = nil,
        nonce: String) -> String
    {
        self.buildConnectCompatibilityPayload(fields: Fields(
            deviceId: deviceId,
            client: Client(id: clientId, mode: clientMode),
            role: role,
            scopes: scopes,
            signedAtMs: signedAtMs,
            token: token,
            nonce: nonce))
    }

    public static func buildV3(
        fields: Fields,
        platform: String?,
        deviceFamily: String?) -> String
    {
        OpenClawMobileCore.DeviceAuthPayload.shared.buildV3(
            deviceId: fields.deviceId,
            clientId: fields.client.id,
            clientMode: fields.client.mode,
            role: fields.role,
            scopes: fields.scopes,
            signedAtMs: fields.signedAtMs,
            token: fields.token,
            nonce: fields.nonce,
            platform: platform,
            deviceFamily: deviceFamily)
    }

    /// Keeps the flat overload source-compatible while `Fields` owns canonical serialization.
    public static func buildV3(
        deviceId: String,
        clientId: String,
        clientMode: String,
        role: String,
        scopes: [String],
        signedAtMs: Int64,
        token: String? = nil,
        nonce: String,
        platform: String? = nil,
        deviceFamily: String? = nil) -> String
    {
        self.buildV3(
            fields: Fields(
                deviceId: deviceId,
                client: Client(id: clientId, mode: clientMode),
                role: role,
                scopes: scopes,
                signedAtMs: signedAtMs,
                token: token,
                nonce: nonce),
            platform: platform,
            deviceFamily: deviceFamily)
    }

    static func normalizeMetadataField(_ value: String?) -> String {
        OpenClawMobileCore.DeviceAuthPayload.shared.normalizeMetadataField(value: value)
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
