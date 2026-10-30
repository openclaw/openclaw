import Foundation
import OpenClawChatUI
import OpenClawKit
import os
import Testing
@testable import OpenClaw

struct GatewayConnectionTests {
    private func makeConnection(
        session: GatewayTestWebSocketSession,
        token: String? = nil) throws -> (GatewayConnection, ConfigSource)
    {
        let url = try #require(URL(string: "ws://example.invalid"))
        let cfg = ConfigSource(token: token)
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        return (conn, cfg)
    }

    private func makeSession(
        helloDelayMs: Int = 0,
        serverCapabilities: [String] = [],
        connectIncludesDeviceHandler: @escaping @Sendable (Bool) -> Void = { _ in })
        -> GatewayTestWebSocketSession
    {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        if let params = GatewayWebSocketTestSupport.connectRequestParams(from: message) {
                            connectIncludesDeviceHandler(params["device"] != nil)
                        }
                        guard sendIndex > 0 else { return }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        let response = GatewayWebSocketTestSupport.okResponseData(id: id)
                        task.emitReceiveSuccess(.data(response))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        if helloDelayMs > 0 {
                            try await Task.sleep(nanoseconds: UInt64(helloDelayMs) * 1_000_000)
                        }
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(GatewayWebSocketTestSupport.connectOkData(
                            id: id,
                            capabilities: serverCapabilities))
                    })
            })
    }

    private final class ConfigSource: @unchecked Sendable {
        private let token = OSAllocatedUnfairLock<String?>(initialState: nil)

        init(token: String?) {
            self.token.withLock { $0 = token }
        }

        func snapshotToken() -> String? {
            self.token.withLock { $0 }
        }

        func setToken(_ value: String?) {
            self.token.withLock { $0 = value }
        }
    }

    @Test func `request reuses single web socket for same config`() async throws {
        let session = self.makeSession()
        let (conn, _) = try makeConnection(session: session)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func `mock connection omits device identity`() async throws {
        let connectIncludesDevice = OSAllocatedUnfairLock<Bool?>(initialState: nil)
        let session = self.makeSession(connectIncludesDeviceHandler: { includesDevice in
            connectIncludesDevice.withLock { $0 = includesDevice }
        })
        let (conn, _) = try self.makeConnection(session: session)

        _ = try await conn.request(method: "status", params: nil)

        #expect(connectIncludesDevice.withLock { $0 } == false)
        await conn.shutdown()
    }

    @Test func `first connection admits hello capabilities before lease readiness`() async throws {
        let session = self.makeSession(serverCapabilities: ["openclaw-setup-model-ref"])
        let (conn, _) = try makeConnection(session: session)

        let lease = try await conn.acquireServerLease()

        #expect(await conn.supportsServerCapability(
            .systemAgentSetupModelRef,
            ifCurrentServerLease: lease) == true)
        #expect(await conn.cachedGatewayVersion() == "test")
        #expect(session.snapshotMakeCount() == 1)
        // Connect handshake plus the recovery-aware health preflight.
        #expect(session.latestTask()?.snapshotSendCount() == 2)
        await conn.shutdown()
    }

    @Test(arguments: ["disconnected", "endpoint-before", "endpoint-after", "send-cancelled", "success"])
    func `server lease preserves dispatch certainty`(outcome: String) async throws {
        let cfg = ConfigSource(token: "initial-test-token")
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                // Connect and health precede the bound request under test.
                if sendIndex == 2 {
                    if outcome == "send-cancelled" {
                        throw CancellationError()
                    }
                    if outcome == "endpoint-after" {
                        cfg.setToken("replacement-test-token")
                    }
                }
                task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let url = try #require(URL(string: "ws://example.invalid"))
        let conn = GatewayConnection(
            configProvider: { (url: url, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        let lease = try await conn.acquireServerLease()

        if outcome == "disconnected" {
            await conn._test_handleDisconnect(socketGeneration: lease.socketGeneration)
        } else if outcome == "endpoint-before" {
            cfg.setToken("replacement-test-token")
        }
        let refusedBeforeDispatch = outcome == "disconnected" || outcome == "endpoint-before"
        do {
            let data = try await conn.request(
                method: "openclaw.setup.activate",
                params: [:],
                ifCurrentServerLease: lease)
            #expect(outcome == "success")
            #expect(!data.isEmpty)
        } catch OpenClawChatTransportSendError.notDispatched {
            #expect(refusedBeforeDispatch)
        } catch is CancellationError {
            #expect(outcome == "endpoint-after" || outcome == "send-cancelled")
        } catch {
            Issue.record("unexpected server lease error: \(error)")
        }

        #expect(!Task.isCancelled)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == (refusedBeforeDispatch ? 2 : 3))
        await conn.shutdown()
    }

    @Test(arguments: [false, true], ["current", "endpoint", "socket"])
    func `bound request denials retain their captured authority`(
        serverBound: Bool,
        replacement: String) async throws
    {
        let gate = GatewayConnectionSuspensionGate()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0,
                      let id = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                if sendIndex == 2 {
                    await gate.suspend()
                    let response = """
                    {"type":"res","id":"\(id)","ok":false,"error":{"code":"INVALID_REQUEST",
                    "message":"Session access denied","details":{"code":"SESSION_PARTICIPATION_REQUIRED"}}}
                    """
                    socket.emitReceiveSuccess(.data(Data(response.utf8)))
                } else {
                    socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                }
            })
        })
        let (conn, cfg) = try self.makeConnection(session: session, token: "initial-test-token")
        let lease = try await conn.acquireServerLease()
        let params = ["sessionKey": AnyCodable("agent:main:main")]
        let request = Task {
            if serverBound {
                try await conn.request(method: "progressCard.get", params: params, ifCurrentServerLease: lease)
            } else {
                try await conn.request(method: "progressCard.get", params: params, ifCurrentRoute: lease.route)
            }
        }
        await gate.waitUntilStarted()
        if replacement == "endpoint" {
            cfg.setToken("replacement-test-token")
        } else if replacement == "socket" {
            await conn._test_handleDisconnect(socketGeneration: lease.socketGeneration)
        }
        await gate.open()
        // Logical route requests deliberately survive same-route socket retirement;
        // server leases additionally require the exact connected physical socket.
        let stale = replacement == "endpoint" || (serverBound && replacement == "socket")
        do {
            _ = try await request.value
            Issue.record("expected the bound request to fail")
        } catch is CancellationError {
            #expect(stale)
        } catch let error as GatewayResponseError {
            #expect(!stale)
            #expect(error.method == "progressCard.get")
            #expect(error.code == "INVALID_REQUEST")
            #expect(error.details["code"]?.stringValue == "SESSION_PARTICIPATION_REQUIRED")
        } catch {
            await conn.shutdown()
            throw error
        }
        #expect(!Task.isCancelled)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 3)
        await conn.shutdown()
    }

    @Test func `server lease preserves caller cancellation after dispatch`() async throws {
        let requestSent = AsyncStream<Void>.makeStream()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
                        guard sendIndex > 0 else { return }
                        if sendIndex == 2 {
                            requestSent.continuation.yield()
                            return
                        }
                        guard let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                        task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
                    },
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(GatewayWebSocketTestSupport.connectOkData(
                            id: id,
                            capabilities: ["openclaw-setup-model-ref"]))
                    })
            })
        let (conn, _) = try makeConnection(session: session)
        let lease = try await conn.acquireServerLease()
        let request = Task {
            try await conn.request(
                method: "openclaw.setup.activate",
                params: [:],
                timeoutMs: 5000,
                ifCurrentServerLease: lease)
        }
        var sentIterator = requestSent.stream.makeAsyncIterator()
        _ = await sentIterator.next()

        request.cancel()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        requestSent.continuation.finish()
        await conn.shutdown()
    }

    @Test func `request reconfigures and cancels on token change`() async throws {
        let session = self.makeSession()
        let (conn, cfg) = try makeConnection(session: session, token: "a")

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        cfg.setToken("b")
        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 2)
        #expect(session.snapshotCancelCount() == 1)
    }

    @Test func `captured route cancels instead of reconfiguring on token change`() async throws {
        let session = self.makeSession()
        let (conn, cfg) = try makeConnection(session: session, token: "a")

        _ = try await conn.request(method: "status", params: nil)
        let route = try #require(await conn.captureRoute())
        cfg.setToken("b")

        do {
            _ = try await conn.request(
                method: "status",
                params: nil,
                ifCurrentRoute: route)
            Issue.record("expected stale route cancellation")
        } catch is CancellationError {}

        do {
            _ = try await conn.request(
                method: "status",
                params: nil,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            Issue.record("expected typed stale route rejection")
        } catch is OpenClawChatTransportSendError {}

        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func `concurrent requests still use single web socket`() async throws {
        let session = self.makeSession(helloDelayMs: 150)
        let (conn, _) = try makeConnection(session: session)

        async let r1: Data = conn.request(method: "status", params: nil)
        async let r2: Data = conn.request(method: "status", params: nil)
        _ = try await (r1, r2)

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `request can disable retries for non idempotent mutations`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                    if sendIndex > 0 {
                        throw URLError(.timedOut)
                    }
                })
            })
        let (conn, _) = try makeConnection(session: session)

        do {
            _ = try await conn.request(
                method: "sessions.compact",
                params: nil,
                timeoutMs: 10,
                retryTransportFailures: false)
            Issue.record("expected sessions.compact transport failure")
        } catch {}

        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 2)
    }

    @Test func `subscribe replays latest snapshot`() async throws {
        let session = self.makeSession()
        let (conn, _) = try makeConnection(session: session)

        _ = try await conn.request(method: "status", params: nil)

        let stream = await conn.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()

        guard first?.isCurrent == true, case let .snapshot(snap) = first?.push else {
            Issue.record("expected snapshot, got \(String(describing: first))")
            return
        }
        #expect(snap.type == "hello-ok")
    }

    @Test(arguments: ["final", "error", "aborted"])
    func `queued chat terminal survives gap recovery but not route replacement`(state: String) async throws {
        let session = self.makeSession()
        let (conn, config) = try self.makeConnection(session: session)
        let queued = await conn.subscribe(bufferingNewest: 10)
        let observer = await conn.subscribe(bufferingNewest: 10)
        do {
            _ = try await conn.request(method: "status", params: nil)
            var observations = observer.makeAsyncIterator()
            let hello = await observations.next()
            guard case .snapshot = hello?.push else {
                Issue.record("expected the admitted connection hello")
                await conn.shutdown()
                return
            }
            let socket = try #require(session.latestTask())
            socket.emitReceiveSuccess(.data(Data("""
            {"type":"event","event":"chat","seq":1,"payload":{"runId":"run","sessionKey":"main",
            "state":"delta","deltaText":"partial","message":{"role":"assistant","content":[{"type":"text","text":"partial"}]}}}
            """.utf8)))
            socket.emitReceiveSuccess(.data(Data("""
            {"type":"event","event":"chat","seq":3,"payload":{"runId":"run","sessionKey":"main",
            "state":"\(state)","message":{"role":"assistant","content":[{"type":"text","text":"settled"}]}}}
            """.utf8)))

            // Hold the consumer queue until the real receive path has retired its socket.
            while let delivery = await observations.next() {
                if case .disconnected = delivery.event { break }
            }
            var consumer = queued.makeAsyncIterator()
            _ = await consumer.next() // hello
            let delta = try #require(await consumer.next())
            let terminal = try #require(await consumer.next())
            #expect(!delta.isCurrent)
            #expect(terminal.isCurrent)
            #expect(!conn.serverLeaseMatchesCurrentState(terminal.serverLease))
            let push = try #require(terminal.push)
            guard case let .chat(chat) = MacGatewayChatTransport.mapPushToTransportEvent(push) else {
                Issue.record("queued terminal was not available to the chat consumer")
                await conn.shutdown()
                return
            }
            #expect(chat.state == state)
            #expect(OpenClawChatEventText.assistantText(from: chat) == "settled")

            config.setToken("replacement-test-token")
            _ = try await conn.request(method: "status", params: nil)
            #expect(!terminal.isCurrent)
            await conn.shutdown()
        } catch {
            await conn.shutdown()
            throw error
        }
    }

    @Test func `subscribe emits seq gap then disconnects without the gapped event`() async throws {
        let session = self.makeSession()
        let (conn, _) = try makeConnection(session: session)

        let stream = await conn.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()

        _ = try await conn.request(method: "status", params: nil)
        _ = await iterator.next() // snapshot

        let evt1 = Data(
            """
            {"type":"event","event":"presence","payload":{"presence":[]},"seq":1}
            """.utf8)
        session.latestTask()?.emitReceiveSuccess(.data(evt1))

        let firstEvent = await iterator.next()
        guard firstEvent?.isCurrent == true, case let .event(firstFrame) = firstEvent?.push else {
            Issue.record("expected event, got \(String(describing: firstEvent))")
            return
        }
        #expect(firstFrame.seq == 1)

        let evt3 = Data(
            """
            {"type":"event","event":"presence","payload":{"presence":[]},"seq":3}
            """.utf8)
        session.latestTask()?.emitReceiveSuccess(.data(evt3))

        let gap = await iterator.next()
        guard case let .seqGap(expected, received) = gap?.push else {
            Issue.record("expected seqGap, got \(String(describing: gap))")
            return
        }
        #expect(expected == 2)
        #expect(received == 3)

        let disconnected = await iterator.next()
        guard case .disconnected = disconnected?.event else {
            Issue.record("expected disconnect, got \(String(describing: disconnected))")
            await conn.shutdown()
            return
        }
        await conn.shutdown()
    }
}
