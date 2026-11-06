import Foundation
import Synchronization

/// Deliberately node-only. Never install this session in the operator/chat session factory.
public final class OpenClawIDNodeWebSocketSession: WebSocketSessioning, Sendable {
    private let tunnel: OpenClawIDNodeTunnel
    private let origin: URL
    public let requiredGatewayRole: String? = "node"

    public init(tunnel: OpenClawIDNodeTunnel, logicalOrigin: URL) {
        self.tunnel = tunnel
        self.origin = logicalOrigin
    }

    public func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        self.makeWebSocketTask(request: URLRequest(url: url))
    }

    public func makeWebSocketTask(request: URLRequest) -> WebSocketTaskBox {
        WebSocketTaskBox(task: OpenClawIDNodeWebSocketTask(
            tunnel: self.tunnel, origin: self.origin, request: request, role: "node"))
    }

    /// Separate worker ingress requires its own admission credential, not a Gateway
    /// role upgrade. The fixed path and role cannot be used for chat/operator RPCs.
    public func prepareWorkerWebSocket() async throws -> WebSocketTaskBox {
        guard var components = URLComponents(url: self.origin, resolvingAgainstBaseURL: false) else {
            throw OpenClawIDNodeTransportError.wrongRoute
        }
        components.path = "/__openclaw__/worker"
        components.query = nil
        components.fragment = nil
        guard let url = components.url else { throw OpenClawIDNodeTransportError.wrongRoute }
        let task = OpenClawIDNodeWebSocketTask(
            tunnel: self.tunnel, origin: self.origin, request: URLRequest(url: url), role: "worker")
        try await task.prepare()
        return WebSocketTaskBox(task: task)
    }

    public func shutdown() async { await self.tunnel.shutdown() }
}

private actor OpenClawIDNodeWebSocketIO {
    private let tunnel: OpenClawIDNodeTunnel
    private let origin: URL
    private let request: URLRequest
    private let role: String
    private var opening: Task<OpenClawIDNodeFrameReader, Error>?
    private var reader: OpenClawIDNodeFrameReader?
    private var writer: Task<Void, Error>?
    private var stopped = false
    private var receiving = false
    private var connectSent = false

    init(tunnel: OpenClawIDNodeTunnel, origin: URL, request: URLRequest, role: String) {
        self.tunnel = tunnel
        self.origin = origin
        self.request = request
        self.role = role
    }

    func open() async throws -> OpenClawIDNodeFrameReader {
        if self.stopped { throw OpenClawIDNodeTransportError.closed }
        if let reader = self.reader { return reader }
        if let opening = self.opening { return try await self.waitForOpen(opening) }
        guard let url = self.request.url,
              (url.scheme == "wss" || url.scheme == "ws"),
              url.host == self.origin.host, url.port == self.origin.port,
              url.user == nil, url.password == nil, url.fragment == nil,
              (self.role == "worker" ? url.path == "/__openclaw__/worker" : (url.path.isEmpty || url.path == "/")),
              let components = URLComponents(url: url, resolvingAgainstBaseURL: false)
        else { throw OpenClawIDNodeTransportError.wrongRoute }
        let path = (components.percentEncodedPath.isEmpty ? "/" : components.percentEncodedPath) +
            (components.percentEncodedQuery.map { "?" + $0 } ?? "")
        let headers = (self.request.allHTTPHeaderFields ?? [:]).sorted { $0.key < $1.key }.map { [$0.key, $0.value] }
        let head = try OpenClawIDNodeTunnelCodec.requestHead(path: path, headers: headers)
        let tunnel = self.tunnel
        let task = Task {
            let stream = try await tunnel.openStream()
            let reader = OpenClawIDNodeFrameReader(stream: stream)
            do {
                try await openClawIDNodeDeadline(.seconds(10), clock: .init()) {
                    try await stream.write(head)
                    guard let bytes = try await reader.next(limit: OpenClawIDNodeTunnelProtocol.maximumHeadBytes) else {
                        throw OpenClawIDNodeTransportError.truncatedFrame
                    }
                    let response = try OpenClawIDNodeTunnelCodec.responseHead(bytes)
                    guard response.status == 101 else {
                        throw OpenClawIDNodeTransportError.upgradeRejected(response.status)
                    }
                    guard response.selectedProtocol == nil else {
                        throw OpenClawIDNodeTransportError.invalidHead
                    }
                    await tunnel.received()
                }
                return reader
            } catch {
                await stream.reset(code: 4)
                await stream.stop(code: 4)
                throw error
            }
        }
        self.opening = task
        do {
            let reader = try await self.waitForOpen(task)
            if self.stopped {
                await reader.stream.reset(code: 4)
                await reader.stream.stop(code: 4)
                throw OpenClawIDNodeTransportError.closed
            }
            self.opening = nil
            self.reader = reader
            return reader
        } catch {
            self.opening = nil
            throw error
        }
    }

    private func waitForOpen(_ task: Task<OpenClawIDNodeFrameReader, Error>) async throws -> OpenClawIDNodeFrameReader {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            return try await task.value
        } onCancel: {
            task.cancel()
            Task { await self.abort() }
        }
    }

    func send(_ message: URLSessionWebSocketTask.Message, lifetime: WebSocketRequestLifetime? = nil) async throws {
        if self.stopped { throw OpenClawIDNodeTransportError.closed }
        let payload: OpenClawIDNodeTunnelCodec.Message
        let data: Data
        switch message {
        case let .string(text): data = Data(text.utf8); payload = .text(text)
        case let .data(bytes): data = bytes; payload = .binary(bytes)
        @unknown default: throw OpenClawIDNodeTransportError.unsupportedOpcode
        }
        // GatewayChannel sends JSON as binary; worker clients may send text. Both
        // forms must prove the route-specific role before using W.
        if !self.connectSent {
            guard let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any], object["type"] as? String == "req", object["method"] as? String == "connect",
                  let params = object["params"] as? [String: Any], params["role"] as? String == self.role,
                  self.role != "worker" || params["admission"] is [String: Any],
                  (params["scopes"] == nil || (params["scopes"] as? [String]) == [])
            else { throw OpenClawIDNodeTransportError.nodeRoleRequired }
            self.connectSent = true
        }
        // The server fixes the role at handshake; later payloads are ordinary protocol
        // messages, not fresh authentication. Avoid reparsing large worker frames here.
        let frame = try OpenClawIDNodeTunnelCodec.message(payload)
        let previous = self.writer
        // Actor reentrancy alone does not preserve write order across await.
        let task = Task {
            if let previous { _ = try? await previous.value }
            try Task.checkCancellation()
            let reader = try await self.open()
            // This is queue admission, not an assertion that a sent request can be
            // retracted. Retiring an already-started write must not corrupt framing.
            if let lifetime, !lifetime.performIfActive({}, onFinish: {}) { throw CancellationError() }
            try Task.checkCancellation()
            do { try await reader.stream.write(frame) } catch {
                await self.abort()
                throw error
            }
        }
        self.writer = task
        try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func abort() async {
        self.stopped = true
        self.opening?.cancel()
        if let reader = self.reader {
            await reader.stream.reset(code: 4)
            await reader.stream.stop(code: 4)
        }
        self.reader = nil
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        guard !self.receiving else { throw OpenClawIDNodeTransportError.malformedFrame }
        self.receiving = true
        defer { self.receiving = false }
        let reader = try await self.open()
        guard let frame = try await reader.next(limit: OpenClawIDNodeTunnelProtocol.maximumFrameBytes) else {
            throw OpenClawIDNodeTransportError.closed
        }
        await self.tunnel.received()
        do {
            switch try OpenClawIDNodeTunnelCodec.decodeMessage(frame) {
            case let .text(text): return .string(text)
            case let .binary(bytes): return .data(bytes)
            case let .close(code, reason):
                await self.close(code: code, reason: reason)
                throw OpenClawIDNodeTransportError.webSocketClosed(code, reason)
            }
        } catch {
            await self.close(code: nil, reason: "")
            throw error
        }
    }

    func ping() async throws {
        _ = try await self.open()
        try await self.tunnel.checkLiveness()
    }

    func close(code: UInt16?, reason: String) async {
        guard !self.stopped else { return }
        self.stopped = true
        self.opening?.cancel()
        self.writer?.cancel()
        let previous = self.writer
        self.writer = nil
        if let reader = self.reader {
            let stream = reader.stream
            // The close handshake is best effort, bounded even if the peer stops reading.
            // Reset is the cancellation fallback; it must release a stalled write's lock.
            do {
                try await openClawIDNodeDeadline(.seconds(1), clock: .init()) {
                    if let previous { _ = try? await previous.value }
                    try await stream.write(OpenClawIDNodeTunnelCodec.message(.close(code, reason)))
                    try await stream.finish()
                }
            } catch {
                await stream.reset(code: 4)
            }
            await stream.stop(code: 4)
        }
        self.reader = nil
    }
}

