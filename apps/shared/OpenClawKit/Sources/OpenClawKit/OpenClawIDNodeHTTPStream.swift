import Foundation

/// Streaming resource transfer through the same W/connection as the native node socket.
/// No URLSession fallback and no body collection; callers await each bounded DATA write.
public actor OpenClawIDNodeHTTPStream {
    private let tunnel: OpenClawIDNodeTunnel
    private let reader: OpenClawIDNodeFrameReader
    private let stream: any OpenClawIDNodeStream
    private var head: Task<OpenClawIDNodeTunnelCodec.ResponseHead, Error>?
    private var writer: Task<Void, Error>?
    private var finishedBody = false
    private var canceled = false

    private init(tunnel: OpenClawIDNodeTunnel, stream: any OpenClawIDNodeStream) {
        self.tunnel = tunnel
        self.stream = stream
        self.reader = OpenClawIDNodeFrameReader(stream: stream)
    }

    public static func open(
        tunnel: OpenClawIDNodeTunnel, method: String, path: String, headers: [[String]] = []) async throws
        -> OpenClawIDNodeHTTPStream
    {
        let bytes = try OpenClawIDNodeTunnelCodec.requestHead(path: path, headers: headers, method: method)
        let stream = try await tunnel.openStream()
        do {
            try await openClawIDNodeDeadline(.seconds(10), clock: .init()) { try await stream.write(bytes) }
            return OpenClawIDNodeHTTPStream(tunnel: tunnel, stream: stream)
        } catch {
            await stream.reset(code: 4)
            await stream.stop(code: 4)
            throw error
        }
    }

    public func writeBody(_ bytes: Data) async throws {
        guard !self.canceled, !self.finishedBody else { throw OpenClawIDNodeTransportError.closed }
        let frame = try OpenClawIDNodeTunnelCodec.frame(bytes, limit: OpenClawIDNodeTunnelProtocol.maximumHTTPDataBytes)
        let previous = self.writer
        let stream = self.stream
        let task = Task {
            if let previous { try await previous.value }
            try Task.checkCancellation()
            try await openClawIDNodeDeadline(.seconds(120), clock: .init()) { try await stream.write(frame) }
        }
        self.writer = task
        do {
            try await withTaskCancellationHandler { try await task.value } onCancel: { task.cancel() }
        } catch {
            await self.cancel()
            throw error
        }
    }

    public func finishBody() async throws {
        guard !self.canceled, !self.finishedBody else { throw OpenClawIDNodeTransportError.closed }
        self.finishedBody = true
        do {
            if let writer = self.writer { try await writer.value }
            try Task.checkCancellation()
            try await self.stream.finish()
        } catch {
            await self.cancel()
            throw error
        }
    }

    public func responseHead() async throws -> OpenClawIDNodeTunnelCodec.ResponseHead {
        guard !self.canceled else { throw OpenClawIDNodeTransportError.closed }
        if let head = self.head { return try await self.waitForHead(head) }
        let reader = self.reader
        let tunnel = self.tunnel
        let task = Task {
            try await openClawIDNodeDeadline(.seconds(120), clock: .init()) {
                guard let bytes = try await reader.next(limit: OpenClawIDNodeTunnelProtocol.maximumHeadBytes) else {
                    throw OpenClawIDNodeTransportError.truncatedFrame
                }
                let response = try OpenClawIDNodeTunnelCodec.responseHead(bytes)
                guard response.status != 101 else { throw OpenClawIDNodeTransportError.invalidHead }
                await tunnel.received()
                return response
            }
        }
        self.head = task
        return try await self.waitForHead(task)
    }

    private func waitForHead(
        _ task: Task<OpenClawIDNodeTunnelCodec.ResponseHead, Error>) async throws
        -> OpenClawIDNodeTunnelCodec.ResponseHead
    {
        do {
            return try await withTaskCancellationHandler {
                try Task.checkCancellation()
                return try await task.value
            } onCancel: {
                task.cancel()
                Task { await self.cancel() }
            }
        } catch {
            await self.cancel()
            throw error
        }
    }

    public func nextBody() async throws -> Data? {
        _ = try await self.responseHead()
        let reader = self.reader
        do {
            let bytes = try await openClawIDNodeDeadline(.seconds(120), clock: .init()) {
                try await reader.next(limit: OpenClawIDNodeTunnelProtocol.maximumHTTPDataBytes)
            }
            if bytes != nil { await self.tunnel.received() }
            return bytes
        } catch {
            await self.cancel()
            throw error
        }
    }

    public func cancel() async {
        guard !self.canceled else { return }
        self.canceled = true
        self.head?.cancel()
        self.writer?.cancel()
        await self.stream.reset(code: 4)
        await self.stream.stop(code: 4)
    }
}
