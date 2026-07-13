import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClawKit

extension NSLock {
    fileprivate func withLock<T>(_ body: () -> T) -> T {
        self.lock()
        defer { self.unlock() }
        return body()
    }
}

private final class DoubleCallbackPingWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let callbacks: [Error?]

    init(callbacks: [Error?]) {
        self.callbacks = callbacks
    }

    var state: URLSessionTask.State {
        .running
    }

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        _ = message
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        for callback in self.callbacks {
            pongReceiveHandler(callback)
        }
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        throw URLError(.badServerResponse)
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        completionHandler(.failure(URLError(.badServerResponse)))
    }
}

private final class FirstCancelGate: @unchecked Sendable {
    private let condition = NSCondition()
    private var shouldBlock = true
    private var started = false
    private var released = false

    func blockIfNeeded() {
        self.condition.lock()
        guard self.shouldBlock else {
            self.condition.unlock()
            return
        }
        self.shouldBlock = false
        self.started = true
        self.condition.broadcast()
        while !self.released {
            self.condition.wait()
        }
        self.condition.unlock()
    }

    func hasStarted() -> Bool {
        self.condition.lock()
        defer { self.condition.unlock() }
        return self.started
    }

    func release() {
        self.condition.lock()
        self.released = true
        self.condition.broadcast()
        self.condition.unlock()
    }
}

