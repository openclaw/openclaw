import Foundation
import OpenClawKit

enum MacNodeCredentialRepairError: LocalizedError {
    case endpointHasExplicitCredential
    case gatewayIdentityUnavailable
    case deviceIdentityUnavailable
    case distinctDeviceIdentity
    case operatorDeviceSessionUnavailable
    case rotationRejected
    case invalidResponse
    case routeChanged
    case persistenceFailed

    var errorDescription: String? {
        switch self {
        case .endpointHasExplicitCredential:
            "The node connection is using an explicit Gateway credential."
        case .gatewayIdentityUnavailable:
            "The Gateway identity is not available for this connection."
        case .deviceIdentityUnavailable:
            "The Mac device identity is not available."
        case .distinctDeviceIdentity:
            "The Mac node uses a different device identity and must be paired separately."
        case .operatorDeviceSessionUnavailable:
            "The operator connection is not using this device's paired credential."
        case .rotationRejected:
            "The Gateway did not reissue this device's node credential."
        case .invalidResponse:
            "The Gateway returned an invalid node credential response."
        case .routeChanged:
            "The selected Gateway changed while repairing the node credential."
        case .persistenceFailed:
            "The repaired node credential could not be saved."
        }
    }
}

enum MacNodeCredentialRepairOutcome: Equatable {
    case alreadyAvailable
    case repaired
}

@MainActor
struct MacNodeCredentialRepairer {
    private let gateway: GatewayConnection

    init(gateway: GatewayConnection = .shared) {
        self.gateway = gateway
    }

    func repair(
        endpoint: GatewayConnection.EndpointSnapshot,
        nodeIdentityProfile: GatewayDeviceIdentityProfile) async throws
        -> MacNodeCredentialRepairOutcome
    {
        guard endpoint.config.token?.nonEmpty == nil,
              endpoint.config.password?.nonEmpty == nil
        else {
            throw MacNodeCredentialRepairError.endpointHasExplicitCredential
        }
        guard let gatewayID = endpoint.deviceAuthGatewayID?.trimmingCharacters(
            in: .whitespacesAndNewlines).nonEmpty
        else {
            throw MacNodeCredentialRepairError.gatewayIdentityUnavailable
        }
        guard let operatorIdentity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
              let nodeIdentity = DeviceIdentityStore.loadOrCreatePersisted(profile: nodeIdentityProfile)
        else {
            throw MacNodeCredentialRepairError.deviceIdentityUnavailable
        }
        guard operatorIdentity.deviceId == nodeIdentity.deviceId else {
            throw MacNodeCredentialRepairError.distinctDeviceIdentity
        }
        if DeviceAuthStore.loadToken(
            deviceId: nodeIdentity.deviceId,
            role: "node",
            gatewayID: gatewayID,
            profile: nodeIdentityProfile) != nil
        {
            return .alreadyAvailable
        }

        let rotation = try await self.gateway.rotateOwnNodeToken(
            deviceID: nodeIdentity.deviceId,
            ifCurrentEndpoint: endpoint)
        try await self.gateway.persistOwnNodeToken(
            from: rotation,
            deviceID: nodeIdentity.deviceId,
            gatewayID: gatewayID,
            profile: nodeIdentityProfile,
            ifCurrentEndpoint: endpoint)
        return .repaired
    }
}
