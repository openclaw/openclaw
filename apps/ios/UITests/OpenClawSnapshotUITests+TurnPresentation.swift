import XCTest

extension OpenClawSnapshotUITests {
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
        XCTAssertFalse(app.staticTexts.containing(
            NSPredicate(format: "label CONTAINS %@", "Checking the latest build log.")).firstMatch.exists,
            "GPT's commentary sits inside Worked")
        self.attachScreenshot(named: "turn-presentation")
    }
}
