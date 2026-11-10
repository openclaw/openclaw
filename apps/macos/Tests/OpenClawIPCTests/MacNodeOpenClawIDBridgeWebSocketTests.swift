import Darwin
import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct BridgeWebSocketUnusedEndpoint: OpenClawIDNodeEndpoint {
    func connect(serverKey _: String, relayURL _: URL, alpn _: Data) async throws -> any OpenClawIDNodeConnection {
        throw MacNodeOpenClawIDBridgeError.unavailable
    }
    func relayStatus() async -> [OpenClawIDNodeRelayStatus] { [] }
    func shutdown() async {}
}

/// Echoes the shared adapter's message contract, without dialing or using app state.
private final class BridgeWebSocketEcho: WebSocketTasking, Sendable {
    let messages = AsyncThrowingStream<URLSessionWebSocketTask.Message, Error>.makeStream()
    var state: URLSessionTask.State { .running }
    func resume() {}
    func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
        self.messages.continuation.finish(throwing: CancellationError())
    }
    func send(_ message: URLSessionWebSocketTask.Message) async throws { self.messages.continuation.yield(message) }
    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) { pongReceiveHandler(nil) }
    func receive() async throws -> URLSessionWebSocketTask.Message {
        var iterator = self.messages.stream.makeAsyncIterator()
        guard let message = try await iterator.next() else { throw CancellationError() }
        return message
    }
    func receive(completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void) {
        Task {
            do { completionHandler(.success(try await self.receive())) } catch { completionHandler(.failure(error)) }
        }
    }
}

struct MacNodeOpenClawIDBridgeWebSocketTests {
    private typealias Codec = MacNodeOpenClawIDBridgeWebSocketCodec
    private let upgrade = Data(("GET /__openclaw__/worker HTTP/1.1\r\nHost: localhost\r\n" +
        "Connection: keep-alive, Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Version: 13\r\n" +
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n\r\n").utf8)

    @Test func rfcUpgradeVectorAndInvalidHandshakes() throws {
        let request = try MacNodeOpenClawIDBridgeRequest.parse(self.upgrade)
        let response = try #require(String(bytes: Codec.upgrade(request), encoding: .utf8))
        #expect(response.contains("Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\r\n"))
        for (old, replacement) in [
            ("GET ", "POST "), ("/__openclaw__/worker", "/"),
            ("Version: 13", "Version: 12"), ("dGhlIHNhbXBsZSBub25jZQ==", "YQ=="),
            ("keep-alive, Upgrade", "keep-alive"),
            ("Sec-WebSocket-Version: 13\r\n", "Sec-WebSocket-Version: 13\r\nSec-WebSocket-Version: 13\r\n"),
        ] {
            let modified = try #require(String(bytes: self.upgrade, encoding: .utf8)).replacingOccurrences(
                of: old,
                with: replacement)
            #expect(throws: (any Error).self) {
                try Codec.upgrade(MacNodeOpenClawIDBridgeRequest.parse(Data(modified.utf8)))
            }
        }
    }

    @Test func rejectsInvalidHeadersBeforePayloadAllocation() throws {
        let invalidHeaders: [[UInt8]] = [
            [0x81, 0x00], // Missing client mask.
            [0xC1, 0x80], // Unnegotiated RSV1.
            [0x83, 0x80], // Reserved opcode.
            [0x09, 0x80], // Fragmented control.
            [0x89, 0xFE, 0x00, 0x7E], // Oversized control.
            [0x81, 0xFE, 0x00, 0x01], // Nonminimal 16-bit length.
            [0x82, 0xFF, 0, 0, 0, 0, 0, 0, 0, 126], // Nonminimal 64-bit length.
            [0x82, 0xFF, 0x80, 0, 0, 0, 0, 0, 0, 0], // Forbidden high bit.
            [0x82, 0xFF, 0, 0, 0, 0, 2, 0, 0, 0], // 32 MiB exceeds tunnel payload bound.
            [0x81, 0xFE], // Truncated extended length.
        ]
        for bytes in invalidHeaders {
            #expect(throws: (any Error).self) { try Codec.Header.parse(Data(bytes)) }
        }
        #expect(try Codec.Header.parse(Data([0x82, 0xFE, 0x01, 0x00])).length == 256)
        #expect(try Codec.Header.parse(Data([0x82, 0xFF, 0, 0, 0, 0, 0, 1, 0, 0])).length == 65536)
        #expect(try Codec.unmask(Data([0x7F, 0x9F, 0x4D, 0x51, 0x58]), key: Data([0x37, 0xFA, 0x21, 0x3D])) == Data("Hello".utf8))
    }

