import Foundation
import OpenClawProtocol

struct GatewayChannelDashboardAuthContext {
    let binding: GatewayAuthBinding
    let options: GatewayConnectOptions
    let encoder: JSONEncoder
    let token: String?
    let password: String?
    let httpResourceBearer: String?
}

extension GatewayChannelActor {
    /// Startup compatibility credentials for released Control UI bundles. Only
    /// credentials selected by the current socket may cross this boundary, and
    /// device/bootstrap grants are deliberately never projected into JavaScript.
    public func controlUIDashboardLegacyCredentials(
        ifCurrentConnectionGeneration expectedGeneration: UInt64) -> [String: String]?
    {
        guard let context = self.dashboardAuthContext(ifCurrentConnectionGeneration: expectedGeneration) else {
            return nil
        }
        return GatewayChannelDashboardAuth.legacyCredentials(
            source: context.binding.source,
            options: context.options,
            token: context.token,
            password: context.password)
    }

    /// Signs a Dashboard challenge with the live operator connection's accepted
    /// credential and identity. This never reads candidate credentials from config.
    public func controlUIDashboardAuthorization(
        ifCurrentConnectionGeneration expectedGeneration: UInt64,
        scopes: [String],
        nonce: String,
        signedAtMs: Int64) throws -> Data
    {
        guard let context = self.dashboardAuthContext(ifCurrentConnectionGeneration: expectedGeneration) else {
            throw CancellationError()
        }
        let payload = try GatewayChannelDashboardAuth.authorizationPayload(
            context: context,
            scopes: scopes,
            nonce: nonce,
            signedAtMs: signedAtMs)
        return try context.encoder.encode(payload)
    }
}

enum GatewayChannelDashboardAuth {
    static func legacyCredentials(
        source: GatewayAuthSource,
        options: GatewayConnectOptions,
        token: String?,
        password: String?) -> [String: String]?
    {
        guard options.role == "operator", options.clientMode == "ui", options.includeDeviceIdentity else { return nil }
        switch source {
        case .sharedToken:
            guard let token = token?.trimmedNonEmpty else { return nil }
            return ["token": token]
        case .password:
            guard let password = password?.trimmedNonEmpty else { return nil }
            return ["password": password]
        case .deviceToken, .bootstrapToken, .none:
            return nil
        }
    }

    static func authorizationPayload(
        context: GatewayChannelDashboardAuthContext,
        scopes: [String],
        nonce: String,
        signedAtMs: Int64) throws -> [String: OpenClawProtocol.AnyCodable]
    {
        let binding = context.binding
        let options = context.options
        guard options.role == "operator", options.clientMode == "ui", options.includeDeviceIdentity,
              !nonce.isEmpty, nonce.utf8.count <= 1024, !nonce.contains("|"),
              signedAtMs > 0, signedAtMs <= 9_007_199_254_740_991,
              let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: options.deviceIdentityProfile),
              binding.deviceId == identity.deviceId
        else { throw CancellationError() }

        let credential: (auth: [String: String], signatureToken: String?)
        switch binding.source {
        case .sharedToken:
            guard let token = context.token?.trimmedNonEmpty else { throw CancellationError() }
            credential = (["token": token], token)
        case .password:
            guard let password = context.password?.trimmedNonEmpty else { throw CancellationError() }
            credential = (["password": password], nil)
        case .deviceToken, .bootstrapToken, .none:
            guard let token = context.httpResourceBearer?.trimmedNonEmpty else { throw CancellationError() }
            credential = (["deviceToken": token], token)
        }

        let fields = GatewayDeviceAuthPayload.Fields(
            deviceId: identity.deviceId,
            client: .init(id: options.clientId, mode: options.clientMode),
            role: options.role,
            scopes: scopes,
            signedAtMs: signedAtMs,
            token: credential.signatureToken,
            nonce: nonce)
        let payload = GatewayDeviceAuthPayload.buildConnectCompatibilityPayload(fields: fields)
        guard let device = GatewayDeviceAuthPayload.signedDeviceDictionary(
            payload: payload,
            identity: identity,
            signedAtMs: signedAtMs,
            nonce: nonce)
        else { throw CancellationError() }

        return [
            "client": OpenClawProtocol.AnyCodable(GatewayConnectPayload.makeClient(
                options: options,
                displayName: options.clientDisplayName ?? InstanceIdentity.displayName,
                platform: InstanceIdentity.platformString)),
            "scopes": OpenClawProtocol.AnyCodable(scopes),
            "auth": OpenClawProtocol.AnyCodable(credential.auth),
            "device": OpenClawProtocol.AnyCodable(device),
        ]
    }
}
