import UIKit
import XCTest

/// Consumer regression for the Sessions screen partial-roster repair (issue #193789):
/// with the loopback Gateway fixture's later page failing (`/partial`), the retained
/// sessions must stay listed beside an incomplete-result notice with a working
/// in-screen Try again, and `/complete` plus that Try again must recover the full roster.
/// The fixture, its setup code, and the `/partial` + `/complete` controls come from
/// `scripts/test-ios-shell-gateway.mjs` (default 205-session roster); the flow was
/// first executed in https://github.com/openclaw/openclaw/pull/193809#pullrequestreview-5794596195.
@MainActor
final class CommandSessionsPartialRosterUITests: XCTestCase {
    func testPartialRosterNoticeRetainsRowsAndTryAgainRecovers() async throws {
        self.continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_APPROVAL_FIXTURE_URL"] != nil,
            "Requires test-ios-shell-gateway.mjs with its default 205-session roster")
        let fixture = try XCTUnwrap(
            environment["OPENCLAW_IOS_APPROVAL_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-destination", "chat",
            "--openclaw-ui-test-readiness", "--openclaw-appearance", "light",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setup = app.textFields["Enter setup code"]
        XCTAssertTrue(setup.waitForExistence(timeout: 5))
        setup.tap()
        setup.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()
        app.terminate()
        try await self.setPartial(true, fixture: fixture)
        app.launchArguments.removeAll { $0 == "--openclaw-reset-onboarding" }
        let destination = try XCTUnwrap(app.launchArguments.firstIndex(of: "chat"))
        app.launchArguments[destination] = "sessions"
        app.launch()

        // The sidebar shows the same notice with its own retry, so every assertion
        // uses the Sessions screen's identifiers.
        let notice = app.staticTexts["Sessions.PartialLoad.Notice"]
        XCTAssertTrue(
            notice.waitForExistence(timeout: 20),
            "Retained rows need an incomplete-result notice")
        XCTAssertEqual(notice.label, "Couldn’t load some sessions. Try again.")
        // The first page (sessions 0–199) stays listed; the failing later page (200–204) is missing.
        let retained = app.buttons["SessionDashboard.Session.agent:main:navigation-1"]
        let laterPage = app.buttons["SessionDashboard.Session.agent:main:navigation-204"]
        XCTAssertTrue(retained.exists, "Rows from the loaded page stay listed beside the notice")
        XCTAssertFalse(laterPage.exists)
        self.capture("partial-roster", in: app)
        let retry = app.buttons["Sessions.PartialLoad.Refresh"]
        XCTAssertTrue(retry.waitForExistence(timeout: 5))
        XCTAssertTrue(retry.isHittable)
        XCTAssertEqual(retry.label, "Try again")
        // Capture the control's identity while it still exists; resolving it after
        // recovery would fail (the notice is gone once the roster is complete).
        let retryIdentity = "label=\(retry.label); identifier=\(retry.identifier)"

        try await self.setPartial(false, fixture: fixture)
        retry.tap()
        XCTAssertTrue(laterPage.waitForExistence(timeout: 15), "Try again loads the rest of the roster")
        XCTAssertTrue(notice.waitForNonExistence(timeout: 5))
        XCTAssertFalse(retry.exists)
        XCTAssertTrue(retained.exists)
        self.capture("complete-roster", in: app)

        let trace = XCTAttachment(
            string: """
            launch arguments: \(app.launchArguments.joined(separator: " "))
            fixture: \(fixture.absoluteString)
            retained rows visible while final page failing: Synthetic session 1; Synthetic session 204 absent
            notice: Couldn’t load some sessions. Try again.
            in-screen Try again: \(retryIdentity)
            after recovery: Synthetic session 204 listed, notice gone
            """)
        trace.name = "sessions-partial-roster-trace"
        trace.lifetime = .keepAlways
        self.add(trace)
    }

    private func setPartial(_ partial: Bool, fixture: URL) async throws {
        var request = URLRequest(url: fixture.appending(path: partial ? "partial" : "complete"))
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func capture(_ name: String, in app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
    }
}
