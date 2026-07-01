import UIKit
import XCTest

@MainActor
final class OpenClawSnapshotUITests: XCTestCase {
    private enum ScreenshotAppearance: String, CaseIterable {
        case light
        case dark
    }

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
        self.app?.terminate()
        self.app = nil
        try super.tearDownWithError()
    }

    func testConnectedGatewayTabs() {
        for appearance in ScreenshotAppearance.allCases {
            for target in Self.screenshotTargets {
                self.launchApp(for: target, appearance: appearance)
                let name = appearance == .light ? target.name : "\(target.name)-dark"
                snapshot(name, timeWaitingForIdle: 5)
            }
        }
    }

    func testControlOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone control hub only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "control",
            name: "control-overview-navigation"))

        let overview = self.app?.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview?.waitForExistence(timeout: 5) == true)
        overview?.tap()

        XCTAssertTrue(self.app?.buttons["Back to Control"].waitForExistence(timeout: 5) == true)
        XCTAssertEqual(self.app?.state, .runningForeground)
    }

    func testChatComposerStartsCompactAndGrowsWithDraft() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone composer proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-growth"))

        let textField = try XCTUnwrap(app?.textFields.firstMatch)
        XCTAssertTrue(textField.waitForExistence(timeout: 8))
        let compactHeight = textField.frame.height
        XCTAssertLessThanOrEqual(compactHeight, 44)
        self.attachScreenshot(named: "chat-composer-compact")

        textField.tap()
        textField.typeText(
            "Draft a polished launch note that covers the new design, validation, rollout plan, and follow-up details for the team.")
        let composerGrew = expectation(
            for: NSPredicate { _, _ in textField.frame.height >= compactHeight + 12 },
            evaluatedWith: textField)
        wait(for: [composerGrew], timeout: 4)
        self.attachScreenshot(named: "chat-composer-expanded")

        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(self.app?.keyboards.firstMatch.waitForNonExistence(timeout: 3) == true)
    }

    func testLiveGatewayControlOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone control hub only")
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Set OPENCLAW_IOS_LIVE_GATEWAY=1 and copy a fresh setup code to the simulator pasteboard")

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
        self.attachScreenshot(named: "live-gateway-control")
        overview.tap()
        XCTAssertTrue(app.buttons["Back to Control"].waitForExistence(timeout: 8))
        self.attachScreenshot(named: "live-gateway-overview")
        XCTAssertEqual(app.state, .runningForeground)
    }

    private func launchApp(
        for target: ScreenshotTarget,
        appearance: ScreenshotAppearance = .light)
    {
        self.app?.terminate()

        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-screenshot-mode",
            "--openclaw-appearance",
            appearance.rawValue,
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
        guard let app else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
