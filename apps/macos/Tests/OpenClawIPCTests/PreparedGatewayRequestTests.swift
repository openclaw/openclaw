import Foundation
import Testing
@testable import OpenClawKit

struct PreparedGatewayRequestTests {
    @Test(arguments: [[], ["screen.snapshot", "system.run"]])
    func `encoder carries matching metadata through connect RPC and native completion`(
        _ commands: [String]) async throws
    {
        let socket = PreparedRequestSocket()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: PreparedRequestSession(socket: socket)),
            connectOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: commands, permissions: [:],
                clientId: "openclaw-macos", clientMode: "node", clientDisplayName: nil,
                includeDeviceIdentity: false, allowStoredDeviceAuth: false))
        let text = #"quotes " / 😀 and literal \u0061"#
        do {
            try await channel.connect()
            _ = try await channel.request(method: "benchmark.echo", params: ["text": AnyCodable(text)])
            try await channel.send(method: "node.invoke.result", params: ["payloadJSON": AnyCodable(text)])
        } catch {
            await channel.shutdown()
            throw error
        }
        await channel.shutdown()

        let requests = socket.snapshot()
        try #require(requests.map(\.request.method) == ["connect", "benchmark.echo", "node.invoke.result"])
        #expect(requests[0].request.commands == Set(commands))
        #expect(requests[1].request.commands == nil)
        #expect(requests[2].request.commands == nil)
        #expect(requests[0].lifetime == nil)
        #expect(requests[2].lifetime == nil)
        let lifetime = try #require(requests[1].lifetime)
        #expect(lifetime.method == "benchmark.echo")
        #expect(!lifetime.performIfActive {} onFinish: {})
        for (index, sent) in requests.enumerated() {
            guard case let .frame(data) = sent.request.body else {
                Issue.record("Generic request must retain its encoded frame")
                continue
            }
            let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            #expect(frame["type"] as? String == "req")
            #expect(frame["id"] as? String == sent.request.id)
            #expect(frame["method"] as? String == sent.request.method)
            let params = try #require(frame["params"] as? [String: Any])
            if index == 0 {
                #expect(Set(params["commands"] as? [String] ?? []) == Set(commands))
            } else {
                #expect(params[index == 1 ? "text" : "payloadJSON"] as? String == text)
            }
        }
    }

    @Test(arguments: [#"{"text":"quotes \" / 🦞 and \\u0061"}"#, "null", #"null],{"id":"injected"}"#])
    func `successful native result freezes metadata and carries exact owned JSON`(raw: String) async throws {
        let socket = PreparedRequestSocket()
        let mutable = NSMutableDictionary(dictionary: ["original": "value"])
        try await Self.withChannel(socket) { channel in
            try await channel.send(method: "node.invoke.result", params: [
                "id": AnyCodable("invoke-1"), "nodeId": AnyCodable("mac-1"), "ok": AnyCodable(true),
                "payloadJSON": AnyCodable(raw), "payload": AnyCodable(mutable),
            ])
        }
        mutable["original"] = "changed"
        let sent = try #require(socket.snapshot().last)
        guard case let .nativeResult(metadata, payloadJSON) = sent.request.body else {
            Issue.record("Capable transport must receive native result without eager payload encoding")
            return
        }
        #expect(payloadJSON == raw)
        let frame = try #require(JSONSerialization.jsonObject(with: metadata) as? [String: Any])
        #expect(frame["id"] as? String == sent.request.id)
        #expect(frame["method"] as? String == "node.invoke.result")
        let params = try #require(frame["params"] as? [String: Any])
        #expect(params["id"] as? String == "invoke-1")
        #expect(params["nodeId"] as? String == "mac-1")
        #expect(params["ok"] as? Bool == true)
        #expect(params["payloadJSON"] == nil)
        #expect((params["payload"] as? [String: String])?["original"] == "value")
        #expect(sent.lifetime == nil)
    }

    @Test(arguments: [true, false])
    func `ordinary websocket keeps eagerly encoded native result strings`(ok: Bool) async throws {
        let (frames, capture) = AsyncStream<Data>.makeStream()
        defer { capture.finish() }
        let socket = GatewayTestWebSocketTask(sendHook: { _, message, index in
            if index > 0, case let .data(data) = message { capture.yield(data) }
        })
        let raw = #"{"text":"🦞","value":null}"#
        try await Self.withChannel(socket) { channel in
            try await channel.send(method: "node.invoke.result", params: [
                "ok": AnyCodable(ok), "payloadJSON": AnyCodable(raw),
            ])
        }
        var iterator = frames.makeAsyncIterator()
        let data = try #require(await iterator.next())
        let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        let params = try #require(frame["params"] as? [String: Any])
        #expect(params["ok"] as? Bool == ok)
        #expect(params["payloadJSON"] as? String == raw)
    }

    @Test func `failed native results remain encoded and unsupported metadata fails before delivery`() async throws {
        let socket = PreparedRequestSocket()
        try await Self.withChannel(socket) { channel in
            try await channel.send(method: "node.invoke.result", params: [
                "ok": AnyCodable(false), "payloadJSON": AnyCodable("not JSON"),
            ])
            await #expect(throws: (any Error).self) {
                try await channel.send(method: "node.invoke.result", params: [
                    "ok": AnyCodable(true), "payloadJSON": AnyCodable("null"), "other": AnyCodable(Date()),
                ])
            }
        }
        let requests = socket.snapshot()
        #expect(requests.count == 2)
        guard case let .frame(data) = try #require(requests.last).request.body else {
            Issue.record("Failed native result must retain generic encoding")
            return
        }
        let frame = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
        #expect((frame["params"] as? [String: Any])?["payloadJSON"] as? String == "not JSON")
    }

    private static func withChannel(
        _ socket: any WebSocketTasking,
        body: (GatewayChannelActor) async throws -> Void) async throws
    {
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")), token: nil,
            session: WebSocketSessionBox(session: PreparedRequestSession(socket: socket)),
            connectOptions: GatewayConnectOptions(
                role: "node", scopes: [], caps: [], commands: [], permissions: [:],
                clientId: "openclaw-macos", clientMode: "node", clientDisplayName: nil,
                includeDeviceIdentity: false, allowStoredDeviceAuth: false))
        do {
            try await channel.connect()
            try await body(channel)
        } catch {
            await channel.shutdown()
            throw error
        }
        await channel.shutdown()
    }
}

