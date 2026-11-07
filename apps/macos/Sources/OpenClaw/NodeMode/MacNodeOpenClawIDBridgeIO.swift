import Darwin
import Foundation

/// Errors intentionally omit socket paths, HTTP headers and worker credentials.
enum MacNodeOpenClawIDBridgeError: Error {
    case unavailable
    case malformedRequest
    case limitExceeded
    case closed
}

/// One accepted descriptor, owned and closed by LocalSocketServer. Blocking Darwin I/O
/// runs on dedicated dispatch queues, never the Swift cooperative executor. Shutdown
/// wakes both queues without closing a descriptor that an operation is still using.
final class MacNodeOpenClawIDBridgeIO: Sendable {
    private let descriptor: Int32
    private let readQueue = DispatchQueue(label: "ai.openclaw.node-bridge.read")
    private let writeQueue = DispatchQueue(label: "ai.openclaw.node-bridge.write")
    static let blockBytes = 64 * 1024

    init(handle: FileHandle) throws {
        self.descriptor = handle.fileDescriptor
        var timeout = timeval(tv_sec: 120, tv_usec: 0)
        guard setsockopt(self.descriptor, SOL_SOCKET, SO_RCVTIMEO, &timeout,
                        socklen_t(MemoryLayout<timeval>.size)) == 0,
              setsockopt(self.descriptor, SOL_SOCKET, SO_SNDTIMEO, &timeout,
                         socklen_t(MemoryLayout<timeval>.size)) == 0
        else { throw MacNodeOpenClawIDBridgeError.unavailable }
    }

    /// Reads one bounded chunk; the caller supplies framing and retains any remainder.
    func read() async throws -> Data {
        try Task.checkCancellation()
        return try await withCheckedThrowingContinuation { continuation in
            self.readQueue.async {
                var bytes = [UInt8](repeating: 0, count: Self.blockBytes)
                var count: Int
                repeat { count = Darwin.recv(self.descriptor, &bytes, Self.blockBytes, 0) } while count < 0 && errno == EINTR
                guard count > 0 else {
                    continuation.resume(throwing: MacNodeOpenClawIDBridgeError.closed)
                    return
                }
                continuation.resume(returning: Data(bytes.prefix(count)))
            }
        }
    }

    /// Serializes complete writes and waits for kernel backpressure before returning.
    func write(_ bytes: Data) async throws {
        try Task.checkCancellation()
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            self.writeQueue.async {
                let succeeded = bytes.withUnsafeBytes { raw in
                    var offset = 0
                    while offset < raw.count {
                        let count = Darwin.send(self.descriptor, raw.baseAddress!.advanced(by: offset), raw.count - offset, 0)
                        if count < 0, errno == EINTR { continue }
                        guard count > 0 else { return false }
                        offset += count
                    }
                    return true
                }
                if succeeded { continuation.resume() } else {
                    continuation.resume(throwing: MacNodeOpenClawIDBridgeError.closed)
                }
            }
        }
    }

    /// Must run while LocalSocketServer still owns the descriptor.
    func interrupt() { _ = Darwin.shutdown(self.descriptor, SHUT_RDWR) }
}

/// Single-consumer buffered reader shared by HTTP framing and the upgraded WebSocket.
actor MacNodeOpenClawIDBridgeReader {
    private let io: MacNodeOpenClawIDBridgeIO
    private var buffer = Data()

    init(io: MacNodeOpenClawIDBridgeIO) { self.io = io }

    /// Consumes through a delimiter without accepting an unbounded header or chunk line.
    func through(_ delimiter: Data, limit: Int) async throws -> Data {
        while true {
            if let range = self.buffer.range(of: delimiter) {
                let count = self.buffer.distance(from: self.buffer.startIndex, to: range.upperBound)
                guard count <= limit else { throw MacNodeOpenClawIDBridgeError.limitExceeded }
                let result = Data(self.buffer.prefix(count))
                self.buffer.removeFirst(count)
                return result
            }
            guard self.buffer.count < limit else { throw MacNodeOpenClawIDBridgeError.limitExceeded }
            self.buffer.append(try await self.io.read())
        }
    }

    /// Reads at most count bytes; large bodies are never accumulated in this reader.
    func portion(_ count: Int) async throws -> Data {
        guard count > 0 else { return Data() }
        if self.buffer.isEmpty { self.buffer = try await self.io.read() }
        let amount = min(count, self.buffer.count)
        let result = Data(self.buffer.prefix(amount))
        self.buffer.removeFirst(amount)
        return result
    }

    /// Used only after validating a fixed-width field or bounded WS payload length.
    func exactly(_ count: Int) async throws -> Data {
        var result = Data()
        while result.count < count { result.append(try await self.portion(count - result.count)) }
        return result
    }
}
