import Foundation
import Testing
@testable import OpenClaw
@testable import OpenClawKit

private actor GatewayRequestProbe {
    private var value: String?
    private var waiter: CheckedContinuation<String, Never>?

    func record(_ value: String) {
        self.value = value
        self.waiter?.resume(returning: value)
        self.waiter = nil
    }

    func wait() async -> String {
        if let value {
            return value
        }
        return await withCheckedContinuation { self.waiter = $0 }
    }
}

private actor GatewayRequestStartGate {
    private var entered = false
    private var released = false
    private var enteredWaiter: CheckedContinuation<Void, Never>?
    private var releaseWaiter: CheckedContinuation<Void, Never>?

    func wait() async {
        self.entered = true
        self.enteredWaiter?.resume()
        self.enteredWaiter = nil
        // Reconnects after release pass through instead of replacing a parked waiter.
        guard !self.released else { return }
        await withCheckedContinuation { self.releaseWaiter = $0 }
    }

    func waitUntilEntered() async {
        if self.entered {
            return
        }
        await withCheckedContinuation { self.enteredWaiter = $0 }
    }

    func release() {
        self.released = true
        self.releaseWaiter?.resume()
        self.releaseWaiter = nil
    }
}

@MainActor
private final class GatewayRequestChannelLifetime {
    weak var channel: GatewayChannelActor?

    init(_ channel: GatewayChannelActor) {
        self.channel = channel
    }
}

@Suite(.testWaitLimit)
struct GatewayChannelRequestTests {
    enum RequestCompletion: CaseIterable, Sendable {
        case response, cancellation, disconnect, shutdown
    }

    @Test func `websocket results retain arrival order across receive callbacks`() async throws {
        let socket = GatewayTestWebSocketTask()
        socket.resume()
        let (messages, continuation) = AsyncStream<String>.makeStream()
        defer { continuation.finish() }
        let receive: @Sendable (Int) -> Void = { ordinal in
            socket.receive { result in
                switch result {
                case let .success(.string(value)):
                    continuation.yield("\(ordinal):\(value)")
                case let .failure(error):
                    #expect((error as? URLError)?.code == .networkConnectionLost)
                    continuation.yield("\(ordinal):connection lost")
                default:
                    Issue.record("Expected a synthetic string frame or connection loss")
                }
            }
        }

        receive(1)
        socket.emitReceiveSuccess(.string("agent.wait completed"))
        // The next peer reply can arrive before the channel registers its next receive.
        socket.emitReceiveSuccess(.string("chat.history reply"))
        socket.emitReceiveFailure()

        var received: [String] = []
        for await message in messages {
            received.append(message)
            if received.count == 3 { break }
            receive(received.count + 1)
        }
        guard received.count == 3 else {
            Issue.record("Still waiting for ordered websocket results")
            throw CancellationError()
        }
        #expect(received == ["1:agent.wait completed", "2:chat.history reply", "3:connection lost"])
        #expect(socket.snapshotCallbackReceiveCount() == 3)
    }

