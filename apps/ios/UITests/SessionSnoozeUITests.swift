import UIKit
import XCTest

@MainActor
final class SessionSnoozeUITests: XCTestCase {
    func testSessionSnoozeStates() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"] != nil,
            "Requires the isolated synthetic sidebar Gateway")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        var reset = URLRequest(url: fixture.appendingPathComponent("reset"))
        reset.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let app = XCUIApplication()
        defer { app.terminate() }
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat", "-AppleLanguages", "(en)",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setupField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupField.waitForExistence(timeout: 5))
        setupField.tap()
        setupField.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()
        XCTAssertTrue(app.staticTexts["Your research workspace is ready."].waitForExistence(timeout: 30))
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let sessions = app.buttons["All Sessions…"]
        XCTAssertTrue(sessions.waitForExistence(timeout: 10))
        for _ in 0..<5 where !sessions.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(sessions.isHittable)
        sessions.tap()
        XCTAssertTrue(app.staticTexts["Recent sessions"].waitForExistence(timeout: 15))
        let active = self.sessionRow("Planning notes", in: app)
        let snoozed = self.sessionRow("Follow-up notes", in: app)
        XCTAssertTrue(active.waitForExistence(timeout: 10))
        XCTAssertTrue(active.isHittable)
        XCTAssertFalse(snoozed.exists)
        self.capture(app, named: "after-sessions-active")
        let main = app.buttons["SessionDashboard.Session.agent:main:main"]
        XCTAssertTrue(main.waitForExistence(timeout: 10))
        main.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Rename…"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Archive"].exists)
        XCTAssertFalse(app.buttons["Delete…"].exists)
        XCTAssertFalse(app.buttons["Snooze"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.94)).tap()
        XCTAssertTrue(app.buttons["Rename…"].waitForNonExistence(timeout: 5))

        active.tap()
        XCTAssertTrue(app.staticTexts["Your planning notes are ready."].waitForExistence(timeout: 15))
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let home = app.buttons["RootTabs.Sidebar.Destination.chat"]
        XCTAssertTrue(home.waitForExistence(timeout: 10))
        XCTAssertEqual(home.label, "Home")
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label == %@", "Home")).count, 1)
        for _ in 0..<5 where !sessions.isHittable { app.swipeUp() }
        sessions.tap()
        XCTAssertTrue(main.waitForExistence(timeout: 10))
        main.tap()
        XCTAssertTrue(app.staticTexts["Your research workspace is ready."].waitForExistence(timeout: 15))
        XCTAssertTrue(app.staticTexts["Your planning notes are ready."].waitForNonExistence(timeout: 5))
        let (stateData, _) = try await URLSession.shared.data(from: fixture)
        let state = try JSONDecoder().decode(FixtureState.self, from: stateData)
        XCTAssertEqual(state.requests.last { $0.method == "chat.history" }?.sessionKey, "agent:main:main")
        XCTAssertFalse(state.requests.contains {
            ["sessions.create", "sessions.reset", "sessions.delete", "sessions.fork", "sessions.patch", "chat.send"]
                .contains($0.method)
        })
        app.buttons["RootTabs.Sidebar.Show"].tap()
        for _ in 0..<5 where !sessions.isHittable { app.swipeUp() }
        sessions.tap()
        XCTAssertTrue(active.waitForExistence(timeout: 10))
        XCTAssertTrue(main.staticTexts["open"].exists)
        XCTAssertTrue(active.staticTexts["recent"].exists)
        active.press(forDuration: 1)
        let snoozeMenu = app.buttons["Snooze"]
        XCTAssertTrue(snoozeMenu.waitForExistence(timeout: 5), app.debugDescription)
        snoozeMenu.tap()
        let hour = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "In 1 hour ·")).firstMatch
        XCTAssertTrue(hour.waitForExistence(timeout: 5), app.debugDescription)
        self.capture(app, named: "after-snooze-presets")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.94)).tap()
        XCTAssertTrue(hour.waitForNonExistence(timeout: 5))

        let snoozedScope = app.segmentedControls.firstMatch.buttons["Snoozed"]
        XCTAssertTrue(snoozedScope.waitForExistence(timeout: 5))
        snoozedScope.tap()
        XCTAssertTrue(snoozed.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertFalse(active.exists)
        XCTAssertTrue(snoozed.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Wakes "))
            .firstMatch.exists)
        self.capture(app, named: "after-sessions-snoozed")
        snoozed.press(forDuration: 1)
        let wake = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Wake session ·")).firstMatch
        XCTAssertTrue(wake.waitForExistence(timeout: 5), app.debugDescription)
        self.capture(app, named: "after-wake-menu")
    }

    private struct FixtureState: Decodable {
        struct Request: Decodable {
            let method: String
            let sessionKey: String?
        }

        let requests: [Request]
    }

    private func sessionRow(_ title: String, in app: XCUIApplication) -> XCUIElement {
        // The retained sidebar exposes the same title, even while visually hidden.
        app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@ AND label CONTAINS %@", "\(title),", ", chat,")).firstMatch
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }
}
