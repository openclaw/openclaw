import Foundation
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
private final class ApprovalPrompterGatewayFixture {
    let gateway: GatewayConnection

    init() {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0, let id = GatewayWebSocketTestSupport.requestID(from: message) else { return }
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            }, receiveHook: { socket, receiveIndex in
                if receiveIndex == 0 { return .data(GatewayWebSocketTestSupport.connectChallengeData()) }
                return .data(GatewayWebSocketTestSupport.connectOkData(
                    id: socket.snapshotConnectRequestID() ?? "connect"))
            })
        })
        self.gateway = GatewayConnection(
            configProvider: { (URL(string: "ws://127.0.0.1:49258")!, nil, nil) },
            sessionBox: WebSocketSessionBox(session: session))
    }

    func connect() async throws {
        _ = try await self.gateway.request(method: "health", params: nil, retryTransportFailures: false)
    }

    func sendRequested(id: String, systemAgent: Bool = false) async {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        let payload = AnyCodable([
            "id": id,
            "request": ["command": "echo safe"],
            "createdAtMs": nowMs,
            "expiresAtMs": nowMs + 60000,
        ])
        await self.sendEvent(
            name: systemAgent ? "openclaw.approval.requested" : "exec.approval.requested",
            payload: payload)
    }

    func sendResolved(id: String, systemAgent: Bool = false) async {
        await self.sendEvent(
            name: systemAgent ? "openclaw.approval.resolved" : "exec.approval.resolved",
            payload: AnyCodable(["id": id]))
    }

    func disconnect() async {
        await self.gateway._test_handleDisconnect(socketGeneration: 1)
    }

    func waitForSubscriber() async {
        await self.gateway._test_waitForSubscriber()
    }

    func resolvedThenRequestedDeliveries(id: String) async throws -> [GatewayConnection.PushDelivery] {
        let resolved = try #require(await self.gateway.makePushDelivery(.event(Self.resolvedEvent(id: id))))
        let requested = try #require(await self.gateway.makePushDelivery(.event(Self.requestedEvent(id: id))))
        return [resolved, requested]
    }

    private func sendEvent(name: String, payload: AnyCodable) async {
        await self.gateway._test_handlePush(
            .event(EventFrame(type: "event", event: name, payload: payload)),
            socketGeneration: 1)
    }

    private static func requestedEvent(id: String) -> EventFrame {
        let nowMs = Int(Date().timeIntervalSince1970 * 1000)
        return EventFrame(
            type: "event",
            event: "exec.approval.requested",
            payload: AnyCodable([
                "id": id,
                "request": ["command": "echo safe"],
                "createdAtMs": nowMs,
                "expiresAtMs": nowMs + 60000,
            ]))
    }

    private static func resolvedEvent(id: String) -> EventFrame {
        EventFrame(type: "event", event: "exec.approval.resolved", payload: AnyCodable(["id": id]))
    }
}

@Suite(.serialized)
@MainActor
struct ExecApprovalsGatewayPrompterTests {
    @Test func `session match prefers active session`() {
        let matches = ExecApprovalsGatewayPrompter.shouldPresent(
            mode: .remote,
            activeSession: " main ",
            requestSession: "main",
            lastInputSeconds: nil)
        #expect(matches)

        let mismatched = ExecApprovalsGatewayPrompter.shouldPresent(
            mode: .remote,
            activeSession: "other",
            requestSession: "main",
            lastInputSeconds: 0)
        #expect(!mismatched)
    }

    @Test func `session fallback uses recent activity`() {
        let recent = ExecApprovalsGatewayPrompter.shouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: "main",
            lastInputSeconds: 10,
            thresholdSeconds: 120)
        #expect(recent)

        let stale = ExecApprovalsGatewayPrompter.shouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: "main",
            lastInputSeconds: 200,
            thresholdSeconds: 120)
        #expect(!stale)
    }

    @Test func `remote gateway requests without presentable UI are left unresolved`() {
        let local = ExecApprovalsGatewayPrompter.shouldPresent(
            mode: .local,
            activeSession: nil,
            requestSession: nil,
            lastInputSeconds: 400)
        #expect(local)

        let remote = ExecApprovalsGatewayPrompter.shouldPresent(
            mode: .remote,
            activeSession: nil,
            requestSession: nil,
            lastInputSeconds: 400)
        #expect(!remote)
    }

    @Test func `external resolution cancels only the matching queued prompt`() async throws {
        try await self.withPrompter { fixture, _ in
            await fixture.sendRequested(id: "approval-a")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(1)

            await fixture.sendResolved(id: "approval-a", systemAgent: true)
            await fixture.sendResolved(id: "approval-b")
            await fixture.sendRequested(id: "approval-barrier")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(2)

            await fixture.sendResolved(id: "approval-barrier")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(1)

            await fixture.sendResolved(id: "approval-a")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(0)
        }
    }

    @Test func `connection retirement cancels its queued prompt`() async throws {
        try await self.withPrompter { fixture, _ in
            await fixture.sendRequested(id: "approval-a")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(1)

            await fixture.disconnect()
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(0)
        }
    }

    @Test func `replacement survives stale task completion and stop cancels it`() async throws {
        try await self.withPrompter { fixture, prompter in
            await fixture.sendRequested(id: "approval-a")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(1)

            let replacement = try await fixture.resolvedThenRequestedDeliveries(id: "approval-a")
            prompter._testHandle(deliveries: replacement)

            await fixture.sendResolved(id: "approval-a")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(0)

            await fixture.sendRequested(id: "approval-a")
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(1)

            prompter.stop()
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(0)
        }
    }

    private func withPrompter(
        _ body: (ApprovalPrompterGatewayFixture, ExecApprovalsGatewayPrompter) async throws -> Void) async throws
    {
        try await TestIsolation.withIsolatedState {
            let previousMode = AppStateStore.shared.connectionMode
            AppStateStore.shared.connectionMode = .local
            defer { AppStateStore.shared.connectionMode = previousMode }

            let reservation = try #require(ExecApprovalsPromptPresenter.reservePromptForTesting())
            let fixture = ApprovalPrompterGatewayFixture()
            let prompter = ExecApprovalsGatewayPrompter(gateway: fixture.gateway)
            try await fixture.connect()
            prompter.start()
            await fixture.waitForSubscriber()

            do {
                try await body(fixture, prompter)
            } catch {
                prompter.stop()
                await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(0)
                ExecApprovalsPromptPresenter.releasePromptForTesting(id: reservation)
                await fixture.gateway.shutdown()
                throw error
            }

            prompter.stop()
            await ExecApprovalsPromptPresenter.waitForPendingPromptCountForTesting(0)
            ExecApprovalsPromptPresenter.releasePromptForTesting(id: reservation)
            await fixture.gateway.shutdown()
        }
    }

}
