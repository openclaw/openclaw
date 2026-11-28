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
            let period = app.buttons["Usage.Period"]
            XCTAssertEqual(period.label, "Last 30 days")
            let position = period.frame.midY
            period.tap()
            let week = app.descendants(matching: .any)["Last 7 days"].firstMatch
            XCTAssertTrue(week.waitForExistence(timeout: 5), "Tapping the period control should open the menu")
            week.tap()
            let changed = XCTNSPredicateExpectation(
                predicate: NSPredicate(format: "exists == YES AND label != %@", original),
                object: summary)
            XCTAssertEqual(XCTWaiter.wait(for: [changed], timeout: 6), .completed)
            self.capture(app, "usage-week-" + appearance)
            XCTAssertEqual(period.label, "Last 7 days")
            XCTAssertEqual(period.frame.midY, position, accuracy: 2)
            period.tap()
            app.buttons["Custom range…"].tap()
            XCTAssertTrue(app.navigationBars["Custom range"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.descendants(matching: .any)["Start date"].firstMatch.exists)
            self.capture(app, "usage-custom-" + appearance)
            XCTAssertTrue(app.descendants(matching: .any)["End date"].firstMatch.exists)
            app.buttons["Cancel"].tap()
            XCTAssertEqual(period.label, "Last 7 days")
            let agent = app.buttons["Usage.Agent.Research"]
            for _ in 0..<4 where !agent.isHittable || agent.frame.maxY > app.frame.maxY - 50 {
                app.swipeUp()
            }
            XCTAssertTrue(agent.isHittable)
            agent.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.35)).tap()
            XCTAssertTrue(app.navigationBars["Research"].waitForExistence(timeout: 5))
            self.capture(app, "usage-agent-" + appearance)
            XCTAssertEqual(period.label, "Last 7 days")
            period.tap()
            app.buttons["Custom range…"].tap()
            app.buttons["Apply"].tap()
            XCTAssertEqual(period.label, "Custom range")
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
