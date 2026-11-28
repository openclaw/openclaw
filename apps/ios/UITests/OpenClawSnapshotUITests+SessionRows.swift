import XCTest

extension OpenClawSnapshotUITests {
    private static let sessionRowsTarget = ScreenshotTarget(
        initialTab: "control",
        initialDestination: "sessions",
        name: "session-rows")

    private func sessionRow(_ key: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons["SessionDashboard.Session.agent:main:\(key)"]
    }

    /// The Sessions page reads each row's title, then its one state line; rows with no state keep the title.
    func testSessionRowsReadTheirStateLine() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Sessions page")
        self.launchApp(for: Self.sessionRowsTarget, additionalArguments: ["--openclaw-session-states-fixture"])
        let app = try XCTUnwrap(self.app)
        let fork = self.sessionRow("rows-fork-lander", in: app)
        XCTAssertTrue(fork.waitForExistence(timeout: 8))
        let expected = [
            "rows-fork-lander": "🛬 Fork lander, Needs approval, gh pr merge 91342 --squash",
            "rows-approval-plain": "Rotate the staging keys, Needs approval",
            "rows-screens": "Map the OpenClaw screens, Failed, Request timed out before a response was generated. "
                + "Please try again, or increase `agents.defaults.timeoutSeconds` in your config.",
            "rows-rate-limit": "Nightly digest, Failed, clawrouter/anthropic/claude-opus-5-5 is rate-limited. "
                + "Pick another model in the model picker, or configure Model fallbacks in Settings.",
            "rows-failed-plain": "Import the old notes, Failed",
            "rows-boards": "📐 PRINCIPAL - Boards / Designer, Subagents working",
            "rows-mapping": "iOS mapping, tempbook",
        ]
        for (key, label) in expected {
            XCTAssertEqual(self.sessionRow(key, in: app).label, label, key)
        }
        XCTAssertFalse(app.buttons["SessionDashboard.Session.agent:main:subagent:rows-boards-a"].exists)
        XCTAssertFalse(app.staticTexts["agent:main:subagent:rows-boards-a"].exists, "The key is never a name")
        self.attachScreenshot(named: "session-rows-top")
        app.swipeUp()
        XCTAssertTrue(self.sessionRow("rows-icon-sizes", in: app).waitForExistence(timeout: 5))
        self.attachScreenshot(named: "session-rows-bottom")
    }

    /// At the largest text size, a row with a state line still ends above the next one.
    func testSessionRowsHoldAtTheLargestTextSize() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Sessions page")
        self.launchApp(for: Self.sessionRowsTarget, additionalArguments: [
            "--openclaw-session-states-fixture",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
        ])
        let app = try XCTUnwrap(self.app)
        let keys = ["rows-spinner", "rows-fork-lander", "rows-approval-plain", "rows-screens"]
        XCTAssertTrue(self.sessionRow(keys[0], in: app).waitForExistence(timeout: 8))
        let frames = keys.map { self.sessionRow($0, in: app).frame }
        for (upper, lower) in zip(frames, frames.dropFirst()) where !lower.isEmpty {
            XCTAssertLessThanOrEqual(upper.maxY, lower.minY + 0.5, "\(upper) overlaps \(lower)")
        }
        self.attachScreenshot(named: "session-rows-ax5")
    }

    private func sidebarButton(in app: XCUIApplication) -> XCUIElement? {
        app.buttons.matching(identifier: "RootTabs.Sidebar.Show").allElementsBoundByIndex.first { $0.isHittable }
    }

    /// The header dot is the fallback for approvals the page does not list: gone while Needs you shows them,
    /// back on a scope without that section, and unchanged in the chat.
    func testSessionsHeaderDotOnlyForApprovalsTheListDoesNotShow() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Sessions page")
        self.launchApp(for: Self.sessionRowsTarget, additionalArguments: ["--openclaw-session-states-fixture"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(self.sessionRow("rows-fork-lander", in: app).waitForExistence(timeout: 8))
        XCTAssertEqual(try XCTUnwrap(self.sidebarButton(in: app)).value as? String, "")
        self.attachScreenshot(named: "sessions-header-listed")

        app.descendants(matching: .any)["Sessions.StatusScope"].tap()
        let snoozed = app.buttons["Snoozed"]
        XCTAssertTrue(snoozed.waitForExistence(timeout: 5))
        snoozed.tap()
        XCTAssertTrue(app.staticTexts["Snoozed sessions"].waitForExistence(timeout: 5))
        XCTAssertEqual(try XCTUnwrap(self.sidebarButton(in: app)).value as? String, "Needs approval")
        self.attachScreenshot(named: "sessions-header-snoozed")

        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: ["--openclaw-session-states-fixture"])
        let chat = try XCTUnwrap(self.app)
        XCTAssertTrue(chat.buttons["RootTabs.Sidebar.Show"].firstMatch.waitForExistence(timeout: 8))
        XCTAssertEqual(try XCTUnwrap(self.sidebarButton(in: chat)).value as? String, "Needs approval")
        self.attachScreenshot(named: "chat-header")
    }
}
