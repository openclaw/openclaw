import UIKit
import XCTest

@MainActor
final class OpenClawSnapshotUITests: XCTestCase {
    private struct ScreenshotTarget {
        let initialTab: String
        let initialDestination: String
        let name: String
    }

    private static let screenshotTargets = [
        ScreenshotTarget(initialTab: "control", initialDestination: "overview", name: "01-control-connected"),
        ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "02-chat-connected"),
        ScreenshotTarget(initialTab: "talk", initialDestination: "talk", name: "03-talk-connected"),
        ScreenshotTarget(initialTab: "agent", initialDestination: "agents", name: "04-agent-connected"),
        ScreenshotTarget(initialTab: "settings", initialDestination: "settings", name: "05-settings-connected"),
    ]

    private var app: XCUIApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        app?.terminate()
        app = nil
        try super.tearDownWithError()
    }

    func testConnectedGatewayTabs() {
        for target in Self.screenshotTargets {
            launchApp(for: target)
            snapshot(target.name, timeWaitingForIdle: 5)
        }
    }

    func testControlOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone control hub only")
        launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "control",
            name: "control-overview-navigation"
        ))

        let overview = app?.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview?.waitForExistence(timeout: 5) == true)
        overview?.tap()

        XCTAssertTrue(app?.buttons["Back to Control"].waitForExistence(timeout: 5) == true)
        XCTAssertEqual(app?.state, .runningForeground)
    }

    func testLiveGatewayControlOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone control hub only")
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Set OPENCLAW_IOS_LIVE_GATEWAY=1 and copy a fresh setup code to the simulator pasteboard"
        )

        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab",
            "control",
            "--openclaw-initial-destination",
            "control",
        ]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Set Up Manually"].waitForExistence(timeout: 8))
        app.buttons["Set Up Manually"].tap()

        let setupCodeField = app.textFields["Paste setup code"]
        XCTAssertTrue(setupCodeField.waitForExistence(timeout: 5))
        setupCodeField.tap()
        setupCodeField.press(forDuration: 1)
        XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 3))
        app.menuItems["Paste"].tap()
        app.buttons["Done"].tap()
        app.buttons["Apply Setup Code"].tap()

        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 45))
        app.buttons["Open OpenClaw"].tap()

        let overview = app.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview.waitForExistence(timeout: 8))
        attachScreenshot(named: "live-gateway-control")
        overview.tap()
        XCTAssertTrue(app.buttons["Back to Control"].waitForExistence(timeout: 8))
        attachScreenshot(named: "live-gateway-overview")
        XCTAssertEqual(app.state, .runningForeground)
    }

    private func launchApp(for target: ScreenshotTarget) {
        self.app?.terminate()

        let app = XCUIApplication()
        setupSnapshot(app, waitForAnimations: false)
        app.launchArguments += [
            "--openclaw-screenshot-mode",
            "--openclaw-initial-tab",
            target.initialTab,
            "--openclaw-initial-destination",
            target.initialDestination,
            "--openclaw-sidebar-visibility",
            "hidden",
        ]
        app.launch()
        self.app = app

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
    }

    private func attachScreenshot(named name: String) {
        guard let app = app else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
