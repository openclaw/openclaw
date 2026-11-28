import AppKit
import SwiftUI
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct TalkOverlayTests {
    @Test
    func `single click toggles pause after the double click interval`() async throws {
        let orb = OrbInteractionNSView()
        var toggles: [ContinuousClock.Instant] = []
        orb.onSingleClick = { toggles.append(.now) }

        let earliest = ContinuousClock.now + .seconds(NSEvent.doubleClickInterval)
        try self.click(orb, count: 1)
        #expect(toggles.isEmpty)

        let timeout = earliest + .seconds(1)
        while toggles.isEmpty, ContinuousClock.now < timeout {
            try await Task.sleep(for: .milliseconds(10))
        }
        #expect(toggles.count == 1)
        let first = try #require(toggles.first)
        #expect(first >= earliest)
    }

    @Test
    func `double click stops speech without toggling pause`() async throws {
        let orb = OrbInteractionNSView()
        var toggles = 0
        var stops = 0
        orb.onSingleClick = { toggles += 1 }
        orb.onDoubleClick = { stops += 1 }

        try self.click(orb, count: 1)
        try self.click(orb, count: 2)

        #expect(stops == 1)
        try await Task.sleep(for: .seconds(NSEvent.doubleClickInterval + 0.05))
        #expect(toggles == 0)
        #expect(stops == 1)
    }

    @Test(arguments: [nil, 1, 2] as [Int?])
    func `drag or removal cancels a pending click`(dragClickCount: Int?) async throws {
        let orb = OrbInteractionNSView()
        var toggles = 0
        var stops = 0
        var drags = 0
        orb.onSingleClick = { toggles += 1 }
        orb.onDoubleClick = { stops += 1 }
        orb.onDragStart = { drags += 1 }

        try self.click(orb, count: 1)
        if let dragClickCount {
            try orb.mouseDown(with: self.mouseEvent(.leftMouseDown, count: dragClickCount))
            let location = NSPoint(x: 3, y: 0)
            try orb.mouseDragged(with: self.mouseEvent(.leftMouseDragged, count: dragClickCount, location: location))
            try orb.mouseUp(with: self.mouseEvent(.leftMouseUp, count: dragClickCount, location: location))
            #expect(drags == 1)
        } else {
            orb.viewWillMove(toWindow: nil)
        }

        try await Task.sleep(for: .seconds(NSEvent.doubleClickInterval + 0.05))
        #expect(toggles == 0)
        #expect(stops == 0)
    }

    @Test
    func `visibility intent changes before animations complete`() throws {
        _ = NSApplication.shared
        let controller = TalkOverlayController()
        controller.present()
        let window = try #require(NSApplication.shared.windows.first {
            ($0.contentView as? NSHostingView<TalkOverlayView>)?.rootView.controller === controller
        })
        defer { window.orderOut(nil) }

        #expect(controller.model.isVisible)
        controller.dismiss()
        #expect(!controller.model.isVisible)
        controller.present()
        #expect(controller.model.isVisible)
        controller.dismiss()
        #expect(!controller.model.isVisible)
    }

    private func click(_ orb: OrbInteractionNSView, count: Int) throws {
        try orb.mouseDown(with: self.mouseEvent(.leftMouseDown, count: count))
        try orb.mouseUp(with: self.mouseEvent(.leftMouseUp, count: count))
    }

    private func mouseEvent(_ type: NSEvent.EventType, count: Int, location: NSPoint = .zero) throws -> NSEvent {
        try #require(NSEvent.mouseEvent(
            with: type,
            location: location,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: count,
            clickCount: count,
            pressure: 1))
    }
}
