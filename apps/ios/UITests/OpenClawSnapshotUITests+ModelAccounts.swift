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
        XCTAssertTrue(app.staticTexts["Sign-in options"].waitForExistence(timeout: 10), app.debugDescription)
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

    func testProviderAccountSelectionKeepsSignInRunning() throws {
        let app = try self.openProviderAccounts(expanded: true)
        let provider = app.buttons["model-auth-provider-openrouter"]
        if !provider.isHittable { app.swipeUp() }
        XCTAssertTrue(provider.waitForExistence(timeout: 5), app.debugDescription)
        provider.tap()
        let option = app.buttons["model-auth-option-openrouter-device"]
        XCTAssertTrue(option.waitForExistence(timeout: 5), app.debugDescription)
        option.tap()
        let proceed = app.buttons["model-auth-continue"]
        let confirm = app.switches["Confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 15), app.debugDescription)
        proceed.tap()
        let selection = app.buttons["Option"]
        XCTAssertTrue(selection.waitForExistence(timeout: 5), app.debugDescription)
        XCTAssertEqual(selection.value as? String, "All models")
        selection.tap()
        let free = app.buttons["Free models only"]
        XCTAssertTrue(
            free.waitForExistence(timeout: 5),
            "Opening the choice must not end sign-in: \(app.debugDescription)")
        free.tap()
        if app.navigationBars["Option"].exists { app.buttons["BackButton"].tap() }
        XCTAssertTrue(proceed.waitForExistence(timeout: 5), "Choosing an option must preserve sign-in")
        XCTAssertEqual(selection.value as? String, "Free models only")
        proceed.tap()
        XCTAssertTrue(app.staticTexts["Sign-in options"].waitForExistence(timeout: 10), app.debugDescription)
    }

    func testProviderAccountReloadFailureKeepsCachedAccountAndOffersRetry() throws {
        try self.assertProviderAccountReloadKeepsCachedAccount(scenario: "refresh-failed")
    }

    func testProviderAccountNotReadyKeepsCachedAccountAndOffersRetry() throws {
        try self.assertProviderAccountReloadKeepsCachedAccount(scenario: "refresh-not-ready")
    }

    func testProviderAccountSuccessfulRetryClearsPostSignInWarning() throws {
        let app = try self.openProviderAccounts(scenario: "post-login-check-failed", expanded: true)
        try self.enterXAIKey("fixture-key", in: app)
        let warning = app.staticTexts["Sign-in ended, but OpenClaw couldn’t check the account."]
        XCTAssertTrue(warning.waitForExistence(timeout: 10), app.debugDescription)
        app.buttons["model-auth-try-again"].tap()
        XCTAssertTrue(app.staticTexts["Sign-in options"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(warning.waitForNonExistence(timeout: 5), "A successful status read must clear the old warning")
    }

    private func assertProviderAccountReloadKeepsCachedAccount(scenario: String) throws {
        let app = try self.openProviderAccounts(scenario: scenario, expanded: true)
        app.buttons["model-auth-provider-anthropic"].tap()
        let option = app.buttons["model-auth-option-anthropic-oauth"]
        XCTAssertTrue(option.waitForExistence(timeout: 5), app.debugDescription)
        // Start inside a visible row, not in the sheet's navigation or resize region.
        let content = option.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        content.press(
            forDuration: 0.05,
            thenDragTo: content.withOffset(CGVector(dx: 0, dy: 320)),
            withVelocity: .slow,
            thenHoldForDuration: 0.7)
        let message = app.staticTexts["model-auth-message"]
        guard message.waitForExistence(timeout: 5) else {
            app.buttons["BackButton"].tap()
            XCTAssertTrue(message.waitForExistence(timeout: 5), "The fixture must return the simulated status failure")
            return XCTFail("A failed reload must be visible beside cached account data, not only on the accounts list")
        }
        XCTAssertTrue(option.exists, "An unavailable status must not replace the last usable account data")
        let retry = app.buttons["model-auth-try-again"]
        XCTAssertTrue(retry.isHittable)
        self.attachScreenshot(named: "provider-account-\(scenario)")
        retry.tap()
        XCTAssertTrue(message.waitForNonExistence(timeout: 5))
        XCTAssertTrue(option.exists)
    }

    private func openProviderAccounts(scenario: String = "ordinary", expanded: Bool = false) throws -> XCUIApplication {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", scenario])
        let app = try XCTUnwrap(self.app)
        let chip = self.inlineModelChip(in: app)
        XCTAssertTrue(chip.waitForExistence(timeout: 8))
        chip.tap()
        if expanded { self.expandModelPickerSheet(in: app) }
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
