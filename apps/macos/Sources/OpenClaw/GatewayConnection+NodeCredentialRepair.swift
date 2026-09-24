import Foundation
import OpenClawKit
import OpenClawProtocol

extension GatewayConnection {
    struct NodeTokenRotation: Sendable {
        fileprivate let lease: ServerLease
        fileprivate let result: DeviceTokenRotateResult
    }

    /// Rotate this operator device's node credential on the exact connected Gateway.
    /// The server returns the token only when the device-token-authenticated caller
    /// owns `deviceID`; callers must still validate and persist the bounded result.
    func rotateOwnNodeToken(
        deviceID: String,
        ifCurrentEndpoint endpoint: EndpointSnapshot) async throws -> NodeTokenRotation
    {
        guard let lease = await self.captureServerLease(),
              lease.matches(endpoint),
              let authBinding = await lease.authBinding(),
              authBinding.source == .deviceToken,
              await self.isCurrentServerLease(lease)
        else {
            throw MacNodeCredentialRepairError.operatorDeviceSessionUnavailable
        }

        let decoder = JSONDecoder()
        let encodedParams = try JSONEncoder().encode(DeviceTokenRotateParams(
            deviceid: deviceID,
            role: "node",
            scopes: []))
        let params = try decoder.decode([String: AnyCodable].self, from: encodedParams)
        let data: Data
        do {
            data = try await self.request(
                method: Method.deviceTokenRotate.rawValue,
                params: params,
                timeoutMs: 15000,
                ifCurrentServerLease: lease)
        } catch is CancellationError {
            throw MacNodeCredentialRepairError.routeChanged
        } catch {
            throw MacNodeCredentialRepairError.rotationRejected
        }

        guard lease.matches(endpoint),
              await self.isCurrentServerLease(lease)
        else {
            throw MacNodeCredentialRepairError.routeChanged
        }
        do {
            return try NodeTokenRotation(
                lease: lease,
                result: decoder.decode(DeviceTokenRotateResult.self, from: data))
        } catch {
            throw MacNodeCredentialRepairError.invalidResponse
        }
    }

    /// Revalidate the exact operator lease after the caller's suspension, then
    /// validate and persist the returned credential without another suspension.
    func persistOwnNodeToken(
        from rotation: NodeTokenRotation,
        deviceID: String,
        gatewayID: String,
        profile: GatewayDeviceIdentityProfile,
        ifCurrentEndpoint endpoint: EndpointSnapshot) async throws
    {
        guard rotation.lease.matches(endpoint),
              await self.isCurrentServerLease(rotation.lease)
        else {
            throw MacNodeCredentialRepairError.routeChanged
        }
        let result = rotation.result
        guard result.deviceid == deviceID,
              result.role == "node",
              result.scopes.isEmpty,
              result.tokendelivery == nil || result.tokendelivery == "in-band",
              let token = result.token?.trimmingCharacters(in: .whitespacesAndNewlines).nonEmpty
        else {
            throw MacNodeCredentialRepairError.invalidResponse
        }
        guard DeviceAuthStore.storeTokenPersisted(
            deviceId: deviceID,
            role: "node",
            token: token,
            scopes: [],
            gatewayID: gatewayID,
            profile: profile)
        else {
            throw MacNodeCredentialRepairError.persistenceFailed
        }
    }
}
