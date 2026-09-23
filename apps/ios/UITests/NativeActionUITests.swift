import UIKit
import XCTest

/// Public controls complement the hosted owner/race suite; they do not replace its private invariants.
@MainActor
final class NativeActionUITests: XCTestCase {
    private struct Session: Decodable {
        let key: String
        let name: String
        let runID: String?
        let prompt: String?
        let priorPrompt: String?
    }

    private struct Fixture: Decodable {
        let kind: String
        let setupCode: String
        let trustSetupCode: String
        let fingerprint: String
        let profileID: String
        let controlURL: URL
        let shortcutPrefix: String
        let primary: Session
        let other: Session
        let dashboard: Session
    }

    private enum Shortcut: String, CaseIterable {
        case primaryOpen, otherOpen, primaryRun, otherRun, compose
    }

    private var app: XCUIApplication!
    private var shortcuts: XCUIApplication!
    private var fixture: Fixture!
    private var witness = ""
    private var subphase = ""
    private var baseline: [String: Any] = [:]
    private var lastFacts: [String: Any] = [:]
    private let draft = "native UI unsent draft"

    override func setUpWithError() throws {
        try super.setUpWithError()
        self.continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        self.app?.terminate()
        self.shortcuts?.terminate()
        XCUIDevice.shared.orientation = .portrait
        try super.tearDownWithError()
    }

    func testNativeControlsPreserveOwnerAuthority() async throws {
        try await self.start(kind: "phone")
        for shortcut in Shortcut.allCases {
            try self.createShortcut(shortcut)
        }
        self.app.activate()
        try await self.runControls()
        try await self.sidebarRouting()
        try await self.settingsPaths()
        try await self.dashboardPresentation()
        try await self.nativeProjection()
        try await self.sidebarFork()
        try await self.newChat()
        try await self.forkSessionControls()
        try await self.appChatModal()
        try await self.sharedChatModal()
        try await self.newOptionsLandscape()
        try await self.pagesPortrait()
        try await self.pagesLandscape()
        try await self.gatewayProblem()
        try await self.approvalDashboard()
        try await self.notificationGuidance()
        try await self.agentDeepLink()
        try await self.gatewayTrust()
        self.phase("complete")
    }

    func testSplitPagesControlsPreserveOwnerAuthority() async throws {
        try await self.start(kind: "tablet")
        try await self.begin("split-pages")
        try await self.step("landscape") { self.orient(.landscapeLeft) }
        try await self.step("split-visible") {
            XCTAssertGreaterThanOrEqual(self.app.frame.width, 980)
            XCTAssertGreaterThan(self.app.frame.width, self.app.frame.height)
            self.require(self.app.buttons["RootTabs.Sidebar.Destination.chat"])
            self.require(self.app.textViews["chat-message-input"])
        }
        try await self.step("edit") { self.openPages() }
        try await self.step("pin") { self.setPagePinned(true) }
        try await self.step("unpin") { self.setPagePinned(false) }
        try await self.step("done") { self.closeNavigation("Pages", button: "Done") }
        try await self.step("select") {
            self.openPages()
            self.tap(self.app.buttons["RootTabs.Sidebar.Pages.Select.activity"])
            self.require(self.app.navigationBars["Activity"])
            self.require(self.app.buttons["RootTabs.Sidebar.Destination.chat"])
        }
        try await self.complete()
        self.phase("complete")
    }

    private func start(kind: String) async throws {
        let data = try XCTUnwrap(ProcessInfo.processInfo.environment["OPENCLAW_IOS_NATIVE_UI_FIXTURE"])
        self.fixture = try JSONDecoder().decode(Fixture.self, from: Data(data.utf8))
        XCTAssertEqual(self.fixture.kind, kind)
        XCTAssertEqual(self.fixture.controlURL.host, "127.0.0.1")
        self.app = XCUIApplication()
        self.shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        self.app.launchArguments = ["-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        self.pairGatewayForUITest(
            in: self.app, setupCode: self.fixture.setupCode, initialTab: "chat", initialDestination: "chat",
            expectedTLSFingerprint: self.fixture.fingerprint)
        InstalledShortcutsControls.selectSession(self.fixture.primary.name, in: self.app)
        _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        _ = try await self.control("onboarded")
        self.phase("onboarded")
    }

    private func begin(_ id: String) async throws {
        self.witness = id
        self.subphase = ""
        _ = try await self.control("begin")
        self.phase(id + ":begin")
    }

