import AppKit
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardFullScreenTests {
    @Test func `completed full screen transitions preserve the windowed toolbar`() throws {
        let controller = try Self.makeController()
        defer { controller.closeDashboard() }
        let window = try #require(controller.window)
        let toolbar = try #require(window.toolbar)
        #expect(toolbar.isVisible)

        for _ in 0..<2 {
            NotificationCenter.default.post(name: NSWindow.willEnterFullScreenNotification, object: window)
            #expect(toolbar.isVisible)

            NotificationCenter.default.post(name: NSWindow.didEnterFullScreenNotification, object: window)
            #expect(!toolbar.isVisible)
            #expect(window.toolbar === toolbar)

            NotificationCenter.default.post(name: NSWindow.willExitFullScreenNotification, object: window)
            #expect(!toolbar.isVisible)

            NotificationCenter.default.post(name: NSWindow.didExitFullScreenNotification, object: window)
            #expect(toolbar.isVisible)
            #expect(window.toolbar === toolbar)
            #expect(window.toolbarStyle == .unified)
            window.toggleToolbarShown(nil)
            #expect(toolbar.isVisible)
        }
    }

    @Test func `replacement reconciles toolbar visibility without showing the window`() throws {
        let controller = try Self.makeController()
        defer { controller.closeDashboard() }
        let window = try #require(controller.window)
        let previousToolbar = try #require(window.toolbar)
        NotificationCenter.default.post(name: NSWindow.didEnterFullScreenNotification, object: window)
        #expect(!previousToolbar.isVisible)

        // Notifications exercise delegate routing without an interactive Space transition.
        // The actual style remains windowed, so replacement must restore windowed chrome.
        #expect(!window.styleMask.contains(.fullScreen))
        let transferredWindow = try #require(controller.detachWindowForReplacement())
        defer { transferredWindow.close() }
        let replacement = try Self.makeController(reusing: transferredWindow)
        defer { replacement.closeDashboard() }

        #expect(replacement.window === window)
        #expect(window.toolbar !== previousToolbar)
        #expect(window.toolbar?.isVisible == true)
    }

    @Test func `full screen notifications only affect their own dashboard`() throws {
        let first = try Self.makeController()
        defer { first.closeDashboard() }
        let second = try Self.makeController()
        defer { second.closeDashboard() }
        let firstWindow = try #require(first.window)
        let secondWindow = try #require(second.window)

        NotificationCenter.default.post(name: NSWindow.didEnterFullScreenNotification, object: firstWindow)
        #expect(firstWindow.toolbar?.isVisible == false)
        #expect(secondWindow.toolbar?.isVisible == true)

        NotificationCenter.default.post(name: NSWindow.didEnterFullScreenNotification, object: secondWindow)
        NotificationCenter.default.post(name: NSWindow.didExitFullScreenNotification, object: firstWindow)
        #expect(firstWindow.toolbar?.isVisible == true)
        #expect(secondWindow.toolbar?.isVisible == false)

        NotificationCenter.default.post(name: NSWindow.didExitFullScreenNotification, object: secondWindow)
        #expect(secondWindow.toolbar?.isVisible == true)
    }

    private static func makeController(reusing window: NSWindow? = nil) throws -> DashboardWindowController {
        try DashboardWindowController(
            url: #require(URL(string: "about:blank")),
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            reusingWindow: window,
            requestBrowserProfileImportOffer: { _ in false })
    }
}
