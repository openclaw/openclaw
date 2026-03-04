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

    private final class LoopbackFallbackFailTask: WebSocketTasking, @unchecked Sendable {
        private let error: URLError

        init(error: URLError = URLError(.secureConnectionFailed)) {
            self.error = error
        }

        var state: URLSessionTask.State = .running

        func resume() {}

        func cancel(with _: URLSessionWebSocketTask.CloseCode, reason _: Data?) {
            self.state = .canceling
        }

        func send(_: URLSessionWebSocketTask.Message) async throws {}

        func receive() async throws -> URLSessionWebSocketTask.Message {
            throw self.error
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {
            completionHandler(.failure(self.error))
        }
    }

    private final class LoopbackFallbackSession: WebSocketSessioning, @unchecked Sendable {
        private let lock = NSLock()
        private var urls: [URL] = []
        private var makeCount = 0

        func snapshotURLs() -> [URL] {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.urls
        }

        func snapshotMakeCount() -> Int {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.makeCount
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            self.lock.lock()
            self.makeCount += 1
            self.urls.append(url)
            self.lock.unlock()

            if url.scheme?.lowercased() == "wss" {
                return WebSocketTaskBox(task: LoopbackFallbackFailTask())
            }

            let task = GatewayTestWebSocketTask(
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
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                })
            return WebSocketTaskBox(task: task)
        }
    }

    private final class LoopbackFallbackAdaptiveSession: WebSocketSessioning, @unchecked Sendable {
        enum Phase {
            case wsFallbackActive
            case tlsOnly
        }

        private let lock = NSLock()
        private var urls: [URL] = []
        private var makeCount = 0
        private var phase: Phase = .wsFallbackActive

        func switchToTLSOnly() {
            self.lock.lock()
            self.phase = .tlsOnly
            self.lock.unlock()
        }

        func snapshotURLs() -> [URL] {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.urls
        }

        func snapshotMakeCount() -> Int {
            self.lock.lock()
            defer { self.lock.unlock() }
            return self.makeCount
        }

        private func successfulTask() -> GatewayTestWebSocketTask {
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
                    let id = task.snapshotConnectRequestID() ?? "connect"
                    return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                })
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            self.lock.lock()
            self.makeCount += 1
            self.urls.append(url)
            let phase = self.phase
            self.lock.unlock()

            let scheme = url.scheme?.lowercased()
            switch (phase, scheme) {
            case (.wsFallbackActive, "wss"):
                return WebSocketTaskBox(task: LoopbackFallbackFailTask(error: URLError(.secureConnectionFailed)))
            case (.wsFallbackActive, "ws"):
                return WebSocketTaskBox(task: self.successfulTask())
            case (.tlsOnly, "wss"):
                return WebSocketTaskBox(task: self.successfulTask())
            case (.tlsOnly, "ws"):
                return WebSocketTaskBox(task: LoopbackFallbackFailTask(error: URLError(.cannotConnectToHost)))
            default:
                return WebSocketTaskBox(task: LoopbackFallbackFailTask(error: URLError(.badServerResponse)))
            }
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

    @Test func requestFallsBackFromLoopbackWssToWsAndCachesScheme() async throws {
        let session = LoopbackFallbackSession()
        let configURL = try #require(URL(string: "wss://127.0.0.1:18789"))
        let conn = GatewayConnection(
            configProvider: { (url: configURL, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)
        _ = try await conn.request(method: "status", params: nil)

        #expect(session.snapshotMakeCount() == 2)
        let urls = session.snapshotURLs()
        #expect(urls.count == 2)
        #expect(urls[0].scheme == "wss")
        #expect(urls[1].scheme == "ws")
        #expect(urls[0].host == "127.0.0.1")
        #expect(urls[1].host == "127.0.0.1")
        #expect(urls[0].port == 18789)
        #expect(urls[1].port == 18789)
    }

    @Test func cachedLoopbackWsFallbackRetriesSourceWssWhenWsFails() async throws {
        let session = LoopbackFallbackAdaptiveSession()
        let cfg = ConfigSource(token: nil)
        let configURL = try #require(URL(string: "wss://127.0.0.1:18789"))
        let conn = GatewayConnection(
            configProvider: { (url: configURL, token: cfg.snapshotToken(), password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)
        session.switchToTLSOnly()
        cfg.setToken("rotate")
        _ = try await conn.request(method: "status", params: nil)

        #expect(session.snapshotMakeCount() == 4)
        let urls = session.snapshotURLs()
        #expect(urls.count == 4)
        let first = try #require(urls.first)
        let second = try #require(urls.dropFirst().first)
        let third = try #require(urls.dropFirst(2).first)
        let fourth = try #require(urls.dropFirst(3).first)
        #expect(first.scheme == "wss")
        #expect(second.scheme == "ws")
        #expect(third.scheme == "ws")
        #expect(fourth.scheme == "wss")
        #expect(fourth.host == "127.0.0.1")
        #expect(fourth.port == 18789)
    }
}
