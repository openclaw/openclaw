import UIKit
import XCTest

extension XCTestCase {
    @MainActor
    func pairGatewayForUITest(
        in app: XCUIApplication,
        setupCode: String?,
        initialTab: String,
        initialDestination: String,
        expectedTLSFingerprint: String? = nil)
    {
        if let setupCode {
            UIPasteboard.general.string = setupCode
        }
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab",
            initialTab,
            "--openclaw-initial-destination",
            initialDestination,
        ]
        app.launch()

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()
        let setupCodeField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupCodeField.waitForExistence(timeout: 5))
        setupCodeField.tap()
        setupCodeField.press(forDuration: 1)
        XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 3))
        app.menuItems["Paste"].tap()
        app.buttons["Apply"].tap()
        if let expectedTLSFingerprint {
            XCTAssertEqual(expectedTLSFingerprint.count, 64)
            XCTAssertTrue(expectedTLSFingerprint.allSatisfy(\.isHexDigit))
            let trust = app.alerts["Trust this gateway?"]
            XCTAssertTrue(trust.waitForExistence(timeout: 15))
            let fingerprint = trust.staticTexts.matching(NSPredicate(
                format: "label ENDSWITH %@", expectedTLSFingerprint))
            XCTAssertEqual(fingerprint.count, 1, "The actual TLS certificate fingerprint differs")
            let accept = trust.buttons["Trust and connect"]
            XCTAssertTrue(accept.isEnabled && accept.isHittable)
            accept.tap()
        }
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 45))
        app.buttons["Go to Chat"].tap()
    }
}
