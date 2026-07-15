import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct StatusItemMouseRouterTests {
    @Test func `installed monitor consumes the target event before native dispatch`() throws {
        let monitorToken = NSObject()
        var installedMask: NSEvent.EventTypeMask = []
        var installedHandler: StatusItemMouseRouter.EventMonitorHandler?
        var leftClicks = 0
        let installedToken = try #require(StatusItemMouseRouter.installMonitor(
            using: { mask, handler in
                installedMask = mask
                installedHandler = handler
                return monitorToken
            },
            handler: { event in
                StatusItemMouseRouter.route(
                    event,
                    hitsTarget: true,
                    onLeftClick: { leftClicks += 1 },
                    onRightClick: {})
            }))

        #expect(installedMask == [.leftMouseDown, .rightMouseDown])
        #expect(installedToken as AnyObject === monitorToken)
        let handler = try #require(installedHandler)
        let left = try Self.mouseEvent(.leftMouseDown)
        #expect(handler(left) == nil)
        #expect(leftClicks == 1)
    }

    @Test func `routes left and right clicks without opening the native menu`() throws {
        var leftClicks = 0
        var rightClicks = 0
        let left = try Self.mouseEvent(.leftMouseDown)
        let right = try Self.mouseEvent(.rightMouseDown)

        #expect(StatusItemMouseRouter.route(
            left,
            hitsTarget: true,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 }) == nil)
        #expect(leftClicks == 1)
        #expect(rightClicks == 0)

        #expect(StatusItemMouseRouter.route(
            right,
            hitsTarget: true,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 }) == nil)
        #expect(leftClicks == 1)
        #expect(rightClicks == 1)
    }

    @Test func `non-target and unrelated events continue to native dispatch`() throws {
        var leftClicks = 0
        var rightClicks = 0
        let nonTarget = try Self.mouseEvent(.leftMouseDown)
        let unrelated = try Self.mouseEvent(.mouseMoved)

        let routedNonTarget = try #require(StatusItemMouseRouter.route(
            nonTarget,
            hitsTarget: false,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 }))
        let routedUnrelated = try #require(StatusItemMouseRouter.route(
            unrelated,
            hitsTarget: true,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 }))

        #expect(routedNonTarget === nonTarget)
        #expect(routedUnrelated === unrelated)
        #expect(leftClicks == 0)
        #expect(rightClicks == 0)
    }

    private static func mouseEvent(_ type: NSEvent.EventType) throws -> NSEvent {
        try #require(NSEvent.mouseEvent(
            with: type,
            location: .zero,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: 0,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1))
    }
}
