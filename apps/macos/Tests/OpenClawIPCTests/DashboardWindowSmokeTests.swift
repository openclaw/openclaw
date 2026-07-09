import Foundation
@testable import OpenClaw
import Testing

@Suite(.serialized)
@MainActor
struct DashboardWindowSmokeTests {
    @Test func `dashboard window controller shows and closes`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:18789/control/",
                token: "device-token",
                password: nil
            )
        )
        controller.show()
        #expect(controller.window?.styleMask.contains(.titled) == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        #expect(controller.window?.contentViewController != nil)
        #expect(controller.window?.standardWindowButton(.closeButton) != nil)
        #expect((controller.window?.frame.width ?? 0) >= DashboardWindowLayout.windowMinSize.width)
        #expect((controller.window?.frame.height ?? 0) >= DashboardWindowLayout.windowMinSize.height)
        controller.closeDashboard()
    }

    @Test func `dashboard navigation stays on same endpoint`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        #expect(try DashboardWindowController.shouldAllowNavigation(
            to: #require(URL(string: "http://127.0.0.1:18789/control/chat")),
            dashboardURL: dashboard
        ))
        #expect(try !DashboardWindowController.shouldAllowNavigation(
            to: #require(URL(string: "https://docs.openclaw.ai/")),
            dashboardURL: dashboard
        ))
    }

    @Test func `dashboard parses only bounded native link requests`() throws {
        let request = DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "https://docs.openclaw.ai/platforms/macos",
            "target": "inline",
        ])
        #expect(try request == DashboardLinkRequest(
            url: #require(URL(string: "https://docs.openclaw.ai/platforms/macos")),
            target: .inline
        ))

        #expect(DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "file:///tmp/private",
            "target": "inline",
        ]) == nil)
        #expect(DashboardWindowController.linkRequest(from: [
            "type": "open-link",
            "url": "https://docs.openclaw.ai/",
            "target": "unknown",
        ]) == nil)
        #expect(DashboardWindowController.linkRequest(from: [
            "type": "other",
            "url": "https://docs.openclaw.ai/",
            "target": "external",
        ]) == nil)
    }

    @Test func `dashboard trusts only its main control path for link messages`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let trusted = try #require(URL(string: "http://127.0.0.1:18789/control/chat"))
        let wrongPath = try #require(URL(string: "http://127.0.0.1:18789/control-room"))
        let wrongPort = try #require(URL(string: "http://127.0.0.1:18790/control/"))
        #expect(DashboardWindowController.isTrustedLinkSource(trusted, dashboardURL: dashboard))
        #expect(!DashboardWindowController.isTrustedLinkSource(wrongPath, dashboardURL: dashboard))
        #expect(!DashboardWindowController.isTrustedLinkSource(wrongPort, dashboardURL: dashboard))
        #expect(!DashboardWindowController.isTrustedLinkSource(nil, dashboardURL: dashboard))
    }

    @Test func `dashboard link browser is isolated collapsed and width persistent`() throws {
        let dashboard = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: dashboard,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        )
        #expect(controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserDataStore === controller._testDashboardDataStore)
        #expect(!controller._testCanOpenWindowsAutomatically)
        #expect(controller._testLinkBrowserNavigationObservationCount == 3)
        #expect(controller._testSplitAutosaveName == DashboardWindowLayout.linkBrowserSplitAutosaveName)

        let report = try #require(URL(string: "http://127.0.0.1:1/report"))
        controller._testOpenLinkBrowser(report)
        #expect(!controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserRepresentedURL == report)
        controller._testCloseLinkBrowser()
        #expect(controller._testLinkBrowserIsCollapsed)
        #expect(controller._testLinkBrowserRepresentedURL == nil)
    }

    @Test func `sidebar browser keeps web navigations in its top level context`() throws {
        let webURL = try #require(URL(string: "https://github.com/openclaw/openclaw"))
        let blankURL = try #require(URL(string: "about:blank"))
        let fileURL = try #require(URL(string: "file:///tmp/private"))
        let mailURL = try #require(URL(string: "mailto:hello@example.com"))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: webURL))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: blankURL))
        #expect(!DashboardWindowController.shouldAllowBrowserNavigation(to: fileURL))
        #expect(!DashboardWindowController.shouldAllowBrowserNavigation(to: mailURL))
    }

    @Test func `external pointer fallback rejects synthetic link activation`() throws {
        let webURL = try #require(URL(string: "https://docs.openclaw.ai/"))
        let mailURL = try #require(URL(string: "mailto:hello@example.com"))
        #expect(DashboardWindowController.shouldOpenExternalDashboardNavigation(
            webURL,
            navigationType: .linkActivated,
            buttonNumber: 1
        ))
        #expect(DashboardWindowController.shouldOpenExternalDashboardNavigation(
            mailURL,
            navigationType: .linkActivated,
            buttonNumber: 1
        ))
        #expect(!DashboardWindowController.shouldOpenExternalDashboardNavigation(
            webURL,
            navigationType: .linkActivated,
            buttonNumber: 0
        ))
        #expect(!DashboardWindowController.shouldOpenExternalDashboardNavigation(
            mailURL,
            navigationType: .other,
            buttonNumber: 1
        ))

        #expect(DashboardWindowController.targetlessNavigationAction(
            for: webURL,
            navigationType: .linkActivated,
            buttonNumber: 1
        ) == .allow)
        #expect(DashboardWindowController.targetlessNavigationAction(
            for: mailURL,
            navigationType: .linkActivated,
            buttonNumber: 1
        ) == .openExternal)
        #expect(DashboardWindowController.targetlessNavigationAction(
            for: mailURL,
            navigationType: .linkActivated,
            buttonNumber: 0
        ) == .cancel)
    }

    @Test func `dashboard origin brackets ipv6 literals`() throws {
        let url = try #require(URL(string: "http://[fd12:3456:789a::1]:18789/control/"))
        #expect(DashboardWindowController.originString(for: url) == "http://[fd12:3456:789a::1]:18789")
    }

    @Test func `dashboard log string strips token fragment`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/#token=sekret")) // pragma: allowlist secret
        #expect(dashboardLogString(for: url) == "http://127.0.0.1:18789/control/")
    }

    @Test func `dashboard native chrome clears both desktop sidebars`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        )
        let chromeScript = try #require(controller._testUserScripts.first {
            $0.source.contains("openclaw-native-macos-chrome")
        })

        #expect(chromeScript.source.contains(".sidebar-shell"))
        #expect(chromeScript.source.contains(".settings-sidebar__header"))
        #expect(chromeScript.source.contains(".topbar"))
        #expect(chromeScript.source.contains("max-width: 1100px"))
        #expect(chromeScript.source.contains("--openclaw-native-titlebar-height"))
    }

    @Test func `dashboard failure state opens in dashboard window`() throws {
        let url = try #require(URL(string: "http://127.0.0.1:18789/control/"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        )
        controller.showFailure(
            title: "Dashboard unavailable",
            message: "Remote control tunnel failed",
            detail: "Reset the remote tunnel and try again."
        )
        #expect(controller.window?.isVisible == true)
        #expect(controller.window?.styleMask.contains(.closable) == true)
        controller.closeDashboard()
    }

    private func makeShownController() throws -> DashboardWindowController {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "device-token",
                password: nil
            )
        )
        controller.show()
        return controller
    }

    @Test func `dashboard follows ready endpoint to a new tunnel port`() async throws {
        let controller = try makeShownController()
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: "device-token",
            password: nil
        ))

        #expect(controller.currentURL.absoluteString == "http://127.0.0.1:60002/#token=device-token")
        let authScripts = controller._testUserScripts
            .filter { $0.source.contains("__OPENCLAW_NATIVE_CONTROL_AUTH__") }
        #expect(authScripts.count == 1)
        // JSONSerialization escapes "/" so match on host:port, not the full origin.
        #expect(authScripts.first?.source.contains("127.0.0.1:60002") == true)
        #expect(authScripts.first?.source.contains("60001") == false)
    }

    @Test func `dashboard keeps endpoint when ready state matches current URL`() async throws {
        let controller = try makeShownController()
        defer { controller.closeDashboard() }
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)
        let scriptsBefore = controller._testUserScripts

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60001")),
            token: "device-token",
            password: nil
        ))
        await manager.handleEndpointState(.connecting(mode: .remote, detail: "Connecting…"))
        await manager.handleEndpointState(.unavailable(mode: .remote, reason: "tunnel down"))

        #expect(controller.currentURL.absoluteString == "http://127.0.0.1:60001/#token=device-token")
        // Identity check: an unchanged endpoint must not re-inject scripts or reload.
        #expect(controller._testUserScripts.elementsEqual(scriptsBefore) { $0 === $1 })
    }

    @Test func `dashboard ignores endpoint changes while window is closed`() async throws {
        let url = try #require(URL(string: "http://127.0.0.1:60001/#token=device-token"))
        let controller = DashboardWindowController(
            url: url,
            auth: DashboardWindowAuth(
                gatewayUrl: "ws://127.0.0.1:60001/",
                token: "device-token",
                password: nil
            )
        )
        let manager = DashboardManager._testMake()
        manager._testSetController(controller)

        try await manager.handleEndpointState(.ready(
            mode: .remote,
            url: #require(URL(string: "ws://127.0.0.1:60002")),
            token: "device-token",
            password: nil
        ))

        #expect(controller.currentURL == url)
    }
}
