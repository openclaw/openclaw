import Foundation
import Synchronization
import Testing
@testable import OpenClawKit

#if DEBUG
private final class PathRecoveryEvents<Value: Sendable>: Sendable {
    private struct State {
        var values: [Value] = []
        var waiters: [(Int, CheckedContinuation<Void, Never>)] = []
    }

    private let state = Mutex(State())

    func record(_ value: Value) {
        self.state.withLock { state in
            state.values.append(value)
            let valueCount = state.values.count
            state.waiters.removeAll { count, continuation in
                guard valueCount >= count else { return false }
                continuation.resume()
                return true
            }
        }
    }

    func wait(forCount count: Int) async {
        await withCheckedContinuation { continuation in
            self.state.withLock { state in
                if state.values.count >= count {
                    continuation.resume()
                } else {
                    state.waiters.append((count, continuation))
                }
            }
        }
    }

    var values: [Value] {
        self.state.withLock { $0.values }
    }
}

private final class PathRecoverySleep: Sendable {
    private let pending = Mutex<[UUID: CheckedContinuation<Void, Error>]>([:])
    let started = PathRecoveryEvents<Duration>()
    let cancelled = PathRecoveryEvents<Void>()

    func sleep(_ duration: Duration) async throws {
        let id = UUID()
        try await withTaskCancellationHandler {
            try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
                self.pending.withLock { pending in
                    if Task.isCancelled {
                        continuation.resume(throwing: CancellationError())
                    } else {
                        pending[id] = continuation
                    }
                }
                self.started.record(duration)
            }
        } onCancel: {
            let continuation = self.pending.withLock { $0.removeValue(forKey: id) }
            continuation?.resume(throwing: CancellationError())
            self.cancelled.record(())
        }
    }

    func release() {
        let continuations = self.pending.withLock { pending in
            defer { pending.removeAll() }
            return Array(pending.values)
        }
        continuations.forEach { $0.resume() }
    }
}

private struct PathRecoveryFixture: Sendable {
    static let wifi = GatewayNetworkPath(isSatisfied: true, interfaces: ["wifi"])
    static let cellular = GatewayNetworkPath(isSatisfied: true, interfaces: ["cellular"])
    static let offline = GatewayNetworkPath(isSatisfied: false, interfaces: [])

    let channel: GatewayChannelActor
    let session: FakeGatewayWebSocketSession
    let paths: AsyncStream<GatewayNetworkPath>.Continuation
    let observed = PathRecoveryEvents<GatewayNetworkPath>()
    let recovered = PathRecoveryEvents<Void>()
    let connectFinished = PathRecoveryEvents<Void>()
    let terminated: PathRecoveryEvents<Void>
    let settle = PathRecoverySleep()

    func emit(_ path: GatewayNetworkPath) async {
        let count = self.observed.values.count + 1
        self.paths.yield(path)
        await self.observed.wait(forCount: count)
    }

    func settleNext(_ path: GatewayNetworkPath) async {
        let count = self.settle.started.values.count + 1
        await self.emit(path)
        await self.settle.started.wait(forCount: count)
        self.settle.release()
    }
}

extension GatewayChannelActor {
    fileprivate func configurePathRecoveryTest(
        fixture: PathRecoveryFixture,
        probeTimeout: Duration,
        reconnectSleep: @escaping @Sendable (Duration) async throws -> Void)
    {
        let settle = fixture.settle
        let observed = fixture.observed
        let recovered = fixture.recovered
        let connectFinished = fixture.connectFinished
        let settleDuration = Duration.milliseconds(17)
        self.networkPathSettleDuration = settleDuration
        self.networkPathProbeTimeout = probeTimeout
        self.testRecoverySleep = { duration in
            if duration == settleDuration {
                try await settle.sleep(duration)
            } else {
                try await reconnectSleep(duration)
            }
        }
        self.testNetworkPathObserved = { observed.record($0) }
        self.testNetworkPathRecoveryFinished = { recovered.record(()) }
        self.testConnectRunFinishedHandler = { connectFinished.record(()) }
    }

    fileprivate func seedPathRecoveryReconnectBackoff(milliseconds: Double) {
        self.backoffMs = milliseconds
    }

    fileprivate func seedPathRecoveryConnectBackoff(_ sleep: PathRecoverySleep?) {
        for _ in 0..<7 {
            self.connectFailureBackoff.record(
                error: URLError(.networkConnectionLost),
                pendingDeviceTokenRetry: false,
                supportedProtocols: 3...4)
        }
        if let sleep {
            self.testConnectFailureBackoffWaitHandler = { try await sleep.sleep(.seconds(30)) }
        }
    }

    fileprivate func hasPathRecoveryConnectBackoff() -> Bool {
        self.connectFailureBackoff.deadline != nil
    }
}

