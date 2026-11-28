import Foundation
import OpenClawChatUI
import Testing
@testable import OpenClaw

@MainActor
struct IOSSidebarPinsTests {
    @Test func `desktop placements alone define the Pinned block on both phone lists`() {
        let keys = ["atlas", "board", "notes", "review", "legacy"].map { "agent:main:\($0)" }
        let sessions = keys.enumerated().map { index, key in
            OpenClawChatSessionEntry(key: key, updatedAt: Double(index), pinned: index == 4)
        }
        let placements = [keys[2], keys[0], keys[1], keys[3]]
        let entries = ["route:cron", "session-rail:\(keys[4])"] + placements.map { "session:\($0)" }
        let pins = IOSSidebarPins(entries: entries)
        let drawer = RootSidebarModel.sections(
            sessions: sessions,
            query: "",
            currentSessionKey: "main",
            mainSessionKey: "main",
            activeAgentID: "main",
            groups: [],
            rosterIsComplete: true,
            personalPins: pins)
        #expect(drawer.first { $0.id == "pinned" }?.nodes.map(\.id) == placements)
        let screen = SessionListGrouping.sections(
            sessions,
            knownCategories: [],
            needsApproval: { _ in false },
            personalPins: pins)
        #expect(screen.first { $0.id == .group(.pinned) }?.sessions.map(\.key) == placements)
    }

    @Test func `pin and unpin preserve other clients' placement and retry only a conflict`() async throws {
        let pref = IOSSidebarPins.preferenceKey
        let first = ["session:one", "plugin:example/page", "session:two", "session-rail:three"]
        var entries = first
        var methods: [String] = []
        var conflict = true
        func request(_ request: OpenClawChatGatewayRequest) throws -> Data {
            methods.append(request.method)
            let params = try #require(JSONSerialization
                .jsonObject(with: JSONEncoder().encode(request.params)) as? [String: Any])
            if request.method == "users.prefs.get" {
                #expect(params["keys"] as? [String] == [pref])
                return try JSONSerialization.data(withJSONObject: ["status": "ok", "entries": [pref: entries]])
            }
            #expect(request.method == "users.prefs.set")
            #expect((params["expectedEntries"] as? [String: [String]])?[pref] == entries)
            if conflict {
                entries.append("session:desktop")
                conflict = false
                return Data(#"{"status":"conflict"}"#.utf8)
            }
            entries = try #require((params["entries"] as? [String: [String]])?[pref])
            return Data(#"{"status":"ok"}"#.utf8)
        }
        let pins = try await IOSSidebarPins.set("phone", pinned: true, using: request)
        #expect(methods == ["users.prefs.get", "users.prefs.set", "users.prefs.get", "users.prefs.set"])
        #expect(entries == first + ["session:desktop", "session:phone"])
        #expect(pins.positions["phone"] == entries.count - 1)
        _ = try await IOSSidebarPins.set("two", pinned: false, using: request)
        #expect(entries == first.filter { $0 != "session:two" } + ["session:desktop", "session:phone"])
    }
}