    @Test(arguments: RequestCompletion.allCases)
    @MainActor
    func `completed requests release their channel before the original deadline`(
        _ completion: RequestCompletion) async throws
    {
        let lifetime = try await self.completeRequest(completion)
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(2))
        while lifetime.channel != nil, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(lifetime.channel == nil)
    }

    @MainActor
    private func completeRequest(_ completion: RequestCompletion) async throws -> GatewayRequestChannelLifetime {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                guard sendIndex == 1,
                      let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                else { return }
                await probe.record(requestID)
            })
        })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        let lifetime = GatewayRequestChannelLifetime(channel)
        let request = Task {
            try await channel.request(method: "release-deadline", params: nil, timeoutMs: 30000)
        }
        do {
            let requestID = await probe.wait()
            let socket = try #require(session.latestTask())
            switch completion {
            case .response:
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: requestID)))
                let response = try await request.value
                #expect(!response.isEmpty)
            case .cancellation:
                request.cancel()
                await #expect(throws: CancellationError.self) { try await request.value }
            case .disconnect:
                socket.emitReceiveFailure()
                await #expect(throws: (any Error).self) { try await request.value }
            case .shutdown:
                await channel.shutdown()
                await #expect(throws: (any Error).self) { try await request.value }
            }
        } catch {
            request.cancel()
            await channel.shutdown()
            throw error
        }
        await channel.shutdown()
        // Returning only a weak reference releases this frame's channel and completed request task.
        return lifetime
    }

    @Test func `request timeout then send failure does not double resume`() async throws {
        let timedOut = AsyncTestGate()
        let sendFailed = AsyncTestGate()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(
                    sendHook: { _, _, sendIndex in
                        guard sendIndex == 1 else { return }
                        await timedOut.wait()
                        sendFailed.open()
                        throw URLError(.cannotConnectToHost)
                    })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)

        do {
            _ = try await channel.request(method: "test", params: nil, timeoutMs: 10)
            Issue.record("Expected request to time out")
        } catch {
            let ns = error as NSError
            #expect(ns.domain == "Gateway")
            #expect(ns.code == 5)
        }

        timedOut.open()
        try await sendFailed.wait("late request send failure")
        // Observe the late send failure for 250 ms; a double resume would crash during this absence window.
        try? await Task.sleep(nanoseconds: 250 * 1_000_000)
    }

    @Test func `cancelled request send keeps the shared socket reusable`() async throws {
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { task, message, sendIndex in
                    if sendIndex == 1 {
                        throw CancellationError()
                    }
                    guard sendIndex == 2,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    task.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: requestID)))
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)

        await #expect(throws: CancellationError.self) {
            try await channel.request(method: "cancelled-send", params: nil, timeoutMs: 5000)
        }
        let response = try await channel.request(method: "retry", params: nil, timeoutMs: 5000)

        #expect(!response.isEmpty)
        #expect(session.snapshotMakeCount() == 1)
        #expect(session.latestTask()?.snapshotSendCount() == 3)
    }

    @Test func `request cancellation removes pending waiter and ignores late response`() async throws {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    guard sendIndex == 1,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    await probe.record(requestID)
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        let request = Task {
            try await channel.request(method: "cancel-me", params: nil, timeoutMs: 5000)
        }
        let requestID = await probe.wait()
        #expect(await channel._test_pendingRequestCount() == 1)

        request.cancel()

        await #expect(throws: CancellationError.self) {
            try await TestWait.value(of: request, "request cancellation")
        }
        #expect(await channel._test_pendingRequestCount() == 0)

        let socket = try #require(session.latestTask())
        socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: requestID)))
        await Task.yield()
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `request cancellation wins after response resumes`() async throws {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    guard sendIndex == 1,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    await probe.record(requestID)
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        let resumedGate = GatewayRequestStartGate()
        await channel._test_setRequestResumedHandler { await resumedGate.wait() }
        let request = Task {
            try await channel.request(method: "response-cancel-race", params: nil, timeoutMs: 5000)
        }
        let requestID = await probe.wait()
        let socket = try #require(session.latestTask())

        socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: requestID)))
        await resumedGate.waitUntilEntered()
        request.cancel()
        await resumedGate.release()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `request cancellation wins after disconnect resumes an error`() async throws {
        let probe = GatewayRequestProbe()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, message, sendIndex in
                    guard sendIndex == 1,
                          let requestID = GatewayWebSocketTestSupport.requestID(from: message)
                    else { return }
                    await probe.record(requestID)
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        let resumedGate = GatewayRequestStartGate()
        await channel._test_setRequestResumedHandler { await resumedGate.wait() }
        let request = Task {
            try await channel.request(method: "disconnect-cancel-race", params: nil, timeoutMs: 5000)
        }
        _ = await probe.wait()
        let socket = try #require(session.latestTask())

        socket.emitReceiveFailure()
        await resumedGate.waitUntilEntered()
        request.cancel()
        await resumedGate.release()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `pre-cancelled request never dispatches`() async throws {
        let session = GatewayTestWebSocketSession()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        try await channel.connect()
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)
        let gate = GatewayRequestStartGate()
        let request = Task {
            await gate.wait()
            return try await channel.request(method: "never-send", params: nil, timeoutMs: 100)
        }
        await gate.waitUntilEntered()

        request.cancel()
        await gate.release()

        await #expect(throws: CancellationError.self) {
            try await request.value
        }
        await Task.yield()
        #expect(socket.snapshotSendCount() == 1)
        #expect(await channel._test_pendingRequestCount() == 0)
    }

    @Test func `pre-cancelled send never dispatches`() async throws {
        let session = GatewayTestWebSocketSession()
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        try await channel.connect()
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)
        let gate = GatewayRequestStartGate()
        let send = Task {
            await gate.wait()
            try await channel.send(method: "never-send", params: nil)
        }
        await gate.waitUntilEntered()

        send.cancel()
        await gate.release()

        await #expect(throws: CancellationError.self) {
            try await send.value
        }
        await Task.yield()
        #expect(socket.snapshotSendCount() == 1)
    }

    @Test func `request cancellation leaves a shared connect promptly`() async throws {
        let connectGate = GatewayRequestStartGate()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                    guard sendIndex == 0 else { return }
                    await connectGate.wait()
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        let connecting = Task { try await channel.connect() }
        await connectGate.waitUntilEntered()
        let request = Task {
            try await channel.request(method: "cancel-during-connect", params: nil, timeoutMs: 5000)
        }
        do {
            try await TestWait.state("two shared connect waiters") {
                await channel._test_connectWaiterCount() == 2
            }
        } catch {
            await connectGate.release()
            request.cancel()
            connecting.cancel()
            _ = try? await request.value
            _ = try? await connecting.value
            await channel.shutdown()
            throw error
        }
        #expect(await channel._test_connectWaiterCount() == 2)

        request.cancel()

        await #expect(throws: CancellationError.self) {
            try await TestWait.value(of: request, "request cancellation")
        }
        #expect(await channel._test_connectWaiterCount() == 1)
        #expect(await channel._test_pendingRequestCount() == 0)
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)

        await connectGate.release()
        try await connecting.value
        await channel.shutdown()
    }

    @Test func `cancelling the initiating connect leaves the shared attempt alive`() async throws {
        let connectGate = GatewayRequestStartGate()
        let session = GatewayTestWebSocketSession(
            taskFactory: {
                GatewayTestWebSocketTask(sendHook: { _, _, sendIndex in
                    guard sendIndex == 0 else { return }
                    await connectGate.wait()
                })
            })
        let channel = try GatewayChannelActor(
            url: #require(URL(string: "ws://example.invalid")),
            token: nil,
            session: WebSocketSessionBox(session: session),
            connectOptions: GatewayWebSocketTestSupport.identityFreeOperatorConnectOptions)
        let initiator = Task { try await channel.connect() }
        await connectGate.waitUntilEntered()
        let peer = Task { try await channel.connect() }
        do {
            try await TestWait.state("two shared connect waiters") {
                await channel._test_connectWaiterCount() == 2
            }
        } catch {
            await connectGate.release()
            initiator.cancel()
            peer.cancel()
            _ = try? await initiator.value
            _ = try? await peer.value
            await channel.shutdown()
            throw error
        }
        #expect(await channel._test_connectWaiterCount() == 2)

        initiator.cancel()

        await #expect(throws: CancellationError.self) {
            try await TestWait.value(of: initiator, "initiating connect cancellation")
        }
        #expect(await channel._test_connectWaiterCount() == 1)
        let socket = try #require(session.latestTask())
        #expect(socket.snapshotSendCount() == 1)

        await connectGate.release()
        try await peer.value
        #expect(await channel._test_connectWaiterCount() == 0)
        #expect(socket.snapshotSendCount() == 1)
        await channel.shutdown()
    }
}
