import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private actor BridgeTestStream: OpenClawIDNodeStream {
    private var response: Data
    private var written = Data()
    private var writeSizes: [Int] = []
    private let finished = AsyncStream<Void>.makeStream()
    private var canceled = false
    private let webSocket: Bool
    private var responseHeadRemaining: Int
    private let readChunkBytes: Int

    init(response: Data, webSocketResponseHeadBytes: Int? = nil, readChunkBytes: Int = 7) {
        self.readChunkBytes = readChunkBytes
        self.response = response
        self.webSocket = webSocketResponseHeadBytes != nil
        self.responseHeadRemaining = webSocketResponseHeadBytes ?? 0
    }

    func read(maxBytes: Int) async throws -> Data? {
        // HTTP responds after upload FIN. WS exposes its 101 first, then waits for
        // the worker's connect frame before returning a synthetic message.
        if self.responseHeadRemaining == 0 {
            var iterator = self.finished.stream.makeAsyncIterator()
            _ = await iterator.next()
        }
        try Task.checkCancellation()
        guard !self.canceled else { throw CancellationError() }
        guard !self.response.isEmpty else { return nil }
        let limit = self.responseHeadRemaining > 0 ? min(maxBytes, self.responseHeadRemaining) : maxBytes
        let chunk = Data(self.response.prefix(min(limit, self.readChunkBytes)))
        self.response.removeFirst(chunk.count)
        self.responseHeadRemaining = max(0, self.responseHeadRemaining - chunk.count)
        return chunk
    }

    func write(_ bytes: Data) async throws {
        try Task.checkCancellation()
        guard !self.canceled else { throw CancellationError() }
        self.writeSizes.append(bytes.count)
        self.written.append(bytes)
        if self.webSocket, self.writeSizes.count == 2 { self.finished.continuation.finish() }
    }

    func finish() {
        self.finished.continuation.finish()
    }

    func reset(code _: Int64) {
        self.canceled = true
        self.finished.continuation.finish()
    }

    func stop(code _: Int64) {
        self.canceled = true
        self.finished.continuation.finish()
    }

    func snapshot() -> (Data, [Int]) {
        (self.written, self.writeSizes)
    }
}

private struct BridgeTestConnection: OpenClawIDNodeConnection {
    let stream: BridgeTestStream
    func openBi() async throws -> any OpenClawIDNodeStream {
        self.stream
    }

    func closed() async throws -> OpenClawIDNodeClose {
        // The production admission race cancels this wait, not a real network.
        try await Task.sleep(for: .seconds(3600))
        throw CancellationError()
    }

    func close(code: Int64) async {
        await self.stream.reset(code: code)
    }
}

private struct BridgeTestEndpoint: OpenClawIDNodeEndpoint {
    let stream: BridgeTestStream
    func connect(serverKey _: String, relayURL _: URL, alpn _: Data) async throws -> any OpenClawIDNodeConnection {
        BridgeTestConnection(stream: self.stream)
    }

    func relayStatus() async -> [OpenClawIDNodeRelayStatus] {
        []
    }

    func shutdown() async {
        await self.stream.stop(code: 0)
    }
}

struct MacNodeOpenClawIDBridgeTests {
    private func request(_ extra: String, method: String = "POST") -> Data {
        Data("\(method) /__openclaw__/worker-transfer/v1/test HTTP/1.1\r\nHost: localhost\r\n\(extra)\r\n".utf8)
    }

