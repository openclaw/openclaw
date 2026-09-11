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
        let session = GatewayTestWebSocketSession()
        let gateway = GatewayConnection(
            configProvider: { (url: URL(string: "ws://127.0.0.1:1")!, token: nil, password: nil) },
            sessionBox: WebSocketSessionBox(session: session))
        try await gateway.refresh()
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

            publishedName = "Published choice"
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: event, seq: 1)))
            try await self.waitUntil { model.modelChoices.first?.name == "Published choice" }
            #expect(model.text == "Unsent draft")

            fails = true
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: event, seq: 2)))
            try await self.waitUntil { model.modelControlStatusMessage != nil }
            #expect(model.modelChoices.map(\.name) == ["Published choice"])
            #expect(model.text == "Unsent draft")

            fails = false
            publishedName = "Recovered choice"
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: event, seq: 3)))
            try await self.waitUntil { model.modelChoices.first?.name == "Recovered choice" }
            #expect(model.modelControlStatusMessage == nil)

            model.endPresentation()
            let reopened = model.beginPresentation()
            await model.refreshForPresentation(id: reopened)
            try await self.waitUntil { subscriptions == 2 && !model.isLoadingModelControls }
            publishedName = "New presentation choice"
            socket.emitReceiveSuccess(.data(GatewayWebSocketTestSupport.eventData(event: "tick", seq: 5)))
            try await self.waitUntil { model.modelChoices.first?.name == "New presentation choice" }
            #expect(model.activePresentationID == reopened)
            model.endPresentation()
            await gateway.shutdown()
        } catch {
            model.endPresentation()
            await gateway.shutdown()
            throw error
        }
    }

    private func waitUntil(_ condition: () -> Bool) async throws {
        let deadline = ContinuousClock.now + .seconds(5)
        while !condition(), ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
        }
        try #require(condition())
    }
}
