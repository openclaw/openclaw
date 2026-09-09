import Foundation
import OpenClawProtocol

public enum GatewayOperatorHTTPError: LocalizedError, Sendable {
    case invalidEndpoint
    case pairingRequired
    case invalidContract
    case capacityExceeded
    case disconnected
    case remote(code: String, message: String)
    case rpc(ErrorShape)
    case resultUnknown(method: String, requestID: String)

    public var errorDescription: String? {
        switch self {
        case .invalidEndpoint:
            "A trusted HTTPS Gateway URL without credentials is required."
        case .pairingRequired:
            "Watch setup is incomplete. Pair again to authorize direct access."
        case .invalidContract:
            "The Gateway connection could not be verified. Reconnect and refresh."
        case .capacityExceeded:
            "The direct connection reached its limit. Refresh before continuing."
        case .disconnected:
            "The direct connection ended. Reconnect to refresh."
        case let .remote(_, message):
            message
        case let .rpc(error):
            error.message
        case .resultUnknown:
            "Delivery uncertain. Check the original conversation before sending again."
        }
    }
}

/// One foreground logical connection; reconnect and application state belong to its caller.
public actor GatewayOperatorHTTPSession {
    public typealias ResponseConsumer = @Sendable (ResponseFrame, @Sendable () -> Bool) async throws -> Void
    public typealias EventConsumer = @Sendable (EventFrame, @Sendable () -> Bool) async throws -> Void

    public static let allowedScopes: Set<String> = [
        "operator.read", "operator.write", "operator.approvals", "operator.talk",
    ]

    private struct Limits: Decodable, Sendable {
        let maxPreauthPayloadBytes: Int
        let maxPayloadBytes: Int
        let maxBufferedBytes: Int
        let maxQueuedFrames: Int
        let maxBatchFrames: Int
        let maxPollWaitMs: Int
        let idleTimeoutMs: Int
        let maxConnections: Int
    }

    private struct Challenge: Decodable, Sendable, Equatable {
        let nonce: String
        let ts: Int64
    }

    private struct Begin: Decodable, Sendable {
        let connectionId: String
        let connectionKey: String
        let challenge: Challenge
        let handshakeExpiresAtMs: Int64
        let limits: Limits
    }

    private struct Accepted: Decodable {
        let acceptedClientSeq: Int
    }

    private struct Poll: Decodable, Sendable {
        struct Delivery: Decodable, Sendable {
            let cursor: Int
            let frame: GatewayFrame
        }

        struct Closed: Decodable, Sendable {
            let code: Int
            let reason: String
            let resyncRequired: Bool
        }

        let acceptedClientSeq: Int
        let frames: [Delivery]
        let closed: Closed?
    }

    private struct Rejection: Decodable {
        struct Detail: Decodable {
            let code: String
            let message: String
            let resyncRequired: Bool?
        }

        let error: Detail
    }

    private struct Connection: Sendable {
        let generation: UUID
        let begin: Begin
        let url: URL
        let http: GatewayTLSPinningSession
        let cancellation: GatewayRequestCancellationGate
    }

    private struct Pending {
        let requestID: String
        let frame: Data
        let method: String
        let consume: ResponseConsumer
        let continuation: CheckedContinuation<ResponseFrame, any Error>
        let timeout: Task<Void, Never>
        let cancellation: GatewayRequestCancellationGate
        var submitted = false
    }

    // These are client memory bounds, not negotiated permissions or persisted settings.
    private static let maximumFrameBytes = 1024 * 1024
    private static let maximumResponseBytes = 8 * 1024 * 1024
    private static let maximumPendingRequests = 16
    private let endpoint: URL
    private let gatewayID: String
    private let makeHTTP: @Sendable () -> GatewayTLSPinningSession
    private var generation = UUID()
    private var connection: Connection?
    private var beginTask: Task<Begin, any Error>?
    private var pumpTask: Task<Void, Never>?
    private var pollTask: Task<Poll, any Error>?
    private var pollInterrupted = false
    private var cleanupTask: Task<Void, Never>?
    private var pending: [Data: Pending] = [:]
    private var outgoing: [Data] = []
    private var pendingBytes = 0
    private var clientSeq = 0
    private var acknowledgedCursor = 0
    private var connected = false
    private var consumeEvent: EventConsumer?
    private var onClosed: (@Sendable (any Error) async -> Void)?

    public init(endpoint: URL, gatewayID: String) throws {
        try self.init(endpoint: endpoint, gatewayID: gatewayID, makeHTTP: {
            GatewayTLSPinningSession(
                params: .init(required: true, expectedFingerprint: nil, allowTOFU: false, storeKey: nil),
                allowsRedirects: false,
                allowsStoredCredentials: false)
        })
    }

    init(
        endpoint: URL,
        gatewayID: String,
        makeHTTP: @escaping @Sendable () -> GatewayTLSPinningSession) throws
    {
        guard endpoint.scheme == "https", endpoint.host?.isEmpty == false,
              endpoint.user == nil, endpoint.password == nil,
              endpoint.query == nil, endpoint.fragment == nil, !gatewayID.isEmpty
        else { throw GatewayOperatorHTTPError.invalidEndpoint }
        self.endpoint = endpoint
        self.gatewayID = gatewayID
        self.makeHTTP = makeHTTP
    }

    public func connect(
        options: GatewayConnectOptions,
        consumeHello: @escaping @Sendable (HelloOk, @Sendable () -> Bool) async throws -> Void,
        consumeEvent: @escaping EventConsumer,
        onClosed: @escaping @Sendable (any Error) async -> Void) async throws -> HelloOk
    {
        guard self.connection == nil, self.beginTask == nil,
              options.role == "operator", options.deviceIdentityProfile == .primary,
              options.deviceAuthGatewayID?.utf8.elementsEqual(self.gatewayID.utf8) == true,
              !options.scopes.isEmpty,
              Set(options.scopes).count == options.scopes.count,
              Set(options.scopes).isSubset(of: Self.allowedScopes),
              let identity = DeviceIdentityStore.loadOrCreatePersisted(profile: .primary),
              let stored = DeviceAuthStore.loadToken(
                  deviceId: identity.deviceId, role: "operator", gatewayID: self.gatewayID, profile: .primary),
              !stored.token.isEmpty, Set(options.scopes).isSubset(of: Set(stored.scopes))
        else { throw GatewayOperatorHTTPError.pairingRequired }

        let generation = UUID()
        self.generation = generation
        let http = self.makeHTTP()
        let url = self.endpoint.appendingPathComponent("api/operator/connections")
        let beginTask = Task {
            let data = try await Self.exchange(
                http: http,
                url: url,
                method: "POST",
                key: nil,
                body: Data("{}".utf8),
                expectedResponse: (status: 201, maximumBytes: 16384),
                timeout: 10)
            return try JSONDecoder().decode(Begin.self, from: data)
        }
        self.beginTask = beginTask
        do {
            let begin = try await withTaskCancellationHandler {
                try await beginTask.value
            } onCancel: {
                beginTask.cancel()
            }
            guard self.generation == generation else { throw CancellationError() }
            self.beginTask = nil
            guard UUID(uuidString: begin.connectionId) != nil,
                  begin.connectionKey.utf8.count == 43,
                  begin.connectionKey.utf8.allSatisfy({
                      (65...90).contains($0) || (97...122).contains($0) || (48...57).contains($0)
                          || $0 == 45 || $0 == 95
                  }),
                  !begin.challenge.nonce.isEmpty, begin.challenge.ts >= 0,
                  begin.handshakeExpiresAtMs > Int64(Date().timeIntervalSince1970 * 1000),
                  begin.limits.maxPreauthPayloadBytes > 0, begin.limits.maxPayloadBytes > 0,
                  begin.limits.maxBufferedBytes > 0, begin.limits.maxBatchFrames > 0,
                  begin.limits.maxPollWaitMs > 0
            else { throw GatewayOperatorHTTPError.invalidContract }
            let connection = Connection(
                generation: generation,
                begin: begin,
                url: url.appendingPathComponent(begin.connectionId),
                http: http,
                cancellation: GatewayRequestCancellationGate())
            self.connection = connection
            self.consumeEvent = consumeEvent
            self.onClosed = onClosed
            self.clientSeq = 0
            self.acknowledgedCursor = 0

            let client = GatewayConnectPayload.makeClient(
                options: options,
                displayName: options.clientDisplayName ?? "OpenClaw Watch",
                platform: InstanceIdentity.platformString)
            let fields = GatewayDeviceAuthPayload.Fields(
                deviceId: identity.deviceId,
                client: .init(id: options.clientId, mode: options.clientMode),
                role: "operator",
                scopes: options.scopes,
                signedAtMs: begin.challenge.ts,
                token: stored.token,
                nonce: begin.challenge.nonce)
            let signaturePayload = GatewayDeviceAuthPayload.buildV3(
                fields: fields,
                platform: InstanceIdentity.platformString,
                deviceFamily: InstanceIdentity.deviceFamily)
            guard let device = GatewayDeviceAuthPayload.signedDeviceDictionary(
                payload: signaturePayload,
                identity: identity,
                signedAtMs: begin.challenge.ts,
                nonce: begin.challenge.nonce)
            else { throw GatewayOperatorHTTPError.pairingRequired }
            let params = ConnectParams(
                minprotocol: GATEWAY_PROTOCOL_VERSION,
                maxprotocol: GATEWAY_PROTOCOL_VERSION,
                client: client,
                caps: [],
                role: "operator",
                scopes: options.scopes,
                device: device,
                auth: ["deviceToken": AnyCodable(stored.token)])
            let response = try await self.enqueue(
                method: "connect",
                params: Self.codableValue(params),
                timeoutMs: Int(min(30000, begin.handshakeExpiresAtMs - begin.challenge.ts)))
            { response, isCurrent in
                guard response.ok else { return }
                let hello = try Self.payload(HelloOk.self, from: response)
                guard hello.type == "hello-ok", hello._protocol == GATEWAY_PROTOCOL_VERSION,
                      hello.server["connId"]?.stringValue?.utf8.elementsEqual(begin.connectionId.utf8) == true,
                      hello.auth["method"]?.stringValue == "device-token",
                      hello.auth["role"]?.stringValue == "operator",
                      let rawScopes = hello.auth["scopes"]?.arrayValue,
                      rawScopes.allSatisfy({ $0.stringValue != nil }),
                      Set(rawScopes.compactMap(\.stringValue)) == Set(options.scopes)
                else { throw GatewayOperatorHTTPError.invalidContract }
                // HTTP hello never rotates credentials. Only the explicit scope-upgrade
                // response can propose a new grant, through its durable response consumer.
                try await consumeHello(hello, isCurrent)
            }
            try self.requireCurrent(connection)
            self.connected = true
            return try Self.payload(HelloOk.self, from: response)
        } catch {
            if self.generation == generation {
                self.retire(error)
            }
            http.finishTasksAndInvalidate()
            throw error
        }
    }

    /// `consume` commits presentation or durable credential state before the output cursor advances.
    /// It must not await another RPC on this connection.
    @discardableResult
    public func request(
        method: String,
        params: AnyCodable? = nil,
        timeoutMs: Int = 30000,
        consume: @escaping ResponseConsumer) async throws -> ResponseFrame
    {
        guard self.connected, method != "connect" else { throw GatewayOperatorHTTPError.disconnected }
        return try await self.enqueue(method: method, params: params, timeoutMs: timeoutMs, consume: consume)
    }

    public func disconnect() async {
        let pump = self.pumpTask
        self.retire(GatewayOperatorHTTPError.disconnected, notify: false)
        await pump?.value
        await self.cleanupTask?.value
    }

    private func enqueue(
        method: String,
        params: AnyCodable?,
        timeoutMs: Int,
        consume: @escaping ResponseConsumer) async throws -> ResponseFrame
    {
        guard let connection = self.connection, timeoutMs > 0, timeoutMs <= 120_000 else {
            throw GatewayOperatorHTTPError.disconnected
        }
        let id = UUID().uuidString
        let key = Data(id.utf8)
        let cancellation = GatewayRequestCancellationGate()
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys, .withoutEscapingSlashes]
        let frame = try encoder.encode(RequestFrame(type: "req", id: id, method: method, params: params))
        let limit = self.connected
            ? connection.begin.limits.maxPayloadBytes : connection.begin.limits.maxPreauthPayloadBytes
        guard frame.count <= min(limit, Self.maximumFrameBytes),
              self.pendingBytes + frame.count <= Self.maximumFrameBytes,
              self.pending.count < Self.maximumPendingRequests
        else { throw GatewayOperatorHTTPError.capacityExceeded }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await withCheckedThrowingContinuation { continuation in
                guard !cancellation.isCancelled else {
                    continuation.resume(throwing: CancellationError())
                    return
                }
                let timeout = Task {
                    do {
                        try await Task.sleep(for: .milliseconds(timeoutMs))
                        self.cancelRequest(key, generation: connection.generation)
                    } catch {}
                }
                self.pending[key] = Pending(
                    requestID: id,
                    frame: frame,
                    method: method,
                    consume: consume,
                    continuation: continuation,
                    timeout: timeout,
                    cancellation: cancellation)
                self.pendingBytes += frame.count
                self.outgoing.append(key)
                // Interrupt only the read. The pump joins it before changing ACK or sending a frame.
                if let pollTask = self.pollTask {
                    self.pollInterrupted = true
                    pollTask.cancel()
                }
                if self.pumpTask == nil {
                    self.pumpTask = Task { await self.pump(connection) }
                }
            }
        } onCancel: {
            cancellation.cancel()
            Task { await self.cancelRequest(key, generation: connection.generation) }
        }
    }

    private func cancelRequest(_ key: Data, generation: UUID) {
        guard self.generation == generation, let request = self.pending[key] else { return }
        request.cancellation.cancel()
        if request.submitted {
            self.retire(GatewayOperatorHTTPError.resultUnknown(
                method: request.method, requestID: request.requestID))
        } else {
            self.outgoing.removeAll { $0 == key }
            self.removePending(key)?.continuation.resume(throwing: CancellationError())
        }
    }

    private func removePending(_ key: Data) -> Pending? {
        guard let request = self.pending.removeValue(forKey: key) else { return nil }
        self.pendingBytes -= request.frame.count
        request.timeout.cancel()
        return request
    }

    private func pump(_ connection: Connection) async {
        do {
            while true {
                try self.requireCurrent(connection)
                while let key = self.outgoing.first {
                    self.outgoing.removeFirst()
                    guard let request = self.pending[key] else { continue }
                    guard !request.cancellation.isCancelled else {
                        self.removePending(key)?.continuation.resume(throwing: CancellationError())
                        continue
                    }
                    self.pending[key]?.submitted = true
                    self.clientSeq += 1
                    // Freeze the frame bytes and sequence. A transport retry is never a new RPC.
                    var body = Data("{\"clientSeq\":\(self.clientSeq),\"ack\":\(self.acknowledgedCursor),\"frame\":"
                        .utf8)
                    body.append(request.frame)
                    body.append(contentsOf: [125])
                    let data = try await Self.retryExchange(
                        connection: connection, suffix: "frames", body: body, expectedStatus: 202, timeout: 10)
                    try self.requireCurrent(connection)
                    guard try JSONDecoder().decode(Accepted.self, from: data).acceptedClientSeq == self.clientSeq else {
                        throw GatewayOperatorHTTPError.invalidContract
                    }
                }
                let ack = self.acknowledgedCursor
                let waitMs = min(25000, connection.begin.limits.maxPollWaitMs)
                let pollTask = Task {
                    let body = Data("{\"ack\":\(ack),\"waitMs\":\(waitMs)}".utf8)
                    let data = try await Self.retryExchange(
                        connection: connection,
                        suffix: "poll",
                        body: body,
                        expectedStatus: 200,
                        timeout: Double(waitMs) / 1000 + 5)
                    return try JSONDecoder().decode(Poll.self, from: data)
                }
                self.pollTask = pollTask
                self.pollInterrupted = false
                let poll: Poll
                do {
                    poll = try await pollTask.value
                } catch {
                    try self.requireCurrent(connection)
                    let interrupted = self.pollInterrupted
                    self.pollTask = nil
                    self.pollInterrupted = false
                    if pollTask.isCancelled, interrupted { continue }
                    throw error
                }
                self.pollTask = nil
                self.pollInterrupted = false
                try self.requireCurrent(connection)
                guard poll.acceptedClientSeq == self.clientSeq,
                      poll.frames.count <= min(64, connection.begin.limits.maxBatchFrames)
                else { throw GatewayOperatorHTTPError.invalidContract }
                for delivery in poll.frames {
                    guard delivery.cursor == self.acknowledgedCursor + 1 else {
                        throw GatewayOperatorHTTPError.invalidContract
                    }
                    try await self.consume(delivery.frame, connection: connection)
                    try self.requireCurrent(connection)
                    self.acknowledgedCursor = delivery.cursor
                }
                if let closed = poll.closed {
                    throw GatewayOperatorHTTPError.remote(
                        code: "connection_closed", message: closed.reason)
                }
            }
        } catch {
            guard self.generation == connection.generation else { return }
            self.retire(error)
        }
    }

    private func consume(_ frame: GatewayFrame, connection: Connection) async throws {
        switch frame {
        case let .event(event):
            guard event.event != "connect.challenge" else { throw GatewayOperatorHTTPError.invalidContract }
            try await self.consumeEvent?(event) { !connection.cancellation.isCancelled }
        case let .res(response):
            try await self.consumeResponse(response, connection: connection)
        case .req, .unknown:
            throw GatewayOperatorHTTPError.invalidContract
        }
    }

    private func consumeResponse(_ response: ResponseFrame, connection: Connection) async throws {
        let key = Data(response.id.utf8)
        guard let pending = self.pending[key], pending.submitted else {
            throw GatewayOperatorHTTPError.invalidContract
        }
        try await pending.consume(response) { !connection.cancellation.isCancelled }
        try self.requireCurrent(connection)
        guard let completed = self.removePending(key) else { throw CancellationError() }
        if response.ok {
            completed.continuation.resume(returning: response)
        } else {
            completed.continuation.resume(throwing: response.error.map(GatewayOperatorHTTPError.rpc)
                ?? GatewayOperatorHTTPError.invalidContract)
        }
    }

    private func requireCurrent(_ connection: Connection) throws {
        try Task.checkCancellation()
        guard self.generation == connection.generation, self.connection != nil else {
            throw CancellationError()
        }
    }

    private func retire(_ error: any Error, notify: Bool = true) {
        let onClosed = self.onClosed
        self.onClosed = nil
        self.connection?.cancellation.cancel()
        self.generation = UUID()
        self.connected = false
        self.beginTask?.cancel()
        self.beginTask = nil
        self.pollTask?.cancel()
        self.pollTask = nil
        self.pollInterrupted = false
        self.pumpTask?.cancel()
        self.pumpTask = nil
        for request in self.pending.values {
            request.timeout.cancel()
            request.continuation.resume(throwing: request.submitted
                ? GatewayOperatorHTTPError.resultUnknown(
                    method: request.method, requestID: request.requestID)
                : error)
        }
        self.pending.removeAll()
        self.outgoing.removeAll()
        self.pendingBytes = 0
        self.consumeEvent = nil
        if let connection = self.connection {
            let previous = self.cleanupTask
            self.cleanupTask = Task {
                await previous?.value
                _ = try? await Self.exchange(
                    http: connection.http,
                    url: connection.url,
                    method: "DELETE",
                    key: connection.begin.connectionKey,
                    body: nil,
                    expectedResponse: (status: 204, maximumBytes: 16384),
                    timeout: 5)
                connection.http.finishTasksAndInvalidate()
            }
        }
        self.connection = nil
        // Timeout and cancellation can retire the owner before the pump's catch runs.
        // Consume the callback here so every unexpected retirement notifies exactly once.
        if notify, let onClosed {
            Task { await onClosed(error) }
        }
    }

    private static func retryExchange(
        connection: Connection, suffix: String, body: Data, expectedStatus: Int, timeout: Double) async throws -> Data
    {
        for attempt in 0..<3 {
            do {
                return try await self.exchange(
                    http: connection.http,
                    url: connection.url.appendingPathComponent(suffix),
                    method: "POST",
                    key: connection.begin.connectionKey,
                    body: body,
                    expectedResponse: (status: expectedStatus, maximumBytes: self.maximumResponseBytes),
                    timeout: timeout)
            } catch {
                try Task.checkCancellation()
                let networkFailure = (error as? URLError).map {
                    [.networkConnectionLost, .timedOut, .cannotConnectToHost].contains($0.code)
                } ?? false
                let cancelledPollRace: Bool = if case GatewayOperatorHTTPError.remote(
                    code: "poll_conflict",
                    message: _) = error
                {
                    suffix == "poll"
                } else {
                    false
                }
                guard attempt < 2, networkFailure || cancelledPollRace else { throw error }
                try await Task.sleep(for: .milliseconds(100 * (attempt + 1)))
            }
        }
        throw GatewayOperatorHTTPError.disconnected
    }

    private static func exchange(
        http: GatewayTLSPinningSession,
        url: URL,
        method: String,
        key: String?,
        body: Data?,
        expectedResponse: (status: Int, maximumBytes: Int),
        timeout: Double) async throws -> Data
    {
        var request = URLRequest(url: url, cachePolicy: .reloadIgnoringLocalCacheData, timeoutInterval: timeout)
        request.httpMethod = method
        request.httpBody = body
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        if let key { request.setValue("Bearer \(key)", forHTTPHeaderField: "Authorization") }
        let (data, response) = try await http.data(for: request, maximumBytes: expectedResponse.maximumBytes)
        guard let response = response as? HTTPURLResponse, response.url == url else {
            throw GatewayOperatorHTTPError.invalidContract
        }
        guard response.statusCode == expectedResponse.status else {
            if let rejection = try? JSONDecoder().decode(Rejection.self, from: data) {
                throw GatewayOperatorHTTPError.remote(
                    code: rejection.error.code, message: rejection.error.message)
            }
            throw GatewayOperatorHTTPError.remote(
                code: "http_error", message: "Gateway HTTP \(response.statusCode). Reconnect to refresh.")
        }
        return data
    }

    private static func codableValue(_ value: some Encodable) throws -> AnyCodable {
        try JSONDecoder().decode(AnyCodable.self, from: JSONEncoder().encode(value))
    }

    private static func payload<T: Decodable>(_ type: T.Type, from response: ResponseFrame) throws -> T {
        guard let payload = response.payload else { throw GatewayOperatorHTTPError.invalidContract }
        return try JSONDecoder().decode(type, from: JSONEncoder().encode(payload))
    }
}
