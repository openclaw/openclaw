import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

struct DashboardNativeBrowserContractTests {
    @Test func `navigation messages admit only reading surface URLs`() throws {
        for address in ["https://example.test/article", "http://example.test/", "about:blank"] {
            let url = try #require(URL(string: address))
            #expect(try DashboardBrowserMessageHandler.decode([
                "type": "open", "sessionKey": "", "tabId": "mac-fixture", "url": address,
            ]) == .open(tabId: "mac-fixture", url: url, sessionKey: "", activate: true))
            #expect(try DashboardBrowserMessageHandler.decode([
                "type": "navigate", "tabId": "mac-fixture", "url": address,
            ]) == .navigate(tabId: "mac-fixture", url: url))
        }
        for address in [
            "file:///tmp/page.html",
            "javascript:void(0)",
            "data:text/html,hello",
            "mailto:reader@example.test",
            "about:config",
            "/relative",
            "https://",
            "",
        ] {
            for type in ["open", "navigate"] {
                #expect(throws: (any Error).self) {
                    try DashboardBrowserMessageHandler.decode([
                        "type": type, "sessionKey": "", "tabId": "mac-fixture", "url": address,
                    ])
                }
            }
        }
        let blankURL = try #require(URL(string: "about:blank"))
        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "open", "sessionKey": "", "tabId": "mac-background", "url": "about:blank", "activate": false,
        ]) == .open(tabId: "mac-background", url: blankURL, sessionKey: "", activate: false))
    }

    @Test func `open requests preserve valid session identities and reject malformed values`() throws {
        let url = try #require(URL(string: "about:blank"))
        for sessionKey in ["", "agent:main:chat:session-a"] {
            #expect(try DashboardBrowserMessageHandler.decode([
                "type": "open", "tabId": "mac-fixture", "url": "about:blank", "sessionKey": sessionKey,
            ]) == .open(tabId: "mac-fixture", url: url, sessionKey: sessionKey, activate: true))
        }
        for sessionKey: Any in [NSNull(), 42, " session-a", "session-a "] {
            #expect(throws: (any Error).self) {
                try DashboardBrowserMessageHandler.decode([
                    "type": "open", "tabId": "mac-fixture", "url": "about:blank", "sessionKey": sessionKey,
                ])
            }
        }
    }

    @Test func `released UI open requests without session identity retain the window scope`() throws {
        let url = try #require(URL(string: "about:blank"))
        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "open", "tabId": "mac-fixture", "url": "about:blank",
        ]) == .open(tabId: "mac-fixture", url: url, sessionKey: nil, activate: true))
        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "open", "tabId": "mac-background", "url": "about:blank", "activate": false,
        ]) == .open(tabId: "mac-background", url: url, sessionKey: nil, activate: false))
    }

    @Test func `requests preserve tab and presentation identities without coercion`() throws {
        let actions: [DashboardBrowserAction] = [.back, .forward, .reload, .stop, .close, .snapshot, .download]
        for action in actions {
            #expect(try DashboardBrowserMessageHandler.decode([
                "type": action.rawValue, "tabId": "mac-fixture",
            ]) == .action(action, tabId: "mac-fixture"))
        }
        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "present", "scope": "panel-one", "tabId": "mac-fixture",
            "rect": ["x": 10.5, "y": 20, "width": 300, "height": 200], "visible": true,
        ]) == .present(
            scope: "panel-one", tabId: "mac-fixture",
            rect: .init(x: 10.5, y: 20, width: 300, height: 200), visible: true))
        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "present", "scope": "panel-one", "tabId": NSNull(),
            "rect": NSNull(), "visible": false,
        ]) == .present(scope: "panel-one", tabId: nil, rect: nil, visible: false))
        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "release-scope", "scope": "panel-one",
        ]) == .releaseScope("panel-one"))

        #expect(try DashboardBrowserMessageHandler.decode([
            "type": "inspect", "tabId": "mac-fixture", "x": 10.5, "y": 20,
        ]) == .inspect(tabId: "mac-fixture", x: 10.5, y: 20))

        let malformed: [Any] = [
            NSNull(), "open", [String: Any](), ["type": "unknown"],
            ["type": "close"], ["type": "close", "tabId": ""], ["type": "close", "tabId": 42],
            ["type": "download"], ["type": "download", "tabId": " "],
            ["type": "open", "sessionKey": "", "tabId": "mac-fixture", "url": "about:blank", "activate": 1],
            ["type": "release-scope", "scope": false],
            ["type": "inspect", "tabId": "mac-fixture", "x": -1, "y": 0],
            ["type": "inspect", "tabId": "mac-fixture", "x": 0, "y": Double.nan],
            ["type": "inspect", "tabId": "mac-fixture", "x": true, "y": 0],
            [
                "type": "present",
                "scope": "panel-one",
                "tabId": NSNull(),
                "rect": NSNull(),
                "visible": 1,
            ],
        ]
        for body in malformed {
            #expect(throws: (any Error).self) {
                try DashboardBrowserMessageHandler.decode(body)
            }
        }
    }

    @Test func `presentation rectangles reject nonfinite values and invalid dimensions`() {
        let invalid: [[String: Any]] = [
            ["x": Double.nan, "y": 0, "width": 100, "height": 100],
            ["x": 0, "y": Double.infinity, "width": 100, "height": 100],
            ["x": 0, "y": 0, "width": -1, "height": 100],
            ["x": 0, "y": 0, "width": 100, "height": -1],
            ["x": true, "y": 0, "width": 100, "height": 100],
            ["x": 0, "y": 0, "width": 100],
        ]
        for rect in invalid {
            #expect(throws: (any Error).self) {
                try DashboardBrowserMessageHandler.decode([
                    "type": "present", "scope": "panel-one", "tabId": "mac-fixture",
                    "rect": rect, "visible": true,
                ])
            }
        }
    }

    @Test func `state uses the web contract keys and preserves creation order and opener provenance`() throws {
        let state = DashboardBrowserState(revision: 7, tabs: [
            .init(
                id: "mac-first",
                sessionKey: "session-a",
                url: "https://example.test/",
                title: "A \"quoted\" page",
                loading: false,
                canGoBack: true,
                canGoForward: false,
                openedBy: "web",
                openerTabId: nil),
            .init(
                id: "mac-second",
                sessionKey: "session-a",
                url: "about:blank",
                title: "",
                loading: true,
                canGoBack: false,
                canGoForward: false,
                openedBy: "native",
                openerTabId: "mac-first"),
        ])
        let encoded = try JSONEncoder().encode(state)
        let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? NSDictionary)
        let expected: NSDictionary = [
            "revision": 7,
            "tabs": [
                [
                    "id": "mac-first",
                    "sessionKey": "session-a",
                    "url": "https://example.test/",
                    "title": "A \"quoted\" page",
                    "loading": false,
                    "canGoBack": true,
                    "canGoForward": false,
                    "openedBy": "web",
                ],
                [
                    "id": "mac-second",
                    "sessionKey": "session-a",
                    "url": "about:blank",
                    "title": "",
                    "loading": true,
                    "canGoBack": false,
                    "canGoForward": false,
                    "openedBy": "native",
                    "openerTabId": "mac-first",
                ],
            ],
        ]
        #expect(actual == expected)
    }

    @Test func `legacy tab state omits session identity while shell tabs preserve the empty key`() throws {
        for sessionKey: String? in [nil, ""] {
            let state = DashboardBrowserState(revision: 1, tabs: [.init(
                id: "mac-legacy",
                sessionKey: sessionKey,
                url: "about:blank",
                title: "",
                loading: false,
                canGoBack: false,
                canGoForward: false,
                openedBy: "web",
                openerTabId: nil)])
            let encoded = try JSONEncoder().encode(state)
            let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            let tabs = try #require(actual["tabs"] as? [[String: Any]])
            let tab = try #require(tabs.first)
            #expect(tab["sessionKey"] as? String == sessionKey)
            #expect((tab["sessionKey"] == nil) == (sessionKey == nil))
        }
    }

    @MainActor
    @Test func `new windows route HTTP reading links and ignore blank popups`() throws {
        let url = try #require(URL(string: "https://example.test/new"))
        #expect(DashboardWindowController.newWindowAction(
            for: url, sourceIsNativeReadingTab: true) == .openTab(url))
        #expect(DashboardWindowController.newWindowAction(
            for: url, sourceIsNativeReadingTab: false) == .openExternal(url))
        for sourceIsNativeReadingTab in [false, true] {
            for address in ["about:blank", "file:///tmp/private", "mailto:reader@example.test"] {
                let target = try #require(URL(string: address))
                #expect(DashboardWindowController.newWindowAction(
                    for: target,
                    sourceIsNativeReadingTab: sourceIsNativeReadingTab) == .ignore)
            }
            #expect(DashboardWindowController.newWindowAction(
                for: nil, sourceIsNativeReadingTab: sourceIsNativeReadingTab) == .ignore)
        }
    }

    @MainActor
    @Test func `reading browser navigation reserves auxiliary schemes for subframes`() throws {
        let webURL = try #require(URL(string: "https://example.test/"))
        let blankURL = try #require(URL(string: "about:blank"))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: webURL, isMainFrame: true))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: webURL, isMainFrame: false))
        #expect(!DashboardWindowController.shouldAllowBrowserNavigation(to: blankURL, isMainFrame: true))
        #expect(DashboardWindowController.shouldAllowBrowserNavigation(to: blankURL, isMainFrame: false))
        for address in ["file:///tmp/private", "mailto:reader@example.test"] {
            #expect(try !DashboardWindowController.shouldAllowBrowserNavigation(
                to: #require(URL(string: address)), isMainFrame: false))
        }
    }

    @MainActor
    @Test func `non-displayable responses require an activated main frame to open externally`() throws {
        let url = try #require(URL(string: "https://example.test/download"))
        let cases: [(mainFrame: Bool, activated: Bool, expected: DashboardBrowserResponseAction)] = [
            (true, true, .openExternal(url)),
            (false, true, .cancel),
            (true, false, .cancel),
            (false, false, .cancel),
        ]
        for testCase in cases {
            #expect(DashboardWindowController.browserResponseAction(
                for: url, canShowMIMEType: false,
                isMainFrame: testCase.mainFrame, userActivated: testCase.activated) == testCase.expected)
            #expect(DashboardWindowController.browserResponseAction(
                for: url, canShowMIMEType: true,
                isMainFrame: testCase.mainFrame, userActivated: testCase.activated) == .allow)
        }
        for address in ["file:///private/download", "mailto:reader@example.test", "about:blank"] {
            let target = try #require(URL(string: address))
            #expect(DashboardWindowController.browserResponseAction(
                for: target, canShowMIMEType: false,
                isMainFrame: true, userActivated: true) == .cancel)
        }
        #expect(DashboardWindowController.browserResponseAction(
            for: nil, canShowMIMEType: false, isMainFrame: true, userActivated: true) == .cancel)
    }

    @Test func `CSS rectangles flip vertically and clip to the dashboard frame`() {
        let dashboard = CGRect(x: 20, y: 30, width: 800, height: 600)
        #expect(DashboardNativeBrowserHost.mappedFrame(
            rect: .init(x: 100, y: 40, width: 300, height: 200),
            dashboardFrame: dashboard) == CGRect(x: 120, y: 390, width: 300, height: 200))
        #expect(DashboardNativeBrowserHost.mappedFrame(
            rect: .init(x: -50, y: -20, width: 100, height: 80),
            dashboardFrame: dashboard) == CGRect(x: 20, y: 570, width: 50, height: 60))
        #expect(DashboardNativeBrowserHost.mappedFrame(
            rect: .init(x: 780, y: 580, width: 100, height: 100),
            dashboardFrame: dashboard) == CGRect(x: 800, y: 30, width: 20, height: 20))
        #expect(DashboardNativeBrowserHost.mappedFrame(
            rect: .init(x: 900, y: 0, width: 100, height: 100), dashboardFrame: dashboard).isEmpty)
    }
}