    @Test func fragmentedUTF8AndInterleavedControlPreserveMessage() throws {
        var messages = Codec.Messages()
        #expect(try messages.consume(.init(final: false, opcode: 1, length: 2), payload: Data([0xF0, 0x9F])) == nil)
        #expect(try messages.consume(.init(final: true, opcode: 9, length: 1), payload: Data([7])) == .ping(Data([7])))
        #expect(try messages.consume(.init(final: true, opcode: 0, length: 2), payload: Data([0x98, 0x80])) == .text("😀"))
        #expect(throws: (any Error).self) { try messages.validate(.init(final: true, opcode: 0, length: 0)) }
        #expect(try messages.consume(.init(final: false, opcode: 2, length: 1), payload: Data([1])) == nil)
        #expect(throws: (any Error).self) { try messages.validate(.init(final: true, opcode: 1, length: 0)) }
        #expect(throws: (any Error).self) {
            try messages.validate(.init(final: true, opcode: 0, length: Codec.maximumMessageBytes))
        }
        var invalidText = Codec.Messages()
        #expect(throws: (any Error).self) {
            try invalidText.consume(.init(final: true, opcode: 1, length: 1), payload: Data([0xFF]))
        }
    }

    @Test func closeValidationAndUnmaskedServerEncoding() throws {
        for bytes in [Data([0]), Data([3, 237]), Data([3, 232, 255]), Data(repeating: 0, count: 126)] {
            #expect(throws: (any Error).self) { try Codec.validateClose(bytes) }
        }
        try Codec.validateClose(Data())
        try Codec.validateClose(Data([3, 232]) + Data("bye".utf8))
        try Codec.validateClose(Data([0x0F, 0xA0])) // Application-defined 4000.
        #expect(try Codec.frame(opcode: 8, payload: Data([3, 232])) == Data([0x88, 2, 3, 232]))
        #expect(try Codec.frame(opcode: 2, payload: Data(repeating: 0, count: 126)).prefix(4) == Data([0x82, 126, 0, 126]))
        #expect(try Codec.frame(opcode: 2, payload: Data(repeating: 0, count: 65536)).prefix(10) ==
            Data([0x82, 127, 0, 0, 0, 0, 0, 1, 0, 0]))
    }

    @Test func unixUpgradeWaitsForUpstreamAndProxiesFragmentsPingAndClose() async throws {
        let entered = AsyncStream<Void>.makeStream()
        let release = AsyncStream<Void>.makeStream()
        let echo = BridgeWebSocketEcho()
        let (bridge, tunnel) = try await self.bridge {
            entered.continuation.yield(())
            entered.continuation.finish()
            var iterator = release.stream.makeAsyncIterator()
            _ = await iterator.next()
            try Task.checkCancellation()
            return WebSocketTaskBox(task: echo)
        }
        do {
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            let reader = MacNodeOpenClawIDBridgeReader(io: io)
            try await io.write(self.upgrade)
            var iterator = entered.stream.makeAsyncIterator()
            _ = await iterator.next()
            var byte: UInt8 = 0
            let pendingRead = recv(handle.fileDescriptor, &byte, 1, MSG_PEEK | MSG_DONTWAIT)
            let pendingError = errno
            #expect(pendingRead == -1)
            #expect(pendingError == EAGAIN || pendingError == EWOULDBLOCK)
            release.continuation.finish()
            let response = try await reader.through(Data([13, 10, 13, 10]), limit: 1024)
            #expect(try #require(String(bytes: response, encoding: .utf8)).hasPrefix("HTTP/1.1 101 "))
            try await io.write(self.masked(opcode: 1, final: false, bytes: Data("hel".utf8)) +
                self.masked(opcode: 9, bytes: Data("p".utf8)) + self.masked(opcode: 0, bytes: Data("lo".utf8)))
            #expect(try await reader.exactly(10) == Data([0x8A, 1, 112, 0x81, 5]) + Data("hello".utf8))
            let close = Data([3, 232]) + Data("bye".utf8)
            try await io.write(self.masked(opcode: 8, bytes: close))
            #expect(try await reader.exactly(7) == Data([0x88, 5]) + close)
        } catch {
            release.continuation.finish()
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
    }

    @Test func malformedWireFramesCloseWithProtocolStatus() async throws {
        let (bridge, tunnel) = try await self.bridge { WebSocketTaskBox(task: BridgeWebSocketEcho()) }
        do {
            for (frame, status) in [
                (Data([0x81, 0]), UInt16(1002)),
                (Data([0x09, 0x80]), UInt16(1002)),
                (self.masked(opcode: 1, bytes: Data([0xFF])), UInt16(1007)),
            ] {
                let handle = try self.connect(bridge.socketPath)
                defer { try? handle.close() }
                let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
                let reader = MacNodeOpenClawIDBridgeReader(io: io)
                try await io.write(self.upgrade)
                _ = try await reader.through(Data([13, 10, 13, 10]), limit: 1024)
                try await io.write(frame)
                #expect(try await reader.exactly(4) == Data([
                    0x88, 2, UInt8(truncatingIfNeeded: status >> 8), UInt8(truncatingIfNeeded: status),
                ]))
            }
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
    }

    @Test func preservesRemoteCloseCodeAndWorkerAdmissionReason() async throws {
        for (code, reason) in [(UInt16(4001), "owner-epoch-stale"), (UInt16(1001), "gateway-shutdown"), (nil, "")] {
            let echo = BridgeWebSocketEcho()
            let (bridge, tunnel) = try await self.bridge { WebSocketTaskBox(task: echo) }
            do {
                let handle = try self.connect(bridge.socketPath)
                defer { try? handle.close() }
                let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
                let reader = MacNodeOpenClawIDBridgeReader(io: io)
                try await io.write(self.upgrade)
                _ = try await reader.through(Data([13, 10, 13, 10]), limit: 1024)
                echo.messages.continuation.finish(throwing: OpenClawIDNodeTransportError.webSocketClosed(code, reason))
                var payload = Data()
                if let code {
                    payload.append(contentsOf: [UInt8(truncatingIfNeeded: code >> 8), UInt8(truncatingIfNeeded: code)])
                    payload.append(contentsOf: reason.utf8)
                }
                #expect(try await reader.exactly(payload.count + 2) == Data([0x88, UInt8(payload.count)]) + payload)
            } catch {
                await bridge.shutdown()
                await tunnel.shutdown()
                throw error
            }
            await bridge.shutdown()
            await tunnel.shutdown()
        }
    }

    @Test func invalidRemoteCloseAndTransportFailureTerminateWithoutCloseFrame() async throws {
        let failures: [OpenClawIDNodeTransportError] = [
            .webSocketClosed(1005, "reserved"), .webSocketClosed(nil, "reason-without-code"),
            .webSocketClosed(1000, String(repeating: "😀", count: 31)), .closed,
        ]
        for failure in failures {
            let echo = BridgeWebSocketEcho()
            let (bridge, tunnel) = try await self.bridge { WebSocketTaskBox(task: echo) }
            do {
                let handle = try self.connect(bridge.socketPath)
                defer { try? handle.close() }
                let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
                let reader = MacNodeOpenClawIDBridgeReader(io: io)
                try await io.write(self.upgrade)
                _ = try await reader.through(Data([13, 10, 13, 10]), limit: 1024)
                echo.messages.continuation.finish(throwing: failure)
                do {
                    _ = try await reader.exactly(1)
                    Issue.record("Malformed remote close or transport failure emitted a wire frame")
                } catch MacNodeOpenClawIDBridgeError.closed {
                    // Expected abnormal closure: no invented close code or reason.
                }
            } catch {
                await bridge.shutdown()
                await tunnel.shutdown()
                throw error
            }
            await bridge.shutdown()
            await tunnel.shutdown()
        }
    }

    @Test func upstreamFailureNeverAcknowledgesLocalUpgrade() async throws {
        let (bridge, tunnel) = try await self.bridge { throw MacNodeOpenClawIDBridgeError.unavailable }
        do {
            let handle = try self.connect(bridge.socketPath)
            defer { try? handle.close() }
            let io = try MacNodeOpenClawIDBridgeIO(handle: handle)
            try await io.write(self.upgrade)
            let response = try await MacNodeOpenClawIDBridgeReader(io: io).through(Data([13, 10, 13, 10]), limit: 1024)
            #expect(try #require(String(bytes: response, encoding: .utf8)).hasPrefix("HTTP/1.1 502 "))
        } catch {
            await bridge.shutdown()
            await tunnel.shutdown()
            throw error
        }
        await bridge.shutdown()
        await tunnel.shutdown()
    }

    private func masked(opcode: UInt8, final: Bool = true, bytes: Data) -> Data {
        let key: [UInt8] = [1, 2, 3, 4]
        return Data([opcode | (final ? 0x80 : 0), 0x80 | UInt8(bytes.count)] + key) +
            Data(bytes.enumerated().map { $0.element ^ key[$0.offset % 4] })
    }

    private func bridge(_ prepare: @escaping MacNodeOpenClawIDBridgeWebSocket.Prepare) async throws
        -> (MacNodeOpenClawIDBridge, OpenClawIDNodeTunnel)
    {
        let tunnel = OpenClawIDNodeTunnel(
            endpoint: BridgeWebSocketUnusedEndpoint(), verifiedServerKey: { "synthetic" },
            relayURL: URL(string: "https://relay.invalid")!)
        let bridge = try await MacNodeOpenClawIDBridge.start(
            tunnel: tunnel, logicalOrigin: URL(string: "wss://claw.invalid")!,
            workerWebSocket: { request, reader, io in
                try await MacNodeOpenClawIDBridgeWebSocket.serve(request: request, reader: reader, io: io, prepare: prepare)
            }, onUnexpectedStop: {})
        return (bridge, tunnel)
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
        guard result == 0 else { Darwin.close(fd); throw MacNodeOpenClawIDBridgeError.unavailable }
        var enabled: Int32 = 1
        _ = setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &enabled, socklen_t(MemoryLayout<Int32>.size))
        return FileHandle(fileDescriptor: fd, closeOnDealloc: true)
    }
}