private final class OpenClawIDNodeWebSocketTask: WebSocketRequestSending, Sendable {
    private let io: OpenClawIDNodeWebSocketIO
    private let taskState = Mutex<URLSessionTask.State>(.suspended)

    init(tunnel: OpenClawIDNodeTunnel, origin: URL, request: URLRequest, role: String) {
        self.io = OpenClawIDNodeWebSocketIO(tunnel: tunnel, origin: origin, request: request, role: role)
    }

    var state: URLSessionTask.State { self.taskState.withLock { $0 } }

    func prepare() async throws {
        do {
            _ = try await self.io.open()
            try Task.checkCancellation()
            self.taskState.withLock { $0 = .running }
        } catch {
            await self.io.close(code: nil, reason: "")
            self.taskState.withLock { $0 = .completed }
            throw error
        }
    }

    func resume() {
        let start = self.taskState.withLock { state in
            guard state == .suspended else { return false }
            state = .running
            return true
        }
        if start {
            Task {
                do { _ = try await self.io.open() } catch {
                    await self.io.close(code: nil, reason: "")
                    self.taskState.withLock { $0 = .completed }
                }
            }
        }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.taskState.withLock { $0 = .canceling }
        Task {
            await self.io.close(
                code: UInt16(exactly: closeCode.rawValue),
                reason: reason.map { String(decoding: $0, as: UTF8.self) } ?? "")
            self.taskState.withLock { $0 = .completed }
        }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws { try await self.io.send(message) }

    func sendRequest(_ message: URLSessionWebSocketTask.Message, lifetime: WebSocketRequestLifetime) async throws {
        try await self.io.send(message, lifetime: lifetime)
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        Task {
            do { try await self.io.ping(); pongReceiveHandler(nil) } catch { pongReceiveHandler(error) }
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message { try await self.io.receive() }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        Task {
            do { completionHandler(.success(try await self.receive())) } catch { completionHandler(.failure(error)) }
        }
    }
}
