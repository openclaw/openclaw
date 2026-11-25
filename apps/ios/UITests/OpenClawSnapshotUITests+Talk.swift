import XCTest

/// Talk in the chat composer, on the fixture: no microphone, voice provider or Gateway behind it.
extension OpenClawSnapshotUITests {
    private func launchTalkFixture(_ state: String, live: Bool, extra: [String] = []) throws -> XCUIApplication {
        self.launchApp(
            for: ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "chat-talk-\(state)"),
            additionalArguments: ["--openclaw-talk-fixture", state] + (live ? ["--openclaw-talk-fixture-live"] : []) +
                extra)
        return try XCTUnwrap(self.app)
    }

    func testTalkStartsInTheComposerAndEndsBackToIt() throws {
        let app = try self.launchTalkFixture("listening", live: false)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        let surface = app.otherElements["chat-composer-surface"]
        let restingHeight = surface.frame.height
        let talk = app.buttons["chat-realtime-control"].firstMatch
        XCTAssertEqual(talk.label, "Start voice conversation")
        talk.tap()

        let status = app.staticTexts["chat-talk-status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 3))
        XCTAssertEqual(status.label, "Listening")
        XCTAssertEqual(talk.label, "End voice conversation")
        XCTAssertEqual(talk.value as? String, "Listening")
        // One place says the state: no strip above the card, no Model sign-in under it.
        XCTAssertFalse(app.otherElements["chat-talk-activity"].exists)
        XCTAssertFalse(app.buttons["Model sign-in"].exists)
        XCTAssertEqual(surface.frame.height, restingHeight, accuracy: 1, "Talk keeps the card's height")
        self.assertMinimumTouchTarget(app.buttons["chat-talk-microphone"].firstMatch)
        self.assertMinimumTouchTarget(talk)
        self.attachScreenshot(named: "talk-listening")

        talk.tap()
        XCTAssertTrue(status.waitForNonExistence(timeout: 3))
        XCTAssertTrue(input.waitForExistence(timeout: 3))
        XCTAssertEqual(talk.label, "Start voice conversation")
        XCTAssertEqual(surface.frame.height, restingHeight, accuracy: 1)
    }

    func testTalkSaysEachStateInOnePlace() throws {
        let expected: [(String, String)] = [
            ("connecting", "Connecting…"),
            ("listening", "Listening"),
            ("hearing", "Listening"),
            ("thinking", "Waiting for a reply"),
            ("speaking", "Speaking"),
            ("muted", "Muted"),
            ("mic-off", "No mic access"),
            ("offline", "Offline"),
            ("failed", "Couldn’t get a reply"),
        ]
        for (state, label) in expected {
            let app = try self.launchTalkFixture(state, live: true)
            let status = app.staticTexts["chat-talk-status"].firstMatch
            XCTAssertTrue(status.waitForExistence(timeout: 8), state)
            XCTAssertEqual(status.label, label, state)
            let end = app.buttons["chat-realtime-control"].firstMatch
            // In every state the main button ends Talk; it is never an inert Stop.
            XCTAssertEqual(end.label, "End voice conversation", state)
            XCTAssertTrue(end.isEnabled, state)
            XCTAssertFalse(app.buttons["chat-stop-response"].exists, state)
            XCTAssertEqual(app.buttons["chat-talk-open-settings"].exists, state == "mic-off", state)
            self.attachScreenshot(named: "talk-\(state)")
            app.terminate()
        }
    }

    func testMuteReadsAsSelectedAndLeavesTalkOn() throws {
        let app = try self.launchTalkFixture("listening", live: true)
        let mute = app.buttons["chat-talk-microphone"].firstMatch
        XCTAssertTrue(mute.waitForExistence(timeout: 8))
        XCTAssertEqual(mute.label, "Mute")
        XCTAssertFalse(mute.isSelected)
        mute.tap()
        let status = app.staticTexts["chat-talk-status"].firstMatch
        self.waitForLabel("Muted", of: status)
        XCTAssertTrue(mute.isSelected)
        mute.tap()
        self.waitForLabel("Listening", of: status)
        XCTAssertEqual(app.buttons["chat-realtime-control"].firstMatch.label, "End voice conversation")
    }

    func testTalkOverADraftKeepsTheDraft() throws {
        // Talk turns on from outside the composer a few seconds after launch, over the draft typed here.
        let app = try self.launchTalkFixture(
            "listening",
            live: false,
            extra: ["--openclaw-talk-fixture-start-after", "12"])
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Keep this draft")
        let status = app.staticTexts["chat-talk-status"].firstMatch
        XCTAssertTrue(status.waitForExistence(timeout: 20))
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 5), "Talk puts the keyboard away")
        self.attachScreenshot(named: "talk-over-draft")
        app.buttons["chat-realtime-control"].firstMatch.tap()
        XCTAssertTrue(status.waitForNonExistence(timeout: 3))
        self.waitForValue("Keep this draft", of: input)
        XCTAssertTrue(app.buttons["chat-send-message"].waitForExistence(timeout: 3))
    }

    private func waitForLabel(_ label: String, of element: XCUIElement, timeout: TimeInterval = 3) {
        let predicate = NSPredicate(format: "label == %@", label)
        let expectation = XCTNSPredicateExpectation(predicate: predicate, object: element)
        XCTAssertEqual(XCTWaiter().wait(for: [expectation], timeout: timeout), .completed, label)
    }
}