    @Test func `rejects ambiguous and injected request framing`() throws {
        for extra in [
            "Content-Length: 2\r\nContent-Length: 2\r\n",
            "Content-Length: 2\r\nTransfer-Encoding: chunked\r\n",
            "Content-Length: -1\r\n", "Content-Length: 9999999999999999999999\r\n",
            "Transfer-Encoding: gzip, chunked\r\n", " folded: value\r\n",
            "X-Header: bad\nvalue\r\n", "Trailer: authorization\r\n", "Expect: other\r\n",
        ] {
            #expect(throws: (any Error).self) { try MacNodeOpenClawIDBridgeRequest.parse(self.request(extra)) }
        }
        #expect(throws: (any Error).self) {
            try MacNodeOpenClawIDBridgeRequest.parse(Data(repeating: 65, count: 65537))
        }
        let parsed = try MacNodeOpenClawIDBridgeRequest.parse(self.request(
            "Transfer-Encoding: chunked\r\nConnection: keep-alive, X-Hop\r\n" +
                "X-Hop: removed\r\nAuthorization: Bearer synthetic\r\n"))
        #expect(parsed.body == .chunked)
        #expect(parsed.isWorkerHTTP)
        #expect(parsed.forwardedHeaders == [["host", "localhost"], ["authorization", "Bearer synthetic"]])
    }

    @Test func `worker HTTP namespaces include bootstrap without prefix confusion`() throws {
        for path in [
            "/__openclaw__/worker-bundle/v1/bundles/test",
            "/__openclaw__/worker-transfer/v1/environments/test?part=1",
            "/__openclaw__/worker-bootstrap/artifacts/test",
        ] {
            let request = try MacNodeOpenClawIDBridgeRequest.parse(
                Data("GET \(path) HTTP/1.1\r\nHost: localhost\r\n\r\n".utf8))
            #expect(request.isWorkerHTTP)
        }
        for path in ["/__openclaw__/worker-bootstrap-other", "/__openclaw__/worker-transfer/v10", "/"] {
            let request = try MacNodeOpenClawIDBridgeRequest.parse(
                Data("GET \(path) HTTP/1.1\r\nHost: localhost\r\n\r\n".utf8))
            #expect(!request.isWorkerHTTP)
        }
    }

    @Test func `response cannot inject headers or reuse remote framing`() throws {
        #expect(throws: (any Error).self) {
            try MacNodeOpenClawIDBridgeHTTP.responseHead(
                status: 200,
                headers: [["x-test", "ok\r\nInjected: bad"]],
                method: "GET")
        }
        let head = try MacNodeOpenClawIDBridgeHTTP.responseHead(
            status: 200,
            headers: [["Content-Length", "500"], ["Connection", "X-Hop"], ["X-Hop", "removed"]],
            method: "GET")
        #expect(try #require(String(bytes: head.bytes, encoding: .utf8)) ==
            "HTTP/1.1 200 Tunnel Response\r\nConnection: close\r\nContent-Length: 500\r\n\r\n")
    }

    @Test func `response length is unambiguous and no body metadata is preserved`() throws {
        for headers in [
            [["Content-Length", "2"], ["content-length", "2"]],
            [["Content-Length", "-1"]], [["Content-Length", ""]],
            [["Content-Length", "999999999999999999999999"]],
        ] {
            #expect(throws: (any Error).self) {
                try MacNodeOpenClawIDBridgeHTTP.responseHead(status: 200, headers: headers, method: "GET")
            }
        }
        for (status, method) in [(200, "HEAD"), (304, "GET")] {
            let response = try MacNodeOpenClawIDBridgeHTTP.responseHead(
                status: status, headers: [["Content-Length", "500"]], method: method)
            #expect(response.noBody)
            #expect(response.length == 500)
            #expect(try #require(String(bytes: response.bytes, encoding: .utf8)).contains("Transfer-Encoding") == false)
        }
        let empty = try MacNodeOpenClawIDBridgeHTTP.responseHead(
            status: 204, headers: [["Content-Length", "500"]], method: "GET")
        #expect(empty.noBody)
        #expect(empty.length == nil)
    }

    @Test(arguments: [200, 206])
    func `worker bundle download preserves length and range`(status: Int) async throws {
        let body = Data("bundle payload".utf8)
        var headers = [["Content-Length", String(body.count)], ["Accept-Ranges", "bytes"]]
        if status == 206 { headers.append(["Content-Range", "bytes 10-23/24"]) }
        let head = try JSONSerialization.data(withJSONObject: ["status": status, "headers": headers])
        let stream = try BridgeTestStream(response: OpenClawIDNodeTunnelCodec.frame(head) + OpenClawIDNodeTunnelCodec
            .frame(body))
        let tunnel = self.tunnel(stream)
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel, logicalOrigin: #require(URL(string: "wss://claw.invalid")), onUnexpectedStop: {})
        do {
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            let reader = MacNodeOpenClawIDBridgeReader(io: io)
            let range = status == 206 ? "Range: bytes=10-\r\n" : ""
            try await io
                .write(
                    Data("GET /__openclaw__/worker-bundle/v1/bundles/test HTTP/1.1\r\nHost: localhost\r\n\(range)\r\n"
                        .utf8))
            let responseBytes = try await reader.through(Data([13, 10, 13, 10]), limit: 1024)
            let response = try #require(String(bytes: responseBytes, encoding: .utf8))
            #expect(response.contains("Content-Length: \(body.count)\r\n"))
            #expect(!response.lowercased().contains("transfer-encoding:"))
            #expect(response.contains("Accept-Ranges: bytes\r\n"))
            if status == 206 { #expect(response.contains("Content-Range: bytes 10-23/24\r\n")) }
            #expect(try await reader.exactly(body.count) == body)
            let written = await stream.snapshot().0
            let size = written.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            let forwarded = try #require(JSONSerialization
                .jsonObject(with: Data(written.dropFirst(4).prefix(size))) as? [String: Any])
            let requestHeaders = try #require(forwarded["headers"] as? [[String]])
            if status == 206 { #expect(requestHeaders.contains(["range", "bytes=10-"])) }
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
    }

    @Test func `private permissions and invalid worker upgrade clean up`() async throws {
        let stream = BridgeTestStream(response: Data())
        let tunnel = self.tunnel(stream)
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel, logicalOrigin: #require(URL(string: "wss://claw.invalid")), onUnexpectedStop: {})
        let directory = URL(fileURLWithPath: bridge.socketPath).deletingLastPathComponent().path
        do {
            var metadata = stat()
            #expect(lstat(directory, &metadata) == 0)
            #expect(metadata.st_mode & 0o777 == 0o700)
            #expect(lstat(bridge.socketPath, &metadata) == 0)
            #expect(metadata.st_mode & 0o777 == 0o600)
            #expect(bridge.gatewayURL == "ws+unix:\(bridge.socketPath):/")
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            try await io
                .write(Data("GET /__openclaw__/worker HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n\r\n".utf8))
            let response = try await MacNodeOpenClawIDBridgeReader(io: io).through(Data([13, 10, 13, 10]), limit: 1024)
            #expect(try #require(String(bytes: response, encoding: .utf8)).hasPrefix("HTTP/1.1 400 "))
            #expect(await stream.snapshot().0.isEmpty)
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await bridge.shutdown()
        await tunnel.shutdown()
        #expect(!FileManager.default.fileExists(atPath: directory))
    }

    @Test func `shutdown interrupts and drains accepted handler`() async throws {
        let entered = AsyncStream<Void>.makeStream()
        let tunnel = self.tunnel(BridgeTestStream(response: Data()))
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel,
            logicalOrigin: #require(URL(string: "wss://claw.invalid")),
            workerWebSocket: { _, reader, _ in
                entered.continuation.yield(())
                entered.continuation.finish()
                _ = try await reader.exactly(1)
            }, onUnexpectedStop: {})
        do {
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            try await io
                .write(Data("GET /__openclaw__/worker HTTP/1.1\r\nHost: localhost\r\nUpgrade: websocket\r\n\r\n".utf8))
            var iterator = entered.stream.makeAsyncIterator()
            _ = await iterator.next()
            await bridge.shutdown()
            #expect(!FileManager.default.fileExists(atPath: bridge.socketPath))
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await tunnel.shutdown()
    }

    @Test func `private listener leaves concurrent admission to tunnel owner`() async throws {
        let entered = AsyncStream<Void>.makeStream()
        let tunnel = self.tunnel(BridgeTestStream(response: Data()))
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel,
            logicalOrigin: #require(URL(string: "wss://claw.invalid")),
            workerWebSocket: { _, reader, io in
                try await io.write(Data([1]))
                entered.continuation.yield(())
                _ = try await reader.exactly(1)
            }, onUnexpectedStop: {})
        var handles: [FileHandle] = []
        defer { for handle in handles {
            try? handle.close()
        } }
        do {
            var admissions = entered.stream.makeAsyncIterator()
            // Keep all earlier handlers blocked to exercise admission beyond the
            // protocol's 64 active-stream credit, without introducing another queue.
            for _ in 0..<65 {
                let handle = try self.connect(bridge.socketPath)
                handles.append(handle)
                let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
                try await io.write(Data(("GET /__openclaw__/worker HTTP/1.1\r\n" +
                        "Host: localhost\r\nUpgrade: websocket\r\n\r\n").utf8))
                #expect(try await MacNodeOpenClawIDBridgeReader(io: io).exactly(1) == Data([1]))
                _ = await admissions.next()
            }
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
        entered.continuation.finish()
        #expect(!FileManager.default.fileExists(atPath: bridge.socketPath))
    }

    @Test func `rejects BOM prefixed chunk size before forwarding body`() async throws {
        var descriptors: [Int32] = [0, 0]
        guard socketpair(AF_UNIX, SOCK_STREAM, 0, &descriptors) == 0 else {
            throw MacNodeOpenClawIDBridgeError.unavailable
        }
        let server = FileHandle(fileDescriptor: descriptors[0], closeOnDealloc: true)
        let client = FileHandle(fileDescriptor: descriptors[1], closeOnDealloc: true)
        defer {
            try? server.close()
            try? client.close()
        }
        let io = try MacNodeOpenClawIDBridgeIO(handle: server)
        let sender = try MacNodeOpenClawIDBridgeIO(handle: client)
        let request = try MacNodeOpenClawIDBridgeRequest.parse(self.request("Transfer-Encoding: chunked\r\n"))
        let head = try OpenClawIDNodeTunnelCodec
            .frame(Data("{\"status\":200,\"headers\":[[\"Content-Length\",\"0\"]]}".utf8))
        let stream = BridgeTestStream(response: head)
        let tunnel = self.tunnel(stream)
        try await sender.write(Data([0xEF, 0xBB, 0xBF]) + Data("1\r\nx\r\n0\r\n\r\n".utf8))
        await #expect(throws: MacNodeOpenClawIDBridgeError.self) {
            try await MacNodeOpenClawIDBridgeHTTP.serve(
                request: request,
                reader: MacNodeOpenClawIDBridgeReader(io: io),
                io: io,
                tunnel: tunnel)
        }
        let (written, _) = await stream.snapshot()
        let headLength = written.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
        #expect(written.count == headLength + 4)
        await tunnel.shutdown()
    }

    @Test func `streams chunked upload and response over unix socket`() async throws {
        let head = try OpenClawIDNodeTunnelCodec.frame(Data("{\"status\":200,\"headers\":[]}".utf8))
        let download = Data(repeating: 121, count: 2 * 1024 * 1024 + 17)
        var response = head
        var expected = Data(("HTTP/1.1 200 Tunnel Response\r\nConnection: close\r\n" +
                "Transfer-Encoding: chunked\r\n\r\n").utf8)
        for start in stride(from: 0, to: download.count, by: 1024 * 1024) {
            let chunk = Data(download.dropFirst(start).prefix(1024 * 1024))
            try response.append(OpenClawIDNodeTunnelCodec.frame(chunk))
            expected.append(Data("\(String(chunk.count, radix: 16))\r\n".utf8) + chunk + Data([13, 10]))
        }
        expected.append(Data("0\r\n\r\n".utf8))
        let stream = BridgeTestStream(response: response, readChunkBytes: 65536)
        let tunnel = self.tunnel(stream)
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel, logicalOrigin: #require(URL(string: "wss://claw.invalid")), onUnexpectedStop: {})
        do {
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            let body = Data(repeating: 120, count: 2 * 1024 * 1024 + 31)
            try await io.write(self.request("Transfer-Encoding: chunked\r\n") +
                Data("\(String(body.count, radix: 16))\r\n".utf8) + body + Data("\r\n0\r\n\r\n".utf8))
            let actual = try await MacNodeOpenClawIDBridgeReader(io: io).exactly(expected.count)
            #expect(actual == expected)
            let (written, sizes) = await stream.snapshot()
            #expect(sizes.allSatisfy { $0 <= MacNodeOpenClawIDBridgeIO.blockBytes + 4 })
            var frames = written
            var payload = Data()
            var first = true
            while !frames.isEmpty {
                let length = frames.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
                frames.removeFirst(4)
                if first {
                    let object = try #require(JSONSerialization
                        .jsonObject(with: Data(frames.prefix(length))) as? [String: Any])
                    #expect(object["kind"] as? String == "http")
                    #expect(object["path"] as? String == "/__openclaw__/worker-transfer/v1/test")
                    first = false
                } else { payload.append(frames.prefix(length)) }
                frames.removeFirst(length)
            }
            #expect(payload == body)
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
    }

    @Test func `default worker handler uses dedicated role and tunnel path`() async throws {
        let head = try OpenClawIDNodeTunnelCodec.frame(Data("{\"status\":101}".utf8))
        let stream = try BridgeTestStream(
            response: head + (OpenClawIDNodeTunnelCodec.message(.text("hello"))),
            webSocketResponseHeadBytes: head.count)
        let tunnel = self.tunnel(stream)
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel, logicalOrigin: #require(URL(string: "wss://claw.invalid")), onUnexpectedStop: {})
        do {
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            let reader = MacNodeOpenClawIDBridgeReader(io: io)
            try await io.write(Data(("GET /__openclaw__/worker HTTP/1.1\r\nHost: localhost\r\n" +
                    "Upgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\n" +
                    "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").utf8))
            let response = try await reader.through(Data([13, 10, 13, 10]), limit: 1024)
            #expect(try #require(String(bytes: response, encoding: .utf8)).hasPrefix("HTTP/1.1 101 "))
            let connect = Data(("{\"type\":\"req\",\"method\":\"connect\",\"params\":{\"role\":\"worker\"," +
                    "\"admission\":{\"credential\":\"synthetic\"}}}").utf8)
            try #require(connect.count < 126)
            let key: [UInt8] = [1, 2, 3, 4]
            try await io.write(Data([0x81, 0x80 | UInt8(connect.count)] + key) +
                Data(connect.enumerated().map { $0.element ^ key[$0.offset % 4] }))
            #expect(try await reader.exactly(7) == Data([0x81, 5]) + Data("hello".utf8))
            let (written, _) = await stream.snapshot()
            let headLength = written.prefix(4).reduce(0) { ($0 << 8) | Int($1) }
            let request = try #require(JSONSerialization
                .jsonObject(with: Data(written.dropFirst(4).prefix(headLength))) as? [String: Any])
            #expect(request["kind"] as? String == "ws")
            #expect(request["path"] as? String == "/__openclaw__/worker")
            let frame = written.dropFirst(4 + headLength)
            #expect(frame.dropFirst(4).prefix(1) == Data([1]))
            #expect(Data(frame.dropFirst(5).prefix(connect.count)) == connect)
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
    }

    private func tunnel(_ stream: BridgeTestStream) -> OpenClawIDNodeTunnel {
        OpenClawIDNodeTunnel(
            endpoint: BridgeTestEndpoint(stream: stream),
            verifiedServerKey: { "synthetic" },
            relayURL: URL(string: "https://relay.invalid")!)
    }

    private func connect(_ path: String) throws -> FileHandle {
        let fd = socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { throw MacNodeOpenClawIDBridgeError.unavailable }
        var address = sockaddr_un()
        address.sun_family = sa_family_t(AF_UNIX)
        address.sun_len = UInt8(MemoryLayout<sockaddr_un>.size)
        path.withCString { source in
            withUnsafeMutableBytes(of: &address.sun_path) { target in
                target.copyBytes(from: UnsafeRawBufferPointer(start: source, count: path.utf8.count + 1))
            }
        }
        let result = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
            }
        }
        guard result == 0 else { Darwin.close(fd)
            throw MacNodeOpenClawIDBridgeError.unavailable
        }
        var enabled: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
}
