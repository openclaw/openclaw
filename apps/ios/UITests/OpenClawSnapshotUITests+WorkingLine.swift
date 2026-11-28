import XCTest

extension OpenClawSnapshotUITests {
    /// Victor's recording of a plain "Hi" turn: the line said "Thinking" before the startup phases, flashed
    /// a one-frame phase, and said "Thinking" again under the streamed answer.
    func testPlainTurnWorkingLineFollowsTheRunInOrder() throws {
        self.executionTimeAllowance = 90
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: ["--openclaw-working-line-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Hi")
        app.buttons["chat-send-message"].tap()

        let line = app.descendants(matching: .any)["chat-working-status"].firstMatch
        XCTAssertTrue(line.waitForExistence(timeout: 5))
        XCTAssertNotEqual(line.label, "Thinking", "Thinking showed before the Gateway reported a phase")
        expectation(for: NSPredicate(format: "label == %@", "Waiting for a response…"), evaluatedWith: line)
        waitForExpectations(timeout: 5)
        self.attachScreenshot(named: "01-startup")

        expectation(for: NSPredicate(format: "label == %@", "Thinking"), evaluatedWith: line)
        waitForExpectations(timeout: 8)
        self.attachScreenshot(named: "02-thinking")

        let answer = app.staticTexts.containing(NSPredicate(format: "label BEGINSWITH %@", "Hi. I got")).firstMatch
        XCTAssertTrue(answer.waitForExistence(timeout: 8))
        // Under answer text the claw stays without words; VoiceOver still hears the run is working.
        expectation(for: NSPredicate(format: "label == %@", "Working"), evaluatedWith: line)
        waitForExpectations(timeout: 3)
        self.attachScreenshot(named: "03-streaming")

        XCTAssertTrue(line.waitForNonExistence(timeout: 20), "The line stays after the run ended")
    }
}
