import Foundation
import Synchronization
import Testing
@testable import OpenClawKit

struct OpenClawIDNodeTunnelTests {
    /// Independent bytes from packages/openclaw-id-protocol/src/tunnel/tunnel.test.ts.
    @Test func `protocol vectors`() throws {
        #expect(try OpenClawIDNodeTunnelCodec.frame(Data("hello".utf8)) == Data([0, 0, 0, 5, 104, 101, 108, 108, 111]))
        #expect(try OpenClawIDNodeTunnelCodec.frame(Data()) == Data([0, 0, 0, 0]))
        #expect(try OpenClawIDNodeTunnelCodec.message(.close(1000, "bye")) == Data([
            0,
            0,
            0,
            6,
            8,
            3,
            232,
            98,
            121,
            101,
        ]))
        #expect(try OpenClawIDNodeTunnelCodec.decodeMessage(Data([1, 104, 105])) == .text("hi"))
        #expect(try OpenClawIDNodeTunnelCodec.decodeMessage(Data([8])) == .close(nil, ""))
        #expect(throws: OpenClawIDNodeTransportError.unsupportedOpcode) {
            try OpenClawIDNodeTunnelCodec.decodeMessage(Data([9]))
        }
        #expect(throws: OpenClawIDNodeTransportError.truncatedFrame) {
            try OpenClawIDNodeTunnelCodec.decodeMessage(Data([8, 3]))
        }
        #expect(throws: OpenClawIDNodeTransportError.malformedFrame) {
            try OpenClawIDNodeTunnelCodec.decodeMessage(Data([1, 255]))
        }
        #expect(try OpenClawIDNodeTunnelCodec.responseHead(Data(#"{"status":101,"protocol":null}"#.utf8)).status == 101)
        #expect(try OpenClawIDNodeTunnelCodec.responseHead(Data(#"{"status":404,"headers":[]}"#.utf8)).status == 404)
        for json in [
            #"{"status":true}"#,
            #"{"status":101.5}"#,
            #"{"status":600}"#,
            #"{"status":200,"headers":[["bad"]]}"#,
        ] {
            #expect(throws: (any Error).self) { try OpenClawIDNodeTunnelCodec.responseHead(Data(json.utf8)) }
        }
        #expect(throws: OpenClawIDNodeTransportError.invalidHead) {
            try OpenClawIDNodeTunnelCodec.requestHead(path: "relative", method: "GET")
        }
        #expect(throws: OpenClawIDNodeTransportError.invalidHead) {
            try OpenClawIDNodeTunnelCodec.requestHead(path: "/", method: "G T")
        }
    }

    @Test func `fragmented frames and length before allocation`() async throws {
        let stream = NodeTestStream(input: Data([0, 0, 0, 2, 104, 105, 0, 0, 0, 0]), chunk: 1)
        let reader = OpenClawIDNodeFrameReader(stream: stream)
        #expect(try await reader.next(limit: 2) == Data("hi".utf8))
        #expect(try await reader.next(limit: 2) == Data())
        #expect(try await reader.next(limit: 2) == nil)
        let oversized = NodeTestStream(input: Data([2, 0, 0, 1])) // 32 MiB + 1
        let oversizedReader = OpenClawIDNodeFrameReader(stream: oversized)
        await #expect(throws: OpenClawIDNodeTransportError.oversizedFrame) {
            try await oversizedReader.next(limit: OpenClawIDNodeTunnelProtocol.maximumFrameBytes)
        }
        #expect(await oversized.readLimits == [4])
        #expect(await oversized.resets == [4])
        let truncated = OpenClawIDNodeFrameReader(stream: NodeTestStream(input: Data([0, 0, 0, 2, 1])))
        await #expect(throws: OpenClawIDNodeTransportError.truncatedFrame) { try await truncated.next(limit: 2) }
    }

    @Test func `node socket carries gateway messages and rejects operator`() async throws {
        let stream = try NodeTestStream(input:
            OpenClawIDNodeTunnelCodec.frame(Data(#"{"status":101,"protocol":null}"#.utf8)) +
                OpenClawIDNodeTunnelCodec.message(.text(#"{"type":"event","event":"connect.challenge"}"#)))
        let endpoint = NodeTestEndpoint(stream: stream)
        let tunnel = self.tunnel(endpoint)
        let url = try #require(URL(string: "wss://claw.example/"))
        let session = OpenClawIDNodeWebSocketSession(tunnel: tunnel, logicalOrigin: url)
        let socket = session.makeWebSocketTask(url: url)
        await #expect(throws: OpenClawIDNodeTransportError.nodeRoleRequired) {
            try await socket.send(.string(#"{"type":"req","method":"connect","params":{"role":"operator"}}"#))
        }
        #expect(await endpoint.dials == 0)
        if case let .string(challenge) = try await socket.receive() {
            #expect(challenge.contains("connect.challenge"))
        } else { Issue.record("Expected Gateway challenge text") }
        try await socket
            .send(.data(Data(#"{"type":"req","method":"connect","params":{"role":"node","scopes":[]}}"#.utf8)))
        #expect(await endpoint.dials == 1)
        #expect(await stream.writes.count == 2)
        try await tunnel.checkLiveness()
        #expect(await endpoint.dials == 2) // A fresh admission probe, never a fabricated WS pong.
        let wrongURL = try #require(URL(string: "wss://different.example/"))
        let wrong = session.makeWebSocketTask(url: wrongURL)
        await #expect(throws: OpenClawIDNodeTransportError.wrongRoute) { try await wrong.receive() }
        await session.shutdown()
        #expect(await endpoint.shutdowns == 1)
        await #expect(throws: OpenClawIDNodeTransportError.closed) { try await tunnel.openStream() }
    }

    @Test func `worker close retains protocol reason for retry classification`() async throws {
        let stream = try NodeTestStream(input:
            OpenClawIDNodeTunnelCodec.frame(Data(#"{"status":101}"#.utf8)) +
                OpenClawIDNodeTunnelCodec.message(.close(1008, "credential-revoked")))
        let tunnel = self.tunnel(NodeTestEndpoint(stream: stream))
        let session = try OpenClawIDNodeWebSocketSession(
            tunnel: tunnel, logicalOrigin: #require(URL(string: "wss://claw.example/")))
        let worker = try await session.prepareWorkerWebSocket()
        await #expect(throws: OpenClawIDNodeTransportError.webSocketClosed(1008, "credential-revoked")) {
            try await worker.receive()
        }
        #expect(await stream.finishes == 1)
        await tunnel.shutdown()
    }

    @Test func `worker ingress requires separate path and admission without operator role`() async throws {
        let stream = try NodeTestStream(input: OpenClawIDNodeTunnelCodec.frame(Data(#"{"status":101}"#.utf8)))
        let endpoint = NodeTestEndpoint(stream: stream)
        let tunnel = self.tunnel(endpoint)
        let url = try #require(URL(string: "wss://claw.example/"))
        let session = OpenClawIDNodeWebSocketSession(tunnel: tunnel, logicalOrigin: url)
        let wrong = session.makeWebSocketTask(url: url.appendingPathComponent("__openclaw__/worker"))
        await #expect(throws: OpenClawIDNodeTransportError.wrongRoute) { try await wrong.receive() }
        #expect(await endpoint.dials == 0)
        let worker = try await session.prepareWorkerWebSocket()
        await #expect(throws: OpenClawIDNodeTransportError.nodeRoleRequired) {
            try await worker.send(.string(#"{"type":"req","method":"connect","params":{"role":"operator"}}"#))
        }
        await #expect(throws: OpenClawIDNodeTransportError.nodeRoleRequired) {
            try await worker.send(.string(#"{"type":"req","method":"connect","params":{"role":"worker"}}"#))
        }
        try await worker
            .send(
                .string(
                    #"{"type":"req","method":"connect","params":{"role":"worker","admission":"# +
                        #"{"credential":"synthetic"}}}"#))
        let writes = await stream.writes
        #expect(writes.count == 2)
        #expect(String(decoding: writes[0], as: UTF8.self).contains("/__openclaw__/worker"))
        await tunnel.shutdown()
    }

    @Test func `retired queued request does not write or poison successor`() async throws {
        let stream = try NodeTestStream(input: OpenClawIDNodeTunnelCodec.frame(Data(#"{"status":101}"#.utf8)))
        let tunnel = self.tunnel(NodeTestEndpoint(stream: stream))
        let url = try #require(URL(string: "wss://claw.example/"))
        let socket = OpenClawIDNodeWebSocketSession(tunnel: tunnel, logicalOrigin: url).makeWebSocketTask(url: url)
        try await socket.send(.data(Data(#"{"type":"req","method":"connect","params":{"role":"node"}}"#.utf8)))
        await stream.blockNextWrite()
        let first = Task { try await socket.send(.string(#"{"method":"first"}"#)) }
        try await stream.writeStarted.wait()
        let lifetime = WebSocketRequestLifetime()
        let retired = Task { try await socket.sendRequest(.string(#"{"method":"retired"}"#), lifetime: lifetime) }
        lifetime.finish()
        stream.writeRelease.resolve(())
        try await first.value
        await #expect(throws: CancellationError.self) { try await retired.value }
        try await socket.send(.string(#"{"method":"successor"}"#))
        let writes = await stream.writes
        #expect(writes.count == 4) // HEAD, node connect, first, successor; no retired request.
        #expect(!writes.contains { String(decoding: $0, as: UTF8.self).contains("retired") })
        await tunnel.shutdown()
    }

    @Test func `close interrupts blocked writer before joining queued writer`() async throws {
        let stream = try NodeTestStream(input: OpenClawIDNodeTunnelCodec.frame(Data(#"{"status":101}"#.utf8)))
        let tunnel = self.tunnel(NodeTestEndpoint(stream: stream))
        let url = try #require(URL(string: "wss://claw.example/"))
        let io = OpenClawIDNodeWebSocketIO(tunnel: tunnel, origin: url, request: URLRequest(url: url), role: "node")
        try await io.send(.string(#"{"type":"req","method":"connect","params":{"role":"node"}}"#))
        await stream.blockNextWrite()
        let first = try await io.enqueue(.string(#"{"method":"first"}"#))
        try await stream.writeStarted.wait()
        // Enqueue returns only after the owner installs the second writer behind the blocked first.
        let second = try await io.enqueue(.string(#"{"method":"second"}"#))
        let watchdog = Task {
            do { try await Task.sleep(for: .seconds(3)) } catch { return }
            Issue.record("Close did not interrupt its writer chain within the one-second close deadline")
            await stream.reset(code: 4)
        }
        await io.close(code: 1000, reason: "done")
        watchdog.cancel()
        await watchdog.value
        await #expect(throws: CancellationError.self) { try await first.value }
        await #expect(throws: CancellationError.self) { try await second.value }
        #expect(await stream.resets.contains(4))
        #expect(await stream.writes.count == 2) // HEAD and connect only; neither blocked nor queued data escaped.
        #expect(await stream.finishes == 0)
        await #expect(throws: OpenClawIDNodeTransportError.closed) {
            try await io.send(.string(#"{"method":"late"}"#))
        }
        await tunnel.shutdown()
    }

    @Test func `canceling HTTP head interrupts underlying read`() async throws {
        let stream = NodeBlockedReadStream()
        let tunnel = self.tunnel(NodeTestEndpoint(stream: stream))
        let http = try await OpenClawIDNodeHTTPStream.open(tunnel: tunnel, method: "GET", path: "/resource")
        let response = Task { try await http.responseHead() }
        try await stream.readStarted.wait()
        response.cancel()
        await #expect(throws: CancellationError.self) { try await response.value }
        #expect(await stream.resets > 0)
        await tunnel.shutdown()
    }

    @Test func `http remains streaming and bounded`() async throws {
        let stream = try NodeTestStream(input:
            OpenClawIDNodeTunnelCodec
                .frame(Data(#"{"status":200,"headers":[["content-type","application/octet-stream"]]}"#.utf8)) +
                OpenClawIDNodeTunnelCodec.frame(Data([1, 2])) + OpenClawIDNodeTunnelCodec.frame(Data([3])))
        let tunnel = self.tunnel(NodeTestEndpoint(stream: stream))
        let http = try await OpenClawIDNodeHTTPStream.open(
            tunnel: tunnel,
            method: "POST",
            path: "/__openclaw__/worker-transfer/v1")
        try await http.writeBody(Data([4, 5]))
        try await http.finishBody()
        #expect(try await http.responseHead().status == 200)
        #expect(try await http.nextBody() == Data([1, 2]))
        #expect(try await http.nextBody() == Data([3]))
        #expect(try await http.nextBody() == nil)
        #expect(await stream.finishes == 1)
        #expect(await stream.writes.count == 2)
        await tunnel.shutdown()
    }

    @Test func `gateway owner refuses operator before opening node transport`() async throws {
        let endpoint = NodeTestEndpoint(stream: NodeTestStream(input: Data()))
        let tunnel = self.tunnel(endpoint)
        let url = try #require(URL(string: "wss://claw.example/"))
        let channel = GatewayChannelActor(
            url: url,
            token: nil,
            password: nil,
            session: WebSocketSessionBox(session: OpenClawIDNodeWebSocketSession(tunnel: tunnel, logicalOrigin: url)),
            networkPathUpdates: nil)
        // Absent connectOptions means operator, just like the normal chat owner.
        await #expect(throws: WebSocketGatewayRoleError.self) { try await channel.connect() }
        #expect(await endpoint.dials == 0)
        await channel.shutdown()
        await tunnel.shutdown()
    }

    @Test func `terminal admission close prevents redial but shutdown is retryable`() async throws {
        for code in [Int64(0), 1, 2] {
            let endpoint = NodeClosedEndpoint(code: code)
            let tunnel = try OpenClawIDNodeTunnel(
                endpoint: endpoint,
                verifiedServerKey: String(
                    repeating: "a",
                    count: 64),
                relayURL: #require(URL(string: "https://relay.example/")),
                clock: OpenClawIDNodeClock(now: { 0 }, sleep: { _ in try await NodeTestWaiter<Void>().wait() }))
            let expected = code == 0 ? OpenClawIDNodeTransportError.closed : .removed
            await #expect(throws: expected) { try await tunnel.openStream() }
            await #expect(throws: expected) { try await tunnel.openStream() }
            #expect(await endpoint.dials == (code == 0 ? 2 : 1))
            await tunnel.shutdown()
        }
    }

    @Test func `full range close codes are not narrowed into revocation`() {
        #expect(OpenClawIDNodeClose(code: 1, kind: .application).requiresReenrollment)
        #expect(OpenClawIDNodeClose(code: 2, kind: .application).requiresReenrollment)
        #expect(!OpenClawIDNodeClose(code: 0x1_0000_0001, kind: .application).requiresReenrollment)
        #expect(!OpenClawIDNodeClose(code: 1, kind: .transport).requiresReenrollment)
    }

    private func tunnel(_ endpoint: NodeTestEndpoint) -> OpenClawIDNodeTunnel {
        OpenClawIDNodeTunnel(
            endpoint: endpoint,
            verifiedServerKey: String(
                repeating: "a",
                count: 64),
            relayURL: URL(string: "https://relay.example/")!,
            clock: OpenClawIDNodeClock(now: { 0 }, sleep: { duration in
                if duration == .milliseconds(500) { return }
                try await NodeTestWaiter<Void>().wait()
            }))
    }
}

private actor NodeTestStream: OpenClawIDNodeStream {
    var input: Data
    let chunk: Int
    var writes: [Data] = []
    var readLimits: [Int] = []
    var resets: [Int64] = []
    var finishes = 0
    private var blockWrite = false
    nonisolated let writeStarted = NodeTestWaiter<Void>()
    nonisolated let writeRelease = NodeTestWaiter<Void>()
    func blockNextWrite() {
        self.blockWrite = true
    }

    init(input: Data, chunk: Int = Int.max) {
        self.input = input
        self.chunk = chunk
    }

    func read(maxBytes: Int) async throws -> Data? {
        self.readLimits.append(maxBytes)
        guard !self.input.isEmpty else { return nil }
        let count = min(maxBytes, self.chunk, self.input.count)
        let result = Data(self.input.prefix(count))
        self.input.removeFirst(count)
        return result
    }

    func write(_ bytes: Data) async throws {
        if self.blockWrite {
            self.blockWrite = false
            self.writeStarted.resolve(())
            try await self.writeRelease.wait()
        }
        self.writes.append(bytes)
    }

    func finish() async throws {
        self.finishes += 1
    }

    func reset(code: Int64) async {
        self.resets.append(code)
        self.writeRelease.reject(CancellationError())
    }

    func stop(code: Int64) async {}
}

private actor NodeTestEndpoint: OpenClawIDNodeEndpoint {
    let stream: any OpenClawIDNodeStream
    var dials = 0
    var shutdowns = 0
    init(stream: any OpenClawIDNodeStream) {
        self.stream = stream
    }

    func connect(serverKey: String, relayURL: URL, alpn: Data) async throws -> any OpenClawIDNodeConnection {
        #expect(alpn == Data("openclaw/tunnel/1".utf8))
        self.dials += 1
        return NodeTestConnection(stream: self.stream)
    }

    func relayStatus() async -> [OpenClawIDNodeRelayStatus] {
        []
    }

    func shutdown() async {
        self.shutdowns += 1
    }
}

private struct NodeTestConnection: OpenClawIDNodeConnection {
    let stream: any OpenClawIDNodeStream
    func openBi() async throws -> any OpenClawIDNodeStream {
        self.stream
    }

    func closed() async throws -> OpenClawIDNodeClose {
        try await NodeTestWaiter<OpenClawIDNodeClose>().wait()
    }

    func close(code: Int64) async {}
}

/// A cancellable suspension without real timers, used for the losing deadline/close waits.
private final class NodeTestWaiter<Value: Sendable>: Sendable {
    private struct State: Sendable {
        var result: Result<Value, Error>?
        var continuation: CheckedContinuation<Value, Error>?
    }

    private let state = Mutex(State())
    func resolve(_ value: Value) {
        self.complete(.success(value))
    }

    func reject(_ error: Error) {
        self.complete(.failure(error))
    }

    private func complete(_ result: Result<Value, Error>) {
        self.state.withLock { state in
            guard state.result == nil else { return }
            state.result = result
            state.continuation?.resume(with: result)
            state.continuation = nil
        }
    }

    func wait() async throws -> Value {
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { continuation in
                self.state.withLock { state in
                    if let result = state.result {
                        continuation.resume(with: result)
                    } else {
                        state.continuation = continuation
                    }
                }
            }
        } onCancel: {
            self.reject(CancellationError())
        }
    }
}

private actor NodeBlockedReadStream: OpenClawIDNodeStream {
    nonisolated let readStarted = NodeTestWaiter<Void>()
    var resets = 0
    private var pendingRead: CheckedContinuation<Data?, Error>?
    private var interrupted = false
    func read(maxBytes: Int) async throws -> Data? {
        guard !self.interrupted else { throw CancellationError() }
        // Like UniFFI, this await ignores Task.cancel(). Only explicit transport
        // interruption releases it, so the regression cannot pass on cancellation alone.
        return try await withCheckedThrowingContinuation { continuation in
            self.pendingRead = continuation
            self.readStarted.resolve(())
        }
    }

    func write(_ bytes: Data) async throws {}
    func finish() async throws {}
    func reset(code: Int64) async {
        self.resets += 1
        self.interrupt()
    }

    func stop(code: Int64) async {
        self.interrupt()
    }

    private func interrupt() {
        self.interrupted = true
        self.pendingRead?.resume(throwing: CancellationError())
        self.pendingRead = nil
    }
}

private actor NodeClosedEndpoint: OpenClawIDNodeEndpoint {
    let code: Int64
    var dials = 0
    init(code: Int64) {
        self.code = code
    }

    func connect(serverKey: String, relayURL: URL, alpn: Data) async throws -> any OpenClawIDNodeConnection {
        self.dials += 1
        return NodeClosedConnection(code: self.code)
    }

    func relayStatus() async -> [OpenClawIDNodeRelayStatus] {
        []
    }

    func shutdown() async {}
}

private struct NodeClosedConnection: OpenClawIDNodeConnection {
    let code: Int64
    func openBi() async throws -> any OpenClawIDNodeStream {
        throw OpenClawIDNodeTransportError.closed
    }

    func closed() async throws -> OpenClawIDNodeClose {
        .init(code: self.code, kind: .application)
    }

    func close(code: Int64) async {}
}
