import Foundation
import Testing
@testable import OpenClawKit
import OpenClawProtocol

@Suite struct GatewayNodeInvokeTests {
    @Test
    func nodeInvokeRequestSendsInvokeResult() async throws {
        let task = TestWebSocketTask()
        let session = TestWebSocketSession(task: task)

        task.enqueue(Self.makeEventMessage(
            event: "connect.challenge",
            payload: ["nonce": "test-nonce"]))

        let tracker = InvokeTracker()
        let gateway = GatewayNodeSession()
        try await gateway.connect(
            url: URL(string: "ws://127.0.0.1:18789")!,
            token: nil,
            password: "test-password",
            connectOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: ["device.info"],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: "Test iOS Node"),
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                await tracker.set(req)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{\"ok\":true}")
            })

        task.enqueue(Self.makeEventMessage(
            event: "node.invoke.request",
            payload: [
                "id": "invoke-1",
                "nodeId": "node-1",
                "command": "device.info",
                "timeoutMs": 15000,
                "idempotencyKey": "abc123",
            ]))

        let resultFrame = try await waitForSentMethod(
            task,
            method: "node.invoke.result",
            timeoutSeconds: 1.0)

        let sentParams = resultFrame.params?.value as? [String: OpenClawProtocol.AnyCodable]
        #expect(sentParams?["id"]?.value as? String == "invoke-1")
        #expect(sentParams?["nodeId"]?.value as? String == "node-1")
        #expect(sentParams?["ok"]?.value as? Bool == true)

        let captured = await tracker.get()
        #expect(captured?.command == "device.info")
        #expect(captured?.id == "invoke-1")
    }

    @Test
    func nodeInvokeRequestHandlesStringPayload() async throws {
        let task = TestWebSocketTask()
        let session = TestWebSocketSession(task: task)

        task.enqueue(Self.makeEventMessage(
            event: "connect.challenge",
            payload: ["nonce": "test-nonce"]))

        let tracker = InvokeTracker()
        let gateway = GatewayNodeSession()
        try await gateway.connect(
            url: URL(string: "ws://127.0.0.1:18789")!,
            token: nil,
            password: "test-password",
            connectOptions: GatewayConnectOptions(
                role: "node",
                scopes: [],
                caps: [],
                commands: ["device.info"],
                permissions: [:],
                clientId: "openclaw-ios",
                clientMode: "node",
                clientDisplayName: "Test iOS Node"),
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                await tracker.set(req)
                return BridgeInvokeResponse(id: req.id, ok: true)
            })

        let payload = """
        {"id":"invoke-2","nodeId":"node-1","command":"device.info"}
        """
        task.enqueue(Self.makeEventMessage(
            event: "node.invoke.request",
            payload: payload))

        let resultFrame = try await waitForSentMethod(
            task,
            method: "node.invoke.result",
            timeoutSeconds: 1.0)

        let sentParams = resultFrame.params?.value as? [String: OpenClawProtocol.AnyCodable]
        #expect(sentParams?["id"]?.value as? String == "invoke-2")
        #expect(sentParams?["nodeId"]?.value as? String == "node-1")
        #expect(sentParams?["ok"]?.value as? Bool == true)

        let captured = await tracker.get()
        #expect(captured?.command == "device.info")
        #expect(captured?.id == "invoke-2")
    }
}

private enum TestError: Error {
    case timeout
}

private func waitForSentMethod(
    _ task: TestWebSocketTask,
    method: String,
    timeoutSeconds: Double
) async throws -> RequestFrame {
    try await AsyncTimeout.withTimeout(
        seconds: timeoutSeconds,
        onTimeout: { TestError.timeout },
        operation: {
            while true {
                let frames = task.sentRequests()
                if let match = frames.first(where: { $0.method == method }) {
                    return match
                }
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        })
}

private actor InvokeTracker {
    private var request: BridgeInvokeRequest?

    func set(_ req: BridgeInvokeRequest) {
        self.request = req
    }

    func get() -> BridgeInvokeRequest? {
        self.request
    }
}

private final class TestWebSocketSession: WebSocketSessioning {
    private let task: TestWebSocketTask

    init(task: TestWebSocketTask) {
        self.task = task
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: self.task)
    }
}

