import OpenClawKit
import Foundation
import os
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewayProcessManagerTests {
    private final class FakeWebSocketTask: WebSocketTasking, @unchecked Sendable {
        private let connectRequestID = OSAllocatedUnfairLock<String?>(initialState: nil)
        private let pendingReceiveHandler =
            OSAllocatedUnfairLock<(@Sendable (Result<URLSessionWebSocketTask.Message, Error>)
                    -> Void)?>(initialState: nil)
        private let cancelCount = OSAllocatedUnfairLock(initialState: 0)
        private let sendCount = OSAllocatedUnfairLock(initialState: 0)

        var state: URLSessionTask.State = .suspended

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

            if currentSendCount == 0 {
                if let id = GatewayWebSocketTestSupport.connectRequestID(from: message) {
                    self.connectRequestID.withLock { $0 = id }
                }
                return
            }

            guard case let .data(data) = message else { return }
            guard
                let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
                (obj["type"] as? String) == "req",
                let id = obj["id"] as? String
            else {
                return
            }

            let response = GatewayWebSocketTestSupport.okResponseData(id: id)
            let handler = self.pendingReceiveHandler.withLock { $0 }
            handler?(Result<URLSessionWebSocketTask.Message, Error>.success(.data(response)))
        }

        func receive() async throws -> URLSessionWebSocketTask.Message {
            let id = self.connectRequestID.withLock { $0 } ?? "connect"
            return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
        }

        func receive(
            completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)
        {
            self.pendingReceiveHandler.withLock { $0 = completionHandler }
        }

    }

    private final class FakeWebSocketSession: WebSocketSessioning, @unchecked Sendable {
        private let tasks = OSAllocatedUnfairLock(initialState: [FakeWebSocketTask]())

        func makeWebSocketTask(url: URL) -> WebSocketTaskBox {
            _ = url
            let task = FakeWebSocketTask()
            self.tasks.withLock { $0.append(task) }
            return WebSocketTaskBox(task: task)
        }
    }

    @Test func clearsLastFailureWhenHealthSucceeds() async {
        let session = FakeWebSocketSession()
        let url = URL(string: "ws://example.invalid")!
        let connection = GatewayConnection(
            configProvider: { (url: url, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))

        let manager = GatewayProcessManager.shared
        manager.setTestingConnection(connection)
        manager.setTestingDesiredActive(true)
        manager.setTestingLastFailureReason("health failed")
        defer {
            manager.setTestingConnection(nil)
            manager.setTestingDesiredActive(false)
            manager.setTestingLastFailureReason(nil)
        }

        let ready = await manager.waitForGatewayReady(timeout: 0.5)
        #expect(ready)
        #expect(manager.lastFailureReason == nil)
    }
}