private final class PreparedRequestSocket: WebSocketRequestSending, @unchecked Sendable {
    struct Sent {
        let request: PreparedGatewayRequest
        let lifetime: WebSocketRequestLifetime?
    }

    private let lock = NSLock()
    private var sent: [Sent] = []
    private let socket = GatewayTestWebSocketTask(sendHook: { socket, message, index in
        if index > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) {
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
        }
    })

    var state: URLSessionTask.State {
        self.socket.state
    }

    func resume() {
        self.socket.resume()
    }

    func cancel(with code: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        self.socket.cancel(with: code, reason: reason)
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {
        try await self.socket.send(message)
    }

    func sendRequest(_ request: PreparedGatewayRequest, lifetime: WebSocketRequestLifetime?) async throws {
        self.lock.withLock { self.sent.append(Sent(request: request, lifetime: lifetime)) }
        switch request.body {
        case let .frame(data), let .nativeResult(data, _): try await self.socket.send(.data(data))
        }
    }

    func snapshot() -> [Sent] {
        self.lock.withLock { self.sent }
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func receive() async throws -> URLSessionWebSocketTask.Message {
        try await self.socket.receive()
    }

    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        self.socket.receive(completionHandler: completionHandler)
    }
}

private final class PreparedRequestSession: WebSocketSessioning {
    let socket: any WebSocketTasking
    init(socket: any WebSocketTasking) {
        self.socket = socket
    }

    func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
        WebSocketTaskBox(task: self.socket)
    }
}
