import UIKit
import XCTest

/// Consumer regression for the Sessions screen partial-roster repair (issue #193789):
/// with the loopback Gateway fixture's later page failing (`/partial`), the retained
/// sessions must stay listed beside an incomplete-result notice with a working
/// in-screen Refresh, and `/complete` plus that Refresh must recover the full roster.
/// The fixture, its setup code, and the `/partial` + `/complete` controls come from
/// `scripts/test-ios-shell-gateway.mjs` (default 205-session roster); the flow was
/// first executed in https://github.com/openclaw/openclaw/pull/193809#pullrequestreview-5794596195.
@MainActor
final class CommandSessionsPartialRosterUITests: XCTestCase {
    func testPartialRosterNoticeRetainsRowsAndRefreshRecovers() async throws {
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

        // The leading sidebar can render the identical notice text, so every
        // assertion is scoped to the Sessions screen's own scroll view.
        let screen = app.scrollViews.containing(.staticText, identifier: "Recent sessions").firstMatch
        XCTAssertTrue(screen.waitForExistence(timeout: 10))
        let notice = screen.staticTexts["Showing 200 sessions; 205 total. Refresh to load the rest."]
        let partialCount = screen.staticTexts["199 sessions"]
        XCTAssertTrue(
            partialCount.waitForExistence(timeout: 20),
            "The main session is excluded from the visible row count")
        self.capture("partial-roster", in: app)
        XCTAssertTrue(
            notice.waitForExistence(timeout: 10),
            "Retained rows need an incomplete-result notice")
        XCTAssertTrue(
            screen.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Synthetic session 1"))
                .firstMatch
                .exists)
        let refresh = screen.buttons["Refresh"]
        XCTAssertTrue(refresh.waitForExistence(timeout: 5))
        XCTAssertTrue(refresh.isHittable)

        try await self.setPartial(false, fixture: fixture)
        refresh.tap()
        XCTAssertTrue(screen.staticTexts["204 sessions"].waitForExistence(timeout: 15))
        XCTAssertTrue(notice.waitForNonExistence(timeout: 5))
        XCTAssertFalse(refresh.exists)
        self.capture("complete-roster", in: app)

        let trace = XCTAttachment(
            string: """
                launch arguments: \(app.launchArguments.joined(separator: " "))
                fixture: \(fixture.absoluteString)
                retained rows visible while final page failing: Synthetic session 1 … header "199 sessions"
                notice: Showing 200 sessions; 205 total. Refresh to load the rest.
                in-screen Refresh label: \(refresh.label)
                header count after recovery: 204 sessions
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
