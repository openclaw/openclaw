import Foundation
import Testing
@testable import OpenClaw

struct HealthStoreStateTests {
    @Test @MainActor func `linked channel probe failure degrades state`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "whatsapp": .init(
                    configured: true,
                    linked: true,
                    authAgeMs: 1,
                    probe: .init(
                        ok: false,
                        status: 503,
                        error: "gateway connect failed",
                        elapsedMs: 12,
                        bot: nil,
                        webhook: nil),
                    lastProbeAt: 0),
            ],
            channelOrder: ["whatsapp"],
            channelLabels: ["whatsapp": "WhatsApp"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        switch store.state {
        case let .degraded(message):
            #expect(!message.isEmpty)
        default:
            Issue.record("Expected degraded state when probe fails for linked channel")
        }

        #expect(store.summaryLine.contains("probe degraded"))
    }

    @Test @MainActor func `gateway healthy with no linked channel reports ok`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [
                "slack": .init(
                    configured: true,
                    linked: nil,
                    authAgeMs: nil,
                    probe: .init(
                        ok: true,
                        status: 200,
                        error: nil,
                        elapsedMs: 5,
                        bot: nil,
                        webhook: nil),
                    lastProbeAt: 0),
            ],
            channelOrder: ["slack"],
            channelLabels: ["slack": "Slack"],
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        #expect(store.state == .ok)
        #expect(store.summaryLine == "Gateway healthy")
    }

    @Test @MainActor func `gateway healthy with empty channels reports ok`() {
        let snap = HealthSnapshot(
            ok: true,
            ts: 0,
            durationMs: 1,
            channels: [:],
            channelOrder: [],
            channelLabels: nil,
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        #expect(store.state == .ok)
        #expect(store.summaryLine == "Gateway healthy")
    }

    @Test @MainActor func `gateway not ok with no linked channel stays pending`() {
        let snap = HealthSnapshot(
            ok: false,
            ts: 0,
            durationMs: 1,
            channels: [:],
            channelOrder: [],
            channelLabels: nil,
            heartbeatSeconds: 60,
            sessions: .init(path: "/tmp/sessions.json", count: 0, recent: []))

        let store = HealthStore.shared
        store.__setSnapshotForTest(snap, lastError: nil)

        #expect(store.state == .unknown)
        #expect(store.summaryLine == "Health check pending")
    }
}
