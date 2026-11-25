import Darwin
import Foundation
import OpenClawKit
import OSLog

/// Route-scoped, owner-private Unix HTTP/WS bridge. The coordinator owns start/shutdown;
/// this owner never closes the shared tunnel and never receives or serializes W.
actor MacNodeOpenClawIDBridge {
    /// A handler owns bounded framing, upstream upgrade and cancellation, and must
    /// finish all descriptor operations before returning. Production uses the shared
    /// transport's dedicated worker admission path, never the node/operator factory.
    typealias WorkerWebSocketHandler = @Sendable (
        MacNodeOpenClawIDBridgeRequest, MacNodeOpenClawIDBridgeReader, MacNodeOpenClawIDBridgeIO) async throws -> Void

    nonisolated let socketPath: String
    /// Existing Bun transfer and worker endpoint owners already understand ws+unix.
    nonisolated var gatewayURL: String {
        "ws+unix:\(self.socketPath):/"
    }

    private let directory: String
    private let server: LocalSocketServer
    private let tunnel: OpenClawIDNodeTunnel
    private let workerWebSocket: WorkerWebSocketHandler
    private var stopping: Task<Void, Never>?

    private init(directory: String, tunnel: OpenClawIDNodeTunnel, workerWebSocket: @escaping WorkerWebSocketHandler) {
        self.directory = directory
        self.socketPath = directory + "/gateway.sock"
        self.server = LocalSocketServer(
            socketPath: self.socketPath,
            logger: Logger(subsystem: "ai.openclaw", category: "node-id-bridge"))
        self.tunnel = tunnel
        self.workerWebSocket = workerWebSocket
    }

    /// Creates a short random 0700 directory before binding. LocalSocketServer owns
    /// socket hardening (0600), accepted clients, shutdown and inode-checked unlink.
    static func start(
        tunnel: OpenClawIDNodeTunnel,
        logicalOrigin: URL,
        workerWebSocket: WorkerWebSocketHandler? = nil,
        onUnexpectedStop: @escaping @Sendable () -> Void) async throws -> MacNodeOpenClawIDBridge
    {
        let session = OpenClawIDNodeWebSocketSession(tunnel: tunnel, logicalOrigin: logicalOrigin)
        let handler: WorkerWebSocketHandler = workerWebSocket ?? { request, reader, io in
            try await MacNodeOpenClawIDBridgeWebSocket.serve(request: request, reader: reader, io: io) {
                try await session.prepareWorkerWebSocket()
            }
        }
        var template = Array("/tmp/oc-node-XXXXXX".utf8CString)
        guard let path = mkdtemp(&template) else { throw MacNodeOpenClawIDBridgeError.unavailable }
        let directory = String(cString: path)
        let bridge = MacNodeOpenClawIDBridge(directory: directory, tunnel: tunnel, workerWebSocket: handler)
        guard chmod(directory, 0o700) == 0 else {
            try? FileManager.default.removeItem(atPath: directory)
            throw MacNodeOpenClawIDBridgeError.unavailable
        }
        let ready = await bridge.server.start(handler: { [weak bridge] handle in
            await bridge?.serve(handle)
        }, onUnexpectedStop: { [weak bridge] in
            onUnexpectedStop()
            Task { await bridge?.shutdown() }
        })
        guard ready, !Task.isCancelled else {
            await bridge.shutdown()
            throw MacNodeOpenClawIDBridgeError.unavailable
        }
        return bridge
    }

    /// Idempotently drains accepted handlers before deleting only this route's directory.
    func shutdown() async {
        if let stopping = self.stopping { await stopping.value
            return
        }
        let server = self.server
        let directory = self.directory
        let stopping = Task {
            await server.stop().value
            try? FileManager.default.removeItem(atPath: directory)
        }
        self.stopping = stopping
        await stopping.value
    }

    private func serve(_ handle: FileHandle) async {
        // The tunnel's stream credit owns admission and queueing for this private
        // listener; local handlers only refuse new work during route retirement.
        guard self.stopping == nil else { return }
        guard let io = try? MacNodeOpenClawIDBridgeIO(handle: handle) else { return }
        let reader = MacNodeOpenClawIDBridgeReader(io: io)
        do {
            try await withTaskCancellationHandler {
                let bytes = try await reader.through(
                    Data([13, 10, 13, 10]), limit: MacNodeOpenClawIDBridgeRequest.maximumHeadBytes)
                let request = try MacNodeOpenClawIDBridgeRequest.parse(bytes)
                try Task.checkCancellation()
                if request.isWebSocket {
                    guard request.path == "/__openclaw__/worker" else {
                        try await io.write(Data(
                            "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n".utf8))
                        return
                    }
                    try await self.workerWebSocket(request, reader, io)
                } else {
                    try await MacNodeOpenClawIDBridgeHTTP.serve(
                        request: request, reader: reader, io: io, tunnel: self.tunnel)
                }
            } onCancel: { io.interrupt() }
        } catch {
            // No second HTTP response after an unknown amount of output; close is
            // the only unambiguous failure signal for interrupted streaming bodies.
            io.interrupt()
        }
    }
}
