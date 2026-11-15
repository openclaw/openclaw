import AppKit
import Foundation
import OpenClawProtocol
import SwiftUI
import Testing
@testable import OpenClaw

@MainActor
struct AgentEventStoreTests {
    @Test
    func `append and clear`() {
        let store = AgentEventStore()
        #expect(store.events.isEmpty)

        store.append(ControlAgentEvent(
            runId: "run",
            seq: 1,
            stream: "test",
            ts: 0,
            data: [:] as [String: OpenClawProtocol.AnyCodable],
            summary: nil))
        #expect(store.events.count == 1)

        store.clear()
        #expect(store.events.isEmpty)
    }

    @Test
    func `trims to max events`() {
        let store = AgentEventStore()
        for i in 1...401 {
            store.append(ControlAgentEvent(
                runId: "run",
                seq: i,
                stream: "test",
                ts: Double(i),
                data: [:] as [String: OpenClawProtocol.AnyCodable],
                summary: nil))
        }

        #expect(store.events.count == 400)
        #expect(store.events.first?.seq == 2)
        #expect(store.events.last?.seq == 401)
    }
}

@Suite(.serialized)
@MainActor
struct AgentEventsWindowRowIdentityTests {
    @Test
    func `keeps one row per run when sequence numbers overlap`() async throws {
        // The window must process the second run's update, so run the AppKit event loop.
        try await AppKitTestSupport.startApplication()
        // The window renders `AgentEventStore.shared`, so drive the store the app renders.
        let store = AgentEventStore.shared
        store.clear()
        defer { store.clear() }
        store.append(Self.event(runId: "run-a", seq: 1, stream: "alpha"))

        let host = NSHostingView(rootView: AgentEventsWindow())
        host.frame = NSRect(x: 0, y: 0, width: 640, height: 520)
        let window = NSWindow(
            contentRect: host.frame,
            styleMask: [.titled],
            backing: .buffered,
            defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        defer {
            window.orderOut(nil)
            window.contentView = nil
            window.close()
        }
        window.makeKeyAndOrderFront(nil)
        window.orderFrontRegardless()

        // Let the first run render, then start a second run that reuses seq=1 while the window
        // is open. Keying rows by the per-run `seq` makes the renderer reuse the first row, so
        // the earlier run disappears instead of keeping its own row.
        _ = try await Self.waitForRows(in: host) { texts in
            texts.contains { $0.contains("run-a") }
        }
        store.append(Self.event(runId: "run-b", seq: 1, stream: "beta"))
        let texts = try await Self.waitForRows(in: host) { texts in
            Self.renderedRunIDs(in: texts) == ["run-a", "run-b"]
        }
        let rows = Self.renderedRunIDs(in: texts)
        #expect(rows == ["run-a", "run-b"], "rendered rows: \(rows)")
    }

    private static func event(runId: String, seq: Int, stream: String) -> ControlAgentEvent {
        ControlAgentEvent(
            runId: runId,
            seq: seq,
            stream: stream,
            ts: Double(seq),
            data: [:] as [String: OpenClawProtocol.AnyCodable],
            summary: nil)
    }

    private static func renderedRunIDs(in texts: [String]) -> Set<String> {
        Set(["run-a", "run-b"].filter { runID in
            texts.contains { $0.contains(runID) }
        })
    }

    private static func waitForRows(
        in host: NSView,
        timeout: Duration = .seconds(5),
        _ predicate: ([String]) -> Bool) async throws -> [String]
    {
        var texts: [String] = []
        let deadline = ContinuousClock.now.advanced(by: timeout)
        while ContinuousClock.now < deadline {
            host.layoutSubtreeIfNeeded()
            texts = try await Self.accessibilityTexts(in: host)
            if predicate(texts) { return texts }
            try await Task.sleep(for: .milliseconds(20))
        }
        return texts
    }

    private static func accessibilityTexts(in root: NSView) async throws -> [String] {
        let elements = try await AppKitTestSupport.accessibilityElements(in: root)
        return elements.flatMap { element -> [String] in
            var texts: [String] = []
            if let name = AppKitTestSupport.accessibilityName(of: element), !name.isEmpty {
                texts.append(name)
            }
            if let value: Any = element.accessibilityValue?() {
                texts.append(String(describing: value))
            }
            return texts
        }
    }
}
