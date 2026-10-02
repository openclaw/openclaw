import Foundation
import OpenClawKit

enum SidecarRuntimeMessage {
    case control([String: Any])
    case transport(TransportWrite)

    struct TransportWrite {
        enum Kind: UInt8 { case text = 1, binary = 2, ping = 3, close = 4 }
        let id: UInt64
        let kind: Kind
        let message: URLSessionWebSocketTask.Message?

        init(_ payload: Data) throws {
            guard payload.count >= 9, payload.count - 9 <= NativeGatewayTransport.maximumMessageBytes,
                  let first = payload.first, let kind = Kind(rawValue: first)
            else { throw URLError(.cannotParseResponse) }
            let id = payload.dropFirst().prefix(8).reduce(UInt64(0)) { ($0 << 8) | UInt64($1) }
            guard id != 0 else { throw URLError(.cannotParseResponse) }
            let body = payload.dropFirst(9)
            self.id = id
            self.kind = kind
            switch kind {
            case .text:
                guard let text = body.withUnsafeBytes({ String(validating: $0, as: UTF8.self) })
                else { throw URLError(.cannotParseResponse) }
                self.message = .string(text)
            case .binary: self.message = .data(body)
            case .ping, .close:
                guard body.isEmpty else { throw URLError(.cannotParseResponse) }
                self.message = nil
            }
        }
    }

    init(_ payload: Data) throws {
        let start = payload.drop(while: { [0x20, 0x09, 0x0A, 0x0D].contains($0) })
        guard start.first == 0x7B, start.dropFirst().first != 0,
              let control = try JSONSerialization.jsonObject(with: payload) as? [String: Any],
              control["type"] as? String != "transport-send"
        else { throw URLError(.cannotParseResponse) }
        self = .control(control)
    }

    init(transport payload: Data) throws {
        self = try .transport(TransportWrite(payload))
    }
}

/// URLSession owns the real socket, system proxy/PAC routing, DNS and TLS challenge.
/// Rust owns the Gateway protocol and node execution; one acknowledged message per direction
/// bounds the relay without making the IPC reader wait for network or pipe writes.
final class NativeGatewayTransport: @unchecked Sendable {
    static let maximumMessageBytes = 25 * 1024 * 1024
    private let lock = NSLock()
    private let socket: WebSocketTaskBox
    private let write: @Sendable (SidecarPayload, SidecarWriteQueue.Lane) async throws -> Void
    private let failed: @Sendable (any Error) -> Void
    private var stopped = false
    private var sending = false
    private var pendingMessage: URLSessionWebSocketTask.Message?
    private var ping: Task<Void, Never>?
    private var receipt: CheckedContinuation<Void, any Error>?
    private var receiver: Task<Void, Never>?

    init(
        socket: WebSocketTaskBox,
        write: @escaping @Sendable (SidecarPayload, SidecarWriteQueue.Lane) async throws -> Void,
        failed: @escaping @Sendable (any Error) -> Void)
    {
        self.socket = socket
        self.write = write
        self.failed = failed
        // The Gateway admits native media up to 25 MiB. Preserve that limit before
        // URLSession allocates a message, independently of the larger IPC envelope.
        (socket.task as? URLSessionWebSocketTask)?.maximumMessageSize = Self.maximumMessageBytes
    }

