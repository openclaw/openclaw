import Foundation
import Testing

@testable import OpenClawWatch

@Suite("WatchPromptAction")
struct WatchPromptActionTests {
    @Test func codableRoundTrip() throws {
        let action = WatchPromptAction(id: "a1", label: "Approve", style: "default")
        let data = try JSONEncoder().encode(action)
        let decoded = try JSONDecoder().decode(WatchPromptAction.self, from: data)
        #expect(decoded == action)
    }

    @Test func codableWithNilStyle() throws {
        let action = WatchPromptAction(id: "a2", label: "Deny", style: nil)
        let data = try JSONEncoder().encode(action)
        let decoded = try JSONDecoder().decode(WatchPromptAction.self, from: data)
        #expect(decoded == action)
        #expect(decoded.style == nil)
    }

    @Test func identifiableUsesId() {
        let action = WatchPromptAction(id: "unique-123", label: "Do it")
        #expect(action.id == "unique-123")
    }

    @Test func equatableComparison() {
        let a = WatchPromptAction(id: "1", label: "A", style: "x")
        let b = WatchPromptAction(id: "1", label: "A", style: "x")
        let c = WatchPromptAction(id: "2", label: "A", style: "x")
        #expect(a == b)
        #expect(a != c)
    }
}
