import XCTest

@MainActor
final class QRScannerPermissionUITests: XCTestCase {
    func testFirstScanRequestsCameraAndDenialOffersSettings() throws {
        let app = try self.openScannerWithUndecidedCameraAccess()
        defer { app.terminate() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let deny = springboard.buttons.matching(
            NSPredicate(format: "label IN %@", ["Don’t Allow", "Don't Allow"])).firstMatch
        XCTAssertTrue(deny.waitForExistence(timeout: 8), "Scanning must request undecided camera access")
        deny.tap()

        let guidance = app.staticTexts["Camera Access Needed"]
        XCTAssertTrue(guidance.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Open Settings"].isHittable)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "qr-camera-permission-denied"
        capture.lifetime = .keepAlways
        self.add(capture)

        app.buttons["Cancel"].tap()
        XCTAssertTrue(guidance.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Opening QR scanner…"].exists)
        app.buttons["Scan QR"].tap()
        XCTAssertTrue(guidance.waitForExistence(timeout: 5), "Denied access must offer recovery on retry")
        XCTAssertTrue(app.buttons["Open Settings"].isHittable)
        app.buttons["Open Settings"].tap()
        let settings = XCUIApplication(bundleIdentifier: "com.apple.Preferences")
        XCTAssertTrue(settings.wait(for: .runningForeground, timeout: 5))
        let camera = settings.switches["Camera"]
        XCTAssertTrue(camera.waitForExistence(timeout: 5))
        XCTAssertEqual(camera.value as? String, "0")
        camera.tap()
        app.activate()
        XCTAssertTrue(guidance.waitForNonExistence(timeout: 8), "Returning from Settings must refresh camera access")
        app.buttons["Cancel"].tap()
        XCTAssertTrue(app.buttons["Scan QR"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["Opening QR scanner…"].exists)
    }

    func testCancelClearsScannerOpeningStatus() throws {
        let app = try self.openScannerWithUndecidedCameraAccess()
        defer { app.terminate() }
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let allow = springboard.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.waitForExistence(timeout: 8))
        allow.tap()

        let title = app.staticTexts["Scan Setup Code"]
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        app.buttons["Cancel"].tap()
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Scan QR"].isHittable)
        XCTAssertFalse(app.staticTexts["Opening QR scanner…"].exists)
        let capture = XCTAttachment(screenshot: app.screenshot())
        capture.name = "qr-scanner-cancelled"
        capture.lifetime = .keepAlways
        self.add(capture)
    }

    private func openScannerWithUndecidedCameraAccess() throws -> XCUIApplication {
        #if targetEnvironment(simulator)
        throw XCTSkip("Run camera permission and VisionKit cancellation proof on a physical iPhone.")
        #else
        self.continueAfterFailure = false
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            let localNetwork = alert.staticTexts.matching(
                NSPredicate(format: "label CONTAINS[c] %@", "local network")).firstMatch
            guard localNetwork.exists, alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        let app = XCUIApplication()
        app.resetAuthorizationStatus(for: .camera)
        app.launchArguments = [
            "--openclaw-reset-onboarding",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        let next = app.buttons["Continue"]
        XCTAssertTrue(next.waitForExistence(timeout: 8))
        next.tap()
        app.tap()
        let scan = app.buttons["Scan QR"]
        XCTAssertTrue(scan.waitForExistence(timeout: 8))
        scan.tap()
        return app
        #endif
    }
}
