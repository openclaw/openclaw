import UIKit
import XCTest

@MainActor
final class SystemsNavigationUITests: XCTestCase {
    func testDefaultPinsExposeSystemsAndNavigateToItsDashboardRoute() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone sidebar evidence")
        let app = launchApp(pinnedPages: "")
        defer { app.terminate() }

        let systems = app.buttons["RootTabs.Sidebar.Destination.systems"]
        XCTAssertTrue(systems.waitForExistence(timeout: 10), app.debugDescription)
        capture(app, named: "systems-default-pin")

        systems.tap()
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        let navigated = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", "ready:systems"),
            object: readiness
        )
        XCTAssertEqual(XCTWaiter.wait(for: [navigated], timeout: 10), .completed)
        capture(app, named: "systems-selected")
    }

    func testSavedPinsRemainAuthoritativeAcrossUpgrade() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone sidebar evidence")
        let app = launchApp(pinnedPages: "usage,overview,docs")
        defer { app.terminate() }

        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.usage"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.overview"].exists)
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.docs"].exists)
        XCTAssertFalse(
            app.buttons["RootTabs.Sidebar.Destination.systems"].exists,
            "An existing saved pin list must not gain Systems during upgrade"
        )
        capture(app, named: "systems-saved-pins-preserved")
    }

    func testLiveGatewaySystemsDestinationOpensDashboard() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone sidebar evidence")
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Requires an isolated live Gateway"
        )
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])

        let app = XCUIApplication()
        defer { app.terminate() }
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments = [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat",
            "-AppleLanguages", "(en)",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setupField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupField.waitForExistence(timeout: 5))
        setupField.tap()
        setupField.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()

        let showSidebar = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertTrue(showSidebar.waitForExistence(timeout: 15), app.debugDescription)
        showSidebar.tap()
        let systems = app.buttons["RootTabs.Sidebar.Destination.systems"]
        XCTAssertTrue(systems.waitForExistence(timeout: 10), app.debugDescription)
        systems.tap()

        XCTAssertTrue(app.navigationBars["Systems"].waitForExistence(timeout: 15))
        let dashboard = app.webViews.firstMatch
        XCTAssertTrue(dashboard.waitForExistence(timeout: 30), app.debugDescription)
        XCTAssertTrue(dashboard.staticTexts["Systems"].waitForExistence(timeout: 60), app.debugDescription)
        XCTAssertFalse(app.descendants(matching: .any)["SettingsHub.Fallback"].exists)
        capture(app, named: "systems-live-dashboard")
    }

    private func launchApp(pinnedPages: String) -> XCUIApplication {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-screenshot-mode",
            "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "visible",
            "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "light",
            "-sidebar.pinnedPages", pinnedPages,
            "-AppleLanguages", "(en)",
        ]
        app.launch()
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        XCTAssertTrue(readiness.waitForExistence(timeout: 30))
        return app
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let captured = app.screenshot()
        let screenshot = XCTAttachment(screenshot: captured)
        screenshot.name = "apple-ios-\(name)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