private final class FakeGatewayWebSocketTask: WebSocketTasking, @unchecked Sendable {
    private let lock = NSLock()
    private let helloAuth: [String: Any]?
    private let connectError: [String: Any]?
    private let cancelGate: FirstCancelGate?
    private var _state: URLSessionTask.State = .suspended
    private var connectRequestId: String?
    private var connectAuth: [String: Any]?
    private var connectDevice: [String: Any]?
    private var sentRequestMethods: [String] = []
    private var receivePhase = 0
    private var pendingReceiveHandler:
        (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?

    init(
        helloAuth: [String: Any]? = nil,
        connectError: [String: Any]? = nil,
        cancelGate: FirstCancelGate? = nil)
    {
        self.helloAuth = helloAuth
        self.connectError = connectError
        self.cancelGate = cancelGate
    }

    var state: URLSessionTask.State {
        get { self.lock.withLock { self._state } }
        set { self.lock.withLock { self._state = newValue } }
    }

    func resume() {
        self.state = .running
    }

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        _ = (closeCode, reason)
        self.state = .canceling
        self.cancelGate?.blockIfNeeded()
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.cancelled)))
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        let data: Data? = switch message {
        case let .data(d): d
        case let .string(s): s.data(using: .utf8)
        @unknown default: nil
        }
        guard let data else { return }
        if let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           obj["type"] as? String == "req",
           let method = obj["method"] as? String
        {
            self.lock.withLock { self.sentRequestMethods.append(method) }
            guard method == "connect", let id = obj["id"] as? String else { return }
            let params = obj["params"] as? [String: Any]
            let auth = (params?["auth"] as? [String: Any]) ?? [:]
            let device = params?["device"] as? [String: Any]
            self.lock.withLock {
                self.connectRequestId = id
                self.connectAuth = auth
                self.connectDevice = device
            }
        }
    }

    func latestConnectAuth() -> [String: Any]? {
        self.lock.withLock { self.connectAuth }
    }

    func latestConnectDevice() -> [String: Any]? {
        self.lock.withLock { self.connectDevice }
    }

    func sentRequestCount(method: String) -> Int {
        self.lock.withLock { self.sentRequestMethods.count(where: { $0 == method }) }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        let phase = self.lock.withLock { () -> Int in
            let current = self.receivePhase
            self.receivePhase += 1
            return current
        }
        if phase == 0 {
            return .data(Self.connectChallengeData(nonce: "nonce-1"))
        }
        for _ in 0..<50 {
            let id = self.lock.withLock { self.connectRequestId }
            if let id {
                if let connectError {
                    return .data(Self.connectErrorData(id: id, error: connectError))
                }
                return .data(Self.connectOkData(id: id, auth: self.helloAuth))
            }
            try await Task.sleep(nanoseconds: 1_000_000)
        }
        if let connectError {
            return .data(Self.connectErrorData(id: "connect", error: connectError))
        }
        return .data(Self.connectOkData(id: "connect", auth: self.helloAuth))
    }

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
    {
        self.lock.withLock { self.pendingReceiveHandler = completionHandler }
    }

    func emitReceiveFailure() {
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            self._state = .canceling
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.networkConnectionLost)))
    }

    func emitInvokeRequest(id: String, command: String) {
        let handler = self.lock.withLock { () -> (@Sendable (Result<
            URLSessionWebSocketTask.Message,
            Error,
        >) -> Void)? in
            defer { self.pendingReceiveHandler = nil }
            return self.pendingReceiveHandler
        }
        handler?(.success(.data(Self.invokeRequestData(id: id, command: command))))
    }

    private static func connectChallengeData(nonce: String) -> Data {
        let frame: [String: Any] = [
            "type": "event",
            "event": "connect.challenge",
            "payload": ["nonce": nonce],
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func connectOkData(id: String, auth: [String: Any]? = nil) -> Data {
        var payload: [String: Any] = [
            "type": "hello-ok",
            "protocol": 2,
            "server": [
                "version": "test",
                "connId": "test",
            ],
            "features": [
                "methods": [],
                "events": [],
            ],
            "snapshot": [
                "presence": [["ts": 1]],
                "health": [:],
                "stateVersion": [
                    "presence": 0,
                    "health": 0,
                ],
                "uptimeMs": 0,
            ],
            "policy": [
                "maxPayload": 1,
                "maxBufferedBytes": 1,
                "tickIntervalMs": 30000,
            ],
            "auth": [:],
        ]
        if let auth {
            payload["auth"] = auth
        }
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": true,
            "payload": payload,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func connectErrorData(id: String, error: [String: Any]) -> Data {
        let frame: [String: Any] = [
            "type": "res",
            "id": id,
            "ok": false,
            "error": error,
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }

    private static func invokeRequestData(id: String, command: String) -> Data {
        let frame: [String: Any] = [
            "type": "event",
            "event": "node.invoke.request",
            "payload": [
                "id": id,
                "nodeId": "test-node",
                "command": command,
                "paramsJSON": "{}",
            ],
        ]
        return (try? JSONSerialization.data(withJSONObject: frame)) ?? Data()
    }
}

private final class FakeGatewayWebSocketSession: WebSocketSessioning, @unchecked Sendable {
    private let lock = NSLock()
    private let helloAuth: [String: Any]?
    private let connectError: [String: Any]?
    private let cancelGate: FirstCancelGate?
    private var tasks: [FakeGatewayWebSocketTask] = []
    private var makeCount = 0

    init(
        helloAuth: [String: Any]? = nil,
        connectError: [String: Any]? = nil,
        cancelGate: FirstCancelGate? = nil)
    {
        self.helloAuth = helloAuth
        self.connectError = connectError
        self.cancelGate = cancelGate
    }

    func snapshotMakeCount() -> Int {
        self.lock.withLock { self.makeCount }
    }

    func latestTask() -> FakeGatewayWebSocketTask? {
        self.lock.withLock { self.tasks.last }
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        _ = url
        return self.lock.withLock {
            self.makeCount += 1
            let task = FakeGatewayWebSocketTask(
                helloAuth: self.helloAuth,
                connectError: self.connectError,
                cancelGate: self.cancelGate)
            self.tasks.append(task)
            return WebSocketTaskBox(task: task)
        }
    }
}

private actor SeqGapProbe {
    private var saw = false
    func mark() {
        self.saw = true
    }

    func value() -> Bool {
        self.saw
    }
}

private actor DisconnectProbe {
    private var reasons: [String] = []

    func record(_ reason: String) {
        self.reasons.append(reason)
    }

    func values() -> [String] {
        self.reasons
    }
}

@Suite(.serialized)
struct GatewayNodeSessionTests {
    @Test
    func `websocket ping ignores duplicate success callbacks`() async throws {
        let task = DoubleCallbackPingWebSocketTask(callbacks: [nil, nil])
        try await WebSocketTaskBox(task: task).sendPing()
    }

    @Test
    func `websocket ping ignores duplicate callbacks after first error`() async throws {
        let firstError = URLError(.networkConnectionLost)
        let task = DoubleCallbackPingWebSocketTask(callbacks: [firstError, nil])

        do {
            try await WebSocketTaskBox(task: task).sendPing()
            Issue.record("sendPing unexpectedly succeeded")
        } catch let error as URLError {
            #expect(error.code == firstError.code)
        }
    }

    @Test
    func `superseded channel callbacks do not reach replacement connection`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let disconnects = DisconnectProbe()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { reason in await disconnects.record("first:\(reason)") },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        try await gateway.connect(
            url: #require(URL(string: "ws://second.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { reason in await disconnects.record("second:\(reason)") },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        for _ in 0..<20 {
            await Task.yield()
        }
        let replacementDisconnects = await disconnects.values()
        #expect(replacementDisconnects.isEmpty)

        await gateway.disconnect()
        for _ in 0..<20 {
            await Task.yield()
        }
        let finalDisconnects = await disconnects.values()
        #expect(finalDisconnects.isEmpty)
    }

    @Test
    func `route bound operations never use a replacement channel`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let firstRoute = try #require(await gateway.currentRoute())

        try await gateway.connect(
            url: #require(URL(string: "ws://second.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        let sent = await gateway.sendEvent(
            event: "push.apns.register",
            payloadJSON: "{}",
            ifCurrentRoute: firstRoute)
        #expect(!sent)
        do {
            _ = try await gateway.request(
                method: "exec.approval.get",
                paramsJSON: "{}",
                ifCurrentRoute: firstRoute)
            Issue.record("stale route request unexpectedly reached the replacement channel")
        } catch is CancellationError {
            // Expected: the route lease belongs to the first channel.
        }
        let replacementTask = try #require(session.latestTask())
        #expect(replacementTask.sentRequestCount(method: "node.event") == 0)
        #expect(replacementTask.sentRequestCount(method: "exec.approval.get") == 0)
    }

    @Test
    func `disconnect during channel shutdown prevents stale channel install`() async throws {
        let cancelGate = FirstCancelGate()
        let session = FakeGatewayWebSocketSession(cancelGate: cancelGate)
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: "first-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })

        let replacement = Task {
            try await gateway.connect(
                url: #require(URL(string: "ws://stale.example.invalid")),
                token: "stale-token",
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
        }
        let deadline = ContinuousClock().now.advanced(by: .seconds(2))
        while !cancelGate.hasStarted(), ContinuousClock().now < deadline {
            await Task.yield()
        }
        #expect(cancelGate.hasStarted())
        #expect(await gateway.currentRoute() == nil)

        let release = Task.detached {
            try? await Task.sleep(nanoseconds: 10_000_000)
            cancelGate.release()
        }
        await gateway.disconnect()
        await release.value
        do {
            try await replacement.value
            Issue.record("superseded replacement unexpectedly connected")
        } catch is CancellationError {
            // Expected: disconnect advanced the generation while old-channel shutdown was suspended.
        }

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test
    func `invoke result is discarded after target switch`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let invokeStarted = AsyncStream<Void>.makeStream()
        let invokeRelease = AsyncStream<Void>.makeStream()
        var startedIterator = invokeStarted.stream.makeAsyncIterator()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: ["camera.snap"],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://first.example.invalid")),
            token: "first-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { request in
                invokeStarted.continuation.yield()
                for await _ in invokeRelease.stream {
                    return BridgeInvokeResponse(
                        id: request.id,
                        ok: true,
                        payloadJSON: #"{"sensitive":"camera-result"}"#,
                        error: nil)
                }
                return BridgeInvokeResponse(id: request.id, ok: false, payloadJSON: nil, error: nil)
            })
        let firstTask = try #require(session.latestTask())
        firstTask.emitInvokeRequest(id: "invoke-old", command: "camera.snap")
        _ = await startedIterator.next()

        try await gateway.connect(
            url: #require(URL(string: "ws://replacement.example.invalid")),
            token: "replacement-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil) })
        let replacementTask = try #require(session.latestTask())

        invokeRelease.continuation.yield()
        invokeRelease.continuation.finish()
        for _ in 0..<100 {
            await Task.yield()
        }

        #expect(firstTask.sentRequestCount(method: "node.invoke.result") == 0)
        #expect(replacementTask.sentRequestCount(method: "node.invoke.result") == 0)
        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `scanned setup code prefers bootstrap auth over stored device token`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stored-device-token")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["bootstrapToken"] as? String == "fresh-bootstrap-token")
        #expect(auth["token"] == nil)
        #expect(auth["deviceToken"] == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `credentialless setup handoff does not send a stored device token`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "previous-gateway-device-token")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://new-gateway.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let task = try #require(session.latestTask())
        let auth = try #require(task.latestConnectAuth())
        #expect(auth["token"] == nil)
        #expect(auth["bootstrapToken"] == nil)
        #expect(auth["deviceToken"] == nil)
        #expect(task.latestConnectDevice() != nil)
        #expect(await gateway.currentIssuedDeviceAuthRoles() == [])

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `stored device token cannot cross gateway owner`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "node",
            token: "gateway-a-device-token",
            gatewayID: "gateway-a")

        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true,
            allowStoredDeviceAuth: true,
            deviceAuthGatewayID: "gateway-b")

        try await gateway.connect(
            url: #require(URL(string: "ws://gateway-b.example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["token"] == nil)
        #expect(auth["deviceToken"] == nil)
        #expect(DeviceAuthStore.loadToken(
            deviceId: identity.deviceId,
            role: "node",
            gatewayID: "gateway-a")?.token == "gateway-a-device-token")

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `share extension identity profile uses separate node identity and token store`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let primaryIdentity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: primaryIdentity.deviceId,
            role: "node",
            token: "primary-node-token")

        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "share-node-token",
            "role": "node",
            "scopes": [],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "OpenClaw Share",
            deviceIdentityProfile: .shareExtension,
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: "shared-password",
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let shareDevice = try #require(session.latestTask()?.latestConnectDevice())
        let shareDeviceId = try #require(shareDevice["id"] as? String)
        #expect(shareDeviceId != primaryIdentity.deviceId)
        #expect(DeviceAuthStore.loadToken(deviceId: primaryIdentity.deviceId, role: "node")?
            .token == "primary-node-token")
        #expect(DeviceAuthStore.loadToken(deviceId: shareDeviceId, role: "node") == nil)
        #expect(
            DeviceAuthStore
                .loadToken(deviceId: shareDeviceId, role: "node", profile: .shareExtension)?.token ==
                "share-node-token")

        await gateway.disconnect()
    }

    @Test
    func `password takes precedence over bootstrap token`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: "stale-bootstrap-token",
            password: "shared-password",
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let auth = try #require(session.latestTask()?.latestConnectAuth())
        #expect(auth["password"] as? String == "shared-password")
        #expect(auth["bootstrapToken"] == nil)
        #expect(auth["token"] == nil)

        await gateway.disconnect()
    }

    @Test
    func `connect failure preserves protocol mismatch details`() async throws {
        let session = FakeGatewayWebSocketSession(connectError: [
            "code": "INVALID_REQUEST",
            "message": "protocol mismatch",
            "details": [
                "code": "PROTOCOL_MISMATCH",
                "clientMinProtocol": 4,
                "clientMaxProtocol": 4,
                "expectedProtocol": 5,
                "minimumProbeProtocol": 4,
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        do {
            try await gateway.connect(
                url: #require(URL(string: "ws://example.invalid")),
                token: "shared-token",
                bootstrapToken: nil,
                password: nil,
                connectOptions: options,
                sessionBox: WebSocketSessionBox(session: session),
                onConnected: {},
                onDisconnected: { _ in },
                onInvoke: { req in
                    BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                })
            Issue.record("connect unexpectedly succeeded")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .protocolMismatch)
            #expect(error.clientMinProtocol == 4)
            #expect(error.clientMaxProtocol == 4)
            #expect(error.expectedProtocol == 5)
            #expect(error.minimumProbeProtocol == 4)

            let problem = GatewayConnectionProblemMapper.map(error: error)
            #expect(problem?.kind == .protocolMismatch)
            #expect(problem?.owner == .iphone)
            #expect(problem?
                .message == "This app is older than the gateway. Update OpenClaw on this device, then retry.")
            #expect(problem?.pauseReconnect == true)
            #expect(problem?.retryable == false)
        } catch {
            Issue.record("unexpected error type: \(error)")
        }

        await gateway.disconnect()
    }

    @Test
    func `changed session box rebuilds existing gateway channel`() async throws {
        let firstSession = FakeGatewayWebSocketSession()
        let secondSession = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: firstSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: secondSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(firstSession.snapshotMakeCount() == 1)
        #expect(secondSession.snapshotMakeCount() == 1)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `bootstrap hello stores additional device tokens`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "node-device-token",
            "role": "node",
            "scopes": [],
            "issuedAtMs": 1000,
            "deviceTokens": [
                [
                    "deviceToken": "operator-device-token",
                    "role": "operator",
                    "scopes": [
                        "node.exec",
                        "operator.admin",
                        "operator.approvals",
                        "operator.pairing",
                        "operator.read",
                        "operator.talk.secrets",
                        "operator.write",
                    ],
                    "issuedAtMs": 1001,
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        let operatorEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator"))
        #expect(nodeEntry.token == "node-device-token")
        #expect(nodeEntry.scopes == [])
        #expect(operatorEntry.token == "operator-device-token")
        #expect(operatorEntry.scopes == [
            "operator.approvals",
            "operator.read",
            "operator.talk.secrets",
            "operator.write",
        ])
        #expect(await gateway.currentIssuedDeviceAuthRoles() == ["node", "operator"])

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `failed device token write is not reported as an issued role`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let blocker = tempDir.appendingPathComponent("not-a-directory", isDirectory: false)
        try Data().write(to: blocker)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", blocker.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "node-device-token",
            "role": "node",
            "scopes": [],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(await gateway.currentIssuedDeviceAuthRoles().isEmpty)
        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `non bootstrap hello stores primary device token but not additional bootstrap tokens`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "server-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "server-operator-token",
                    "role": "operator",
                    "scopes": ["operator.admin"],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "wss://example.invalid")),
            token: "shared-token",
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        #expect(nodeEntry.token == "server-node-token")
        #expect(nodeEntry.scopes == [])
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `untrusted bootstrap hello does not persist bootstrap handoff tokens`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let session = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "untrusted-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "untrusted-operator-token",
                    "role": "operator",
                    "scopes": [
                        "operator.approvals",
                        "operator.read",
                    ],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node") == nil)
        #expect(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator") == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `private lan bootstrap persists handoff tokens for reconnect`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        let url = try #require(URL(string: "ws://192.168.50.164:18889"))
        let bootstrapSession = FakeGatewayWebSocketSession(helloAuth: [
            "deviceToken": "lan-node-token",
            "role": "node",
            "scopes": [],
            "deviceTokens": [
                [
                    "deviceToken": "lan-operator-token",
                    "role": "operator",
                    "scopes": [
                        "operator.approvals",
                        "operator.read",
                    ],
                ],
            ],
        ])
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "node",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        try await gateway.connect(
            url: url,
            token: nil,
            bootstrapToken: "fresh-bootstrap-token",
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: bootstrapSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })
        await gateway.disconnect()

        let nodeEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "node"))
        let operatorEntry = try #require(DeviceAuthStore.loadToken(deviceId: identity.deviceId, role: "operator"))
        #expect(nodeEntry.token == "lan-node-token")
        #expect(nodeEntry.scopes == [])
        #expect(operatorEntry.token == "lan-operator-token")
        #expect(operatorEntry.scopes == [
            "operator.approvals",
            "operator.read",
        ])

        let reconnectSession = FakeGatewayWebSocketSession()
        try await gateway.connect(
            url: url,
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: reconnectSession),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let reconnectAuth = try #require(reconnectSession.latestTask()?.latestConnectAuth())
        #expect(reconnectAuth["token"] as? String == "lan-node-token")
        #expect(reconnectAuth["bootstrapToken"] == nil)
        #expect(reconnectAuth["deviceToken"] == nil)

        await gateway.disconnect()
    }

    @Test(.stateDirectoryIsolated)
    func `token mismatch retries stored device token only for trusted loopback hosts`() async throws {
        let tempDir = FileManager.default.temporaryDirectory
            .appendingPathComponent(UUID().uuidString, isDirectory: true)
        try FileManager.default.createDirectory(at: tempDir, withIntermediateDirectories: true)
        let previousStateDir = ProcessInfo.processInfo.environment["OPENCLAW_STATE_DIR"]
        setenv("OPENCLAW_STATE_DIR", tempDir.path, 1)
        defer {
            if let previousStateDir {
                setenv("OPENCLAW_STATE_DIR", previousStateDir, 1)
            } else {
                unsetenv("OPENCLAW_STATE_DIR")
            }
            try? FileManager.default.removeItem(at: tempDir)
        }

        let identity = DeviceIdentityStore.loadOrCreate()
        _ = DeviceAuthStore.storeToken(
            deviceId: identity.deviceId,
            role: "operator",
            token: "stored-device-token")

        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: true)

        let connectError: [String: Any] = [
            "code": GatewayConnectAuthDetailCode.authTokenMismatch.rawValue,
            "message": "token mismatch",
            "details": [
                "canRetryWithDeviceToken": true,
            ],
        ]

        func retryAuth(for rawURL: String) async throws -> [String: Any] {
            let session = FakeGatewayWebSocketSession(connectError: connectError)
            let gateway = GatewayNodeSession()
            let url = try #require(URL(string: rawURL))

            for _ in 0..<2 {
                do {
                    try await gateway.connect(
                        url: url,
                        token: "shared-gateway-token",
                        bootstrapToken: nil,
                        password: nil,
                        connectOptions: options,
                        sessionBox: WebSocketSessionBox(session: session),
                        onConnected: {},
                        onDisconnected: { _ in },
                        onInvoke: { req in
                            BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
                        })
                    Issue.record("connect unexpectedly succeeded")
                } catch let error as GatewayConnectAuthError {
                    #expect(error.detail == .authTokenMismatch)
                }
            }

            let retryAuth = try #require(session.latestTask()?.latestConnectAuth())
            await gateway.disconnect()
            return retryAuth
        }

        for rawURL in [
            "ws://127.attacker.example:18789",
            "ws://0.0.0.0:18789",
            "ws://[::]:18789",
        ] {
            let retryAuth = try await retryAuth(for: rawURL)
            #expect(retryAuth["token"] as? String == "shared-gateway-token")
            #expect(retryAuth["deviceToken"] == nil)
        }

        for rawURL in [
            "ws://localhost:18789",
            "ws://127.0.0.2:18789",
            "ws://[::1]:18789",
        ] {
            let retryAuth = try await retryAuth(for: rawURL)
            #expect(retryAuth["token"] as? String == "shared-gateway-token")
            #expect(retryAuth["deviceToken"] as? String == "stored-device-token")
        }
    }

    @Test
    func `normalize canvas host url preserves explicit secure canvas port`() throws {
        let normalized = try canonicalizeCanvasHostUrl(
            raw: "https://canvas.example.com:9443/__openclaw__/cap/token",
            activeURL: #require(URL(string: "wss://gateway.example.com")))

        #expect(normalized == "https://canvas.example.com:9443/__openclaw__/cap/token")
    }

    @Test
    func `normalize canvas host url backfills gateway host for loopback canvas`() throws {
        let normalized = try canonicalizeCanvasHostUrl(
            raw: "http://127.0.0.1:18789/__openclaw__/cap/token",
            activeURL: #require(URL(string: "wss://gateway.example.com:7443")))

        #expect(normalized == "https://gateway.example.com:7443/__openclaw__/cap/token")
    }

    @Test
    func `invoke with timeout returns underlying response before timeout`() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 50,
            onInvoke: { req in
                #expect(req.id == "1")
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: "{}", error: nil)
            })

        #expect(response.ok == true)
        #expect(response.error == nil)
        #expect(response.payloadJSON == "{}")
    }

    @Test
    func `invoke with timeout returns timeout error`() async {
        let request = BridgeInvokeRequest(id: "abc", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 10,
            onInvoke: { _ in
                try? await Task.sleep(nanoseconds: 200_000_000) // 200ms
                return BridgeInvokeResponse(id: "abc", ok: true, payloadJSON: "{}", error: nil)
            })

        #expect(response.ok == false)
        #expect(response.error?.code == .unavailable)
        #expect(response.error?.message.contains("timed out") == true)
    }

    @Test
    func `invoke with timeout zero disables timeout`() async {
        let request = BridgeInvokeRequest(id: "1", command: "x", paramsJSON: nil)
        let response = await GatewayNodeSession.invokeWithTimeout(
            request: request,
            timeoutMs: 0,
            onInvoke: { req in
                try? await Task.sleep(nanoseconds: 5_000_000)
                return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        #expect(response.ok == true)
        #expect(response.error == nil)
    }

    @Test
    func `gateway request timeout zero disables the client deadline`() {
        #expect(GatewayChannelActor.resolveRequestTimeoutMs(0, defaultMs: 15000) == nil)
        #expect(GatewayChannelActor.resolveRequestTimeoutMs(nil, defaultMs: 15000) == 15000)
        #expect(GatewayChannelActor.resolveRequestTimeoutMs(30000, defaultMs: 15000) == 30000)
    }

    @Test
    func `emits synthetic seq gap after reconnect snapshot`() async throws {
        let session = FakeGatewayWebSocketSession()
        let gateway = GatewayNodeSession()
        let options = GatewayConnectOptions(
            role: "operator",
            scopes: ["operator.read"],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios-test",
            clientMode: "ui",
            clientDisplayName: "iOS Test",
            includeDeviceIdentity: false)

        let stream = await gateway.subscribeServerEvents(bufferingNewest: 32)
        let probe = SeqGapProbe()
        let listenTask = Task {
            for await evt in stream {
                if evt.event == "seqGap" {
                    await probe.mark()
                    return
                }
            }
        }

        try await gateway.connect(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            bootstrapToken: nil,
            password: nil,
            connectOptions: options,
            sessionBox: WebSocketSessionBox(session: session),
            onConnected: {},
            onDisconnected: { _ in },
            onInvoke: { req in
                BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: nil, error: nil)
            })

        let firstTask = try #require(session.latestTask())
        firstTask.emitReceiveFailure()

        try await waitUntil("reconnect socket created") {
            session.snapshotMakeCount() >= 2
        }
        try await waitUntil("synthetic seqGap broadcast") {
            await probe.value()
        }

        listenTask.cancel()
        await gateway.disconnect()
    }
}
