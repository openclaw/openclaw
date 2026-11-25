import XCTest

/// Provider accounts in the model sheet, against the app's local sign-in fixture (no real provider).
extension OpenClawSnapshotUITests {
    func testProviderAccountsOpenFromModelSheetRoot() throws {
        let app = try self.openProviderAccounts()
        XCTAssertTrue(app.buttons["model-auth-provider-openai"].exists)
        let anthropic = app.buttons["model-auth-provider-anthropic"]
        XCTAssertTrue(anthropic.exists)
        anthropic.tap()
        XCTAssertTrue(app.navigationBars["Anthropic"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Sign-in expires"))
                .firstMatch.waitForExistence(timeout: 5),
            app.debugDescription)
        // Sign out is hidden until Victor decides to offer it (ChatModelAccountsPolicy.offersSignOut).
        XCTAssertFalse(app.buttons["model-auth-sign-out"].exists)
        self.attachScreenshot(named: "provider-account-expiring")
        // The system back button returns to the accounts page, then to the models.
        app.buttons["BackButton"].tap()
        XCTAssertTrue(app.navigationBars["Provider accounts"].waitForExistence(timeout: 5))
    }

    func testProviderAccountSignInFinishes() throws {
        let app = try self.openProviderAccounts()
        try self.enterXAIKey("fixture-key", in: app)
        // Signed in: the page shows the account with no banner; the options stay reachable.
        XCTAssertTrue(app.staticTexts["Other ways to sign in"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(app.descendants(matching: .any)["model-auth-problem"].exists)
        self.attachScreenshot(named: "provider-account-signed-in")
    }

    func testProviderAccountSignInFailureOffersTryAgain() throws {
        let app = try self.openProviderAccounts()
        try self.enterXAIKey("bad-key", in: app)
        XCTAssertTrue(
            app.staticTexts["xAI didn’t accept this key."].waitForExistence(timeout: 10),
            app.debugDescription)
        XCTAssertTrue(app.buttons["model-auth-try-again"].exists)
        XCTAssertTrue(app.buttons["model-auth-option-xai-api-key"].isEnabled)
        self.attachScreenshot(named: "provider-account-failed")
    }

    func testModelSheetRootFlagsProviderThatNeedsSignIn() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", "ordinary"])
        let app = try XCTUnwrap(self.app)
        let chip = self.inlineModelChip(in: app)
        XCTAssertTrue(chip.waitForExistence(timeout: 8))
        chip.tap()
        let xai = app.buttons["chat-model-picker-provider-xai"]
        if !xai.waitForExistence(timeout: 3) { self.expandModelPickerSheet(in: app) }
        XCTAssertTrue(xai.waitForExistence(timeout: 3), app.debugDescription)
        XCTAssertTrue(xai.label.contains("Sign-in needed"), xai.label)
        XCTAssertFalse(app.buttons["chat-model-picker-provider-openai"].label.contains("Sign-in"))
        xai.tap()
        let signIn = app.buttons["chat-model-picker-sign-in-xai"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 5), app.debugDescription)
        signIn.tap()
        XCTAssertTrue(app.navigationBars["xAI"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.buttons["model-auth-option-xai-api-key"].waitForExistence(timeout: 5))
    }

    private func openProviderAccounts() throws -> XCUIApplication {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", "ordinary"])
        let app = try XCTUnwrap(self.app)
        let chip = self.inlineModelChip(in: app)
        XCTAssertTrue(chip.waitForExistence(timeout: 8))
        chip.tap()
        self.pickerSignInRow(in: app).tap()
        XCTAssertTrue(app.navigationBars["Provider accounts"].waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertTrue(app.buttons["model-auth-provider-xai"].waitForExistence(timeout: 5), app.debugDescription)
        return app
    }

    private func enterXAIKey(_ key: String, in app: XCUIApplication) throws {
        app.buttons["model-auth-provider-xai"].tap()
        let option = app.buttons["model-auth-option-xai-api-key"]
        XCTAssertTrue(option.waitForExistence(timeout: 5), app.debugDescription)
        option.tap()
        // The server marks the key sensitive, so it is a secure field.
        let field = app.secureTextFields["model-auth-field"]
        XCTAssertTrue(field.waitForExistence(timeout: 5), app.debugDescription)
        field.tap()
        field.typeText(key)
        app.buttons["model-auth-continue"].tap()
    }
}
