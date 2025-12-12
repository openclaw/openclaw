import Foundation
import os
import Testing
@testable import Clawdis

@Suite struct GatewayConnectionTests {
    private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
        private let pendingReceiveHandler =
            OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?>(initialState: nil)
        private let cancelCount = OSAllocatedUnfairLock(initialState: 0)
        private let sendCount = OSAllocatedUnfairLock(initialState: 0)

        var state: URLSessionTask.State = .suspended

        func snapshotCancelCount() -> Int { self.cancelCount.withLock { $0 } }

        func resume() {
            self.state = .running
        }

        func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
            _ = (closeCode, reason)
            self.state = .canceling
            self.cancelCount.withLock { $0 += 1 }
            let handler = self.pendingReceiveHandler.withLock { handler in
                defer { handler = nil }
                return handler
            }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.failure(URLError(.cancelled)))
        }

        func send(_ message: URLSessionWebSocketTask.Message) async throws {
            let currentSendCount = self.sendCount.withLock { count in
                defer { count += 1 }
                return count
            }

            // First send is the hello frame. Subsequent sends are request frames.
            if currentSendCount == 0 { return }

            guard case let .data(data) = message else { return }
            guard
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                (obj["type"] as? String) == "req",
                let id = obj["id"] as? String
            else {
                return
            }

            let response = Self.responseData(id: id)
            let handler = self.pendingReceiveHandler.withLock { $0 }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.success(.data(response)))
        }

        func receive() async throws -> URLSessionWebSocketTask.Message {
            .data(Self.helloOkData())
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {
            self.pendingReceiveHandler.withLock { $0 = completionHandler }
        }

        private static func helloOkData() -> Data {
            let json = """
            {
              "type": "hello-ok",
              "protocol": 1,
              "server": { "version": "test", "connId": "test" },
              "features": { "methods": [], "events": [] },
              "snapshot": {
                "presence": [ { "ts": 1 } ],
                "health": {},
                "stateVersion": { "presence": 0, "health": 0 },
                "uptimeMs": 0
              },
              "policy": { "maxPayload": 1, "maxBufferedBytes": 1, "tickIntervalMs": 30000 }
            }
            """
            return Data(json.utf8)
        }

        private static func responseData(id: String) -> Data {
            let json = """
            {
              "type": "res",
              "id": "\(id)",
              "ok": true,
              "payload": { "ok": true }
            }
            """
            return Data(json.utf8)
        }
    }

    private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
        private let makeCount = OSAllocatedUnfairLock(initialState: 0)
        private let tasks = OSAllocatedUnfairLock(initialState: [FakeWebSocketTask]())

        func snapshotMakeCount() -> Int { self.makeCount.withLock { $0 } }
        func snapshotCancelCount() -> Int {
            self.tasks.withLock { tasks in
                tasks.reduce(0) { $0 + $1.snapshotCancelCount() }
            }
        }

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            self.makeCount.withLock { $0 += 1 }
            let task = FakeWebSocketTask()
            self.tasks.withLock { $0.append(task) }
            return WebSocketTaskBox(task: task)
        }
    }

    private final class ConfigSource: @unchecked Sendable {
        private let token = OSAllocatedUnfairLock<String?>(initialState: nil)

        init(token: String?) {
            self.token.withLock { $0 = token }
        }

        func snapshotToken() -> String? { self.token.withLock { $0 } }
        func setToken(_ value: String?) { self.token.withLock { $0 = value } }
    }

    @Test func requestReusesSingleWebSocketForSameConfig() async throws {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: nil)
        let conn = GatewayConnection(
            configProvider: { (url, cfg.snapshotToken()) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.snapshotCancelCount() == 0)
    }

    @Test func requestReconfiguresAndCancelsOnTokenChange() async throws {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let cfg = ConfigSource(token: "a")
        let conn = GatewayConnection(
            configProvider: { (url, cfg.snapshotToken()) },
            sessionBox: WebSocketSessionBox(session: session))

        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 1)

        cfg.setToken("b")
        _ = try await conn.request(method: "status", params: nil)
        #expect(session.snapshotMakeCount() == 2)
        #expect(session.snapshotCancelCount() == 1)
    }
}
