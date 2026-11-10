import Foundation

struct OpenClawIDNodeClock: Sendable {
    var now: @Sendable () -> TimeInterval = { ProcessInfo.processInfo.systemUptime }
    var sleep: @Sendable (Duration) async throws -> Void = { try await Task.sleep(for: $0) }
}

/// The FFI boundary must cancel pending operations when the losing deadline task is canceled.
func openClawIDNodeDeadline<T: Sendable>(
    _ duration: Duration,
    clock: OpenClawIDNodeClock,
    operation: @escaping @Sendable () async throws -> T) async throws -> T
{
    try await withThrowingTaskGroup(of: T.self) { group in
        group.addTask { try await operation() }
        group.addTask {
            try await clock.sleep(duration)
            throw OpenClawIDNodeTransportError.deadline
        }
        defer { group.cancelAll() }
        guard let result = try await group.next() else { throw CancellationError() }
        return result
    }
}

/// One verified target and W per owner. GatewayChannelActor still owns WS reconnection;
/// this owner reuses the QUIC connection and refuses all future dials after removal.
public actor OpenClawIDNodeTunnel {
    private let endpoint: any OpenClawIDNodeEndpoint
    private let serverKey: String
    private let relayURL: URL
    private let clock: OpenClawIDNodeClock
    private var pending: Task<any OpenClawIDNodeConnection, Error>?
    private var active: (id: UUID, connection: any OpenClawIDNodeConnection)?
    private var closeWatcher: Task<Void, Never>?
    private var watchdog: Task<Void, Never>?
    private var probe: Task<Void, Error>?
    private var stopped = false
    private var removed = false
    private var generation: UInt64 = 0
    private var lastReceived: TimeInterval
    private var lastProbe = -Double.infinity
    private var nextDial = -Double.infinity
    private var denialBackoff: TimeInterval = 10

    /// The caller must supply K_srv from a verified binding and commit its pin first.
    public init(endpoint: any OpenClawIDNodeEndpoint, verifiedServerKey: String, relayURL: URL) {
        self.init(endpoint: endpoint, verifiedServerKey: verifiedServerKey, relayURL: relayURL, clock: .init())
    }

    init(endpoint: any OpenClawIDNodeEndpoint, verifiedServerKey: String, relayURL: URL, clock: OpenClawIDNodeClock) {
        self.endpoint = endpoint
        self.serverKey = verifiedServerKey
        self.relayURL = relayURL
        self.clock = clock
        self.lastReceived = clock.now()
    }

    public func received() {
        self.lastReceived = self.clock.now()
    }

    private func checkActive() throws {
        if self.removed { throw OpenClawIDNodeTransportError.removed }
        if self.stopped { throw OpenClawIDNodeTransportError.closed }
        try Task.checkCancellation()
    }

    private func dial() async throws -> any OpenClawIDNodeConnection {
        try self.checkActive()
        let delay = max(0, self.nextDial - self.clock.now())
        if delay > 0 { try await self.clock.sleep(.seconds(delay)) }
        try self.checkActive()
        let endpoint = self.endpoint
        let key = self.serverKey
        let relay = self.relayURL
        let clock = self.clock
        do {
            let connection = try await openClawIDNodeDeadline(.seconds(5), clock: clock) {
                let connection = try await endpoint.connect(
                    serverKey: key, relayURL: relay, alpn: OpenClawIDNodeTunnelProtocol.alpn)
                if Task.isCancelled {
                    await connection.close(code: 10)
                    throw CancellationError()
                }
                return connection
            }
            do {
                // QUIC establishment precedes the server's membership check.
                let close = try await withThrowingTaskGroup(of: OpenClawIDNodeClose?.self) { group in
                    group.addTask { try await connection.closed() }
                    group.addTask { try await clock.sleep(.milliseconds(500))
                        return nil
                    }
                    defer { group.cancelAll() }
                    return try await group.next().flatMap(\.self)
                }
                if let close {
                    if close.requiresReenrollment {
                        await self.markRemoved()
                        throw OpenClawIDNodeTransportError.removed
                    }
                    throw OpenClawIDNodeTransportError.closed
                }
                try self.checkActive()
                self.denialBackoff = 10
                self.nextDial = -Double.infinity
                return connection
            } catch {
                await connection.close(code: 0)
                throw error
            }
        } catch {
            if !self.stopped, !self.removed,
               await endpoint.relayStatus().contains(where: \.admissionDenied)
            {
                self.nextDial = self.clock.now() + self.denialBackoff
                self.denialBackoff = min(120, self.denialBackoff * 2)
            }
            throw error
        }
    }

    private func connection() async throws -> any OpenClawIDNodeConnection {
        try self.checkActive()
        if let active = self.active { return active.connection }
        if let pending = self.pending { return try await pending.value }
        let generation = self.generation
        let task = Task { try await self.dial() }
        self.pending = task
        do {
            let connection = try await task.value
            guard generation == self.generation, !self.stopped, !self.removed else {
                await connection.close(code: 0)
                try self.checkActive()
                throw CancellationError()
            }
            self.pending = nil
            let id = UUID()
            self.active = (id, connection)
            self.lastReceived = self.clock.now()
            self.closeWatcher = Task { [weak self] in
                do {
                    let close = try await connection.closed()
                    await self?.didClose(id: id, close: close)
                } catch {
                    if !Task.isCancelled { await self?.didClose(id: id, close: .init(code: nil, kind: .transport)) }
                }
            }
            if self.watchdog == nil {
                let clock = self.clock
                self.watchdog = Task { [weak self] in
                    while !Task.isCancelled {
                        do { try await clock.sleep(.seconds(3)) } catch { return }
                        await self?.checkSilence()
                    }
                }
            }
            return connection
        } catch {
            if generation == self.generation { self.pending = nil }
            throw error
        }
    }

    private func didClose(id: UUID, close: OpenClawIDNodeClose) async {
        guard self.active?.id == id else { return }
        self.active = nil
        if close.requiresReenrollment { await self.markRemoved() }
    }

    private func markRemoved() async {
        self.removed = true
        await self.shutdown()
    }

    public func openStream() async throws -> any OpenClawIDNodeStream {
        let connection = try await self.connection()
        try self.checkActive()
        let stream = try await connection.openBi()
        do { try self.checkActive() } catch {
            await stream.reset(code: 4)
            await stream.stop(code: 4)
            throw error
        }
        return stream
    }

    private func checkSilence() async {
        guard self.active != nil, self.clock.now() - self.lastReceived >= 3,
              self.clock.now() - self.lastProbe >= 5 else { return }
        try? await self.checkLiveness()
    }

    /// tunnel/1 has no WS ping opcode. A fresh admitted connection supplies the real check.
    public func checkLiveness() async throws {
        try self.checkActive()
        if let probe = self.probe { return try await probe.value }
        let current = self.active
        self.lastProbe = self.clock.now()
        let task = Task {
            let connection = try await self.dial()
            await connection.close(code: 0)
        }
        self.probe = task
        do {
            try await task.value
            self.probe = nil
            try self.checkActive()
            self.lastReceived = self.clock.now()
        } catch {
            self.probe = nil
            if let current, self.active?.id == current.id {
                self.active = nil
                await current.connection.close(code: 10)
            }
            throw error
        }
    }

    public func shutdown() async {
        guard !self.stopped else { return }
        self.stopped = true
        self.generation &+= 1
        self.pending?.cancel()
        self.pending = nil
        self.probe?.cancel()
        self.probe = nil
        self.watchdog?.cancel()
        self.watchdog = nil
        self.closeWatcher?.cancel()
        self.closeWatcher = nil
        self.active = nil
        await self.endpoint.shutdown()
    }
}
