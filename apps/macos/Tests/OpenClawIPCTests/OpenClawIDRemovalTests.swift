import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

@MainActor
struct OpenClawIDRemovalTests {
    static let now = Date(timeIntervalSince1970: 1_800_000_000)

    @Test(arguments: [MacOpenClawIDRemoval.Origin.here, .elsewhere])
    func `removal retires local state and new enrollment clears recovery`(origin: MacOpenClawIDRemoval.Origin) async throws {
        let suite = "ocid-removal-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MacOpenClawIDDeviceStore(
            defaults: defaults, databaseURL: URL(fileURLWithPath: "/unused.sqlite"))
        let device = MacOpenClawIDDevice(
            hostname: "studio.example.test", clawID: "fixture", discoveryOrigin: URL(string: "https://id.example.test")!,
            deviceEnrollmentID: UUID(), nodeEnrollmentID: nil, approvedWith: .device)
        store.save(device)
        var effects: [String] = []
        await store.remove(
            device, origin: origin, now: Self.now,
            stopRoute: { effects.append("route") }, deselectNode: { effects.append("node") },
            forgetKeys: { retired in
                #expect(retired == device)
                effects.append("keys")
            }, clearPrimary: { effects.append("primary") })
        #expect(effects == ["route", "node", "primary", "keys"])
        #expect(store.load() == nil)
        let restarted = MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: store.databaseURL)
        #expect(restarted.lastRemoval() == .init(hostname: device.hostname, date: Self.now, origin: origin))
        #expect(restarted.lastRemoval()?.shortName == "studio")
        restarted.save(device)
        #expect(restarted.load() == device)
        #expect(restarted.lastRemoval() == nil)
    }

    @Test func `verified removal during a local request retains local origin`() async throws {
        let suite = "ocid-local-removal-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let store = MacOpenClawIDDeviceStore(defaults: defaults, databaseURL: URL(fileURLWithPath: "/unused.sqlite"))
        let device = MacOpenClawIDDevice(
            hostname: "studio.example.test", clawID: "fixture", discoveryOrigin: URL(string: "https://id.example.test")!,
            deviceEnrollmentID: UUID(), nodeEnrollmentID: nil, approvedWith: .device)
        store.save(device)
        store.beginLocalRemoval(device)
        await store.remove(
            device, origin: .elsewhere, stopRoute: {}, deselectNode: {}, forgetKeys: { _ in }, clearPrimary: {})
        store.endLocalRemoval(device)
        #expect(store.lastRemoval()?.origin == .here)
        store.clearRemoval()
        #expect(store.lastRemoval() == nil)
    }

    @Test func `settings offers enrollment without a remote primary and preserves migration`() {
        let removal = MacOpenClawIDRemoval(hostname: "studio.example.test", date: Self.now, origin: .here)
        for mode in [AppState.ConnectionMode.unconfigured, .local] {
            for note in [nil, removal] {
                #expect(OpenClawIDSettingsModel.unenrolledPresentation(
                    available: true, mode: mode, transport: .direct, target: "", url: "", removal: note) ==
                    .signIn(removal: note))
            }
        }
        #expect(OpenClawIDSettingsModel.unenrolledPresentation(
            available: false, mode: .unconfigured, transport: .direct, target: "", url: "", removal: removal) == nil)
        #expect(OpenClawIDSettingsModel.unenrolledPresentation(
            available: true, mode: .remote, transport: .direct, target: "", url: "wss://studio.ts.net", removal: nil) ==
            .migrate(claw: "studio.ts.net", route: "Tailscale", address: "studio.ts.net"))
    }

    @Test(arguments: [MacOpenClawIDRemoval.Origin.here, .elsewhere])
    func `dashboard recovery escapes names and offers enrollment not reload`(origin: MacOpenClawIDRemoval.Origin) {
        let removal = MacOpenClawIDRemoval(hostname: "studio<&>.example.test", date: Self.now, origin: origin)
        let html = DashboardFailurePage.html(removal: removal, now: Self.now.addingTimeInterval(120))
        #expect(html.contains("studio&lt;&amp;&gt;"))
        #expect(!html.contains("studio<&>"))
        #expect(html.contains("openclaw-id-sign-in"))
        #expect(html.contains("Set up a different connection"))
        #expect(html.contains("close-recovery"))
        #expect(!html.contains("type:'reload'"))
        #expect(!html.contains("class=\"badge\""))
        #expect(html.contains(origin == .here ? "You removed it in Settings 2m ago" : "removed from another device"))
    }

    @Test func `removed menu offers sign in first without gateway not configured`() {
        let snapshot = StatusMenuDescriptor.Snapshot(
            connection: .unconfigured,
            removal: .init(hostname: "studio.example.test", date: Self.now, origin: .here), openClawIDAvailable: true)
        let entries = StatusMenuDescriptor.build(from: snapshot).sections.flatMap(\.entries)
        #expect(entries.prefix(2).map(\.id) == ["header", "action.openClawIDSignIn"])
        #expect(!entries.contains { $0.id == "placeholder" })
        #expect(snapshot.removal?.subtitle(now: Self.now.addingTimeInterval(120)) == "Removed from studio · 2m ago")
    }
}
