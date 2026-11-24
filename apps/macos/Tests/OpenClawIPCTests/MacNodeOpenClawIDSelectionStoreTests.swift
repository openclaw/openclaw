import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct MacNodeOpenClawIDSelectionStoreTests {
    @Test
    func `reopened selection retains enrollment identity but no credentials or dialing authority`() throws {
        let suite = "NodeSelectionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let database = URL(fileURLWithPath: "/unused-profile/node-enrollment.sqlite")
        let id = UUID()
        let store = MacNodeOpenClawIDSelectionStore(defaults: defaults, databaseURL: database)
        #expect(try store.load() == nil)
        store.save(MacNodeOpenClawIDTarget(
            hostname: "node.example.invalid",
            enrollmentID: id,
            databaseURL: database,
            identityStore: OpenClawIDNodeIdentityKeychainStore(enrollmentID: id)))
        let reopened = try MacNodeOpenClawIDSelectionStore(
            defaults: #require(UserDefaults(suiteName: suite)), databaseURL: database)
        let selected = try #require(try reopened.load())
        #expect(selected.hostname == "node.example.invalid")
        #expect(selected.enrollmentID == id)
        #expect(selected.databaseURL == database)
        #expect(defaults.dictionary(forKey: "openclaw.mac.node.openClawID.target")?.keys.sorted() == [
            "enrollmentID", "hostname",
        ])
        reopened.save(nil)
        #expect(try store.load() == nil)
    }

    @Test(arguments: ["not-a-uuid", ""])
    func `malformed saved selection is an error rather than an operator fallback`(id: String) throws {
        let suite = "NodeSelectionInvalidTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        defaults.set(
            ["hostname": "node.example.invalid", "enrollmentID": id],
            forKey: "openclaw.mac.node.openClawID.target")
        let store = MacNodeOpenClawIDSelectionStore(
            defaults: defaults, databaseURL: URL(fileURLWithPath: "/unused-profile/node-enrollment.sqlite"))
        #expect(throws: MacNodeOpenClawIDSelectionStore.LoadError.self) { try store.load() }
    }
}
