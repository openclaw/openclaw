import CryptoKit
import Foundation
import OpenClawProtocol

/// Account facts from one captured connection, never inferred from transport or HTTP failures.
public enum GatewayProfileBindingObservation: Sendable, Equatable {
    case verified(profileID: String)
    case rejected(expectedProfileID: String)

    public static func rejection(from error: Error, expectedProfileID: String?) -> Self? {
        guard let expectedProfileID, let response = error as? GatewayResponseError,
              response.detailsReason == "EXPECTED_PROFILE_MISMATCH" else { return nil }
        return .rejected(expectedProfileID: expectedProfileID)
    }
}

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
    /// Keeps the flat overload source-compatible while credentials remain one reconnect identity.
    public func connect(
        url: URL,
        token: String? = nil,
        bootstrapToken: String? = nil,
        password: String? = nil,
        connectOptions: GatewayConnectOptions,
        sessionBox: WebSocketSessionBox?,
        extraHeadersProvider: (@Sendable () -> [String: String])? = nil,
        onConnected: @escaping @Sendable () async -> Void,
        onDisconnected: @escaping @Sendable (String) async -> Void,
        onInvoke: @escaping @Sendable (BridgeInvokeRequest) async -> BridgeInvokeResponse,
        onInvokeInput: (@Sendable (NodeInvokeInputEvent) async -> Void)? = nil,
        onInvokeCancel: (@Sendable (String) async -> Void)? = nil,
        onRouteInvalidated: (@Sendable () async -> Void)? = nil) async throws
    {
        try await self.connect(
            url: url,
            credentials: GatewayNodeSessionCredentials(
                token: token,
                bootstrapToken: bootstrapToken,
                password: password),
            connectOptions: connectOptions,
            sessionBox: sessionBox,
            extraHeadersProvider: extraHeadersProvider,
            onConnected: onConnected,
            onDisconnected: onDisconnected,
            onInvoke: onInvoke,
            onInvokeInput: onInvokeInput,
            onInvokeCancel: onInvokeCancel,
            onRouteInvalidated: onRouteInvalidated)
    }

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

    struct PluginSurfaceCaller: Sendable {
        let id: UUID
        let cancellation: GatewayRequestCancellationGate
        let deadline: ContinuousClock.Instant?
        let profileObservationID: UUID?
        let onProfileObservation: @Sendable (GatewayProfileBindingObservation) -> Void

        var isEligible: Bool {
            !self.cancellation.isCancelled && self.deadline.map { ContinuousClock.now < $0 } != false
        }
    }

    struct PluginSurfaceWaiter {
        let owner: PluginSurfaceOwner
        let observedURL: String?
        let caller: PluginSurfaceCaller
        let continuation: CheckedContinuation<GatewayCanvasHostRoute?, Never>

        var isEligible: Bool {
            self.caller.isEligible
        }
    }

    struct PluginSurfaceRefresh {
        let id: UUID
        let owner: PluginSurfaceOwner
        let profileObservationID: UUID?
        let task: Task<Void, Never>
        var waiters: [PluginSurfaceWaiter]
    }

    struct PluginSurfaceState {
        var cached: (owner: PluginSurfaceOwner, route: GatewayCanvasHostRoute)?
        var refresh: PluginSurfaceRefresh?
        var pending: [PluginSurfaceWaiter] = []

        mutating func removeJoiningWaiters(for waiter: PluginSurfaceWaiter) -> [PluginSurfaceWaiter] {
            // Cache authority may survive a fresh capture, but an in-flight
            // account rejection belongs only to its captured caller lifetime.
            let joins = { (candidate: PluginSurfaceWaiter) in
                candidate.owner == waiter.owner &&
                    candidate.caller.profileObservationID == waiter.caller.profileObservationID
            }
            let waiters = self.pending.filter(joins)
            self.pending.removeAll(where: joins)
            return waiters
        }

        mutating func finishRefresh(
            _ refresh: PluginSurfaceRefresh,
            route: GatewayCanvasHostRoute?,
            ownerIsCurrent: Bool)
        {
            if let route, ownerIsCurrent, refresh.waiters.contains(where: \.isEligible) {
                self.cached = (refresh.owner, route)
            }
            self.refresh = nil
        }

        mutating func releaseWaiter(_ id: UUID?) {
            self.pending.removeAll { waiter in
                guard waiter.caller.id == id || !waiter.isEligible else { return false }
                waiter.continuation.resume(returning: nil)
                return true
            }
            if var refresh = self.refresh {
                refresh.waiters.removeAll { waiter in
                    guard waiter.caller.id == id || !waiter.isEligible else { return false }
                    waiter.continuation.resume(returning: nil)
                    return true
                }
                if refresh.waiters.isEmpty {
                    refresh.task.cancel()
                    self.refresh = nil
                } else {
                    self.refresh = refresh
                }
            }
        }

        func cancelAll() {
            self.refresh?.task.cancel()
            for waiter in (self.refresh?.waiters ?? []) + self.pending {
                waiter.continuation.resume(returning: nil)
            }
        }
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
