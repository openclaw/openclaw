import Foundation
import Testing

@testable import OpenClawWatch

@Suite("OpenClawWidget")
struct WatchWidgetTests {
    // MARK: - WidgetPersistedState decoding

    @Test func decodesValidState() throws {
        let state = WidgetPersistedState(
            title: "Alert", body: "Fire detected", updatedAt: Date(),
            risk: "high", actions: [.init(id: "a1")])
        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(WidgetPersistedState.self, from: data)
        #expect(decoded.title == "Alert")
        #expect(decoded.body == "Fire detected")
        #expect(decoded.risk == "high")
        #expect(decoded.actions?.count == 1)
    }

    @Test func decodesStateWithNilOptionals() throws {
        let state = WidgetPersistedState(
            title: "T", body: "B", updatedAt: Date(),
            risk: nil, actions: nil)
        let data = try JSONEncoder().encode(state)
        let decoded = try JSONDecoder().decode(WidgetPersistedState.self, from: data)
        #expect(decoded.risk == nil)
        #expect(decoded.actions == nil)
    }

    // MARK: - Relevance score computation

    private func relevanceScore(risk: String?, hasActions: Bool) -> Float {
        switch risk?.lowercased() {
        case "high": 80
        case "medium" where hasActions: 60
        case _ where hasActions: 50
        default: 20
        }
    }

    @Test func highRiskScore() {
        #expect(relevanceScore(risk: "high", hasActions: false) == 80)
        #expect(relevanceScore(risk: "high", hasActions: true) == 80)
    }

    @Test func mediumRiskWithActionsScore() {
        #expect(relevanceScore(risk: "medium", hasActions: true) == 60)
    }

    @Test func mediumRiskWithoutActionsScore() {
        #expect(relevanceScore(risk: "medium", hasActions: false) == 20)
    }

    @Test func actionsOnlyScore() {
        #expect(relevanceScore(risk: nil, hasActions: true) == 50)
        #expect(relevanceScore(risk: "low", hasActions: true) == 50)
    }

    @Test func defaultScore() {
        #expect(relevanceScore(risk: nil, hasActions: false) == 20)
        #expect(relevanceScore(risk: "low", hasActions: false) == 20)
    }

    // MARK: - readLatestEntry with nil/empty defaults

    @Test func readLatestEntryWithEmptyDefaults() {
        let defaults = UserDefaults(suiteName: "test.\(UUID())")!
        let data = defaults.data(forKey: WatchInboxStore.persistedStateKey)
        #expect(data == nil)
    }

    @Test func readLatestEntryDecodesPersistedData() throws {
        let defaults = UserDefaults(suiteName: "test.\(UUID())")!
        let state = WidgetPersistedState(
            title: "Hello", body: "World", updatedAt: Date(),
            risk: "medium", actions: [.init(id: "x")])
        let data = try JSONEncoder().encode(state)
        defaults.set(data, forKey: WatchInboxStore.persistedStateKey)
        let restored = defaults.data(forKey: WatchInboxStore.persistedStateKey)
        #expect(restored != nil)
        let decoded = try JSONDecoder().decode(
            WidgetPersistedState.self, from: restored!)
        #expect(decoded.title == "Hello")
        #expect(decoded.risk == "medium")
    }
}
