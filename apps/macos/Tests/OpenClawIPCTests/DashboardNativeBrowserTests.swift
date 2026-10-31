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
        let favicon = "data:image/png;base64,AQID"
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
                openerTabId: nil,
                favicon: nil),
            .init(
                id: "mac-second",
                sessionKey: "session-a",
                url: "about:blank",
                title: "",
                loading: true,
                canGoBack: false,
                canGoForward: false,
                openedBy: "native",
                openerTabId: "mac-first",
                favicon: favicon),
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
                    "favicon": favicon,
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
                openerTabId: nil,
                favicon: nil)])
            let encoded = try JSONEncoder().encode(state)
            let actual = try #require(JSONSerialization.jsonObject(with: encoded) as? [String: Any])
            let tabs = try #require(actual["tabs"] as? [[String: Any]])
            let tab = try #require(tabs.first)
            #expect(tab["sessionKey"] as? String == sessionKey)
            #expect((tab["sessionKey"] == nil) == (sessionKey == nil))
        }
    }

    @Test func `favicon results accept only bounded image data URLs`() {
        let prefix = "data:image/png;base64,"
        let maximum = prefix + String(repeating: "A", count: 98304 - prefix.utf8.count)
        for favicon in [prefix + "AQID", "data:image/SVG+xml;base64,AQID", maximum] {
            #expect(DashboardNativeBrowserHost.acceptedFavicon(favicon) == favicon)
        }
        let invalid: [Any?] = [
            nil, NSNull(), 42, false,
            "https://example.test/favicon.ico",
            "data:text/plain;base64,AQID",
            "data:image/svg+xml;charset=utf-8;base64,AQID",
            "data:image/png;base64,",
            "data:image/png;base64,???",
            "data:image/ſvg+xml;base64,AQID",
            "data:image/png;base64,KQID",
            maximum + "A",
        ]
        for value in invalid {
            #expect(DashboardNativeBrowserHost.acceptedFavicon(value) == nil)
        }
    }

    @MainActor
    @Test func `new windows route HTTP reading links and ignore blank popups`() throws {
        let url = try #require(URL(string: "https://example.test/new"))
        #expect(ControlUIDocumentHost.newWindowAction(
            for: url, sourceIsNativeReadingTab: true) == .openTab(url))
        #expect(ControlUIDocumentHost.newWindowAction(
            for: url, sourceIsNativeReadingTab: false) == .openExternal(url))
        for sourceIsNativeReadingTab in [false, true] {
            for address in ["about:blank", "file:///tmp/private", "mailto:reader@example.test"] {
                let target = try #require(URL(string: address))
                #expect(ControlUIDocumentHost.newWindowAction(
                    for: target,
                    sourceIsNativeReadingTab: sourceIsNativeReadingTab) == .ignore)
            }
            #expect(ControlUIDocumentHost.newWindowAction(
                for: nil, sourceIsNativeReadingTab: sourceIsNativeReadingTab) == .ignore)
        }
    }

    @MainActor
    @Test func `reading browser navigation reserves auxiliary schemes for subframes`() throws {
        let webURL = try #require(URL(string: "https://example.test/"))
        let blankURL = try #require(URL(string: "about:blank"))
        #expect(ControlUIDocumentHost.shouldAllowBrowserNavigation(to: webURL, isMainFrame: true))
        #expect(ControlUIDocumentHost.shouldAllowBrowserNavigation(to: webURL, isMainFrame: false))
        #expect(!ControlUIDocumentHost.shouldAllowBrowserNavigation(to: blankURL, isMainFrame: true))
        #expect(ControlUIDocumentHost.shouldAllowBrowserNavigation(to: blankURL, isMainFrame: false))
        for address in ["file:///tmp/private", "mailto:reader@example.test"] {
            #expect(try !ControlUIDocumentHost.shouldAllowBrowserNavigation(
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
            #expect(ControlUIDocumentHost.browserResponseAction(
                for: url, canShowMIMEType: false,
                isMainFrame: testCase.mainFrame, userActivated: testCase.activated) == testCase.expected)
            #expect(ControlUIDocumentHost.browserResponseAction(
                for: url, canShowMIMEType: true,
                isMainFrame: testCase.mainFrame, userActivated: testCase.activated) == .allow)
        }
        for address in ["file:///private/download", "mailto:reader@example.test", "about:blank"] {
            let target = try #require(URL(string: address))
            #expect(ControlUIDocumentHost.browserResponseAction(
                for: target, canShowMIMEType: false,
                isMainFrame: true, userActivated: true) == .cancel)
        }
        #expect(ControlUIDocumentHost.browserResponseAction(
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
    @Test func `a committed document clears only its tab's favicon from state`() throws {
        let fixture = self.fixture()
        defer { fixture.host.dispose() }
        let blank = try #require(URL(string: "about:blank"))
        let favicon = "data:image/png;base64,AQID"
        for tabId in ["mac-first", "mac-second"] {
            try fixture.host.open(tabId: tabId, url: blank, sessionKey: "")
            let webView = try #require(fixture.host.webView(for: tabId))
            let browser = try #require(fixture.host.browserTab(for: webView))
            browser.favicon = favicon
        }
        #expect(fixture.host.state.tabs.map(\.favicon) == [favicon, favicon])
        let first = try #require(fixture.host.webView(for: "mac-first"))
        fixture.host.navigationDidCommit(in: first)
        #expect(fixture.host.state.tabs.map(\.favicon) == [nil, favicon])
    }

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
        fixture.host.navigationDidFail(for: original, error: URLError(.cannotConnectToHost))
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

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct DashboardNativeBrowserFaviconTests {
    private static let favicon = "data:image/png;base64," +
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

    @Test func `navigations that keep the displayed page keep its favicon`() async throws {
        let unreachable = try await DashboardHTTPFixture.start()
        let unreachableURL = unreachable.url("/gone")
        unreachable.stop()
        let server = try await Self.server()
        defer { server.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        try controller.nativeBrowser.open(tabId: "mac-article", url: server.url("/article"), sessionKey: "")
        let article = try #require(controller.nativeBrowser.webView(for: "mac-article"))

        for trigger in ["fragment", "unreachable", "cancelled"] {
            try controller.nativeBrowser.navigate(tabId: "mac-article", url: server.url("/article"))
            try await TestWait.state("article favicon before \(trigger)") {
                !article.isLoading && controller.nativeBrowser.state.tabs.first?.favicon == Self.favicon
            }
            if trigger == "fragment" {
                _ = try await article.evaluateJavaScript("document.getElementById('jump').click(); true")
                try await TestWait.state("fragment navigation") { article.url?.fragment == "section" }
            } else {
                try controller.nativeBrowser.navigate(
                    tabId: "mac-article",
                    url: trigger == "unreachable" ? unreachableURL : server.url("/archive.bin"))
                try #require(article.isLoading)
                try await TestWait.state("\(trigger) navigation ends") { !article.isLoading }
                #expect(article.url?.path == "/article")
            }
            #expect(controller.nativeBrowser.state.tabs.first?.favicon == Self.favicon, "\(trigger)")
        }
    }

    @Test func `replacement documents drop the previous page's favicon, including history restores`() async throws {
        let server = try await Self.server()
        defer { server.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        try controller.nativeBrowser.open(tabId: "mac-article", url: server.url("/article"), sessionKey: "")
        let article = try #require(controller.nativeBrowser.webView(for: "mac-article"))
        try await TestWait.state("article favicon") {
            controller.nativeBrowser.state.tabs.first?.favicon == Self.favicon
        }

        try controller.nativeBrowser.navigate(tabId: "mac-article", url: server.url("/plain"))
        try await TestWait.state("plain page") { !article.isLoading && article.url?.path == "/plain" }
        #expect(controller.nativeBrowser.state.tabs.first?.favicon == nil)

        article.goBack()
        try await TestWait.state("article favicon after back") {
            !article.isLoading && controller.nativeBrowser.state.tabs.first?.favicon == Self.favicon
        }
        article.goForward()
        try await TestWait.state("plain page after forward") { !article.isLoading && article.url?.path == "/plain" }
        #expect(controller.nativeBrowser.state.tabs.first?.favicon == nil)
    }

    private static func server() async throws -> DashboardHTTPFixture {
        try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><head><title>Article</title><link rel="icon" href="\(self.favicon)"></head>
            <body><a id="jump" href="#section">Section</a><h2 id="section">Section</h2></body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; img-src data:; connect-src data:",
            rawResponseHandler: { request in
                let responses = [
                    "/archive.bin": ("application/octet-stream", "PK\u{3}\u{4}"),
                    "/plain": ("text/html", "<!doctype html><title>Plain</title>"),
                ]
                guard let (type, body) = responses.first(where: { request.hasPrefix("GET \($0.key) ") })?.value
                else { return nil }
                return .init(data: Data((
                    "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.utf8.count)\r\n" +
                        "Connection: close\r\n\r\n\(body)").utf8))
            })
    }

    private static func controller(_ server: DashboardHTTPFixture) -> DashboardWindowController {
        DashboardWindowController(
            url: server.url("/control/"),
            auth: DashboardWindowAuth.unauthenticated,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
    }
}

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct DashboardNativeBrowserFailureTests {
    private static let favicon = "data:image/png;base64," +
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="

    @Test func `a failed first load explains the failure and Reload retries the attempted URL`() async throws {
        let (port, attempted) = try await Self.releasedEndpoint("/article")
        let dashboard = try await DashboardHTTPFixture.start()
        defer { dashboard.stop() }
        let controller = Self.controller(dashboard)
        defer { controller.closeDashboard() }
        try controller.nativeBrowser.open(tabId: "mac-offline", url: attempted, sessionKey: "")
        let webView = try #require(controller.nativeBrowser.webView(for: "mac-offline"))
        let browser = try #require(controller.nativeBrowser.browserTab(for: webView))

        try await TestWait.state("failed first load") { !webView.isLoading && browser.failureView != nil }
        let failure = try #require(browser.failureView)
        #expect(failure.superview === webView)
        #expect(!failure.titleLabel.stringValue.isEmpty)
        #expect(!failure.messageLabel.stringValue.isEmpty)
        #expect(!failure.messageLabel.stringValue.contains("127.0.0.1"))
        #expect(webView.url == nil)
        #expect(controller.nativeBrowser.state.tabs.first?.url == attempted.absoluteString)

        let revived = try await Self.reclaim(port)
        defer { revived.stop() }
        failure.reloadButton.performClick(nil)
        try await TestWait.state("retried first load") {
            !webView.isLoading && webView.url == attempted && webView.title == "Article"
        }
        #expect(browser.failureView == nil)
        #expect(failure.superview == nil)
        #expect(controller.nativeBrowser.state.tabs.first?.url == attempted.absoluteString)
    }

    @Test func `a failed navigation from a loaded page keeps its favicon and toolbar Reload retries it`() async throws {
        let (port, attempted) = try await Self.releasedEndpoint("/article")
        let server = try await Self.server()
        defer { server.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        try controller.nativeBrowser.open(tabId: "mac-article", url: server.url("/article"), sessionKey: "")
        let webView = try #require(controller.nativeBrowser.webView(for: "mac-article"))
        let browser = try #require(controller.nativeBrowser.browserTab(for: webView))
        try await TestWait.state("loaded article") {
            !webView.isLoading && controller.nativeBrowser.state.tabs.first?.favicon == Self.favicon
        }

        try controller.nativeBrowser.navigate(tabId: "mac-article", url: attempted)
        try await TestWait.state("failed navigation") { !webView.isLoading && browser.failureView != nil }
        #expect(webView.url == server.url("/article"))
        let failed = try #require(controller.nativeBrowser.state.tabs.first)
        #expect(failed.url == attempted.absoluteString)
        #expect(failed.favicon == Self.favicon)

        let revived = try await Self.reclaim(port)
        defer { revived.stop() }
        try controller.nativeBrowser.perform(.reload, tabId: "mac-article")
        try await TestWait.state("retried navigation") {
            !webView.isLoading && webView.url == attempted && webView.title == "Article"
        }
        #expect(browser.failureView == nil)
        #expect(webView.canGoBack)
    }

    @Test(arguments: ["download", "stop", "replacement"])
    func `deliberate interruptions keep the page without failure UI`(_ trigger: String) async throws {
        let server = try await Self.server()
        defer { server.stop() }
        let stalled = try await DashboardHTTPFixture.start(beforeResponse: {
            try? await Task.sleep(for: .seconds(60))
        })
        defer { stalled.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        try controller.nativeBrowser.open(tabId: "mac-article", url: server.url("/article"), sessionKey: "")
        let webView = try #require(controller.nativeBrowser.webView(for: "mac-article"))
        let browser = try #require(controller.nativeBrowser.browserTab(for: webView))
        try await TestWait.state("loaded article") { !webView.isLoading && webView.title == "Article" }

        let expectedPath: String
        switch trigger {
        case "download":
            try controller.nativeBrowser.navigate(tabId: "mac-article", url: server.url("/archive.bin"))
            expectedPath = "/article"
        case "stop":
            try controller.nativeBrowser.navigate(tabId: "mac-article", url: stalled.url("/pending"))
            try await TestWait.state("request reaches the stalled server") { stalled.activeConnectionCount > 0 }
            try controller.nativeBrowser.perform(.stop, tabId: "mac-article")
            expectedPath = "/article"
        default:
            try controller.nativeBrowser.navigate(tabId: "mac-article", url: stalled.url("/pending"))
            try await TestWait.state("request reaches the stalled server") { stalled.activeConnectionCount > 0 }
            try controller.nativeBrowser.navigate(tabId: "mac-article", url: server.url("/plain"))
            expectedPath = "/plain"
        }
        try await TestWait.state("\(trigger) settles") { !webView.isLoading && webView.url?.path == expectedPath }
        #expect(browser.failureView == nil, "\(trigger)")
        #expect(controller.nativeBrowser.state.tabs.first?.url == webView.url?.absoluteString, "\(trigger)")
    }

    @Test func `repeated content process exits stop automatic reloads in only that tab until the user reloads`() async throws {
        var loads: [String: Int] = [:]
        let server = try await DashboardHTTPFixture.start(
            html: "<!doctype html><title>Article</title>",
            requestHandler: { request in
                let path = request.split(separator: " ").dropFirst().first.map(String.init) ?? ""
                loads[path, default: 0] += 1
                return nil
            })
        defer { server.stop() }
        let controller = Self.controller(server)
        defer { controller.closeDashboard() }
        let crashingURL = server.url("/crashing")
        // A different host keeps the second tab out of the first tab's content process.
        let otherURL = try #require(URL(string: "http://localhost:\(server.port)/other"))
        try controller.nativeBrowser.open(tabId: "mac-crashing", url: crashingURL, sessionKey: "")
        try controller.nativeBrowser.open(tabId: "mac-other", url: otherURL, sessionKey: "")
        let crashing = try #require(controller.nativeBrowser.webView(for: "mac-crashing"))
        let other = try #require(controller.nativeBrowser.webView(for: "mac-other"))
        let browser = try #require(controller.nativeBrowser.browserTab(for: crashing))
        try await TestWait.state("both tabs loaded") {
            !crashing.isLoading && crashing.title == "Article" && !other.isLoading && other.title == "Article"
        }
        try #require(Self.contentProcess(of: crashing) != Self.contentProcess(of: other))

        for exit in 1...DashboardBrowserTab.automaticReloadLimit {
            let before = loads["/crashing", default: 0]
            try Self.terminateContentProcess(of: crashing)
            try await TestWait.state("automatic reload \(exit)") {
                loads["/crashing", default: 0] > before && !crashing.isLoading && crashing.title == "Article"
            }
        }
        let before = loads["/crashing", default: 0]
        try Self.terminateContentProcess(of: crashing)
        try await TestWait.state("exhausted budget") {
            browser.failureView != nil || crashing.isLoading || loads["/crashing", default: 0] > before
        }
        #expect(browser.failureView != nil)
        #expect(!crashing.isLoading)
        #expect(loads["/crashing", default: 0] == before)
        #expect(controller.nativeBrowser.state.tabs.first?.url == crashingURL.absoluteString)

        // The other tab still recovers on its own budget.
        let otherBefore = loads["/other", default: 0]
        try Self.terminateContentProcess(of: other)
        try await TestWait.state("other tab reload") {
            loads["/other", default: 0] > otherBefore && !other.isLoading && other.title == "Article"
        }

        // Explicit Reload recovers the page and restores automatic recovery.
        try controller.nativeBrowser.perform(.reload, tabId: "mac-crashing")
        try await TestWait.state("manual reload") {
            loads["/crashing", default: 0] > before && !crashing.isLoading && crashing.title == "Article"
        }
        #expect(browser.failureView == nil)
        let reloaded = loads["/crashing", default: 0]
        try Self.terminateContentProcess(of: crashing)
        try await TestWait.state("automatic reload after manual reload") {
            loads["/crashing", default: 0] > reloaded && !crashing.isLoading && crashing.title == "Article"
        }

        // Navigate menu Back and Forward (Command-[ and Command-]) restore the full budget too.
        let secondURL = server.url("/second")
        crashing.load(URLRequest(url: secondURL))
        try await TestWait.state("second page") {
            crashing.url?.path == "/second" && !crashing.isLoading && crashing.title == "Article"
        }
        let window = try #require(controller.window)
        let rect = DashboardBrowserRect(x: 0, y: 0, width: 300, height: 200)
        try controller.nativeBrowser.present(scope: "panel", tabId: "mac-crashing", rect: rect, visible: true)
        #expect(window.makeFirstResponder(crashing))
        for back in [true, false] {
            let path = back ? crashingURL.path : secondURL.path
            if back { controller.navigateBack() } else { controller.navigateForward() }
            try await TestWait.state("menu history to \(path)") {
                crashing.url?.path == path && !crashing.isLoading
            }
            for exit in 1...DashboardBrowserTab.automaticReloadLimit {
                let before = loads[path, default: 0]
                try Self.terminateContentProcess(of: crashing)
                try await TestWait.state("automatic reload \(exit) at \(path)") {
                    browser.failureView != nil ||
                        (loads[path, default: 0] > before && !crashing.isLoading && crashing.title == "Article")
                }
                try #require(browser.failureView == nil, "exit \(exit) at \(path) after menu history")
            }
        }
    }

    private static func contentProcess(of webView: WKWebView) -> pid_t {
        (webView.value(forKey: "_webProcessIdentifier") as? NSNumber)?.int32Value ?? 0
    }

    /// Kills only the content process WebKit reports for this test-owned tab.
    private static func terminateContentProcess(of webView: WKWebView) throws {
        let pid = self.contentProcess(of: webView)
        try #require(pid > 1 && pid != getpid())
        try #require(Darwin.kill(pid, SIGKILL) == 0)
    }

    /// Reserves a loopback port and releases it, so loads fail with a refused connection.
    private static func releasedEndpoint(_ path: String) async throws -> (UInt16, URL) {
        let fixture = try await DashboardHTTPFixture.start()
        defer { fixture.stop() }
        return (fixture.port, fixture.url(path))
    }

    private static func reclaim(_ port: UInt16) async throws -> DashboardHTTPFixture {
        var revived: DashboardHTTPFixture?
        try await TestWait.state("released endpoint accepts again") {
            revived = try? await self.server(port: port)
            return revived != nil
        }
        return try #require(revived)
    }

    private static func server(port: UInt16 = 0) async throws -> DashboardHTTPFixture {
        try await DashboardHTTPFixture.start(
            port: port,
            html: """
            <!doctype html><html><head><title>Article</title><link rel="icon" href="\(self.favicon)"></head>
            <body>Article</body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; img-src data:; connect-src data:",
            rawResponseHandler: { request in
                let responses = [
                    "/archive.bin": ("application/octet-stream", "PK\u{3}\u{4}"),
                    "/plain": ("text/html", "<!doctype html><title>Plain</title>"),
                ]
                guard let (type, body) = responses.first(where: { request.hasPrefix("GET \($0.key) ") })?.value
                else { return nil }
                return .init(data: Data((
                    "HTTP/1.1 200 OK\r\nContent-Type: \(type)\r\nContent-Length: \(body.utf8.count)\r\n" +
                        "Connection: close\r\n\r\n\(body)").utf8))
            })
    }

    private static func controller(_ server: DashboardHTTPFixture) -> DashboardWindowController {
        DashboardWindowController(
            url: server.url("/control/"),
            auth: DashboardWindowAuth.unauthenticated,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
    }
}

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct DashboardNativeBrowserInspectTests {
    @Test func `inspection reports the real element when the page replaces the DOM lookups`() async throws {
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><body style="margin:0">
            <div id="real" style="width:600px;height:400px">Real content</div>
            <script>
            window.hookCalls = 0;
            document.elementFromPoint = () => {
              window.hookCalls += 1;
              const fake = document.createElement("button");
              fake.id = "spoofed";
              return fake;
            };
            const getAttribute = Element.prototype.getAttribute;
            Element.prototype.getAttribute = function (name) {
              window.hookCalls += 1;
              return getAttribute.call(this, name);
            };
            </script></body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url("/control/"),
            auth: DashboardWindowAuth.unauthenticated,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        try controller.nativeBrowser.open(tabId: "mac-page", url: server.url("/page"), sessionKey: "")
        try controller.nativeBrowser.present(
            scope: "panel", tabId: "mac-page", rect: DashboardBrowserRect(x: 0, y: 0, width: 600, height: 400),
            visible: true)
        let page = try #require(controller.nativeBrowser.webView(for: "mac-page"))
        try await TestWait.state("hooked page") { !page.isLoading && page.url?.path == "/page" }
        let pageWorld = try await page.evaluateJavaScript("(\(BrowserInspectScript.source))(10, 10)") as? [String: Any]
        #expect(pageWorld?["id"] as? String == "spoofed")
        _ = try await page.evaluateJavaScript("window.hookCalls = 0")

        let reply = try await controller.nativeBrowser.inspect(tabId: "mac-page", x: 10, y: 10)

        let node = try #require(reply["node"] as? [String: Any])
        #expect(node["id"] as? String == "real")
        #expect(node["tag"] as? String == "div")
        let hookCalls = try await page.evaluateJavaScript("window.hookCalls") as? Int
        #expect(hookCalls == 0)
    }
}
