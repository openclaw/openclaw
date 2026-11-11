import Foundation

extension ShareGatewayRelaySettings {
    public static func connectOptions(
        gatewayStableID: String?,
        allowStoredDeviceAuth: Bool = true) -> GatewayConnectOptions
    {
        GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "OpenClaw Share",
            deviceIdentityProfile: .shareExtension,
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: allowStoredDeviceAuth && gatewayStableID != nil,
            deviceAuthGatewayID: gatewayStableID)
    }

    /// Enroll the extension using the paired app's existing authority, not its credentials.
    public static func prepareDeviceAuth(
        operatorGateway: GatewayNodeSession,
        url: URL,
        gatewayStableID: String,
        sessionBox: WebSocketSessionBox?) async throws
    {
        guard let route = await operatorGateway.currentRoute(ifGatewayID: gatewayStableID),
              await operatorGateway.currentOperatorScopes(ifCurrentRoute: route)?.contains("operator.admin") == true
        else { return }
        guard let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .shareExtension) else {
            throw self.pairingError("Could not securely save the sharing identity.")
        }
        // A rejected existing token may have been explicitly revoked. Never undo that
        // decision by automatically enrolling the extension again.
        guard DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: gatewayStableID,
            profile: .shareExtension) == nil
        else { return }

        let params: [String: Any] = [
            "includeQr": false,
            "bootstrapProfile": "node",
            "publicUrl": url.absoluteString,
        ]
        let data = try JSONSerialization.data(withJSONObject: params)
        let response = try await operatorGateway.request(
            method: "device.pair.setupCode",
            paramsJSON: String(bytes: data, encoding: .utf8)!,
            timeoutSeconds: 20,
            ifCurrentRoute: route)
        struct SetupCodeResponse: Decodable {
            var setupCode: String
        }
        let setup = try JSONDecoder().decode(SetupCodeResponse.self, from: response)
        guard let bootstrapToken = GatewayConnectDeepLink.fromSetupCode(setup.setupCode)?.bootstrapToken else {
            throw self.pairingError("The Gateway did not provide a sharing setup credential.")
        }
        try Task.checkCancellation()
        guard await operatorGateway.currentRoute(ifGatewayID: gatewayStableID) == route else {
            throw CancellationError()
        }

        let shareGateway = GatewayNodeSession()
        do {
            // Reuse the authenticated route and its TLS policy, never a setup response's endpoint.
            // Only the resulting gateway-scoped node token is persisted in the shared profile.
            try await shareGateway.connect(
                url: url,
                credentials: GatewayNodeSessionCredentials(bootstrapToken: bootstrapToken),
                connectOptions: self.connectOptions(
                    gatewayStableID: gatewayStableID,
                    allowStoredDeviceAuth: false),
                sessionBox: sessionBox,
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: false) })
            let roles = await shareGateway.currentDeviceAuthRoles()
            guard roles.persisted.contains("node") else {
                throw self.pairingError("Could not securely save Gateway access for sharing.")
            }
            await shareGateway.disconnect()
        } catch {
            await shareGateway.disconnect()
            throw error
        }
    }

    private static func pairingError(_ message: String) -> NSError {
        NSError(domain: "OpenClawShare", code: 13, userInfo: [NSLocalizedDescriptionKey: message])
    }
}
