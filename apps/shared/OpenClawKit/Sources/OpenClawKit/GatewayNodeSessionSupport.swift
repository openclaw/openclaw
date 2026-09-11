import CryptoKit
import Foundation
import OpenClawProtocol

struct NodeInvokeRequestPayload: Codable {
    var id: String
    var nodeId: String
    var command: String
    var paramsJSON: String?
    var timeoutMs: Int?
    var idempotencyKey: String?
    var sessionKey: String?
}

struct NodeInvokeCancelPayload: Codable {
    var invokeId: String
}

extension GatewayNodeSession {
    private static let staleRouteInvokeMessage = "UNAVAILABLE: node route changed before dispatch"

    enum ComputerInvokeReceiptState {
        case inFlight(Task<BridgeInvokeResponse, Never>)
        case completed(BridgeInvokeResponse)

        var isCompleted: Bool {
            if case .completed = self {
                return true
            }
            return false
        }
    }

    struct ComputerInvokeReceipt {
        let id: UUID
        let fingerprint: String
        var state: ComputerInvokeReceiptState
        var operationSettled: Bool
    }

    struct ConnectOptionsKey: Equatable {
        let normalizedInputs: String
        let deviceAuthGatewayIDBytes: [UInt8]?
    }

    struct ComputerInvokeReceiptKey: Hashable {
        let receiptScopeBytes: [UInt8]
        let idempotencyKeyBytes: [UInt8]

        init(receiptScope: String, idempotencyKey: String) {
            self.receiptScopeBytes = Array(receiptScope.utf8)
            self.idempotencyKeyBytes = Array(idempotencyKey.utf8)
        }
    }

    struct LifecycleCallbackBarrier {
        let id: UUID
        let task: Task<Void, Never>
    }

    struct ServerEventSubscriber {
        let continuation: AsyncStream<EventFrame>.Continuation
        /// Filters before buffering so unrelated traffic cannot evict awaited events.
        let matches: @Sendable (EventFrame) -> Bool
    }

    struct PluginSurfaceOwner: Sendable, Equatable {
        let route: GatewayNodeSessionRoute
        let expectedProfileId: String?

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.route == rhs.route &&
                lhs.expectedProfileId.map { Array($0.utf8) } == rhs.expectedProfileId.map { Array($0.utf8) }
        }
    }

    struct PluginSurfaceWaiter {
        let id: UUID
        let owner: PluginSurfaceOwner
        let observedURL: String?
        let cancellation: GatewayRequestCancellationGate
        let deadline: ContinuousClock.Instant?
        let continuation: CheckedContinuation<GatewayCanvasHostRoute?, Never>

        var isEligible: Bool {
            !self.cancellation.isCancelled && self.deadline.map { ContinuousClock.now < $0 } != false
        }
    }

    struct PluginSurfaceRefresh {
        let id: UUID
        let owner: PluginSurfaceOwner
        let task: Task<Void, Never>
        var waiters: [PluginSurfaceWaiter]
    }

    struct PluginSurfaceState {
        var cached: (owner: PluginSurfaceOwner, route: GatewayCanvasHostRoute)?
        var refresh: PluginSurfaceRefresh?
        var pending: [PluginSurfaceWaiter] = []
    }

    struct PluginSurfaceRefreshResponse: Decodable {
        let pluginSurfaceUrls: [String: AnyCodable]?
    }

    func connectOptionsKey(_ options: GatewayConnectOptions) -> ConnectOptionsKey {
        func sorted(_ values: [String]) -> String {
            values.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
                .sorted()
                .joined(separator: ",")
        }
        let role = options.role.trimmingCharacters(in: .whitespacesAndNewlines)
        let scopes = sorted(options.scopes)
        let caps = sorted(options.caps)
        let commands = sorted(options.commands)
        let pathEnv = options.pathEnv?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let clientId = options.clientId.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientMode = options.clientMode.trimmingCharacters(in: .whitespacesAndNewlines)
        let clientDisplayName = (options.clientDisplayName ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        let deviceIdentityProfile = options.deviceIdentityProfile.rawValue
        let includeDeviceIdentity = options.includeDeviceIdentity ? "1" : "0"
        let allowStoredDeviceAuth = options.allowStoredDeviceAuth ? "1" : "0"
        let permissions = options.permissions
            .map { key, value in
                let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
                return "\(trimmed)=\(value ? "1" : "0")"
            }
            .sorted()
            .joined(separator: ",")

        let normalizedInputs = [
            role,
            scopes,
            caps,
            commands,
            pathEnv,
            clientId,
            clientMode,
            clientDisplayName,
            deviceIdentityProfile,
            includeDeviceIdentity,
            allowStoredDeviceAuth,
            permissions,
        ].joined(separator: "|")
        return ConnectOptionsKey(
            normalizedInputs: normalizedInputs,
            deviceAuthGatewayIDBytes: options.deviceAuthGatewayID.map { Array($0.utf8) })
    }

    static func staleRouteInvokeResponse(requestId: String) -> BridgeInvokeResponse {
        BridgeInvokeResponse(
            id: requestId,
            ok: false,
            error: OpenClawNodeError(
                code: .unavailable,
                message: self.staleRouteInvokeMessage))
    }

    static func computerInvokeFingerprint(_ request: NodeInvokeRequestPayload) -> String {
        let value = [request.nodeId, request.command, request.paramsJSON ?? ""].joined(separator: "\u{0}")
        return SHA256.hash(data: Data(value.utf8))
            .map { String(format: "%02x", $0) }
            .joined()
    }

    static func rebindInvokeResponse(
        _ response: BridgeInvokeResponse,
        requestId: String) -> BridgeInvokeResponse
    {
        BridgeInvokeResponse(
            type: response.type,
            id: requestId,
            ok: response.ok,
            payload: response.payload,
            payloadJSON: response.payloadJSON,
            error: response.error)
    }

    static func isStaleRouteInvokeResponse(_ response: BridgeInvokeResponse) -> Bool {
        response.ok == false &&
            response.error?.code == .unavailable &&
            response.error?.message == self.staleRouteInvokeMessage
    }

    func decodeParamsJSON(
        _ paramsJSON: String?) throws -> [String: AnyCodable]?
    {
        guard let paramsJSON, !paramsJSON.isEmpty else { return nil }
        guard let data = paramsJSON.data(using: .utf8) else {
            throw NSError(domain: "Gateway", code: 12, userInfo: [
                NSLocalizedDescriptionKey: "paramsJSON not UTF-8",
            ])
        }
        return try JSONDecoder().decode([String: AnyCodable].self, from: data)
    }
}