private final class TestWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private var _state: URLSessionTask.State = .suspended
    private var receiveQueue: [URLSessionWebSocketTask.Message] = []
    private var receiveContinuations: [CheckedContinuation<URLSessionWebSocketTask.Message, Error>] = []
    private var receiveHandlers: [@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void] = []
    private var sent: [URLSessionWebSocketTask.Message] = []

    var state: URLSessionTask.State {
        self.lock.withLock { self._state }
    }

    func resume() {
        self.lock.withLock { self._state = .running }
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.lock.withLock { self._state = .canceling }
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        self.lock.withLock { self.sent.append(message) }
        guard let frame = Self.decodeRequestFrame(message) else { return }
        guard frame.method == "connect" else { return }
        let id = frame.id
        let response = Self.connectResponse(for: id)
        self.enqueue(.data(response))
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await withCheckedThrowingContinuation { cont in
            var next: URLSessionWebSocketTask.Message?
            self.lock.withLock {
                if !self.receiveQueue.isEmpty {
                    next = self.receiveQueue.removeFirst()
                } else {
                    self.receiveContinuations.append(cont)
                }
            }
            if let next { cont.resume(returning: next) }
        }
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        var next: URLSessionWebSocketTask.Message?
        self.lock.withLock {
            if !self.receiveQueue.isEmpty {
                next = self.receiveQueue.removeFirst()
            } else {
                self.receiveHandlers.append(completionHandler)
            }
        }
        if let next {
            completionHandler(.success(next))
        }
    }

    func enqueue(_ message: URLSessionWebSocketTask.Message) {
        var handler: (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?
        var continuation: CheckedContinuation<URLSessionWebSocketTask.Message, Error>?
        self.lock.withLock {
            if !self.receiveHandlers.isEmpty {
                handler = self.receiveHandlers.removeFirst()
            } else if !self.receiveContinuations.isEmpty {
                continuation = self.receiveContinuations.removeFirst()
            } else {
                self.receiveQueue.append(message)
            }
        }
        if let handler {
            handler(.success(message))
        } else if let continuation {
            continuation.resume(returning: message)
        }
    }

    func sentRequests() -> [RequestFrame] {
        let messages = self.lock.withLock { self.sent }
        return messages.compactMap(Self.decodeRequestFrame)
    }

    private static func decodeRequestFrame(_ message: URLSessionWebSocketTask.Message) -> RequestFrame? {
        let data: Data?
        switch message {
        case let .data(raw): data = raw
        case let .string(text): data = text.data(using: .utf8)
        @unknown default: data = nil
        }
        guard let data else { return nil }
        return try? JSONDecoder().decode(RequestFrame.self, from: data)
    }

    private static func connectResponse(for id: String) -> Data {
        let payload: [String: Any] = [
            "type": "hello-ok",
            "protocol": 3,
            "server": [
                "version": "dev",
                "connId": "test-conn",
            ],
            "features": [
                "methods": [],
                "events": [],
            ],
            "snapshot": [
                "presence": [],
                "health": ["ok": true],
                "stateVersion": ["presence": 0, "health": 0],
                "uptimeMs": 0,
            ],
            "policy": [
                "maxPayload": 1,
                "maxBufferedBytes": 1,
                "tickIntervalMs": 1000,
            ],
        ]
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": payload,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }
}

private extension GatewayNodeInvokeTests {
    static func makeEventMessage(event: String, payload: Any) -> URLSessionWebSocketTask.Message {
        let frame: [String: Any] = [
            "type": "event",
            "event": event,
            "payload": payload,
        ]
        let data = try? JSONSerialization.data(withJSONObject: frame)
        return .data(data ?? Data())
    }
}

private extension NSLock {
    func withLock<T>(_ body: () -> T) -> T {
        self.lock()
        defer { self.unlock() }
        return body()
    }
}
