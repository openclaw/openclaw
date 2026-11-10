#if os(macOS) || os(iOS)
import Foundation
#if OPENCLAW_IROH_NATIVE
import OpenClawIroh

/// In-process W owner. The caller must await shutdown when retiring its enrolled route.
/// Discovery, pins and membership remain the enrollment/tunnel owners' responsibility.
public final class OpenClawIDNodeNativeEndpoint: OpenClawIDNodeEndpoint, Sendable {
    private let native: OpenClawIroh.Endpoint
    private let relayState = OpenClawIDNodeNativeRelayState()
    private let relayWatcher: Task<Void, Never>

    public static func bind(identity: OpenClawIDNodeIdentity, relayURL: URL) async throws -> Self {
        try Task.checkCancellation()
        let native = try await identity.withNativeSeed { seed in
            try await OpenClawIroh.bind(
                secretKey: seed,
                relayUrl: relayURL.absoluteString,
                alpns: [],
                ipTransports: true,
                keepAliveMs: OpenClawIDNodeTunnelProtocol.keepAliveMilliseconds)
        }
        if Task.isCancelled {
            await native.shutdown()
            throw CancellationError()
        }
        let endpoint = await Self(native: native)
        if Task.isCancelled {
            await endpoint.shutdown()
            throw CancellationError()
        }
        return endpoint
    }

    private init(native: OpenClawIroh.Endpoint) async {
        self.native = native
        let watcher = await native.watchHomeRelay()
        let state = self.relayState
        self.relayWatcher = Task {
            while let statuses = await watcher.next() {
                await state.update(statuses.map {
                    OpenClawIDNodeRelayStatus(connected: $0.connected, admissionDenied: $0.authDeniedReason != nil)
                })
            }
        }
    }

    public func connect(serverKey: String, relayURL: URL, alpn: Data) async throws -> any OpenClawIDNodeConnection {
        // The protocol owner uses iroh:<hex>; the native API accepts only bare hex.
        _ = try OpenClawIDNodeIdentity.unhex(serverKey, prefix: "iroh:")
        let token = OpenClawIroh.CancelToken()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let connection = try await self.native.connect(
                endpointId: String(serverKey.dropFirst(5)),
                alpn: alpn,
                relayUrl: relayURL.absoluteString,
                directAddrs: [],
                cancel: token)
            if Task.isCancelled {
                try? connection.close(code: 10, reason: Data())
                throw CancellationError()
            }
            return OpenClawIDNodeNativeConnection(native: connection)
        } onCancel: {
            // Also reached when the tunnel owner's deadline cancels its losing dial.
            // Tokens are single-dial; never cancel the shared endpoint for a probe.
            token.cancel()
        }
    }

    public func relayStatus() async -> [OpenClawIDNodeRelayStatus] {
        await self.relayState.statuses
    }

    public func shutdown() async {
        await self.native.shutdown()
        await self.relayWatcher.value
    }
}

private actor OpenClawIDNodeNativeRelayState {
    var statuses: [OpenClawIDNodeRelayStatus] = []
    func update(_ statuses: [OpenClawIDNodeRelayStatus]) {
        self.statuses = statuses
    }
}

final class OpenClawIDNodeNativeConnection: OpenClawIDNodeConnection, Sendable {
    private let native: OpenClawIroh.Connection
    private let closure = OpenClawIDNodeNativeClosure()
    private let monitor: Task<Void, Never>

    init(native: OpenClawIroh.Connection) {
        self.native = native
        let closure = self.closure
        // One lifetime FFI future. Swift cancellation cannot retire this Rust future;
        // admission timers and close watchers subscribe through cancellable Swift waits.
        self.monitor = Task {
            let info = await native.closed()
            let kind: OpenClawIDNodeClose.Kind = switch info.kind {
            case .application: .application
            case .locallyClosed: .local
            case .timedOut: .timedOut
            case .reset: .reset
            case .transport: .transport
            }
            await closure.complete(.init(code: info.code, kind: kind))
        }
    }