private func withPathRecoveryFixture(
    probeTimeout: Duration = .seconds(5),
    reconnectSleep: @escaping @Sendable (Duration) async throws -> Void = { _ in },
    extraHeadersProvider: (@Sendable () async throws -> [String: String])? = nil,
    body: (PathRecoveryFixture) async throws -> Void) async throws
{
    let stream = AsyncStream<GatewayNetworkPath>.makeStream(bufferingPolicy: .bufferingNewest(1))
    let terminated = PathRecoveryEvents<Void>()
    stream.continuation.onTermination = { _ in terminated.record(()) }
    let session = FakeGatewayWebSocketSession()
    let channel = try GatewayChannelActor(
        url: #require(URL(string: "wss://gateway.example.invalid")),
        token: nil,
        session: WebSocketSessionBox(session: session),
        connectOptions: GatewayConnectOptions(
            role: "node", scopes: [], caps: [], commands: [], permissions: [:],
            clientId: "openclaw-ios-test", clientMode: "node", clientDisplayName: "iOS Test",
            includeDeviceIdentity: false,
            allowStoredDeviceAuth: false),
        extraHeadersProvider: extraHeadersProvider,
        networkPathUpdates: { stream.stream })
    let fixture = PathRecoveryFixture(
        channel: channel, session: session, paths: stream.continuation, terminated: terminated)
    await channel.configurePathRecoveryTest(
        fixture: fixture, probeTimeout: probeTimeout, reconnectSleep: reconnectSleep)
    do {
        try await body(fixture)
        await channel.shutdown()
    } catch {
        await channel.shutdown()
        stream.continuation.finish()
        throw error
    }
    stream.continuation.finish()
}

