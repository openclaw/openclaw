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
        self.app?.terminate()
        self.app = nil
        try super.tearDownWithError()
    }

    func testConnectedGatewayTabs() {
        for target in Self.screenshotTargets {
            self.launchApp(for: target)
            snapshot(target.name, timeWaitingForIdle: 5)
            self.attachScreenshot(named: target.name)
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

        XCTAssertTrue(self.app?.navigationBars.buttons["Control"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Gateway settings"].waitForExistence(timeout: 5) == true)
        XCTAssertEqual(self.app?.state, .runningForeground)
    }

    func testSettingsBackReturnsToOriginatingPhoneTab() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone settings navigation only")

        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-settings-back"))

        let gatewaySettings = try XCTUnwrap(self.app?.buttons["chat-gateway-status"])
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 8))
        gatewaySettings.tap()
        let gatewayNavigationBar = try XCTUnwrap(self.app?.navigationBars["Gateway"])
        XCTAssertTrue(gatewayNavigationBar.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Chat"].isSelected == true)
        self.attachScreenshot(named: "chat-gateway-origin-stack")

        gatewayNavigationBar.buttons["BackButton"].tap()
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Chat"].isSelected == true)
        self.attachScreenshot(named: "chat-after-settings-back")

        self.launchApp(for: ScreenshotTarget(
            initialTab: "talk",
            initialDestination: "talk",
            name: "talk-settings-back"))

        let voiceSettings = try XCTUnwrap(self.app?.buttons["talk-voice-settings-control"])
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 8))
        voiceSettings.tap()
        let voiceNavigationBar = try XCTUnwrap(self.app?.navigationBars["Voice & Talk"])
        XCTAssertTrue(voiceNavigationBar.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Talk"].isSelected == true)

        voiceNavigationBar.buttons["BackButton"].tap()
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.tabBars.buttons["Talk"].isSelected == true)
    }

    func testChatComposerStartsCompactAndGrowsWithDraft() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone composer proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-growth"))

        let textField = try XCTUnwrap(app?.textFields["chat-message-input"])
        XCTAssertTrue(textField.waitForExistence(timeout: 8))
        let talkButton = try XCTUnwrap(app?.buttons["chat-realtime-control"])
        XCTAssertTrue(talkButton.waitForExistence(timeout: 5))
        let attachmentButton = try XCTUnwrap(app?.buttons["chat-attachment-picker"])
        XCTAssertTrue(attachmentButton.waitForExistence(timeout: 5))
        let composerSurface = try XCTUnwrap(app?.otherElements["chat-composer-surface"])
        XCTAssertTrue(composerSurface.waitForExistence(timeout: 5))
        let gatewayStatus = try XCTUnwrap(app?.buttons["chat-gateway-status"])
        XCTAssertTrue(gatewayStatus.waitForExistence(timeout: 5))
        let sendButton = try XCTUnwrap(app?.buttons["chat-send-message"])
        XCTAssertTrue(sendButton.waitForExistence(timeout: 5))
        XCTAssertTrue(composerSurface.frame.contains(attachmentButton.frame))
        XCTAssertTrue(composerSurface.frame.contains(talkButton.frame))
        XCTAssertGreaterThanOrEqual(attachmentButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(attachmentButton.frame.height, 44)
        XCTAssertGreaterThanOrEqual(talkButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(talkButton.frame.height, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.width, 44)
        XCTAssertGreaterThanOrEqual(sendButton.frame.height, 44)
        let compactHeight = textField.frame.height
        XCTAssertLessThanOrEqual(compactHeight, 44)
        XCTAssertLessThanOrEqual(abs(talkButton.frame.midY - textField.frame.midY), 1)
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

    func testChatPresentationInLightAppearance() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-light"),
            appearance: "light")

        XCTAssertTrue(self.app?.buttons["chat-gateway-status"].waitForExistence(timeout: 8) == true)
        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].exists == true)
        self.attachScreenshot(named: "chat-light")
    }

    func testTalkUsesCompactIconControls() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Talk controls only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "talk",
            initialDestination: "talk",
            name: "talk-icon-controls"))

        let speakerphone = try XCTUnwrap(app?.buttons["talk-speakerphone-control"])
        let backgroundListening = try XCTUnwrap(app?.buttons["talk-background-listening-control"])
        let voiceSettings = try XCTUnwrap(app?.buttons["talk-voice-settings-control"])
        XCTAssertTrue(speakerphone.waitForExistence(timeout: 8))
        XCTAssertTrue(backgroundListening.exists)
        XCTAssertTrue(voiceSettings.exists)
        XCTAssertFalse(self.app?.switches["Speakerphone"].exists == true)
        XCTAssertFalse(self.app?.switches["Background listening"].exists == true)

        let originalValue = speakerphone.value as? String
        defer {
            if speakerphone.value as? String != originalValue {
                speakerphone.tap()
            }
        }
        if originalValue == "Off" {
            speakerphone.tap()
        }
        XCTAssertEqual(speakerphone.value as? String, "On")
        self.attachScreenshot(named: "talk-icon-controls")

        let initialValue = speakerphone.value as? String
        speakerphone.tap()
        XCTAssertNotEqual(speakerphone.value as? String, initialValue)
    }

    func testAppearanceUsesToolbarMenu() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Settings proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "appearance-compact"))

        let menu = try XCTUnwrap(app?.buttons["settings-appearance-menu"])
        XCTAssertTrue(menu.waitForExistence(timeout: 8))
        XCTAssertFalse(self.app?.segmentedControls["settings-appearance-picker"].exists == true)
        menu.tap()
        XCTAssertTrue(self.app?.buttons["System"].waitForExistence(timeout: 3) == true)
        XCTAssertTrue(self.app?.buttons["Light"].exists == true)
        XCTAssertTrue(self.app?.buttons["Dark"].exists == true)
        self.attachScreenshot(named: "appearance-menu")
    }

    func testAgentUsesToolbarFilter() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Agent proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "agent",
            initialDestination: "agents",
            name: "agent-toolbar-filter"))

        let menu = try XCTUnwrap(app?.buttons["agent-status-filter-menu"])
        XCTAssertTrue(menu.waitForExistence(timeout: 8))
        XCTAssertFalse(self.app?.segmentedControls["Agent status"].exists == true)
        menu.tap()
        XCTAssertTrue(self.app?.buttons["All"].waitForExistence(timeout: 3) == true)
        XCTAssertTrue(self.app?.buttons["Online"].exists == true)
        XCTAssertTrue(self.app?.buttons["Ready"].exists == true)
        self.attachScreenshot(named: "agent-toolbar-filter")
    }

    func testLiveGatewayChatRoundTripAndControlOverview() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        let app = try launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")

        let input = app.textFields["chat-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        let replyMarker = "OPENCLAW_E2E_OK_\(Int(Date().timeIntervalSince1970 * 1000))"
        input.tap()
        input.typeText("Reply exactly with \(replyMarker)")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertTrue(send.isEnabled)
        send.tap()

        XCTAssertTrue(app.staticTexts[replyMarker].waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["Writing"].waitForNonExistence(timeout: 5))
        self.attachScreenshot(named: "live-gateway-chat-round-trip")

        let controlApp = self.relaunchConnectedLiveGatewayApp(
            initialTab: "control",
            initialDestination: "control")
        let overview = controlApp.buttons.containing(.staticText, identifier: "Overview").firstMatch
        XCTAssertTrue(overview.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "live-gateway-control")
        overview.tap()
        XCTAssertTrue(controlApp.navigationBars.buttons["Control"].waitForExistence(timeout: 8))
        XCTAssertTrue(controlApp.buttons["Gateway settings"].waitForExistence(timeout: 5))
        self.attachScreenshot(named: "live-gateway-overview")
        XCTAssertEqual(controlApp.state, .runningForeground)
    }

    private func launchApp(for target: ScreenshotTarget, appearance: String? = "dark") {
        self.app?.terminate()

        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-screenshot-mode",
            "--openclaw-initial-tab",
            target.initialTab,
            "--openclaw-initial-destination",
            target.initialDestination,
            "--openclaw-sidebar-visibility",
            "hidden",
        ]
        if let appearance {
            app.launchArguments += ["--openclaw-appearance", appearance]
        }
        app.launch()
        self.app = app

        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
    }

    private func launchPairedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) throws -> XCUIApplication
    {
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
            initialTab,
            "--openclaw-initial-destination",
            initialDestination,
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
        return app
    }

    private func relaunchConnectedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) -> XCUIApplication
    {
        self.app?.terminate()
        let app = XCUIApplication()
        app.launchArguments += [
            "--openclaw-initial-tab",
            initialTab,
            "--openclaw-initial-destination",
            initialDestination,
        ]
        app.launch()
        self.app = app
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        return app
    }

    private func attachScreenshot(named name: String) {
        guard let app else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
