import XCTest

extension OpenClawSnapshotUITests {
    /// "Copy Message" leaves no trace once the menu closes, so the toast confirms it, under the
    /// top bar, and leaves on its own.
    func testToastConfirmsCopyMessage() throws {
        self.launchApp(for: ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "toast-copy"))
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Can you summarize the release notes?")
        app.buttons["chat-send-message"].tap()
        let bubble = app.staticTexts["Can you summarize the release notes?"].firstMatch
        XCTAssertTrue(bubble.waitForExistence(timeout: 10), app.debugDescription)
        bubble.press(forDuration: 1)
        let copy = app.buttons["Copy Message"].firstMatch
        XCTAssertTrue(copy.waitForExistence(timeout: 5), app.debugDescription)
        copy.tap()

        let text = app.staticTexts["Toast.Text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(text.label, "Copied")
        XCTAssertFalse(app.buttons["Toast.Action"].exists)
        let sidebar = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertGreaterThanOrEqual(text.frame.minY, sidebar.frame.maxY, "The toast sits below the top bar")
        self.attachScreenshot(named: "toast-copy")
        XCTAssertTrue(text.waitForNonExistence(timeout: 6), "A toast without an action leaves after about 2 s")
    }

    /// A failed export says so and offers Try again, which runs the export again.
    func testToastOffersTryAgainWhenExportFails() throws {
        self.launchApp(
            for: ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "toast-export"),
            additionalArguments: ["--openclaw-export-failure-fixture"])
        let app = try XCTUnwrap(self.app)
        let identity = app.buttons["chat-agent-identity"]
        XCTAssertTrue(identity.waitForExistence(timeout: 8))
        identity.tap()
        let export = app.buttons["Export chat"]
        XCTAssertTrue(export.waitForExistence(timeout: 5), app.debugDescription)
        export.tap()

        let text = app.staticTexts["Toast.Text"]
        XCTAssertTrue(text.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(text.label, "Couldn’t export this chat.")
        XCTAssertFalse(app.alerts.firstMatch.exists, "No alert any more")
        let tryAgain = app.buttons["Toast.Action"]
        XCTAssertEqual(tryAgain.label, "Try again")
        self.attachScreenshot(named: "toast-export-failed")
        // A toast with an action stays about 5 s, so it is still here after 2.5 s.
        Thread.sleep(forTimeInterval: 2.5)
        XCTAssertTrue(text.exists)
        // The toast has its own window, which XCTest's hit test doesn't treat as frontmost, so this
        // is a real touch at the button's place rather than `tap()` on the element.
        tryAgain.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        // The retry fails again and posts a fresh toast, which outlives the first one's 5 s.
        Thread.sleep(forTimeInterval: 4)
        XCTAssertTrue(text.exists)
        XCTAssertEqual(text.label, "Couldn’t export this chat.")
    }

    /// The toast draws above an open sheet, and above the composer with the keyboard up.
    func testToastShowsAboveAnOpenSheet() throws {
        self.launchApp(
            for: ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "toast-over-sheet"),
            additionalArguments: ["--openclaw-voice-wake-fixture", "Summarize today’s calendar"])
        let app = try XCTUnwrap(self.app)
        let sidebar = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertTrue(sidebar.waitForExistence(timeout: 8))
        sidebar.tap()
        let settings = app.buttons["RootTabs.Sidebar.Destination.settings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()
        let sheetRow = app.staticTexts["Appearance"].firstMatch
        XCTAssertTrue(sheetRow.waitForExistence(timeout: 5), app.debugDescription)

        let text = app.staticTexts["Toast.Text"]
        XCTAssertTrue(text.waitForExistence(timeout: 12), app.debugDescription)
        XCTAssertEqual(text.label, "“Summarize today’s calendar”")
        XCTAssertTrue(sheetRow.exists, "The sheet is still open under the toast")
        self.attachScreenshot(named: "toast-over-sheet")
        // The capsule lies over the sheet's first row, Appearance, whose menu opens from the value at
        // its trailing end. A touch on the capsule there must land on the toast, not open that menu.
        let appearanceRow = app.descendants(matching: .any)["SettingsHub.Appearance"]
        XCTAssertTrue(appearanceRow.exists)
        let capsule = text.frame
        XCTAssertTrue(capsule.intersects(appearanceRow.frame))
        let overValue = CGVector(dx: capsule.maxX - 12, dy: (appearanceRow.frame.minY + capsule.maxY) / 2)
        let onCapsule = CGVector(
            dx: (overValue.dx - capsule.minX) / capsule.width,
            dy: (overValue.dy - capsule.minY) / capsule.height)
        // The fixture hears the command every 4 s and the toast stays 2 s, so poll closely (the waits
        // below check about once a second) and touch a fresh toast once its entrance ends. A tap
        // relative to the capsule finds it first, so the toast is up when the touch lands.
        func poll(_ timeout: TimeInterval, until condition: () -> Bool) -> Bool {
            let end = Date().addingTimeInterval(timeout)
            repeat {
                if condition() { return true }
            } while Date() < end
            return false
        }
        XCTAssertTrue(poll(6) { !text.exists })
        XCTAssertTrue(poll(6) { text.exists })
        Thread.sleep(forTimeInterval: 0.3)
        text.coordinate(withNormalizedOffset: onCapsule).tap()
        Thread.sleep(forTimeInterval: 1)
        XCTAssertFalse(app.buttons["System"].exists, "The touch stayed on the toast")
        XCTAssertTrue(sheetRow.exists, "The sheet is still on its root page")
        // Control: once that toast leaves, and before the next one, a touch at the same place opens the menu.
        XCTAssertTrue(poll(6) { !text.exists })
        app.coordinate(withNormalizedOffset: .zero).withOffset(overValue).tap()
        XCTAssertTrue(app.buttons["System"].waitForExistence(timeout: 3), "Without a toast the row gets the touch")
        app.buttons["Dark"].tap()
        XCTAssertTrue(app.buttons["System"].waitForNonExistence(timeout: 3))
        XCTAssertTrue(text.waitForNonExistence(timeout: 6))

        app.swipeDown(velocity: .fast)
        XCTAssertTrue(sheetRow.waitForNonExistence(timeout: 5))
        // Settings was opened from the sidebar, which is still open beside the chat.
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 5))
        input.tap()
        input.typeText("Can you also check the changelog")
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        XCTAssertTrue(text.waitForExistence(timeout: 12))
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.exists)
        XCTAssertFalse(text.frame.intersects(send.frame), "The toast never covers Send")
        XCTAssertLessThan(text.frame.maxY, keyboard.frame.minY)
        self.attachScreenshot(named: "toast-keyboard-up")
    }
}