    private func step(_ id: String, _ action: () async throws -> Void) async throws {
        self.subphase = id
        self.baseline = try InstalledShortcutsControls.observation(in: self.app)
        _ = try await self.control("prepare", ["observation": self.baseline])
        try await action()
        let after = try InstalledShortcutsControls.observation(in: self.app)
        self.lastFacts = try await self.control("observe", ["observation": after, "uiVerified": true])
        self.phase(self.witness + ":" + id)
    }

    private func complete() async throws {
        let image = XCTAttachment(screenshot: self.app.screenshot())
        image.name = "native-control-" + self.witness
        image.lifetime = .keepAlways
        self.add(image)
        _ = try await self.control("complete")
        self.phase(self.witness + ":complete")
    }

    private func control(_ action: String, _ facts: [String: Any] = [:]) async throws -> [String: Any] {
        var request = URLRequest(url: self.fixture.controlURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        var payload = facts
        payload["action"] = action
        payload["id"] = self.witness
        payload["step"] = self.subphase
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Native UI fixture refused evidence")
        XCTAssertLessThan(data.count, 4096)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func phase(_ value: String) {
        print("[ios-native-ui] phase=\(value)")
    }

    private func require(_ element: XCUIElement, timeout: TimeInterval = 15) {
        XCTAssertTrue(element.waitForExistence(timeout: timeout), "Required public control is absent")
        XCTAssertFalse(element.frame.isEmpty)
    }

    private func tap(_ element: XCUIElement) {
        self.require(element)
        XCTAssertTrue(element.isEnabled && element.isHittable)
        element.tap()
    }

    private func wait(_ predicate: @escaping () -> Bool) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in predicate() }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 15), .completed)
    }

    private func orient(_ orientation: UIDeviceOrientation) {
        XCUIDevice.shared.orientation = orientation
        self.wait {
            orientation == .portrait
                ? self.app.frame.height > self.app.frame.width
                : self.app.frame.width > self.app.frame.height
        }
    }

    private func showSidebar() {
        let show = self.app.buttons["RootTabs.Sidebar.Show"]
        if show.exists, show.isHittable { self.tap(show) }
        self.require(self.app.buttons["RootTabs.Sidebar.Destination.chat"])
    }

    private func destination(_ value: String) {
        self.showSidebar()
        self.tap(self.app.buttons["RootTabs.Sidebar.Destination." + value])
    }

    private func selectPrimary() {
        InstalledShortcutsControls.selectSession(self.fixture.primary.name, in: self.app)
    }

    private func selectRow(_ name: String) {
        self.showSidebar()
        let rows = self.app.buttons.containing(.staticText, identifier: name)
        self.require(rows.firstMatch)
        XCTAssertEqual(rows.count, 1)
        self.tap(rows.firstMatch)
    }

    private func closeNavigation(_ title: String, button: String) {
        let bar = self.app.navigationBars[title]
        self.tap(bar.buttons[button])
        self.wait { !bar.exists }
    }

    private func swipeSheet(_ title: String) {
        let sheet = self.app.sheets.containing(.navigationBar, identifier: title)
        XCTAssertEqual(sheet.count, 1)
        self.require(sheet.firstMatch)
        sheet.firstMatch.swipeDown()
        self.wait { !sheet.firstMatch.exists }
    }

    private func chatAction(_ title: String) {
        self.tap(self.app.buttons["Chat actions"])
        let popover = self.app.descendants(matching: .any)["chat-actions-popover"]
        self.require(popover)
        self.tap(popover.buttons[title])
    }

    private func editor(_ text: String) {
        let editor = self.app.textViews["chat-message-input"]
        self.tap(editor)
        let old = editor.value as? String ?? ""
        editor.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: old.count) + text)
        XCTAssertEqual(editor.value as? String, text)
    }

    private func createShortcut(_ shortcut: Shortcut) throws {
        try self.shortcuts.open(XCTUnwrap(URL(string: "shortcuts://create-shortcut")))
        let isRun = shortcut == .primaryRun || shortcut == .otherRun
        InstalledShortcutsControls.addAction(
            isRun ? "Open Run" : shortcut == .compose ? "Compose Message" : "Open Session",
            in: self.shortcuts)
        let session = shortcut == .otherRun || shortcut == .otherOpen ? self.fixture.other : self.fixture.primary
        InstalledShortcutsControls.choose(isRun ? "Run" : "Session", in: self.shortcuts)
        try InstalledShortcutsControls.choose(isRun ? XCTUnwrap(session.runID) : session.name, in: self.shortcuts)
        InstalledShortcutsControls.expand(in: self.shortcuts)
        if shortcut == .compose {
            let field = self.shortcuts.textFields["Draft"].firstMatch
            self.tap(field)
            field.typeText("fixture compose request")
        }
        InstalledShortcutsControls.assertHiddenParameters(in: self.shortcuts)
        InstalledShortcutsControls.save(self.fixture.shortcutPrefix + shortcut.rawValue, in: self.shortcuts)
    }

    private func launch(_ shortcut: Shortcut) throws {
        var url = try XCTUnwrap(URLComponents(string: "shortcuts://run-shortcut"))
        url.queryItems = [URLQueryItem(name: "name", value: self.fixture.shortcutPrefix + shortcut.rawValue)]
        try self.shortcuts.open(XCTUnwrap(url.url))
        self.app.activate()
    }

    private func forwarded(_ kind: String, _ outcome: String, since before: [String: Any]? = nil) throws {
        let before = before ?? self.baseline
        let count = try XCTUnwrap(before["forwardingCompletions"] as? Int)
        let observed = try InstalledShortcutsControls.waitForObservation(in: self.app) {
            $0["forwardingCompletions"] as? Int == count + 1
        }
        XCTAssertEqual(observed["forwardingEntries"] as? Int, count + 1)
        XCTAssertEqual(observed["forwardingKind"] as? String, kind)
        XCTAssertEqual(observed["forwardingOutcome"] as? String, outcome)
        XCTAssertEqual(observed["forwardingOverflow"] as? Bool, false)
        XCTAssertEqual(observed["forwardingMisattributed"] as? Bool, false)
    }

    private func freshOpen() throws {
        try self.launch(.primaryOpen)
        try self.forwarded("session", "opened")
        InstalledShortcutsControls.assertSelectedSession(self.fixture.primary.name, in: self.app)
        self.require(self.app.textViews["chat-message-input"])
    }

    private func refused() throws {
        XCTAssertEqual(self.baseline["idleUnprotectedComposer"] as? Bool, true)
        try self.launch(.otherOpen)
        try self.forwarded("session", "unavailable")
        let after = try InstalledShortcutsControls.observation(in: self.app)
        XCTAssertEqual(after["idleUnprotectedComposer"] as? Bool, true)
    }

    private func runControls() async throws {
        self.selectPrimary()
        try await self.begin("run-controls")
        try await self.step("open") {
            try self.launch(.primaryRun)
            try self.forwarded("inspect", "opened")
            try InstalledShortcutsControls.verifyRun(
                XCTUnwrap(self.fixture.primary.runID),
                session: self.fixture.primary.key,
                profile: self.fixture.profileID,
                in: self.app)
        }
        try await self.step("done") { InstalledShortcutsControls.dismissRun(in: self.app) }
        try await self.step("reopen") {
            try self.launch(.primaryRun)
            try self.forwarded("inspect", "opened")
            self.require(InstalledShortcutsControls.runSheet(in: self.app))
        }
        try await self.step("gesture") {
            self.swipeSheet("Run")
            // Reopen only after observed dismissal; replacement starts with an acknowledged sheet.
            try self.launch(.primaryRun)
            try self.forwarded("inspect", "opened")
            self.require(InstalledShortcutsControls.runSheet(in: self.app))
        }
        try await self.step("replace") {
            try self.launch(.primaryRun)
            try self.forwarded("inspect", "opened")
            try InstalledShortcutsControls.verifyRun(
                XCTUnwrap(self.fixture.primary.runID),
                session: self.fixture.primary.key,
                profile: self.fixture.profileID,
                in: self.app)
        }
        try await self.step("select-other") {
            InstalledShortcutsControls.dismissRun(in: self.app)
            InstalledShortcutsControls.selectSession(self.fixture.other.name, in: self.app)
        }
        try await self.complete()
    }

    private func sidebarRouting() async throws {
        try await self.begin("sidebar-routing")
        for (step, destination) in [
            ("settings-held", "settings"),
            ("overview-held", "overview"),
            ("same-key-held", "session"),
            ("chat-held", "chat"),
        ] {
            self.selectPrimary()
            try await self.step(step) {
                try self.launch(.primaryRun)
                _ = try await self.control("wait-held")
                if destination == "session" { self.selectPrimary() } else { self.destination(destination) }
                _ = try await self.control("release")
                try self.forwarded("inspect", "cancelled")
                XCTAssertFalse(InstalledShortcutsControls.runSheet(in: self.app).exists)
                if destination == "session" {
                    InstalledShortcutsControls.assertSelectedSession(self.fixture.primary.name, in: self.app)
                } else if destination == "chat" {
                    self.require(self.app.textViews["chat-message-input"])
                } else { self.require(self.app.navigationBars[destination == "settings" ? "Settings" : "Overview"]) }
            }
        }
        try await self.complete()
    }

    private func settingsPaths() async throws {
        self.destination("settings")
        try await self.begin("settings-paths")
        try await self.step("diagnostics") {
            self.devicePanel("Diagnostics")
            self.require(self.app.navigationBars["Diagnostics"])
        }
        try await self.step("diagnostics-back") { self.back(to: "Settings") }
        try await self.step("usage") {
            self.destination("usage")
            self.require(self.app.navigationBars["Usage"])
        }
        try await self.step("usage-back") {
            self.destination("settings")
            self.require(self.app.navigationBars["Settings"])
        }
        try await self.step("watch") {
            self.devicePanel("Apple Watch")
            self.tapVisibleButton("Message Delivery")
            self.require(self.app.navigationBars["Message Delivery"])
            self.back(to: "Apple Watch")
            self.back(to: "Settings")
        }
        try await self.step("license") {
            self.devicePanel("Licenses")
            let links = self.app.tables.buttons
            self.require(links.firstMatch)
            XCTAssertGreaterThan(links.count, 0)
            // Every bundled document is a real public row; require its title after navigation.
            let title = links.firstMatch.label
            XCTAssertFalse(title.isEmpty)
            self.tap(links.firstMatch)
            self.require(self.app.navigationBars[title])
            self.back(to: "Licenses")
            self.back(to: "Settings")
        }
        try await self.step("headers") {
            self.tap(self.app.buttons["SettingsHub.Gateway"])
            self.tapVisibleButton("Custom Headers")
            self.require(self.app.navigationBars["Custom Headers"])
            self.back(to: "Gateway")
        }
        try await self.step("logs") {
            self.destination("settings")
            self.devicePanel("Diagnostics")
            self.tapVisibleButton("Discovery Logs")
            self.require(self.app.navigationBars["Discovery Logs"])
            self.back(to: "Diagnostics")
            self.back(to: "Settings")
        }
        try await self.complete()
    }

    private func dashboardPresentation() async throws {
        self.destination("overview")
        try await self.begin("dashboard-presentation")
        try await self.step("gear") {
            self.tap(self.app.buttons["Gateway settings"])
            self.require(self.app.navigationBars["Gateway"])
            self.selectRow(self.fixture.dashboard.name)
            self.require(self.app.navigationBars["Dashboard"])
        }
        try await self.step("done") { self.closeNavigation("Dashboard", button: "Done") }
        try await self.step("gear-reopen") {
            self.destination("overview")
            self.tap(self.app.buttons["Gateway settings"])
            self.require(self.app.navigationBars["Gateway"])
            self.selectRow(self.fixture.dashboard.name)
            self.require(self.app.navigationBars["Dashboard"])
        }
        try await self.step("gesture") { self.swipeSheet("Dashboard") }
        try await self.step("public-url") {
            self.destination("settings")
            try self.app.open(XCTUnwrap(URL(string: "openclaw://dashboard")))
            self.require(self.app.navigationBars["Overview"])
        }
        try await self.step("url-done") {
            self.selectRow(self.fixture.dashboard.name)
            self.closeNavigation("Dashboard", button: "Done")
            self.require(self.app.navigationBars["Overview"])
        }
        try await self.complete()
    }

    private func nativeProjection() async throws {
        try await self.begin("native-projection")
        try await self.step("settings-open") {
            self.destination("settings")
            self.devicePanel("Diagnostics")
            try self.freshOpen()
        }
        try await self.step("settings-inspect") {
            self.destination("settings")
            self.devicePanel("Diagnostics")
            try self.launch(.primaryRun)
            try self.forwarded("inspect", "opened")
            try InstalledShortcutsControls.verifyRun(
                XCTUnwrap(self.fixture.primary.runID),
                session: self.fixture.primary.key,
                profile: self.fixture.profileID,
                in: self.app)
            InstalledShortcutsControls.dismissRun(in: self.app)
        }
        try await self.step("user-chat-open") {
            InstalledShortcutsControls.selectSession(self.fixture.other.name, in: self.app)
            try self.freshOpen()
        }
        try await self.complete()
    }

    private func sidebarFork() async throws {
        self.selectPrimary()
        try await self.begin("sidebar-fork")
        try await self.step("menu") { self.forkMenu(self.fixture.primary.name) }
        try await self.step("fork") { self.tap(self.app.buttons["Fork"]) }
        try await self.step("adopted") {
            self.wait { self.app.textViews["chat-message-input"].exists && !self.selected(self.fixture.primary.name) }
            _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        }
        try await self.complete()
    }

    private func newChat() async throws {
        self.selectPrimary()
        try await self.begin("new-chat")
        try await self.step("bound-held") {
            try self.launch(.primaryRun)
            _ = try await self.control("wait-held")
            self.showSidebar()
            self.tap(self.app.buttons["New Chat"])
            self.require(self.app.textViews["chat-message-input"])
            _ = try await self.control("release")
            try self.forwarded("inspect", "cancelled")
            XCTAssertFalse(InstalledShortcutsControls.runSheet(in: self.app).exists)
        }
        try await self.step("protected-editor") {
            self.editor(self.draft)
            try self.launch(.compose)
            try self.forwarded("compose", "unavailable")
            XCTAssertEqual(self.app.textViews["chat-message-input"].value as? String, self.draft)
            self.editor("")
        }
        try await self.step("ordinary") {
            self.showSidebar()
            self.tap(self.app.buttons["New Chat"])
            _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        }
        try await self.complete()
    }

    private func forkSessionControls() async throws {
        self.selectPrimary()
        self.editor(self.draft)
        let prompt = try XCTUnwrap(self.fixture.primary.prompt)
        let priorPrompt = try XCTUnwrap(self.fixture.primary.priorPrompt)
        try await self.begin("fork-session-controls")
        try await self.step("fork") {
            self.forkMessage(prompt)
            self.wait { !self.selected(self.fixture.primary.name) && self.app.textViews["chat-message-input"].exists }
            XCTAssertEqual(self.app.textViews["chat-message-input"].value as? String, prompt)
            self.require(self.restoredImage())
        }
        let firstChild = try XCTUnwrap(self.lastFacts["createdName"] as? String)
        try await self.step("remove-attachment") {
            self.removeRestoredImage()
            XCTAssertEqual(self.app.textViews["chat-message-input"].value as? String, prompt)
        }
        try await self.step("fork-again") {
            self.forkMessage(priorPrompt)
            self.wait { !self.selected(firstChild) && self.app.textViews["chat-message-input"].exists }
            XCTAssertEqual(self.app.textViews["chat-message-input"].value as? String, priorPrompt)
            self.require(self.restoredImage())
        }
        let secondChild = try XCTUnwrap(self.lastFacts["createdName"] as? String)
        try await self.step("reset") {
            self.removeRestoredImage()
            // iOS exposes reset through its local slash command. Draft-preserving reset
            // identity is separately retained in the hosted owner test.
            self.editor("/reset")
            self.tap(self.app.buttons["chat-send-message"])
            _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        }
        try await self.step("new-thread") {
            self.showSidebar()
            self.tap(self.app.buttons["New Chat"])
            _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        }
        try await self.step("return-child") {
            InstalledShortcutsControls.selectSession(secondChild, in: self.app)
            _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        }
        try await self.complete()
    }

    private func appChatModal() async throws {
        self.selectPrimary()
        try await self.begin("app-chat-modal")
        try await self.step("background-tasks") {
            self.chatAction("Background tasks")
            self.require(self.app.navigationBars["Background Tasks"])
        }
        try await self.step("refused") { try self.refused()
            self.require(self.app.navigationBars["Background Tasks"])
        }
        try await self.step("done") { self.closeNavigation("Background Tasks", button: "Done") }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.complete()
    }

    private func sharedChatModal() async throws {
        // This fixture has one completed assistant reply; the two-image Fork fixture is separate.
        InstalledShortcutsControls.selectSession(self.fixture.other.name, in: self.app)
        _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        try await self.begin("shared-chat-modal")
        try await self.step("select-text") {
            let controls = self.app.buttons.matching(identifier: "chat-message-actions")
            self.require(controls.firstMatch)
            XCTAssertEqual(controls.count, 1)
            self.tap(controls.firstMatch)
            self.tap(self.app.buttons["Select Text"])
            self.require(self.app.navigationBars["Select Text"])
            self.require(self.app.textViews["chat-selectable-text"])
        }
        try await self.step("refused") { try self.refused()
            self.require(self.app.navigationBars["Select Text"])
        }
        try await self.step("close") { self.closeNavigation("Select Text", button: "Close") }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.complete()
    }

    private func newOptionsLandscape() async throws {
        self.selectPrimary()
        try await self.begin("new-options-landscape")
        try await self.step("landscape") { self.orient(.landscapeLeft) }
        try await self.step("cover") {
            self.chatAction("New session options…")
            self.require(self.app.staticTexts["New Thread"])
            self.require(self.app.buttons["Create Thread"])
        }
        try await self.step("create-refused") {
            self.tap(self.app.buttons["Create Thread"])
            self.require(self.app.staticTexts["Controlled fixture request refusal"])
            self.require(self.app.staticTexts["New Thread"])
        }
        try await self.step("retry-created") {
            self.tap(self.app.buttons["Create Thread"])
            self.wait { !self.app.staticTexts["New Thread"].exists }
            _ = try InstalledShortcutsControls.assertIdleEditor(in: self.app)
        }
        try await self.step("portrait") { self.orient(.portrait) }
        try await self.complete()
    }

    private func pagesPortrait() async throws {
        self.selectPrimary()
        try await self.begin("pages-portrait")
        try await self.step("edit") { self.openPages() }
        try await self.step("pin") { self.setPagePinned(true) }
        try await self.step("unpin") { self.setPagePinned(false) }
        try await self.step("done") { self.closeNavigation("Pages", button: "Done") }
        try await self.step("reopen") { self.openPages() }
        try await self.step("gesture") { self.swipeSheet("Pages") }
        try await self.step("select") {
            self.openPages()
            self.tap(self.app.buttons["RootTabs.Sidebar.Pages.Select.activity"])
            self.require(self.app.navigationBars["Activity"])
        }
        try await self.complete()
    }

    private func pagesLandscape() async throws {
        self.selectPrimary()
        try await self.begin("pages-landscape")
        try await self.step("landscape") { self.orient(.landscapeLeft) }
        try await self.step("cover") { self.openPages() }
        try await self.step("refused") { try self.refused()
            self.require(self.app.navigationBars["Pages"])
        }
        try await self.step("done") { self.closeNavigation("Pages", button: "Done") }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.step("portrait") { self.orient(.portrait) }
        try await self.complete()
    }

    private func gatewayProblem() async throws {
        self.selectPrimary()
        try await self.begin("gateway-problem")
        try await self.step("node-fault") { self.require(self.app.buttons["Details"]) }
        try await self.step("details") { self.tap(self.app.buttons["Details"])
            self.require(self.app.navigationBars["Connection problem"])
        }
        try await self.step("refused") { try self.refused()
            self.require(self.app.navigationBars["Connection problem"])
        }
        try await self.step("done") { self.closeNavigation("Connection problem", button: "Done") }
        try await self.step("operator-current") { self.require(self.app.textViews["chat-message-input"]) }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.complete()
    }

    private func approvalDashboard() async throws {
        self.destination("settings")
        try await self.begin("approval-dashboard")
        try await self.step("inbox") {
            self.require(self.app.staticTexts["Notifications are off"])
            self.tap(self.app.buttons["Not Now"])
            self.wait { !self.app.staticTexts["Notifications are off"].exists }
            _ = try await self.control("release")
            self.require(self.app.buttons["approval-dashboard-review"])
        }
        try await self.step("review") {
            self.tap(self.app.buttons["approval-dashboard-review"])
            self.require(self.app.navigationBars["Review approval"])
        }
        try await self.step("refused") { try self.refused()
            self.require(self.app.navigationBars["Review approval"])
        }
        try await self.step("done") {
            self.tap(self.app.buttons["DashboardPage.Close"])
            self.wait { !self.app.navigationBars["Review approval"].exists }
            self.require(self.app.buttons["approval-dashboard-review"])
        }
        try await self.step("cancel") {
            self.tap(self.app.buttons["Cancel"])
            self.wait { !self.app.buttons["approval-dashboard-review"].exists }
        }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.complete()
    }

    private func notificationGuidance() async throws {
        self.destination("settings")
        try await self.begin("notification-guidance")
        try await self.step("system-denied") { try self.denyNotifications() }
        try await self.step("approval-event") { self.require(self.app.staticTexts["Notifications are off"]) }
        try await self.step("prompt") {
            self.require(self.app.buttons["Open Notifications Settings"])
            self.require(self.app.buttons["Not Now"])
            XCTAssertFalse(self.app.buttons["approval-dashboard-review"].exists)
        }
        try await self.step("refused") { try self.refused()
            self.require(self.app.staticTexts["Notifications are off"])
        }
        try await self.step("not-now") {
            self.tap(self.app.buttons["Not Now"])
            self.wait { !self.app.staticTexts["Notifications are off"].exists }
        }
        try await self.step("fresh-open") { try self.freshOpen() }
        // The canonical get is released only after the fresh action, then the native
        // Cancel dismisses presentation; the fixture separately denies and joins the run.
        self.require(self.app.buttons["approval-dashboard-review"])
        self.tap(self.app.buttons["Cancel"])
        self.wait { !self.app.buttons["approval-dashboard-review"].exists }
        try await self.complete()
    }

    private func agentDeepLink() async throws {
        self.selectPrimary()
        try await self.begin("agent-deeplink")
        try await self
            .step("public-url") {
                try self.app.open(XCTUnwrap(URL(string: "openclaw://agent?message=fixture%20agent%20request")))
            }
        try await self.step("prompt") { self.require(self.app.alerts["Run OpenClaw agent?"]) }
        try await self.step("refused") { try self.refused()
            self.require(self.app.alerts["Run OpenClaw agent?"])
        }
        try await self.step("cancel") { self.tap(self.app.alerts["Run OpenClaw agent?"].buttons["Cancel"])
            self.wait { !self.app.alerts["Run OpenClaw agent?"].exists }
        }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.complete()
    }

    private func gatewayTrust() async throws {
        self.destination("settings")
        self.tap(self.app.buttons["SettingsHub.Gateway"])
        try await self.begin("gateway-trust")
        try await self.step("public-setup") {
            let field = self.app.textFields["Paste setup code"]
            self.scrollTo(field)
            self.tap(field)
            field.typeText(self.fixture.trustSetupCode)
            self.tapVisibleButton("Connect")
        }
        try await self.step("fingerprint") {
            let alert = self.app.alerts["Trust this gateway?"]
            self.require(alert)
            XCTAssertEqual(
                alert.staticTexts.matching(NSPredicate(format: "label ENDSWITH %@", self.fixture.fingerprint)).count,
                1)
        }
        try await self.step("refused") { try self.refused()
            self.require(self.app.alerts["Trust this gateway?"])
        }
        try await self.step("cancel") {
            self.tap(self.app.alerts["Trust this gateway?"].buttons["Cancel"])
            self.wait { !self.app.alerts["Trust this gateway?"].exists }
        }
        try await self.step("fresh-open") { try self.freshOpen() }
        try await self.complete()
    }

    private func openPages() {
        self.showSidebar()
        self.tap(self.app.buttons["Edit Pages"])
        self.require(self.app.navigationBars["Pages"])
    }

    private func setPagePinned(_ value: Bool) {
        let pin = self.app.buttons["RootTabs.Sidebar.Pages.Pin.activity"]
        self.require(pin)
        XCTAssertEqual(pin.value as? String, value ? "Not pinned" : "Pinned")
        self.tap(pin)
        self.wait { pin.value as? String == (value ? "Pinned" : "Not pinned") }
    }

    private func selected(_ name: String) -> Bool {
        let identity = self.app.descendants(matching: .any)["chat-agent-identity"]
            .descendants(matching: .any)["chat-gateway-status"]
        return identity.exists && identity.label.hasSuffix(". " + name)
    }

    private func forkMenu(_ name: String) {
        self.showSidebar()
        let row = self.app.buttons.containing(.staticText, identifier: name)
        self.require(row.firstMatch)
        XCTAssertEqual(row.count, 1)
        row.firstMatch.press(forDuration: 1)
        self.require(self.app.buttons["Fork"])
    }

    private func back(to title: String) {
        let back = self.app.navigationBars.buttons.element(boundBy: 0)
        self.tap(back)
        self.require(self.app.navigationBars[title])
    }

    private func scrollTo(_ element: XCUIElement) {
        for _ in 0..<8 {
            if element.exists, element.isHittable { return }
            self.app.swipeUp()
        }
        self.require(element)
        XCTAssertTrue(element.isHittable)
    }

    private func tapVisibleButton(_ title: String) {
        let button = self.app.buttons[title]
        self.scrollTo(button)
        self.tap(button)
    }

    private func devicePanel(_ title: String) {
        let web = self.app.webViews["SettingsHub.Dashboard"]
        self.require(web)
        self.tap(web.links["This iPhone"])
        let button = try? self.rowButton(
            title: title, button: "Open", in: web,
            excludingTitles: ["Diagnostics", "Licenses", "About", "Apple Watch"].filter { $0 != title })
        guard let button else { XCTFail("Device panel must have one public row control")
            return
        }
        self.scrollTo(button)
        self.tap(button)
    }

    private func rowButton(
        title: String, button: String, in root: XCUIElement,
        excludingTitles: [String], status: String? = nil) throws -> XCUIElement
    {
        self.wait {
            self.rowButtons(
                title: title, button: button, in: root,
                excludingTitles: excludingTitles, status: status).count == 1
        }
        let matches = self.rowButtons(
            title: title, button: button, in: root,
            excludingTitles: excludingTitles, status: status)
        XCTAssertEqual(matches.count, 1, "Public semantic row is missing or ambiguous")
        return try XCTUnwrap(matches.first)
    }

    private func rowButtons(
        title: String, button: String, in root: XCUIElement,
        excludingTitles: [String], status: String? = nil) -> [XCUIElement]
    {
        let containers = root.otherElements.containing(.staticText, identifier: title).allElementsBoundByIndex
        guard containers.count <= 64 else { return [] }
        // A page or section ancestor is not a row. Exclude other row titles before
        // accepting its status and sole action; nested copies must name the same button.
        var matches: [(CGRect, XCUIElement)] = []
        for container in containers {
            guard container.staticTexts.matching(identifier: title).count == 1,
                  !excludingTitles.contains(where: { container.staticTexts.matching(identifier: $0).count > 0 }),
                  container.buttons.count == 1 else { continue }
            if let status, container.staticTexts.matching(identifier: status).count != 1 { continue }
            let buttons = container.buttons.matching(identifier: button)
            if buttons.count == 1 {
                let candidate = buttons.element(boundBy: 0)
                let frame = candidate.frame
                if !frame.isEmpty, !matches.contains(where: { $0.0 == frame }) { matches.append((frame, candidate)) }
            }
        }
        return matches.map(\.1)
    }

    private func denyNotifications() throws {
        let web = self.app.webViews["SettingsHub.Dashboard"]
        self.require(web)
        self.tap(web.links["Permissions"])
        self.require(web.staticTexts["Notifications"])
        let otherPermissions = [
            "Accessibility",
            "Screen Recording",
            "Microphone",
            "Camera",
            "Speech Recognition",
            "Location",
            "Contacts",
            "Calendars",
            "Reminders",
            "Photos",
        ]
        try self.tap(self.rowButton(
            title: "Notifications", button: "Grant…", in: web,
            excludingTitles: otherPermissions, status: "Not determined"))
        let relay = self.app.alerts["Enable OpenClaw Hosted Push Relay?"]
        if relay.waitForExistence(timeout: 3) { self.tap(relay.buttons["Allow"]) }
        let system = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let permission = system.alerts.matching(NSPredicate(format: "label CONTAINS[c] %@", "OpenClaw")).firstMatch
        // Query the expected system permission owner, never a global interruption callback.
        self.require(permission)
        let deny = permission.buttons.allElementsBoundByIndex.filter {
            $0.label.replacingOccurrences(of: "’", with: "'").lowercased() == "don't allow"
        }
        XCTAssertEqual(deny.count, 1)
        try self.tap(XCTUnwrap(deny.first))
        self.wait { !permission.exists }
        _ = try self.rowButton(
            title: "Notifications", button: "Open System Settings…", in: web,
            excludingTitles: otherPermissions, status: "Denied")
    }

    private func restoredImage() -> XCUIElement {
        self.app.staticTexts["image-1.png"]
    }

    private func removeRestoredImage() {
        self.require(self.restoredImage())
        self.tap(self.app.buttons["Remove image-1.png"])
        self.wait { !self.restoredImage().exists }
    }

    private func forkMessage(_ text: String) {
        let message = self.app.staticTexts[text]
        self.require(message)
        message.press(forDuration: 1)
        self.tap(self.app.buttons["Fork from Here"])
    }
}
