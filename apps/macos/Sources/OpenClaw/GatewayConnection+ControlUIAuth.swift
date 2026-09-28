import Foundation
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    /// The released v2026.9.6 UI understands only shared startup credentials.
    /// Wait for native hello and project its accepted method, never saved candidates
    /// or a device grant that belongs to a different identity than that older browser.
    func controlUiLegacyCredentials(
        endpoint: EndpointSnapshot) async throws -> DashboardNativeGatewayAuth.LegacyCredentials
    {
        _ = try await self.controlUiBrowserIdentityURL(config: endpoint.config)
        guard self.includeDeviceIdentity, endpoint.browserSession == nil,
              let lease = await self.captureServerLease(),
              lease.route.matches(config: endpoint.config), lease.route.browserSession == nil,
              GatewayTLSRoute.hasSameConnectionIdentity(lease.route.tls, endpoint.tls),
              endpoint.routeAuthority == nil || endpoint.routeAuthority == lease.route.authority,
              endpoint.revision == nil || endpoint.revision == lease.endpointRevision,
              endpoint.deviceAuthGatewayID == nil || endpoint.deviceAuthGatewayID == lease.route.deviceAuthGatewayID
        else { throw CancellationError() }
        let binding = try await self.controlUiAuthBinding(ifCurrentServerLease: lease)
        guard let snapshot = self.lastSnapshot,
              snapshot.auth["role"]?.value as? String == "operator",
              await self.isCurrentServerLease(lease)
        else { throw CancellationError() }
        let method = snapshot.auth["method"].map { $0.value as? String } ??
            (binding.source == .sharedToken ? "token" : binding.source.rawValue)
        let credential = method.flatMap {
            Self.controlUiCredential(method: $0, source: binding.source, config: endpoint.config, token: nil)
        }
        let credentials: [String: String] = switch credential {
        case .token, .password: credential?.auth ?? [:]
        default: [:]
        }
        let isCurrent: @Sendable () -> Bool = { self.serverLeaseMatchesCurrentState(lease) }
        return DashboardNativeGatewayAuth.LegacyCredentials(
            credentials: credentials,
            isCurrent: isCurrent,
            waitForInvalidation: {
                // Subscribe before checking so retirement cannot fall between
                // the initial lease check and observer installation.
                let deliveries = await self.subscribe(bufferingNewest: 1)
                guard isCurrent() else { return }
                for await _ in deliveries {
                    if Task.isCancelled || !isCurrent() { return }
                }
            })
    }

    func controlUiNativeAuth(
        endpoint: EndpointSnapshot,
        nonce: String,
        signedAt: Int64) async throws -> DashboardNativeGatewayAuth
    {
        guard self.includeDeviceIdentity, endpoint.browserSession == nil,
              let lease = await self.captureServerLease(),
              lease.route.matches(config: endpoint.config),
              lease.route.browserSession == nil,
              GatewayTLSRoute.hasSameConnectionIdentity(lease.route.tls, endpoint.tls),
              endpoint.routeAuthority == nil || endpoint.routeAuthority == lease.route.authority,
              endpoint.revision == nil || endpoint.revision == lease.endpointRevision,
              endpoint.deviceAuthGatewayID == nil || endpoint.deviceAuthGatewayID == lease.route.deviceAuthGatewayID
        else { throw CancellationError() }
        let binding = try await self.controlUiAuthBinding(ifCurrentServerLease: lease)
        guard let snapshot = self.lastSnapshot,
              snapshot.auth["role"]?.value as? String == "operator",
              let scopeValues = snapshot.auth["scopes"]?.value as? [OpenClawProtocol.AnyCodable],
              let identity = DeviceIdentityStore.loadOrCreatePersisted(), binding.deviceId == identity.deviceId
        else { throw CancellationError() }
        let scopes = scopeValues.compactMap { $0.value as? String }
        guard scopes.count == scopeValues.count else { throw CancellationError() }
        let gatewayID = lease.route.deviceAuthGatewayID
        let deviceToken = gatewayID.flatMap {
            DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator", gatewayID: $0)?.token
        }
        let method: String
        if let advertised = snapshot.auth["method"] {
            guard let value = advertised.value as? String else { throw CancellationError() }
            method = value
        } else {
            // Older hello responses omit method. The socket's canonical auth
            // binding identifies its selected credential, not merely saved config.
            method = binding.source == .sharedToken ? "token" : binding.source.rawValue
        }
        guard let credential = Self.controlUiCredential(
            method: method, source: binding.source, config: endpoint.config, token: deviceToken)
        else { throw CancellationError() }
        let client = [
            "id": "openclaw-macos", "mode": "ui",
            "displayName": InstanceIdentity.displayName,
            "version": Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev",
            "platform": InstanceIdentity.platformString, "deviceFamily": InstanceIdentity.deviceFamily,
            "instanceId": InstanceIdentity.instanceId,
        ]
        let json = try DashboardNativeGatewayAuth.sign(
            identity: identity,
            credential: credential,
            scopes: scopes,
            nonce: nonce,
            signedAt: signedAt,
            client: client)
        let isCurrent: @Sendable () -> Bool = {
            guard self.serverLeaseMatchesCurrentState(lease),
                  DeviceIdentityStore.loadOrCreatePersisted()?.deviceId == identity.deviceId else { return false }
            guard case let .deviceToken(token) = credential else { return true }
            guard let gatewayID else { return false }
            // Rotation/revocation retires an already prepared reply, while a new
            // challenge can use the current grant for this same native identity.
            return DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator", gatewayID: gatewayID)?
                .token.trimmingCharacters(in: .whitespacesAndNewlines) == token
        }
        guard await self.isCurrentServerLease(lease), isCurrent() else { throw CancellationError() }
        return DashboardNativeGatewayAuth(json: json, isCurrent: isCurrent)
    }

    private static func controlUiCredential(
        method: String,
        source: GatewayAuthSource,
        config: Config,
        token: String?) -> DashboardNativeGatewayAuth.Credential?
    {
        switch method {
        case "token":
            guard source == .sharedToken else { return nil }
            return config.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty.map { .token($0) }
        case "password":
            guard source == .password else { return nil }
            return config.password?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty.map { .password($0) }
        case "device-token", "bootstrap-token", "tailscale", "trusted-proxy", "none":
            // Nonshared native authentication can authorize a reusable device
            // grant, but never permits exporting bootstrap or rejected config.
            return token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty.map { .deviceToken($0) }
        default:
            return nil
        }
    }
}