    deinit {
        // The monitor retains the foreign handle until closed() completes.
        try? self.native.close(code: 0, reason: Data())
    }

    func openBi() async throws -> any OpenClawIDNodeStream {
        let token = OpenClawIroh.CancelToken()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let stream = try await self.native.openBi(cancel: token)
            if Task.isCancelled {
                try? await stream.send.reset(code: 4)
                try? await stream.recv.stop(code: 4)
                throw CancellationError()
            }
            return OpenClawIDNodeNativeStream(native: stream, connection: self)
        } onCancel: {
            // Cancel only this peer-credit wait, preserving concurrent streams.
            token.cancel()
        }
    }

    func closed() async throws -> OpenClawIDNodeClose {
        try await self.closure.wait()
    }

    func close(code: Int64) async {
        try? self.native.close(code: code, reason: Data())
    }
}

/// Cancellation removes just the subscriber, not the connection-lifetime observation.
actor OpenClawIDNodeNativeClosure {
    private var result: OpenClawIDNodeClose?
    private var waiters: [UUID: CheckedContinuation<OpenClawIDNodeClose, any Error>] = [:]

    func wait() async throws -> OpenClawIDNodeClose {
        let id = UUID()
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            if let result = self.result { return result }
            return try await withCheckedThrowingContinuation { self.waiters[id] = $0 }
        } onCancel: {
            Task { await self.cancel(id) }
        }
    }

    func complete(_ result: OpenClawIDNodeClose) {
        guard self.result == nil else { return }
        self.result = result
        let waiters = self.waiters.values
        self.waiters.removeAll()
        for waiter in waiters {
            waiter.resume(returning: result)
        }
    }

    private func cancel(_ id: UUID) {
        self.waiters.removeValue(forKey: id)?.resume(throwing: CancellationError())
    }
}

private struct OpenClawIDNodeNativeStream: OpenClawIDNodeStream {
    let native: OpenClawIroh.BiStream
    /// Keep the connection owner alive even if a caller retains only a stream.
    let connection: OpenClawIDNodeNativeConnection

    func read(maxBytes: Int) async throws -> Data? {
        guard (1...1_048_576).contains(maxBytes) else { throw OpenClawIDNodeTransportError.oversizedFrame }
        return try await withTaskCancellationHandler {
            try Task.checkCancellation()
            let bytes = try await self.native.recv.read(max: UInt32(maxBytes))
            try Task.checkCancellation()
            return bytes
        } onCancel: {
            Task { try? await self.native.recv.stop(code: 4) }
        }
    }

    func write(_ bytes: Data) async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await self.native.send.write(data: bytes)
            try Task.checkCancellation()
        } onCancel: {
            // A canceled partial write is not retryable; reset the whole send half.
            Task { try? await self.native.send.reset(code: 4) }
        }
    }

    func finish() async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await self.native.send.finish()
        } onCancel: {
            Task { try? await self.native.send.reset(code: 4) }
        }
    }

    func reset(code: Int64) async {
        try? await self.native.send.reset(code: code)
    }

    func stop(code: Int64) async {
        try? await self.native.recv.stop(code: code)
    }
}
#else
/// The default app build does not package the experimental native transport.
public final class OpenClawIDNodeNativeEndpoint: OpenClawIDNodeEndpoint, Sendable {
    private init() {}

    public static func bind(identity: OpenClawIDNodeIdentity, relayURL: URL) async throws -> Self {
        throw OpenClawIDNodeNativePackagingError.notPackaged
    }

    public func connect(serverKey: String, relayURL: URL, alpn: Data) async throws -> any OpenClawIDNodeConnection {
        throw OpenClawIDNodeNativePackagingError.notPackaged
    }

    public func relayStatus() async -> [OpenClawIDNodeRelayStatus] {
        []
    }

    public func shutdown() async {}
}

public enum OpenClawIDNodeNativePackagingError: Error, LocalizedError {
    case notPackaged

    public var errorDescription: String? {
        "Native transport not packaged. Build the Apple XCFramework and rebuild with OPENCLAW_IROH_NATIVE=1."
    }
}
#endif
#endif
