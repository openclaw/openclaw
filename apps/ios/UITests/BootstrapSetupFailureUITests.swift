import XCTest

@MainActor
final class BootstrapSetupFailureUITests: XCTestCase {
    func testOnboardingPreservesFailedBootstrapSetupForRetry() throws {
        try self.assertBootstrapRefusal(inSettings: false)
    }

    func testSettingsPreservesFailedBootstrapSetupForRetry() throws {
        try self.assertBootstrapRefusal(inSettings: true)
    }

    private func assertBootstrapRefusal(inSettings: Bool) throws {
        self.continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
            "-node.instanceId", "bootstrap-refusal-\(UUID().uuidString)",
            // The argument domain survives launch reset. A malformed legacy queue must
            // refuse replacement rather than lose potentially recoverable Watch messages.
            "-watch.chat.command.queue.v1", "malformed-legacy-queue",
        ]
        if inSettings {
            app.launchArguments += [
                "--openclaw-initial-destination", "gateway",
                "-gateway.onboardingComplete", "YES",
                "-gateway.hasConnectedOnce", "YES",
                "-onboarding.completed", "YES",
                "-onboarding.quickSetupDismissed", "YES",
            ]
        }
        app.launch()
        if !inSettings {
            let continueButton = app.buttons["Continue"]
            XCTAssertTrue(continueButton.waitForExistence(timeout: 8))
            continueButton.tap()
            app.tap()
            let manual = app.buttons["Connect Manually"]
            XCTAssertTrue(manual.waitForExistence(timeout: 8))
            manual.tap()
        }

        let setup = app.textFields[inSettings ? "Paste setup code" : "Enter setup code"]
        XCTAssertTrue(setup.waitForExistence(timeout: 8))
        if !inSettings {
            let home = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Home Network")).firstMatch
            for _ in 0..<12 where !home.isHittable {
                app.swipeUp()
            }
            XCTAssertTrue(home.exists)
            XCTAssertTrue(home.isHittable)
            home.tap()
            self.continueOnboarding(in: app)
        }
        let originalManualEndpoint = try self.manualEndpoint(in: app)
        if inSettings {
            // Recycled List cells can retain pre-scroll accessibility frames. Return
            // to the top with the status-bar gesture before targeting the setup field.
            let statusBarHeight = app.navigationBars["Gateway"].frame.minY - app.frame.minY
            XCTAssertGreaterThan(statusBarHeight, 0)
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 20, dy: statusBarHeight / 2)).tap()
        } else {
            let back = app.buttons["Back"]
            XCTAssertTrue(back.isHittable)
            back.tap()
            for _ in 0..<12 where !setup.isHittable {
                app.swipeDown()
            }
        }
        XCTAssertTrue(setup.exists)
        XCTAssertTrue(setup.isHittable)
        setup.tap()
        if inSettings {
            XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        }
        let code = #"{"url":"wss://bootstrap-refusal.invalid:443","bootstrapToken":"test-bootstrap-refusal"}"#
        setup.typeText(code)
        XCTAssertEqual(setup.value as? String, code, "BOOTSTRAP_SETUP_INPUT_NOT_ENTERED")
        if !inSettings {
            app.buttons["Dismiss Keyboard"].tap()
        }
        let connect = app.buttons[inSettings ? "Connect" : "Apply"].firstMatch
        XCTAssertTrue(connect.isEnabled)
        connect.tap()

        let failure = inSettings
            ? "Could not remove offline data for this gateway"
            : "Could not safely replace the gateway's offline data. Try again."
        let failureVisible = app.staticTexts[failure].firstMatch.waitForExistence(timeout: 8)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = inSettings ? "bootstrap-refusal-settings" : "bootstrap-refusal-onboarding"
        capture.lifetime = .keepAlways
        self.add(capture)
        XCTAssertTrue(failureVisible, "BOOTSTRAP_REFUSAL_NOT_PRESERVED")
        // A refused setup must remain editable; the old flow cleared this field
        // and continued into trust/connection after the preparation returned false.
        XCTAssertEqual(setup.value as? String, code, "BOOTSTRAP_SETUP_CODE_LOST")
        XCTAssertTrue(connect.wait(for: \.isEnabled, toEqual: true, timeout: 5))
        XCTAssertFalse(app.alerts["Trust this gateway?"].exists)
        if !inSettings {
            self.continueOnboarding(in: app)
        }
        let refused = try self.manualEndpoint(in: app)
        XCTAssertEqual(refused.host, originalManualEndpoint.host, "BOOTSTRAP_MANUAL_HOST_CHANGED")
        XCTAssertEqual(refused.port, originalManualEndpoint.port, "BOOTSTRAP_MANUAL_PORT_CHANGED")
    }

    private func continueOnboarding(in app: XCUIApplication) {
        let next = app.buttons["Continue"]
        for _ in 0..<12 where !next.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(next.exists)
        XCTAssertTrue(next.isHittable)
        XCTAssertTrue(next.isEnabled)
        next.tap()
    }

    private func manualEndpoint(in app: XCUIApplication) throws -> (host: String, port: String) {
        let host = app.textFields["Host"]
        for _ in 0..<12 where !host.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(host.exists)
        XCTAssertTrue(host.isHittable)
        let hostValue = try XCTUnwrap(host.value as? String)
        let port = app.textFields["Port"]
        for _ in 0..<12 where !port.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(port.exists)
        XCTAssertTrue(port.isHittable)
        return try (hostValue, XCTUnwrap(port.value as? String))
    }
}
