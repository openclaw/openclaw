import XCTest

@MainActor
final class NativeUsageUITests: XCTestCase {
    func testChangePeriodAndInspectAgent() {
        self.continueAfterFailure = false
        for appearance in ["light", "dark"] {
            let app = XCUIApplication()
            app.launchArguments = [
                "--openclaw-screenshot-mode",
                "--openclaw-usage-fixture",
                "--openclaw-initial-destination",
                "usage",
                "--openclaw-sidebar-visibility",
                "hidden",
                "--openclaw-appearance",
                appearance,
                "-AppleLanguages",
                "(en)",
            ]
            app.launch()
            let summary = app.descendants(matching: .any)["Usage.Headline"].firstMatch
            XCTAssertTrue(summary.waitForExistence(timeout: 12))
            self.capture(app, "usage-overview-" + appearance)
            let original = summary.label
            app.buttons["7 days"].tap()
            let changed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == YES AND label != %@", original),
                object: summary)
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 6), .completed)
            app.buttons["Custom"].tap()
            XCTAssertTrue(app.staticTexts["Start date"].waitForExistence(timeout: 4))
            self.capture(app, "usage-custom-" + appearance)
            let agent = app.buttons.containing(.staticText, identifier: "Research").firstMatch
            for _ in 0..<6 where !agent.isHittable {
                app.swipeUp()
            }
            XCTAssertTrue(agent.isHittable)
            agent.tap()
            XCTAssertTrue(app.navigationBars["Research"].waitForExistence(timeout: 5))
            self.capture(app, "usage-agent-" + appearance)
            app.buttons["Done"].tap()
            XCTAssertTrue(app.navigationBars["Usage"].exists)
            app.terminate()
        }
    }

    private func capture(_ app: XCUIApplication, _ name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
