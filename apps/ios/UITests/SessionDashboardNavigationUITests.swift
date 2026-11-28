import UIKit
import XCTest

@MainActor
final class SessionDashboardNavigationUITests: XCTestCase {
    func testDashboardOpensItsOwnChat() async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"] != nil,
            "Requires the isolated synthetic sidebar Gateway")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        var reset = URLRequest(url: fixture.appendingPathComponent("reset-dashboard"))
        reset.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: reset)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)

        XCUIDevice.shared.orientation = UIDevice.current.userInterfaceIdiom == .pad ? .landscapeLeft : .portrait
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

        let homeTranscript = app.staticTexts["Your research workspace is ready."]
        let planningTranscript = app.staticTexts["Your planning notes are ready."]
        let dashboard = app.navigationBars["Dashboard"]
        let planningRow = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Planning notes"))
            .firstMatch
        XCTAssertTrue(homeTranscript.waitForExistence(timeout: 30))
        self.openSidebar(in: app)
        self.tapSidebarRow(planningRow, in: app)
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10))
        XCTAssertTrue(app.webViews.staticTexts["Planning dashboard"].waitForExistence(timeout: 15))

        let desktop = dashboard.buttons["SessionDashboard.Desktop"]
        XCTAssertTrue(desktop.waitForExistence(timeout: 10))
        desktop.tap()
        let desktopBar = app.navigationBars["Desktop"]
        XCTAssertTrue(desktopBar.waitForExistence(timeout: 10))
        desktopBar.buttons["Dashboard"].tap()
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10))
        dashboard.buttons["Done"].tap()
        XCTAssertTrue(dashboard.waitForNonExistence(timeout: 10))
        XCTAssertTrue(homeTranscript.isHittable)

        self.openSidebar(in: app)
        self.tapSidebarRow(planningRow, in: app)
        XCTAssertTrue(dashboard.waitForExistence(timeout: 10))
        self.capture(app, named: "planning-dashboard")
        let chat = dashboard.buttons["Chat"]
        XCTAssertTrue(chat.waitForExistence(timeout: 5), "The dashboard must offer its own native Chat action")
        chat.tap()
        XCTAssertTrue(dashboard.waitForNonExistence(timeout: 10))
        XCTAssertTrue(planningTranscript.waitForExistence(timeout: 15))
        XCTAssertFalse(homeTranscript.exists)
        self.capture(app, named: "planning-chat")

        self.openSidebar(in: app)
        self.tapSidebarRow(app.buttons["RootTabs.Sidebar.Destination.chat"], in: app)
        XCTAssertTrue(homeTranscript.waitForExistence(timeout: 15))
        self.openSidebar(in: app)
        self.tapSidebarRow(app.buttons["All Sessions…"], in: app)
        let allSessionsRow = app.buttons["SessionDashboard.Session.agent:main:snooze-active"]
        XCTAssertTrue(allSessionsRow.waitForExistence(timeout: 10))
        allSessionsRow.tap()
        XCTAssertTrue(planningTranscript.waitForExistence(timeout: 15))
        XCTAssertFalse(dashboard.exists)
    }

    private func openSidebar(in app: XCUIApplication) {
        let show = app.buttons["RootTabs.Sidebar.Show"]
        if show.isHittable {
            show.tap()
        }
    }

    private func tapSidebarRow(_ row: XCUIElement, in app: XCUIApplication) {
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        for _ in 0..<5 where !row.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(row.isHittable)
        row.tap()
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