struct GatewayNetworkPathRecoveryTests {
    @Test
    func `missing pong after a settled path change retires requests and reconnects`() async throws {
        try await withPathRecoveryFixture(probeTimeout: .zero) { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.wifi)
            let oldSocket = try #require(fixture.session.latestTask())
            oldSocket.holdPongs()
            let pending = Task {
                try await fixture.channel.request(method: "health", params: nil, timeoutMs: 0)
            }
            await oldSocket.waitForSentRequests(method: "health", count: 1)

            await fixture.settleNext(PathRecoveryFixture.cellular)
            await fixture.recovered.wait(forCount: 1)
            await fixture.session.waitForTasks(count: 2)
            try await fixture.channel.connect()

            switch await pending.result {
            case .success:
                Issue.record("The retired socket left its request alive")
            case let .failure(error):
                #expect(error.localizedDescription == "gateway socket unresponsive after a network change")
            }
            #expect(oldSocket.snapshotPingCount() == 1)
            #expect(oldSocket.state == .canceling)
            #expect(fixture.session.snapshotMakeCount() == 2)
            #expect(fixture.session.latestTask()?.sentRequestCount(method: "connect") == 1)
            oldSocket.finishPongs()
        }
    }

    @Test
    func `healthy pong preserves the connected socket`() async throws {
        try await withPathRecoveryFixture { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.wifi)
            let socket = try #require(fixture.session.latestTask())
            let generation = await fixture.channel.currentConnectionGeneration()

            await fixture.settleNext(PathRecoveryFixture.cellular)
            await fixture.recovered.wait(forCount: 1)

            #expect(socket.snapshotPingCount() == 1)
            #expect(fixture.session.snapshotMakeCount() == 1)
            #expect(await fixture.channel.currentConnectionGeneration() == generation)
        }
    }

    @Test
    func `overlapping settled changes share one probe for a socket generation`() async throws {
        try await withPathRecoveryFixture { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.wifi)
            let socket = try #require(fixture.session.latestTask())
            socket.holdPongs()
            await fixture.settleNext(PathRecoveryFixture.cellular)
            await socket.waitForPings(count: 1)

            await fixture.settleNext(GatewayNetworkPath(isSatisfied: true, interfaces: ["vpn"]))
            await fixture.recovered.wait(forCount: 1)
            #expect(socket.snapshotPingCount() == 1)

            socket.finishPongs()
            await fixture.recovered.wait(forCount: 2)
            #expect(fixture.session.snapshotMakeCount() == 1)
            #expect(await fixture.channel.currentConnectionGeneration() != nil)
        }
    }

    @Test
    func `an old probe failure cannot retire a replacement socket`() async throws {
        try await withPathRecoveryFixture { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.wifi)
            let oldSocket = try #require(fixture.session.latestTask())
            oldSocket.holdPongs()
            await fixture.settleNext(PathRecoveryFixture.cellular)
            await oldSocket.waitForPings(count: 1)

            oldSocket.emitReceiveFailure()
            await fixture.session.waitForTasks(count: 2)
            try await fixture.channel.connect()
            let replacementGeneration = await fixture.channel.currentConnectionGeneration()
            oldSocket.finishPongs(error: URLError(.networkConnectionLost))
            await fixture.recovered.wait(forCount: 1)

            #expect(fixture.session.snapshotMakeCount() == 2)
            #expect(fixture.session.latestTask()?.state == .running)
            #expect(await fixture.channel.currentConnectionGeneration() == replacementGeneration)
        }
    }

    @Test
    func `satisfied path wakes the pending reconnect and resets both backoffs`() async throws {
        let reconnect = PathRecoverySleep()
        let upgrade = PathRecoverySleep()
        let upgradeCalls = PathRecoveryEvents<Void>()
        try await withPathRecoveryFixture(
            reconnectSleep: { try await reconnect.sleep($0) },
            extraHeadersProvider: {
                upgradeCalls.record(())
                if upgradeCalls.values.count > 1 { try await upgrade.sleep(.zero) }
                return [:]
            }) { fixture in
                try await fixture.channel.connect()
                await fixture.emit(PathRecoveryFixture.offline)
                let oldSocket = try #require(fixture.session.latestTask())
                await fixture.channel.seedPathRecoveryReconnectBackoff(milliseconds: 30000)
                await fixture.channel.seedPathRecoveryConnectBackoff(nil)
                oldSocket.emitReceiveFailure()
                await reconnect.started.wait(forCount: 1)
                #expect(reconnect.started.values == [.seconds(30)])

                await fixture.settleNext(PathRecoveryFixture.wifi)
                await upgrade.started.wait(forCount: 1)
                #expect(reconnect.cancelled.values.count == 1)
                #expect(await fixture.channel.backoffMs == 500)
                #expect(await fixture.channel.hasPathRecoveryConnectBackoff() == false)

                upgrade.release()
                try await fixture.channel.connect()
                #expect(fixture.session.snapshotMakeCount() == 2)
                #expect(upgradeCalls.values.count == 2)
            }
    }

    @Test
    func `satisfied path wakes a coalesced connect attempt inside its failure backoff`() async throws {
        let backoff = PathRecoverySleep()
        try await withPathRecoveryFixture { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.offline)
            let oldSocket = try #require(fixture.session.latestTask())
            await fixture.channel.seedPathRecoveryConnectBackoff(backoff)
            oldSocket.emitReceiveFailure()
            await backoff.started.wait(forCount: 1)
            let caller = Task { try await fixture.channel.connect() }

            await fixture.settleNext(PathRecoveryFixture.wifi)
            try await caller.value

            #expect(backoff.cancelled.values.count == 1)
            #expect(fixture.session.snapshotMakeCount() == 2)
            #expect(await fixture.channel.hasPathRecoveryConnectBackoff() == false)
        }
    }

    @Test
    func `a satisfied path leaves authentication paused`() async throws {
        let upgradeCalls = PathRecoveryEvents<Void>()
        try await withPathRecoveryFixture(extraHeadersProvider: {
            upgradeCalls.record(())
            if upgradeCalls.values.count > 1 { throw GatewayExternalAuthorizationError() }
            return [:]
        }) { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.offline)
            let oldSocket = try #require(fixture.session.latestTask())
            oldSocket.emitReceiveFailure()
            await fixture.connectFinished.wait(forCount: 2)

            await fixture.settleNext(PathRecoveryFixture.wifi)
            await fixture.recovered.wait(forCount: 1)

            #expect(upgradeCalls.values.count == 2)
            #expect(fixture.session.snapshotMakeCount() == 1)
            #expect(oldSocket.snapshotPingCount() == 0)
            #expect(await fixture.channel.currentConnectionGeneration() == nil)
        }
    }

    @Test
    func `initial repeated unsatisfied and unsettled path changes do not probe`() async throws {
        try await withPathRecoveryFixture { fixture in
            try await fixture.channel.connect()
            let socket = try #require(fixture.session.latestTask())
            await fixture.emit(PathRecoveryFixture.wifi)
            await fixture.emit(PathRecoveryFixture.wifi)
            #expect(fixture.settle.started.values.isEmpty)

            await fixture.emit(PathRecoveryFixture.cellular)
            await fixture.settle.started.wait(forCount: 1)
            await fixture.emit(PathRecoveryFixture.wifi)
            await fixture.settle.cancelled.wait(forCount: 1)
            #expect(socket.snapshotPingCount() == 0)

            await fixture.settleNext(PathRecoveryFixture.offline)
            await fixture.recovered.wait(forCount: 1)
            await fixture.emit(PathRecoveryFixture.offline)
            #expect(fixture.settle.started.values.count == 2)
            #expect(socket.snapshotPingCount() == 0)
            #expect(fixture.session.snapshotMakeCount() == 1)
        }
    }

    @Test
    func `shutdown terminates path consumption and fences an outstanding probe`() async throws {
        try await withPathRecoveryFixture { fixture in
            try await fixture.channel.connect()
            await fixture.emit(PathRecoveryFixture.wifi)
            let socket = try #require(fixture.session.latestTask())
            socket.holdPongs()
            await fixture.settleNext(PathRecoveryFixture.cellular)
            await socket.waitForPings(count: 1)

            await fixture.channel.shutdown()
            await fixture.terminated.wait(forCount: 1)
            socket.finishPongs(error: URLError(.networkConnectionLost))
            await fixture.recovered.wait(forCount: 1)
            if case .terminated = fixture.paths.yield(PathRecoveryFixture.wifi) {
                // Stream cancellation makes the shutdown boundary observable without waiting on time.
            } else {
                Issue.record("Shutdown left network path consumption registered")
            }
            #expect(fixture.session.snapshotMakeCount() == 1)
            #expect(socket.snapshotPingCount() == 1)
            #expect(await fixture.channel.currentConnectionGeneration() == nil)
        }
    }
}
#endif
