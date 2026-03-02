import Foundation
import OpenClawKit
import os
import Testing
@testable import OpenClaw

@Suite struct GatewayConnectionTests {
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

    private func makeSession(helloDelayMs: Int = 0) -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { task, message, sendIndex in
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
                        return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
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

    @Test func requestReusesSingleWebSocketForSameConfig() async throws {
        let session = self.makeSession()
        let (conn, _) = try self.makeConnection(session: session)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func requestReconfiguresAndCancelsOnTokenChange() async throws {
        let session = self.makeSession()
        let (conn, cfg) = try self.makeConnection(session: session, token: "a")

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        cfg.setToken("b")
        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 2)
        #expect(session.snapshotCancelCount() == 1)
    }

    @Test func concurrentRequestsStillUseSingleWebSocket() async throws {
        let session = self.makeSession(helloDelayMs: 150)
        let (conn, _) = try self.makeConnection(session: session)

        async let r1: Data = conn.request(method: "status", params: nil)
        async let r2: Data = conn.request(method: "status", params: nil)
        _ = try await (r1, r2)

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func subscribeReplaysLatestSnapshot() async throws {
        let session = self.makeSession()
        let (conn, _) = try self.makeConnection(session: session)

        _ = try await conn.request(method: "status", params: nil)

        let stream = await conn.subscribe(bufferingNewest: 10)
        var iterator = stream.makeAsyncIterator()
        let first = await iterator.next()

        guard case let .snapshot(snap) = first else {
            Issue.record("expected snapshot, got \(String(describing: first))")
            return
        }
        #expect(snap.type == "hello-ok")
    }

    @Test func subscribeEmitsSeqGapBeforeEvent() async throws {
        let session = self.makeSession()
        let (conn, _) = try self.makeConnection(session: session)

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
        guard case let .event(firstFrame) = firstEvent else {
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
        guard case let .seqGap(expected, received) = gap else {
            Issue.record("expected seqGap, got \(String(describing: gap))")
            return
        }
        #expect(expected == 2)
        #expect(received == 3)

        let secondEvent = await iterator.next()
        guard case let .event(secondFrame) = secondEvent else {
            Issue.record("expected event, got \(String(describing: secondEvent))")
            return
        }
        #expect(secondFrame.seq == 3)
    }
}
