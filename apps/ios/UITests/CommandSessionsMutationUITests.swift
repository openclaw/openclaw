import UIKit
import XCTest

@MainActor
final class CommandSessionsMutationUITests: XCTestCase {
    func testRejectedPinKeepsLoadedSessionsUsable() async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_SESSION_MUTATION_FIXTURE_URL"] != nil,
            "Requires test-ios-shell-gateway.mjs --session-mutations")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_SESSION_MUTATION_FIXTURE_URL"]
            .flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        try await self.setListRejected(true, fixture: fixture)
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-destination", "chat",
            "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "light", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
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
        self.openSessions(in: app)

        XCTAssertTrue(app.staticTexts["Sessions unavailable"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Try again after the gateway reconnects."].exists)
        self.capture("initial-roster-unavailable", app: app)
        try await self.setListRejected(false, fixture: fixture)
        self.openDestination("overview", in: app)
        self.openSessions(in: app)

        let first = self.row("Synthetic session 1", app: app)
        let second = self.row("Synthetic session 2", app: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))
        XCTAssertTrue(second.exists)
        self.capture("loaded-before-pin", app: app)
        self.pin(first, in: app)
        let rejection = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "Synthetic pin refused"))
            .firstMatch
        XCTAssertTrue(rejection.waitForExistence(timeout: 10))
        self.capture("rejected-pin", app: app)
        XCTAssertTrue(first.exists, "Rejected Pin must retain its loaded conversation")
        XCTAssertTrue(second.exists, "Rejected Pin must retain unrelated loaded conversations")
        XCTAssertTrue(first.isHittable)
        XCTAssertTrue(second.isHittable)
        XCTAssertFalse(app.staticTexts["Sessions unavailable"].exists)
        XCTAssertFalse(app.staticTexts["Pinned"].exists)

        second.tap()
        XCTAssertTrue(app.staticTexts["Opened agent:main:navigation-2"].waitForExistence(timeout: 10))
        self.openSessions(in: app)
        XCTAssertTrue(first.waitForExistence(timeout: 10))

        // A rejected action must still offer Pin, not an optimistic Unpin.
        self.pin(first, in: app)
        XCTAssertTrue(app.staticTexts["Pinned"].waitForExistence(timeout: 10))
        XCTAssertTrue(rejection.waitForNonExistence(timeout: 5))
        XCTAssertTrue(first.exists)
        XCTAssertTrue(second.exists)
        self.capture("successful-pin", app: app)
        first.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Unpin"].waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.1)).tap()
        XCTAssertTrue(app.buttons["Unpin"].waitForNonExistence(timeout: 5))

        first.tap()
        XCTAssertTrue(app.staticTexts["Opened agent:main:navigation-1"].waitForExistence(timeout: 10))
    }

    private func row(_ title: String, app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "\(title),", ", chat,")).firstMatch
    }

    private func pin(_ row: XCUIElement, in app: XCUIApplication) {
        row.press(forDuration: 1)
        let pin = app.buttons["Pin"]
        XCTAssertTrue(pin.waitForExistence(timeout: 5))
        pin.tap()
    }

    private func openSessions(in app: XCUIApplication) {
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let sessions = app.buttons["All Sessions…"]
        XCTAssertTrue(sessions.waitForExistence(timeout: 10))
        for _ in 0..<5 where !sessions.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(sessions.isHittable)
        sessions.tap()
        self.waitForDestination("sessions", in: app)
    }

    private func openDestination(_ destination: String, in app: XCUIApplication) {
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let button = app.buttons["RootTabs.Sidebar.Destination.\(destination)"]
        XCTAssertTrue(button.waitForExistence(timeout: 5))
        button.tap()
        self.waitForDestination(destination, in: app)
    }

    private func waitForDestination(_ destination: String, in app: XCUIApplication) {
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(
            for: NSPredicate(format: "value == %@", "ready:\(destination)"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)
    }

    private func setListRejected(_ rejected: Bool, fixture: URL) async throws {
        var request = URLRequest(url: fixture.appendingPathComponent("session-mutations")
            .appending(queryItems: [URLQueryItem(name: "rejectList", value: rejected ? "1" : "0")]))
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func capture(_ name: String, app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
