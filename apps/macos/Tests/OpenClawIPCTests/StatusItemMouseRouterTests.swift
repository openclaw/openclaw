import AppKit
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct StatusItemMouseRouterTests {
    @Test func `installed monitor consumes the native button event`() throws {
        let (window, button) = Self.makeButtonWindow()
        defer { window.close() }

        let monitorToken = NSObject()
        var installedMask: NSEvent.EventTypeMask = []
        var installedHandler: StatusItemMouseRouter.EventMonitorHandler?
        var removedMonitor = false
        var leftClicks = 0
        let router = StatusItemMouseRouter(
            eventMonitorInstaller: { mask, handler in
                installedMask = mask
                installedHandler = handler
                return monitorToken
            },
            eventMonitorRemover: { monitor in
                removedMonitor = monitor as AnyObject === monitorToken
            })
        router.install(
            on: button,
            onLeftClick: { leftClicks += 1 },
            onRightClick: {},
            onHoverChanged: { _ in })

        #expect(installedMask == [.leftMouseDown, .rightMouseDown])
        let handler = try #require(installedHandler)
        let left = try Self.mouseEvent(.leftMouseDown, window: window, location: NSPoint(x: 30, y: 30))
        #expect(handler(left) == nil)
        #expect(leftClicks == 1)

        router.uninstall()
        #expect(removedMonitor)
    }

    @Test func `routes left and right clicks without opening the native menu`() throws {
        let (window, button) = Self.makeButtonWindow()
        defer { window.close() }

        var leftClicks = 0
        var rightClicks = 0
        var hoverStates: [Bool] = []
        let router = StatusItemMouseRouter()
        router.install(
            on: button,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 },
            onHoverChanged: { hoverStates.append($0) })
        defer { router.uninstall() }

        let left = try Self.mouseEvent(.leftMouseDown, window: window, location: NSPoint(x: 30, y: 30))
        let right = try Self.mouseEvent(.rightMouseDown, window: window, location: NSPoint(x: 30, y: 30))
        let outside = try Self.mouseEvent(.leftMouseDown, window: window, location: NSPoint(x: 5, y: 5))

        #expect(router.route(left) == nil)
        #expect(leftClicks == 1)
        #expect(rightClicks == 0)

        #expect(router.route(right) == nil)
        #expect(leftClicks == 1)
        #expect(rightClicks == 1)

        let routedOutside = try #require(router.route(outside))
        #expect(routedOutside === outside)

        router.mouseEntered(with: left)
        router.mouseExited(with: left)
        #expect(hoverStates == [true, false])
    }

    @Test func `replacement button becomes the only click target`() throws {
        let (firstWindow, firstButton) = Self.makeButtonWindow()
        let (secondWindow, secondButton) = Self.makeButtonWindow()
        defer {
            firstWindow.close()
            secondWindow.close()
        }

        var leftClicks = 0
        var rightClicks = 0
        let router = StatusItemMouseRouter()
        defer { router.uninstall() }

        router.install(
            on: firstButton,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 },
            onHoverChanged: { _ in })
        router.install(
            on: secondButton,
            onLeftClick: { leftClicks += 1 },
            onRightClick: { rightClicks += 1 },
            onHoverChanged: { _ in })

        let staleClick = try Self.mouseEvent(
            .leftMouseDown,
            window: firstWindow,
            location: NSPoint(x: 30, y: 30))
        let currentClick = try Self.mouseEvent(
            .rightMouseDown,
            window: secondWindow,
            location: NSPoint(x: 30, y: 30))

        let routedStaleClick = try #require(router.route(staleClick))
        #expect(routedStaleClick === staleClick)
        #expect(router.route(currentClick) == nil)
        #expect(leftClicks == 0)
        #expect(rightClicks == 1)
    }

    private static func makeButtonWindow() -> (NSWindow, NSStatusBarButton) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 120, height: 80),
            styleMask: .borderless,
            backing: .buffered,
            defer: false)
        let button = NSStatusBarButton(frame: NSRect(x: 20, y: 20, width: 40, height: 24))
        window.contentView?.addSubview(button)
        return (window, button)
    }

    private static func mouseEvent(
        _ type: NSEvent.EventType,
        window: NSWindow,
        location: NSPoint) throws -> NSEvent
    {
        try #require(NSEvent.mouseEvent(
            with: type,
            location: location,
            modifierFlags: [],
            timestamp: 0,
            windowNumber: window.windowNumber,
            context: nil,
            eventNumber: 1,
            clickCount: 1,
            pressure: 1))
    }
}
