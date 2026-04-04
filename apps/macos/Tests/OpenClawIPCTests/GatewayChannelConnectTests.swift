import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

struct GatewayChannelConnectTests {
    private enum FakeResponse {
        case helloOk(delayMs: Int)
        case invalid(delayMs: Int)
        case authFailed(
            delayMs: Int,
            detailCode: String,
            canRetryWithDeviceToken: Bool,
            recommendedNextStep: String?)
    }

    private func makeSession(response: FakeResponse) -> GatewayTestWebSocketSession {
        GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let delayMs: Int
                        let message: URLSessionWebSocketTask.Message
                        switch response {
                        case let .helloOk(ms):
                            delayMs = ms
                            let id = task.snapshotConnectRequestID() ?? "connect"
                            message = .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                        case let .invalid(ms):
                            delayMs = ms
                            message = .string("not json")
                        case let .authFailed(ms, detailCode, canRetryWithDeviceToken, recommendedNextStep):
                            delayMs = ms
                            let id = task.snapshotConnectRequestID() ?? "connect"
                            message = .data(GatewayWebSocketTestSupport.connectAuthFailureData(
                                id: id,
                                detailCode: detailCode,
                                canRetryWithDeviceToken: canRetryWithDeviceToken,
                                recommendedNextStep: recommendedNextStep))
                        }
                        try await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
                        return message
                    })
            })
    }

    private func makeChallengeTimeoutProfile() -> GatewayChannelTimeoutProfile {
        GatewayChannelTimeoutProfile(
            connectTimeoutSeconds: 0.2,
            connectChallengeTimeoutSeconds: 0.05,
            loopbackConnectTimeoutSeconds: 0.2,
            loopbackConnectChallengeTimeoutSeconds: 0.15)
    }

    private func makeConnectTimeoutProfile() -> GatewayChannelTimeoutProfile {
        GatewayChannelTimeoutProfile(
            connectTimeoutSeconds: 0.08,
            connectChallengeTimeoutSeconds: 0.05,
            loopbackConnectTimeoutSeconds: 0.2,
            loopbackConnectChallengeTimeoutSeconds: 0.05)
    }

    @Test func `concurrent connect is single flight on success`() async throws {
        let session = self.makeSession(response: .helloOk(delayMs: 200))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        _ = try await t1.value
        _ = try await t2.value

        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `concurrent connect shares failure`() async throws {
        let session = self.makeSession(response: .invalid(delayMs: 200))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        let t1 = Task { try await channel.connect() }
        let t2 = Task { try await channel.connect() }

        let r1 = await t1.result
        let r2 = await t2.result

        #expect({
            if case .failure = r1 { true } else { false }
        }())
        #expect({
            if case .failure = r2 { true } else { false }
        }())
        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `connect surfaces structured auth failure`() async throws {
        let session = self.makeSession(response: .authFailed(
            delayMs: 0,
            detailCode: GatewayConnectAuthDetailCode.authTokenMissing.rawValue,
            canRetryWithDeviceToken: true,
            recommendedNextStep: GatewayConnectRecoveryNextStep.updateAuthConfiguration.rawValue))
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session))

        do {
            try await channel.connect()
            Issue.record("expected GatewayConnectAuthError")
        } catch let error as GatewayConnectAuthError {
            #expect(error.detail == .authTokenMissing)
            #expect(error.detailCode == GatewayConnectAuthDetailCode.authTokenMissing.rawValue)
            #expect(error.canRetryWithDeviceToken)
            #expect(error.recommendedNextStep == .updateAuthConfiguration)
            #expect(error.recommendedNextStepCode == GatewayConnectRecoveryNextStep.updateAuthConfiguration.rawValue)
        } catch {
            Issue.record("unexpected error: \(error)")
        }
    }

    @Test func `loopback connect tolerates a slower challenge budget`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            try await Task.sleep(nanoseconds: 100_000_000)
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                    })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            timeoutProfile: self.makeChallengeTimeoutProfile())

        try await channel.connect()
        #expect(session.snapshotMakeCount() == 1)
    }

    @Test func `remote connect keeps the tighter challenge budget`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { _, receiveIndex in
                        if receiveIndex == 0 {
                            try await Task.sleep(nanoseconds: 100_000_000)
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        Issue.record("remote connect should time out before challenge arrives")
                        return .data(GatewayWebSocketTestSupport.connectChallengeData())
                    })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            timeoutProfile: self.makeChallengeTimeoutProfile())

        do {
            try await channel.connect()
            Issue.record("expected connect to fail before the delayed challenge arrives")
        } catch {
            #expect(String(describing: error).contains("ConnectChallengeError"))
        }
    }

    @Test func `loopback connect tolerates a slower connect response budget`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        try await Task.sleep(nanoseconds: 100_000_000)
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                    })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://127.0.0.1:18789")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            timeoutProfile: self.makeConnectTimeoutProfile())

        try await channel.connect()
    }

    @Test func `remote connect keeps the tighter overall connect budget`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    receiveHook: { task, receiveIndex in
                        if receiveIndex == 0 {
                            return .data(GatewayWebSocketTestSupport.connectChallengeData())
                        }
                        try await Task.sleep(nanoseconds: 100_000_000)
                        let id = task.snapshotConnectRequestID() ?? "connect"
                        return .data(GatewayWebSocketTestSupport.connectOkData(id: id))
                    })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            timeoutProfile: self.makeConnectTimeoutProfile())

        do {
            try await channel.connect()
            Issue.record("expected connect to fail before the delayed response arrives")
        } catch {
            #expect(error.localizedDescription.contains("connect timed out"))
        }
    }
}
