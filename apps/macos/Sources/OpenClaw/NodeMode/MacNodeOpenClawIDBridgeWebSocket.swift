import Foundation
import OpenClawKit
import Synchronization

/// Cancellation can arrive from either pump or route shutdown. Preserve the first
/// close's code/reason rather than racing multiple asynchronous adapter cancellations.
private final class MacNodeOpenClawIDBridgeWebSocketLifetime: Sendable {
    let upstream: WebSocketTaskBox
    private let canceled = Mutex(false)

    init(upstream: WebSocketTaskBox) {
        self.upstream = upstream
    }

    func cancel(code: URLSessionWebSocketTask.CloseCode = .goingAway, reason: Data? = nil) {
        let first = self.canceled.withLock { canceled in
            guard !canceled else { return false }
            canceled = true
            return true
        }
        if first { self.upstream.cancel(with: code, reason: reason) }
    }
}

/// Serializes whole RFC frames from the two pumps. At most one pending write per
/// pump is retained, and no data/pong can follow an admitted close frame.
private actor MacNodeOpenClawIDBridgeWebSocketWriter {
    private let io: MacNodeOpenClawIDBridgeIO
    private var tail: Task<Void, Error>?
    private var closing = false

    init(io: MacNodeOpenClawIDBridgeIO) {
        self.io = io
    }

    func send(opcode: UInt8, payload: Data) async throws {
        guard !self.closing else { return }
        let bytes = try MacNodeOpenClawIDBridgeWebSocketCodec.frame(opcode: opcode, payload: payload)
        if opcode == 8 { self.closing = true }
        let previous = self.tail
        let io = self.io
        let task = Task {
            if let previous { try await previous.value }
            try Task.checkCancellation()
            try await io.write(bytes)
        }
        self.tail = task
        try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
    }
}

/// Bounded RFC 6455 server for the private worker socket, not a general Gateway proxy.
enum MacNodeOpenClawIDBridgeWebSocket {
    typealias Prepare = @Sendable () async throws -> WebSocketTaskBox
    private typealias Codec = MacNodeOpenClawIDBridgeWebSocketCodec

    /// The upstream owner must return only after validating tunnel HTTP 101. Never
    /// acknowledge a local upgrade while upstream admission is unknown or rejected.
    static func serve(
        request: MacNodeOpenClawIDBridgeRequest,
        reader: MacNodeOpenClawIDBridgeReader,
        io: MacNodeOpenClawIDBridgeIO,
        prepare: Prepare) async throws
    {
        let response: Data
        do { response = try Codec.upgrade(request) } catch {
            try await Self.reject(400, io: io)
            return
        }
        let upstream: WebSocketTaskBox
        do { upstream = try await prepare() } catch {
            try await Self.reject(502, io: io)
            return
        }
        // prepare can complete concurrently with route retirement; the task belongs
        // to this handler now, and must be canceled even before the first local write.
        let lifetime = MacNodeOpenClawIDBridgeWebSocketLifetime(upstream: upstream)
        defer { lifetime.cancel() }
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await io.write(response)
            let writer = MacNodeOpenClawIDBridgeWebSocketWriter(io: io)
            try await withThrowingTaskGroup(of: Void.self) { group in
                group.addTask {
                    try await Self.fromWorker(reader: reader, writer: writer, lifetime: lifetime)
                }
                group.addTask {
                    try await Self.toWorker(writer: writer, upstream: upstream)
                }
                // Both read directions must be released before the group awaits
                // children, and all local writes drain before the descriptor closes.
                defer {
                    group.cancelAll()
                    io.interrupt()
                    lifetime.cancel()
                }
                _ = try await group.next()
            }
        } onCancel: {
            io.interrupt()
            lifetime.cancel()
        }
    }

    private static func reject(_ status: Int, io: MacNodeOpenClawIDBridgeIO) async throws {
        try await io
            .write(Data("HTTP/1.1 \(status) Upgrade Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8))
    }

    private static func fromWorker(
        reader: MacNodeOpenClawIDBridgeReader,
        writer: MacNodeOpenClawIDBridgeWebSocketWriter,
        lifetime: MacNodeOpenClawIDBridgeWebSocketLifetime) async throws
    {
        let upstream = lifetime.upstream
        var messages = Codec.Messages()
        do {
            while true {
                let header = try await Self.readHeader(reader)
                // Validate fragmentation/cumulative size before reading its payload.
                try messages.validate(header)
                let key = try await reader.exactly(4)
                let payload = try await Codec.unmask(reader.exactly(header.length), key: key)
                guard let event = try messages.consume(header, payload: payload) else { continue }
                switch event {
                case let .text(text): try await upstream.send(.string(text))
                case let .binary(bytes): try await upstream.send(.data(bytes))
                case let .ping(bytes):
                    // A local pong must not report health for an unresponsive tunnel.
                    try await upstream.sendPing()
                    try await writer.send(opcode: 10, payload: bytes)
                case .pong: break
                case let .close(bytes):
                    try await writer.send(opcode: 8, payload: bytes)
                    let code = bytes
                        .isEmpty ? 1000 : ((Int(bytes[bytes.startIndex]) << 8) | Int(bytes[bytes.startIndex + 1]))
                    let reason = bytes.isEmpty ? nil : Data(bytes.dropFirst(2))
                    lifetime.cancel(
                        code: URLSessionWebSocketTask.CloseCode(rawValue: code) ?? .normalClosure,
                        reason: reason)
                    return
                }
            }
        } catch let error as MacNodeOpenClawIDBridgeWebSocketError {
            try? await writer.send(opcode: 8, payload: Data([
                UInt8(truncatingIfNeeded: error.code >> 8), UInt8(truncatingIfNeeded: error.code),
            ]))
            throw error
        }
    }

    private static func readHeader(_ reader: MacNodeOpenClawIDBridgeReader) async throws -> Codec.Header {
        var bytes = try await reader.exactly(2)
        let tag = bytes[bytes.startIndex + 1] & 0x7F
        if tag == 126 { try await bytes.append(reader.exactly(2)) }
        if tag == 127 { try await bytes.append(reader.exactly(8)) }
        return try Codec.Header.parse(bytes)
    }

    private static func toWorker(
        writer: MacNodeOpenClawIDBridgeWebSocketWriter, upstream: WebSocketTaskBox) async throws
    {
        do {
            while true {
                switch try await upstream.receive() {
                case let .string(text): try await writer.send(opcode: 1, payload: Data(text.utf8))
                case let .data(bytes): try await writer.send(opcode: 2, payload: bytes)
                @unknown default: throw MacNodeOpenClawIDBridgeWebSocketError.framing
                }
            }
        } catch let OpenClawIDNodeTransportError.webSocketClosed(code, reason) {
            // Worker admission/fencing reasons determine retry behavior. Preserve a
            // real remote close, but never synthesize one for other transport errors.
            var payload = Data()
            if let code {
                guard reason.utf8.count <= 123 else { throw MacNodeOpenClawIDBridgeWebSocketError.tooLarge }
                payload.append(contentsOf: [UInt8(truncatingIfNeeded: code >> 8), UInt8(truncatingIfNeeded: code)])
                payload.append(contentsOf: reason.utf8)
            } else if !reason.isEmpty {
                throw MacNodeOpenClawIDBridgeWebSocketError.framing
            }
            // The writer validates RFC close codes and payload size before enqueueing.
            try await writer.send(opcode: 8, payload: payload)
        }
    }
}
