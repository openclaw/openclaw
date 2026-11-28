import XCTest

extension OpenClawSnapshotUITests {
    func testFinishedCommandsSeparatedByEmptyThinkingShareOneSheet() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: ["--openclaw-image-review-tools-fixture"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.staticTexts["All three images are ready."].waitForExistence(timeout: 8))
        let groups = app.buttons.matching(identifier: "chat-tool-group")
        XCTAssertEqual(groups.count, 1)
        self.attachScreenshot(named: "finished-group-transcript")
        groups.firstMatch.tap()
        for index in 0..<5 {
            XCTAssertTrue(app.buttons["chat-tool-step-image-check-\(index)"].waitForExistence(timeout: 3))
        }
        self.attachScreenshot(named: "finished-group-sheet")
    }

    /// Victor's iPhone, Nov 26: a running Claude CLI turn left its first command alone under the input and
    /// hid the launch the Control UI shows. Both commands share one row, and the launch keeps its own.
    func testRunningCLITurnGroupsCommandsAndShowsItsLaunch() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: [
            "--openclaw-cli-live-turn-fixture",
            "--openclaw-goal-running-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        let launch = app.staticTexts.containing(
            NSPredicate(format: "label BEGINSWITH %@", "Launched Port the reconnect fix")).firstMatch
        XCTAssertTrue(launch.waitForExistence(timeout: 8), "The launch keeps its own row while the turn runs")
        XCTAssertEqual(app.buttons.matching(identifier: "chat-tool-group").count, 1, "Both commands share one row")
        XCTAssertFalse(app.descendants(matching: .any)["chat-tool-activity-cli-e1"].exists, "No command stands alone")
        XCTAssertTrue(app.descendants(matching: .any)["chat-working-status"].exists, "The turn is still running")
        self.attachScreenshot(named: "running-cli-turn")
    }

    /// Victor's rule: only a turn an OpenAI model answered folds into "Worked". Claude's notes between
    /// tool calls are its reply and stay where they were said; GPT's commentary folds with its tools.
    func testOnlyAnOpenAITurnFoldsIntoWorked() throws {
        self.executionTimeAllowance = 60
        self.launchApp(
            for: Self.chatScreenshotTarget,
            appearance: "light",
            additionalArguments: ["--openclaw-turn-presentation-fixture"])
        let app = try XCTUnwrap(self.app)
        let answer = app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "Fixing it now")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 10), "Claude's note between tool calls is visible")
        XCTAssertTrue(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "check the latest build log first")).firstMatch.exists)
        let worked = app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND label BEGINSWITH %@", "chat-completed-work-", "Worked"))
        XCTAssertEqual(worked.count, 1, "Only the GPT turn folds")
        XCTAssertFalse(
            app.staticTexts.containing(
                NSPredicate(format: "label CONTAINS %@", "Checking the latest build log.")).firstMatch.exists,
            "GPT's commentary sits inside Worked")
        self.attachScreenshot(named: "turn-presentation")
    }
}
