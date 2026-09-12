import Foundation
import OpenClawChatUI
import OpenClawProtocol
import Testing
@testable import OpenClaw
@testable import OpenClawKit

@MainActor
struct QuickChatCatalogPublicationTests {
    @Test(arguments: ["config.changed", "chat.metadata.changed"])
    func `Gateway publications refresh the presentation without discarding a draft`(_ event: String) async throws {
        let session = GatewayTestWebSocketSession(taskFactory: {
            GatewayTestWebSocketTask(sendHook: { socket, message, sendIndex in
                guard sendIndex > 0 else { return }
                #expect(GatewayWebSocketTestSupport.requestMethod(from: message) == "health")
                let id = try #require(GatewayWebSocketTestSupport.requestID(from: message))
                socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.okResponseData(id: id)))
            })
        })
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        _ = try await gateway.acquireServerLease()
        let socket = try #require(session.latestTask())
        var publishedName = "Original choice"
        var fails = false
        var subscriptions = 0
        let model = QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main", mainkey: "main", scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Fixture")])
            },
            agentIdentityProvider: { _ in .placeholder },
            permissionStatusProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in
                if fails { throw URLError(.cannotConnectToHost) }
                return QuickChatModelControlSnapshot(
                    models: [.init(modelID: "choice", name: publishedName, provider: "fixture", contextWindow: nil)],
                    currentModelSelectionID: "fixture/choice",
                    currentThinkingLevel: nil,
                    thinkingOptions: [],
                    defaultProvider: "fixture")
            },
            modelCatalogEventsProvider: {
                let events = await gateway.subscribe()
                subscriptions += 1
                return events
            })
        defer { model.endPresentation() }
        do {
            let presentation = model.beginPresentation()
            await model.refreshForPresentation(id: presentation)
            try await self.waitUntil { subscriptions == 1 && !model.isLoadingModelControls }
            model.text = "Unsent draft"
            print("Quick Chat catalog \(event): initial=\(model.modelChoices.map(\.name)), draft=\(model.text)")

            publishedName = "Published choice"
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: event, seq: 1)))
            try await self.waitUntil { model.modelChoices.first?.name == "Published choice" }
            #expect(model.text == "Unsent draft")
            print(
                "Quick Chat catalog \(event): seq=1, published=\(model.modelChoices.map(\.name)), draft=\(model.text)")

            fails = true
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: event, seq: 2)))
            try await self.waitUntil { model.modelControlStatusMessage != nil }
            #expect(model.modelChoices.map(\.name) == ["Published choice"])
            #expect(model.text == "Unsent draft")
            print(
                "Quick Chat catalog \(event): seq=2, failedRefresh=\(model.modelControlStatusMessage != nil), retained=\(model.modelChoices.map(\.name)), draft=\(model.text)")

            fails = false
            publishedName = "Recovered choice"
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: event, seq: 3)))
            try await self.waitUntil { model.modelChoices.first?.name == "Recovered choice" }
            #expect(model.modelControlStatusMessage == nil)
            print(
                "Quick Chat catalog \(event): seq=3, recovered=\(model.modelChoices.map(\.name)), draft=\(model.text)")

            model.endPresentation()
            let reopened = model.beginPresentation()
            await model.refreshForPresentation(id: reopened)
            try await self.waitUntil { subscriptions == 2 && !model.isLoadingModelControls }
            publishedName = "New presentation choice"
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: "tick", seq: 5)))
            try await self.waitUntil { model.modelChoices.first?.name == "New presentation choice" }
            #expect(model.activePresentationID == reopened)
            print(
                "Quick Chat catalog \(event): reopened, seq=5 tick, choices=\(model.modelChoices.map(\.name)), currentPresentation=\(model.activePresentationID == reopened)")
            model.endPresentation()
            await gateway.shutdown()
        } catch {
            model.endPresentation()
            await gateway.shutdown()
            throw error
        }
    }

    @Test func `a late catalog read cannot replace the reopened presentation`() async throws {
        func snapshot(_ name: String) -> QuickChatModelControlSnapshot {
            QuickChatModelControlSnapshot(
                models: [.init(modelID: "choice", name: name, provider: "fixture", contextWindow: nil)],
                currentModelSelectionID: "fixture/choice", currentThinkingLevel: nil,
                thinkingOptions: [], defaultProvider: "fixture")
        }
        var pendingRead: CheckedContinuation<QuickChatModelControlSnapshot, Never>?
        var reads = 0
        let model = QuickChatModel(
            sessionKeyProvider: { "agent:main:main" },
            agentsProvider: {
                AgentsListResult(
                    defaultid: "main", mainkey: "main", scope: AnyCodable("per-agent"),
                    agents: [AgentSummary(id: "main", name: "Fixture")])
            },
            agentIdentityProvider: { _ in .placeholder },
            permissionStatusProvider: { _ in [:] },
            connectionGateProvider: { .available },
            modelControlsProvider: { _ in
                reads += 1
                if reads == 1 {
                    return await withCheckedContinuation { pendingRead = $0 }
                }
                return snapshot("New choice")
            },
            modelCatalogEventsProvider: { AsyncStream { $0.finish() } })
        let first = model.beginPresentation()
        let oldRefresh = Task { await model.refreshForPresentation(id: first) }
        defer {
            pendingRead?.resume(returning: snapshot("Old choice"))
            model.endPresentation()
        }
        try await self.waitUntil { pendingRead != nil }
        model.endPresentation()
        let reopened = model.beginPresentation()
        await model.refreshForPresentation(id: reopened)
        model.text = "New presentation draft"
        #expect(model.modelChoices.map(\.name) == ["New choice"])

        // A transport can finish a read after cancellation; the model must reject that old result.
        let read = try #require(pendingRead)
        pendingRead = nil
        read.resume(returning: snapshot("Old choice"))
        await oldRefresh.value
        #expect(model.modelChoices.map(\.name) == ["New choice"])
        #expect(model.activePresentationID == reopened)
        #expect(model.text == "New presentation draft")
        print(
            "Quick Chat late read: choices=\(model.modelChoices.map(\.name)), draft=\(model.text), currentPresentation=\(model.activePresentationID == reopened)")
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(condition())
    }
}
