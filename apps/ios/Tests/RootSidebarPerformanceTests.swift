import Observation
import OpenClawChatUI
import Testing
import UIKit
@testable import OpenClaw

@MainActor
struct RootSidebarPerformanceTests {
    @Test func `cached aliases follow roster replacements and all routing inputs`() throws {
        let model = RootSidebarModel()
        func resolve(_ current: String = "main", agent: String? = "one", contract: String? = nil) -> String {
            model.resolvedSessionKey(
                current: current,
                mainSessionKey: "main",
                activeAgentID: agent,
                sessionRoutingContract: contract)
        }
        func roster(_ keys: [String]) throws -> ChatSessionRosterSnapshot {
            let data = try JSONSerialization.data(withJSONObject: keys.map { ["key": $0] })
            return try ChatSessionRosterSnapshot(
                sessions: JSONDecoder().decode([OpenClawChatSessionEntry].self, from: data), isCached: false)
        }
        let first = try roster(["agent:one:main", "agent:two:main"])
        model.applyRoster(first)
        for agent in ["one", "two"] {
            for contract: String? in [nil, "session-key-v1"] {
                #expect(resolve(agent: agent, contract: contract) == ChatSessionSidebarModel.selectedSessionKey(
                    sessions: first.sessions, currentSessionKey: "main", mainSessionKey: "main",
                    activeAgentID: agent, sessionRoutingContract: contract))
            }
        }
        // Warm the cache, then replace its authoritative roster. A stale hit must not survive.
        _ = resolve()
        let second = try roster(["main"])
        model.applyRoster(second)
        #expect(resolve() == "main")
        #expect(resolve("missing") == "missing")
    }

    @Test func `font cache follows content size changes and restores prior metrics`() throws {
        defer { OpenClawType.installUIKitAppearance() }
        let window = UIWindow()
        let navigationBar = UINavigationBar()
        window.addSubview(navigationBar)
        func titleFont(_ category: UIContentSizeCategory) throws -> UIFont {
            var font: UIFont?
            UITraitCollection(preferredContentSizeCategory: category).performAsCurrent {
                OpenClawType.refreshUIKitAppearance(in: [window])
                font = navigationBar.titleTextAttributes?[.font] as? UIFont
            }
            return try #require(font)
        }
        let small = try titleFont(.extraSmall)
        let large = try titleFont(.accessibilityExtraExtraExtraLarge)
        #expect(large.pointSize > small.pointSize)
        #expect(try titleFont(.extraSmall).pointSize == small.pointSize)
    }
}