@Suite(.serialized)
@MainActor
struct DashboardNativeBrowserHostTests {
    @Test func `releasing a presentation keeps window tabs alive and closing removes only its tab`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        let url = try #require(URL(string: "about:blank"))
        try fixture.host.open(tabId: "mac-first", url: url, sessionKey: "")
        try fixture.host.open(
            tabId: "mac-second",
            url: #require(URL(string: "http://127.0.0.1:1/second")),
            sessionKey: "")
        let first = try #require(fixture.host.webView(for: "mac-first"))
        let second = try #require(fixture.host.webView(for: "mac-second"))
        #expect(first.configuration.websiteDataStore === second.configuration.websiteDataStore)
        #expect(!first.configuration.websiteDataStore.isPersistent)
        #expect(fixture.host.state.tabs.map(\.id) == ["mac-first", "mac-second"])
        #expect(first.isHidden)
        try fixture.host.present(
            scope: "panel-one", tabId: "mac-first",
            rect: .init(x: 100, y: 40, width: 300, height: 200), visible: true)
        #expect(!first.isHidden)
        #expect(fixture.container.convert(first.bounds, from: first) ==
            CGRect(x: 120, y: 390, width: 300, height: 200))
        #expect(second.isHidden)
        fixture.host.releaseScope("panel-one")
        #expect(first.isHidden)
        #expect(fixture.host.state.tabs.count == 2)
        try fixture.host.close(tabId: "mac-first")
        #expect(first.superview == nil)
        #expect(fixture.host.webView(for: "mac-first") == nil)
        #expect(fixture.host.state.tabs.map(\.id) == ["mac-second"])
        #expect(fixture.host.hasTabs)
        try fixture.host.close(tabId: "mac-second")
        #expect(!fixture.host.hasTabs)
        #expect(second.superview == nil)
    }

    @Test func `most recent scope wins and releasing it restores the surviving presentation`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        try fixture.host.open(tabId: "mac-first", url: #require(URL(string: "about:blank")), sessionKey: "")
        let tab = try #require(fixture.host.webView(for: "mac-first"))
        let firstRect = DashboardBrowserRect(x: 10, y: 20, width: 200, height: 100)
        let secondRect = DashboardBrowserRect(x: 300, y: 50, width: 300, height: 250)
        #expect(fixture.host.presentationScope(for: tab) == nil)
        try fixture.host.present(scope: "panel-one", tabId: "mac-first", rect: firstRect, visible: true)
        try fixture.host.present(scope: "panel-two", tabId: "mac-first", rect: secondRect, visible: true)
        #expect(fixture.host.presentationScope(for: tab) == "panel-two")
        #expect(fixture.container.convert(tab.bounds, from: tab) ==
            CGRect(x: 320, y: 330, width: 300, height: 250))
        fixture.host.releaseScope("panel-two")
        #expect(fixture.host.presentationScope(for: tab) == "panel-one")
        #expect(!tab.isHidden)
        #expect(fixture.container.convert(tab.bounds, from: tab) ==
            CGRect(x: 30, y: 510, width: 200, height: 100))
        try fixture.host.present(scope: "panel-one", tabId: "mac-first", rect: firstRect, visible: false)
        #expect(fixture.host.presentationScope(for: tab) == nil)
        #expect(tab.isHidden)
        try fixture.host.present(scope: "panel-one", tabId: "mac-first", rect: firstRect, visible: true)
        fixture.host.releaseAllScopes()
        #expect(tab.isHidden)
        #expect(fixture.host.hasTabs)
    }

    @Test func `page opened tabs publish native provenance and the opener identity`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        let url = try #require(URL(string: "http://127.0.0.1:1/popup"))
        try fixture.host.open(tabId: "mac-parent", url: url, sessionKey: "")
        let opener = try #require(fixture.host.webView(for: "mac-parent"))
        fixture.host.openNewWindow(url, opener: opener)
        let tabs = fixture.host.state.tabs
        #expect(tabs.count == 2)
        #expect(tabs.first?.openedBy == "web")
        let child = try #require(tabs.last)
        #expect(child.id != "mac-parent")
        #expect(child.openedBy == "native")
        #expect(child.openerTabId == "mac-parent")
        #expect(child.url == url.absoluteString)
        #expect(fixture.host.webView(for: child.id) != nil)
    }

    @Test func `opening a reading link reuses its current URL or retained requested alias`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        let requested = try #require(URL(string: "http://127.0.0.1:1/short"))
        let redirected = try #require(URL(string: "http://127.0.0.1:1/final"))
        #expect(try fixture.host.open(tabId: "mac-original", url: requested, sessionKey: "") == "mac-original")
        let original = try #require(fixture.host.webView(for: "mac-original"))
        #expect(try fixture.host.open(tabId: "mac-same", url: requested, sessionKey: "") == "mac-original")
        fixture.host.navigationWillStart(redirected, in: original)
        #expect(try fixture.host.open(tabId: "mac-alias", url: requested, sessionKey: "") == "mac-original")
        #expect(try fixture.host.open(tabId: "mac-current", url: redirected, sessionKey: "") == "mac-original")
        #expect(fixture.host.state.tabs.map(\.id) == ["mac-original"])
        #expect(fixture.host.webView(for: "mac-original") === original)

        fixture.host.openNewWindow(requested, opener: original)
        let current = try #require(fixture.host.state.tabs.last)
        #expect(current.id != "mac-original")
        #expect(try fixture.host.open(tabId: "mac-prefer-current", url: requested, sessionKey: "") == current.id)
        #expect(fixture.host.state.tabs.count == 2)

        try fixture.host.close(tabId: current.id)
        fixture.host.navigationDidFail(for: original)
        #expect(try fixture.host.open(tabId: "mac-retry", url: requested, sessionKey: "") == "mac-retry")
        #expect(fixture.host.state.tabs.map(\.id) == ["mac-original", "mac-retry"])

        // The explicit new-tab action opens about:blank and must always get its own tab.
        let blank = try #require(URL(string: "about:blank"))
        #expect(try fixture.host.open(tabId: "mac-blank-one", url: blank, sessionKey: "") == "mac-blank-one")
        #expect(try fixture.host.open(tabId: "mac-blank-two", url: blank, sessionKey: "") == "mac-blank-two")
        #expect(fixture.host.state.tabs.map(\.id) == ["mac-original", "mac-retry", "mac-blank-one", "mac-blank-two"])
    }

    @Test func `reading links and their redirect aliases are reused only within their session`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        let requested = try #require(URL(string: "http://127.0.0.1:1/short"))
        let redirected = try #require(URL(string: "http://127.0.0.1:1/final"))
        #expect(try fixture.host.open(tabId: "mac-first", url: requested, sessionKey: "session-a") == "mac-first")
        let original = try #require(fixture.host.webView(for: "mac-first"))
        fixture.host.navigationWillStart(redirected, in: original)
        #expect(try fixture.host.open(tabId: "mac-alias", url: requested, sessionKey: "session-a") == "mac-first")
        #expect(try fixture.host.open(tabId: "mac-current", url: redirected, sessionKey: "session-a") == "mac-first")
        #expect(try fixture.host.open(tabId: "mac-second", url: requested, sessionKey: "session-b") == "mac-second")
        #expect(try fixture.host.open(tabId: "mac-third", url: redirected, sessionKey: "session-b") == "mac-third")
        #expect(fixture.host.state.tabs.map(\.sessionKey) == ["session-a", "session-b", "session-b"])
        #expect(fixture.host.webView(for: "mac-first") === original)

        fixture.host.openNewWindow(requested, opener: original)
        let popup = try #require(fixture.host.state.tabs.last)
        #expect(popup.sessionKey == "session-a")
        #expect(popup.openerTabId == "mac-first")
        #expect(try fixture.host.open(tabId: "mac-reuse-popup", url: requested, sessionKey: "session-a") == popup.id)
        #expect(try fixture.host
            .open(tabId: "mac-reuse-second", url: requested, sessionKey: "session-b") == "mac-second")
    }

    @Test func `legacy ownership survives reuse and popups without becoming the empty shell scope`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        let url = try #require(URL(string: "http://127.0.0.1:1/page"))
        #expect(try fixture.host.open(tabId: "mac-legacy", url: url, sessionKey: nil) == "mac-legacy")
        #expect(try fixture.host.open(tabId: "mac-reuse", url: url, sessionKey: nil) == "mac-legacy")
        #expect(try fixture.host.open(tabId: "mac-shell", url: url, sessionKey: "") == "mac-shell")
        #expect(try fixture.host.open(tabId: "mac-session", url: url, sessionKey: "session-a") == "mac-session")
        let opener = try #require(fixture.host.webView(for: "mac-legacy"))
        fixture.host.openNewWindow(url, opener: opener)
        let popup = try #require(fixture.host.state.tabs.last)
        #expect(popup.openerTabId == "mac-legacy")
        #expect(popup.sessionKey == nil)
        #expect(fixture.host.state.tabs.map(\.sessionKey) == [nil, "", "session-a", nil])
    }

    @Test func `requested alias survives the initial redirect chain and retires on later navigation`() throws {
        let requested = try #require(URL(string: "http://127.0.0.1:1/short"))
        let redirected = try #require(URL(string: "http://127.0.0.1:1/final"))
        let tab = DashboardBrowserTab(websiteDataStore: .nonPersistent(), requestedURL: requested)
        defer { tab.dispose() }
        let navigation = NSObject()
        tab.startNavigation(navigation)
        tab.updateRepresentedURL(redirected)
        tab.startNavigation(navigation)
        #expect(tab.requestedURLAlias == requested)
        tab.finishNavigation(navigation, at: redirected, title: "Final page")
        #expect(tab.requestedURLAlias == requested)
        #expect(tab.representedURL == redirected)
        tab.startNavigation(NSObject())
        #expect(tab.requestedURLAlias == nil)
        #expect(tab.representedURL == redirected)
    }

    @Test(arguments: ["replacement", "failure", "same-document"])
    func `requested alias retires when the original page is no longer reusable`(_ transition: String) throws {
        let requested = try #require(URL(string: "http://127.0.0.1:1/short"))
        let redirected = try #require(URL(string: "http://127.0.0.1:1/final"))
        let replacement = try #require(URL(string: "http://127.0.0.1:1/replacement"))
        let tab = DashboardBrowserTab(websiteDataStore: .nonPersistent(), requestedURL: requested)
        defer { tab.dispose() }
        let navigation = NSObject()
        tab.startNavigation(navigation)
        tab.updateRepresentedURL(redirected)
        switch transition {
        case "replacement": tab.startNavigation(NSObject())
        case "failure": tab.failNavigation()
        default:
            tab.finishNavigation(navigation, at: redirected, title: nil)
            tab.updateRepresentedURL(replacement)
        }
        #expect(tab.requestedURLAlias == nil)
    }

    @Test func `state pushes coalesce in the same main runloop turn`() async {
        var states: [DashboardBrowserState] = []
        let fixture = self.fixture { states.append($0) }
        defer { fixture.host.dispose() }
        fixture.host.scheduleStatePush()
        fixture.host.scheduleStatePush()
        fixture.host.scheduleStatePush()
        #expect(states.isEmpty)
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        #expect(states.count == 1)
        let firstRevision = states.first?.revision ?? 0
        fixture.host.scheduleStatePush()
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        #expect(states.count == 2)
        #expect((states.last?.revision ?? 0) > firstRevision)
    }

    private func fixture(
        onStateChange: @escaping (DashboardBrowserState) -> Void = { _ in })
        -> (host: DashboardNativeBrowserHost, container: NSView, dashboard: WKWebView)
    {
        let store = WKWebsiteDataStore.nonPersistent()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = store
        let container = NSView(frame: CGRect(x: 0, y: 0, width: 1000, height: 800))
        let dashboard = WKWebView(
            frame: CGRect(x: 20, y: 30, width: 800, height: 600), configuration: configuration)
        container.addSubview(dashboard)
        let host = DashboardNativeBrowserHost(
            dashboardWebView: dashboard, container: container,
            websiteDataStore: store, onStateChange: onStateChange)
        return (host, container, dashboard)
    }
}