    func start() {
        self.lock.withLock {
            guard !self.stopped, self.receiver == nil else { return }
            self.socket.resume()
            self.receiver = Task { [self] in
                do {
                    while !Task.isCancelled {
                        var payload: SidecarPayload? = try await self.receivePayload()
                        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<
                            Void,
                            any Error,
                        >) in
                            let accepted = self.lock.withLock {
                                guard !self.stopped, self.receipt == nil else { return false }
                                self.receipt = continuation
                                return true
                            }
                            guard accepted else { continuation.resume(throwing: URLError(.cancelled))
                                return
                            }
                            guard let outgoing = payload else {
                                continuation.resume(throwing: URLError(.cancelled))
                                return
                            }
                            // The writer task owns these bytes only until the pipe write finishes;
                            // the receiver waiting for its receipt must not retain another copy.
                            payload = nil
                            Task {
                                do { try await self.write(outgoing, .transport) } catch { self.fail(error) }
                            }
                        }
                    }
                } catch { self.fail(error) }
            }
        }
    }

    func received() throws {
        let receipt = self.lock.withLock { () -> CheckedContinuation<Void, any Error>? in
            defer { self.receipt = nil }
            return self.receipt
        }
        guard let receipt else { throw URLError(.cannotParseResponse) }
        receipt.resume()
    }

    private func receivePayload() async throws -> SidecarPayload {
        let kind: SidecarRuntimeMessage.TransportWrite.Kind
        let body: SidecarPayload.Body
        switch try await self.socket.receive() {
        case let .string(text): kind = .text
            body = .utf8(text)
        case let .data(data): kind = .binary
            body = .data(data)
        @unknown default: throw URLError(.cannotParseResponse)
        }
        guard body.count <= Self.maximumMessageBytes else { throw URLError(.dataLengthExceedsMaximum) }
        // Native receive records have no write receipt ID. The shared authenticated
        // channel supplies ordering; Gateway bytes stay outside JSON and base64.
        return SidecarPayload(
            body: body,
            prefix: Data([kind.rawValue] + Array(repeating: 0, count: 8)),
            format: .transport)
    }

    func send(_ write: SidecarRuntimeMessage.TransportWrite) throws {
        let id = write.id
        let kind = write.kind
        let accepted = self.lock.withLock {
            guard !self.stopped, !self.sending, kind != .ping || self.ping == nil else { return false }
            self.sending = true
            self.pendingMessage = write.message
            return true
        }
        guard accepted else { throw URLError(.networkConnectionLost) }
        Task {
            do {
                // The task takes the admitted message instead of capturing it. Its bytes
                // can then be released before awaiting the receipt that admits the next send.
                var message = try self.lock.withLock {
                    guard !self.stopped else { throw URLError(.cancelled) }
                    defer { self.pendingMessage = nil }
                    return self.pendingMessage
                }
                switch kind {
                case .text, .binary:
                    guard let message else {
                        throw URLError(.cannotParseResponse)
                    }
                    try await self.socket.send(message)
                case .ping: self.startPing(id: id)
                case .close: self.socket.cancel(with: .normalClosure, reason: nil)
                }
                message = nil
                self.lock.withLock { self.sending = false }
                try await self.write(SidecarPayload(JSONSerialization.data(withJSONObject: [
                    "type": "transport-sent", "id": id, "ok": true,
                ])), .receipt)
            } catch { self.fail(error) }
        }
    }

    private func startPing(id: UInt64) {
        self.lock.withLock {
            guard !self.stopped else { return }
            // URLSession only processes Pong while receive is progressing. Report submission
            // independently so Rust can consume the frame that releases the native reader.
            self.ping = Task { [self] in
                let ok: Bool
                do { try await self.socket.sendPing()
                    ok = true
                } catch { ok = false }
                let report = self.lock.withLock {
                    guard !self.stopped else { return false }
                    self.ping = nil
                    return true
                }
                guard report else { return }
                do {
                    try await self.write(SidecarPayload(JSONSerialization.data(withJSONObject: [
                        "type": "transport-pong", "id": id, "ok": ok,
                    ])), .pong)
                } catch { self.fail(error) }
            }
        }
    }

    func close() {
        let retired = self.lock.withLock { () -> (
            Task<Void, Never>?,
            Task<Void, Never>?,
            CheckedContinuation<Void, any Error>?) in
            self.stopped = true
            self.pendingMessage = nil
            defer { self.receiver = nil
                self.ping = nil
                self.receipt = nil
            }
            return (self.receiver, self.ping, self.receipt)
        }
        self.socket.cancel(with: .goingAway, reason: nil)
        retired.0?.cancel()
        retired.1?.cancel()
        retired.2?.resume(throwing: URLError(.cancelled))
    }

    private func fail(_ error: any Error) {
        let report = self.lock.withLock { !self.stopped }
        self.close()
        if report { self.failed(error) }
    }
}
