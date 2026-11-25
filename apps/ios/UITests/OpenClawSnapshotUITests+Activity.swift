import XCTest

extension OpenClawSnapshotUITests {
    private static let activityTarget = ScreenshotTarget(
        initialTab: "chat", initialDestination: "chat", name: "chat-activity-pills")

    private func activityPill(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons["chat-activity-pill-\(id)"]
    }

    func testActivityPillsSitInOneRowAboveTheComposer() throws {
        launchApp(for: Self.activityTarget, additionalArguments: ["--openclaw-activity-fixture"])
        let app = try XCTUnwrap(self.app)
        let subagents = self.activityPill("subagents", in: app)
        let goal = self.activityPill("goal", in: app)
        let progress = self.activityPill("progress", in: app)
        XCTAssertTrue(progress.waitForExistence(timeout: 8))
        XCTAssertTrue(subagents.waitForExistence(timeout: 5))
        XCTAssertTrue(goal.exists)
        attachScreenshot(named: "activity-pills-row")
        // His web order: subagents, Goal, task progress; one line, never a second row.
        XCTAssertLessThan(subagents.frame.minX, goal.frame.minX)
        XCTAssertLessThan(goal.frame.minX, progress.frame.minX)
        XCTAssertLessThanOrEqual(abs(subagents.frame.midY - progress.frame.midY), 1)
        XCTAssertEqual(subagents.label, "2 subagents working")
        XCTAssertTrue(goal.label.hasPrefix("Goal active: Plan a week in Lisbon"))
        XCTAssertTrue(progress.label.hasPrefix(
            "Task progress, Compare flights and hotel reviews, 2 of 5 completed"))
        // The row rests on the composer, never under it.
        let surface = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(surface.exists)
        XCTAssertLessThanOrEqual(progress.frame.maxY, surface.frame.minY)
        assertMinimumTouchTarget(goal)
        // The old wide bar is gone above the composer.
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Plan, ")).firstMatch.exists)
    }

    func testActivityPillsOpenTheirSheetsAndKeepTheDraft() throws {
        launchApp(for: Self.activityTarget, additionalArguments: ["--openclaw-activity-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Parent draft")
        let goal = self.activityPill("goal", in: app)
        XCTAssertTrue(goal.waitForExistence(timeout: 5))
        goal.tap()

        let close = app.buttons["chat-activity-sheet-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["chat-activity-goal-objective"].exists)
        // Close sits on the leading side of the bar.
        XCTAssertLessThan(close.frame.midX, app.frame.midX)
        attachScreenshot(named: "activity-sheet-goal")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))

        self.activityPill("progress", in: app).tap()
        XCTAssertTrue(app.otherElements["chat-activity-progress-summary"].waitForExistence(timeout: 5)
            || app.staticTexts["2 of 5 completed"].waitForExistence(timeout: 2))
        XCTAssertTrue(app.staticTexts["Outline each day"].exists)
        attachScreenshot(named: "activity-sheet-progress")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))

        self.activityPill("subagents", in: app).tap()
        XCTAssertTrue(app.staticTexts["Working"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Finished"].waitForExistence(timeout: 5))
        attachScreenshot(named: "activity-sheet-subagents")
        let child = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        child.tap()
        let order = app.staticTexts["chat-activity-child-order"]
        XCTAssertTrue(order.waitForExistence(timeout: 5))
        XCTAssertTrue(order.label.hasPrefix("Compare round-trip fares from SFO to Lisbon"))
        attachScreenshot(named: "activity-sheet-child")
        // A pushed page has only the system back button; Close stays on the root.
        XCTAssertFalse(close.isHittable)
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))

        XCTAssertTrue((input.value as? String ?? "").contains("Parent draft"))
    }

    func testActivitySheetsShowFailuresInPlace() throws {
        launchApp(
            for: Self.activityTarget,
            additionalArguments: ["--openclaw-activity-fixture", "--openclaw-activity-fixture-failures"])
        let app = try XCTUnwrap(self.app)
        let subagents = self.activityPill("subagents", in: app)
        XCTAssertTrue(subagents.waitForExistence(timeout: 8))
        subagents.tap()
        // The roster still shows the children; only the full list failed, and says so where it would be.
        XCTAssertTrue(app.staticTexts["Couldn’t load every subagent."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-activity-try-again"].exists)
        app.buttons["chat-activity-child-agent:main:subagent:activity-hotels"].tap()
        XCTAssertTrue(app.staticTexts["Couldn’t load what it was asked."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-activity-try-again"].exists)
        attachScreenshot(named: "activity-sheet-child-failed")
    }
}
