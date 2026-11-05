import UIKit
import XCTest

/// Consumer regression for the Sessions screen partial-roster repair (issue #193789):
/// when a later `sessions.list` page keeps failing, the loaded rows must stay visible
/// with an incomplete-load notice and a working in-screen Refresh, and the notice must
/// clear once a retry recovers the full roster. Runs against the screenshot fixture
/// transport via `--openclaw-partial-sessions-fixture`.
@MainActor
final class SessionsPartialLoadUITests: XCTestCase {
    private static let partialNotice = "Showing 200 sessions; 201 total. Refresh to load the rest."

    func testSessionsKeepsRowsAndRecoversAfterLaterPageFailure() throws {
        self.continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "sessions",
            "--openclaw-screenshot-mode",
            "--openclaw-ui-test-readiness",
            "--openclaw-partial-sessions-fixture",
            "--openclaw-appearance", "light",
            "-AppleLanguages", "(en)",
        ]
        app.launch()
        defer { app.terminate() }

        let ready = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        XCTAssertTrue(ready.waitForExistence(timeout: 60), "App did not reach UI-test readiness")

        // The retained first page must stay listed while the final page is failing.
        let firstRow = app.staticTexts["Partial session 001"].firstMatch
        XCTAssertTrue(
            firstRow.waitForExistence(timeout: 30),
            "Partial roster dropped its retained sessions rows")
        let partialCount = app.staticTexts["200 sessions"].firstMatch
        XCTAssertTrue(
            partialCount.waitForExistence(timeout: 10),
            "Header does not count the retained partial roster")
        self.capture("sessions-partial-roster", in: app)

        let notice = app.staticTexts[Self.partialNotice].firstMatch
        XCTAssertTrue(
            notice.waitForExistence(timeout: 10),
            "Partial roster was presented as complete: no incomplete-load notice")
        let refresh = app.buttons["Sessions.PartialLoad.Refresh"].firstMatch
        XCTAssertTrue(
            refresh.waitForExistence(timeout: 5),
            "Incomplete-load notice is missing its in-screen Refresh action")

        // The fixture keeps the final page failing until its third load, so the
        // screen may legitimately need one more in-screen retry before recovery.
        var refreshTaps = 0
        while notice.exists, refreshTaps < 3 {
            refresh.tap()
            refreshTaps += 1
            _ = notice.waitForNonExistence(timeout: 15)
        }
        XCTAssertFalse(
            notice.exists,
            "Incomplete-load notice survived a successful complete reload")

        // Recovery re-reads the full roster: the header counts all 201 sessions.
        let recoveredCount = app.staticTexts["201 sessions"].firstMatch
        XCTAssertTrue(
            recoveredCount.waitForExistence(timeout: 15),
            "In-screen Refresh did not recover the complete roster")
        self.capture("sessions-recovered", in: app)

        let trace = XCTAttachment(
            string: """
                launch arguments: \(app.launchArguments.joined(separator: " "))
                retained rows visible while final page failing: Partial session 001 … header "200 sessions"
                notice: \(Self.partialNotice)
                in-screen refresh taps until recovery: \(refreshTaps)
                header count after recovery: 201 sessions
                """)
        trace.name = "sessions-partial-load-trace"
        trace.lifetime = .keepAlways
        self.add(trace)
    }

    private func capture(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
