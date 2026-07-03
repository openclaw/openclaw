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

    func testVoiceWakeResumesAfterTalkModeToggle() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Settings proof only")
        self.addUIInterruptionMonitor(withDescription: "Microphone and speech permissions") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "voice-wake-talk-lifecycle"))

        let voiceSettings = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Voice & Talk").firstMatch)
        XCTAssertTrue(voiceSettings.waitForExistence(timeout: 8))
        voiceSettings.tap()

        let voiceWake = try XCTUnwrap(self.app?.switches["Voice Wake"])
        let talkMode = try XCTUnwrap(self.app?.switches["Talk Mode"])
        XCTAssertTrue(voiceWake.waitForExistence(timeout: 5))
        XCTAssertTrue(talkMode.exists)

        if talkMode.value as? String == "1" {
            talkMode.tap()
        }
        if voiceWake.value as? String == "1" {
            voiceWake.tap()
        }

        voiceWake.tap()
        XCTAssertEqual(voiceWake.value as? String, "1")
        talkMode.tap()
        XCTAssertEqual(talkMode.value as? String, "1")
        talkMode.tap()
        XCTAssertEqual(talkMode.value as? String, "0")
        XCTAssertEqual(voiceWake.value as? String, "1")
        XCTAssertEqual(self.app?.state, .runningForeground)
        self.attachScreenshot(named: "voice-wake-after-talk-resume")

        let voiceNavigationBar = try XCTUnwrap(self.app?.navigationBars["Voice & Talk"])
        voiceNavigationBar.buttons["BackButton"].tap()
        let diagnostics = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Diagnostics").firstMatch)
        XCTAssertTrue(diagnostics.waitForExistence(timeout: 5))
        diagnostics.tap()
        let voiceWakeStatus = try XCTUnwrap(
            self.app?.descendants(matching: .any)["diagnostics-voice-wake-status"])
        XCTAssertTrue(voiceWakeStatus.waitForExistence(timeout: 5))
        let resumed = expectation(
            for: NSPredicate(
                format: "value == %@",
                "Voice Wake isn’t supported on Simulator"),
            evaluatedWith: voiceWakeStatus)
        wait(for: [resumed], timeout: 5)

        let diagnosticsNavigationBar = try XCTUnwrap(self.app?.navigationBars["Diagnostics"])
        diagnosticsNavigationBar.buttons["BackButton"].tap()
        voiceSettings.tap()
        XCTAssertTrue(voiceWake.waitForExistence(timeout: 5))
        voiceWake.tap()
        XCTAssertEqual(voiceWake.value as? String, "0")
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
            "Draft a polished launch note that covers the new design, validation, rollout plan, " +
                "and follow-up details for the team.")
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

    func testAppearanceUsesSettingsRow() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Settings proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "appearance-compact"), appearance: nil)

        let row = try XCTUnwrap(self.app?.buttons["settings-appearance-row"])
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        XCTAssertFalse(self.app?.buttons["settings-appearance-menu"].exists == true)
        XCTAssertFalse(self.app?.segmentedControls["settings-appearance-picker"].exists == true)

        row.tap()
        XCTAssertTrue(self.app?.buttons["System"].waitForExistence(timeout: 3) == true)
        XCTAssertTrue(self.app?.buttons["Light"].exists == true)
        XCTAssertTrue(self.app?.buttons["Dark"].exists == true)
        self.app?.buttons["System"].firstMatch.tap()
        self.waitForValue("System", of: row)
        self.attachScreenshot(named: "appearance-system")

        row.tap()
        XCTAssertTrue(self.app?.buttons["Dark"].waitForExistence(timeout: 3) == true)
        self.app?.buttons["Dark"].firstMatch.tap()
        self.waitForValue("Dark", of: row)
        self.attachScreenshot(named: "appearance-dark")

        row.tap()
        XCTAssertTrue(self.app?.buttons["System"].waitForExistence(timeout: 3) == true)
        self.app?.buttons["System"].firstMatch.tap()
        self.waitForValue("System", of: row)
    }

    func testChatReturnsToOriginatingControlDetail() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Control proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "activity",
            name: "control-chat-return"))

        let chatTab = try XCTUnwrap(self.app?.tabBars.buttons["Chat"])
        let controlTab = try XCTUnwrap(self.app?.tabBars.buttons["Control"])

        // Retain an embedded Chat Settings route, then prove contextual routing pops it.
        chatTab.tap()
        let gatewaySettings = try XCTUnwrap(self.app?.buttons["chat-gateway-status"])
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 5))
        gatewaySettings.tap()
        XCTAssertTrue(self.app?.navigationBars["Gateway"].waitForExistence(timeout: 5) == true)

        controlTab.tap()
        XCTAssertTrue(self.app?.navigationBars["Control"].waitForExistence(timeout: 8) == true)
        let activity = try XCTUnwrap(self.app?.buttons["Activity"])
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        activity.tap()

        let recentActivity = try XCTUnwrap(self.app?.staticTexts["Recent activity"])
        XCTAssertTrue(recentActivity.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "control-activity-before-chat")

        let activityChat = try self.controlDetailChatButton(above: chatTab)
        activityChat.tap()
        XCTAssertTrue(chatTab.isSelected)

        let returnButton = try XCTUnwrap(self.app?.buttons["OpenClawChatBackToControlDetailButton"])
        XCTAssertTrue(returnButton.waitForExistence(timeout: 5))
        XCTAssertEqual(returnButton.label, "Back to Activity")
        self.attachScreenshot(named: "chat-return-to-activity")

        returnButton.tap()
        XCTAssertTrue(recentActivity.waitForExistence(timeout: 8))
        XCTAssertTrue(controlTab.isSelected)
        self.attachScreenshot(named: "control-activity-after-chat")

        try self.controlDetailChatButton(above: chatTab).tap()
        XCTAssertTrue(chatTab.isSelected)
        controlTab.tap()
        XCTAssertTrue(self.app?.navigationBars["Control"].waitForExistence(timeout: 8) == true)
        let overview = try XCTUnwrap(self.app?.buttons["Overview"])
        XCTAssertTrue(overview.exists)
        self.attachScreenshot(named: "control-tab-returns-to-root")

        overview.tap()
        XCTAssertTrue(self.app?.staticTexts["Agent session"].waitForExistence(timeout: 8) == true)
        let agentSession = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Molty").firstMatch)
        XCTAssertTrue(agentSession.waitForExistence(timeout: 8))
        agentSession.tap()

        XCTAssertTrue(returnButton.waitForExistence(timeout: 8))
        XCTAssertEqual(returnButton.label, "Back to Overview")
        self.attachScreenshot(named: "chat-session-return-to-overview")
        returnButton.tap()
        XCTAssertTrue(self.app?.navigationBars["Overview"].waitForExistence(timeout: 8) == true)
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

        // Build scrollable history through the paired app before checking reader behavior.
        for index in 0..<3 {
            let seedMarker = "OPENCLAW_E2E_SEED_\(index)_\(Int(Date().timeIntervalSince1970 * 1000))"
            let seedContext = String(repeating: "Reader context \(index). ", count: 6)
            self.sendLiveGatewayMessage(
                "\(seedContext)Reply exactly with \(seedMarker) and no other text.",
                expecting: seedMarker,
                in: app)
        }

        let replyMarker = "OPENCLAW_E2E_OK_\(Int(Date().timeIntervalSince1970 * 1000))"
        self.sendLiveGatewayMessage(
            "Reply exactly with \(replyMarker) and no other text.",
            expecting: replyMarker,
            in: app)
        let jumpToLatest = app.buttons["Jump to latest reply"]
        XCTAssertTrue(jumpToLatest.waitForExistence(timeout: 3))
        self.attachScreenshot(named: "live-gateway-chat-reply-anchored")

        jumpToLatest.tap()
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))
        XCTAssertTrue(app.staticTexts[replyMarker].exists)
        Thread.sleep(forTimeInterval: 0.5)
        self.attachScreenshot(named: "live-gateway-chat-jumped-to-latest")

        let transcript = app.scrollViews.firstMatch
        XCTAssertTrue(transcript.exists)
        transcript.swipeDown()
        XCTAssertTrue(jumpToLatest.waitForExistence(timeout: 3))
        self.attachScreenshot(named: "live-gateway-chat-manual-departure")
        jumpToLatest.tap()
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))

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

    func testManualAuthRetryUsesEditedToken() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_RETRY_E2E"] == "1",
            "Set OPENCLAW_IOS_RETRY_E2E=1 with a local token-auth Gateway on port 18920")
        let token = try XCTUnwrap(ProcessInfo.processInfo.environment["OPENCLAW_IOS_RETRY_TOKEN"])

        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += ["--openclaw-reset-onboarding"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Set Up Manually"].waitForExistence(timeout: 8))
        app.buttons["Set Up Manually"].tap()
        let developerMode = app.buttons["Developer mode"]
        if developerMode.value as? String != "On" {
            developerMode.tap()
        }
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Same Machine (Dev)")).firstMatch.tap()
        app.buttons["Continue"].tap()

        let port = app.textFields["Port"]
        XCTAssertTrue(port.waitForExistence(timeout: 5))
        port.tap()
        port.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: 5) + "18920")
        app.buttons["Connect"].tap()

        let tokenField = app.secureTextFields["Gateway Auth Token"]
        XCTAssertTrue(tokenField.waitForExistence(timeout: 20))
        tokenField.tap()
        tokenField.typeText(token)
        app.buttons["Done"].tap()
        app.buttons["Retry Connection"].tap()

        XCTAssertTrue(app.staticTexts["Connected"].waitForExistence(timeout: 30))
        self.attachScreenshot(named: "manual-auth-retry-connected")
    }

    func testPhotosLimitedAccess() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_PHOTOS_E2E"] == "1",
            "Set OPENCLAW_IOS_PHOTOS_E2E=1 to exercise the system Photos prompt")
        addUIInterruptionMonitor(withDescription: "Photos access") { alert in
            for title in ["Limit Access…", "Select Photos…"] where alert.buttons[title].exists {
                alert.buttons[title].tap()
                return true
            }
            return false
        }
        self.launchApp(for: ScreenshotTarget(
            initialTab: "settings",
            initialDestination: "settings",
            name: "photos-limited-access"))

        let permissions = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Permissions").firstMatch)
        XCTAssertTrue(permissions.waitForExistence(timeout: 8))
        permissions.tap()

        let privacy = try XCTUnwrap(
            self.app?.buttons.containing(.staticText, identifier: "Privacy & Access").firstMatch)
        XCTAssertTrue(privacy.waitForExistence(timeout: 8))
        privacy.tap()

        let request = try XCTUnwrap(self.app?.buttons["privacy-access-Photos-action"])
        XCTAssertTrue(request.waitForExistence(timeout: 5))
        request.tap()
        self.app?.tap()

        // The limited picker is an out-of-process system surface without stable accessibility identifiers.
        // Normalized taps are confined to this opt-in simulator test; app-owned state proves completion below.
        let screen = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.17, dy: 0.43)).tap()
        screen.coordinate(withNormalizedOffset: CGVector(dx: 0.90, dy: 0.16)).tap()

        self.app?.activate()
        let limitedStatus = try XCTUnwrap(self.app?.staticTexts.matching(
            NSPredicate(
                format: "identifier == %@ AND label == %@",
                "privacy-access-Photos-status",
                "Limited")).firstMatch)
        XCTAssertTrue(limitedStatus.waitForExistence(timeout: 8))
        XCTAssertEqual(self.app?.buttons["privacy-access-Photos-action"].label, "Manage Access")
        self.attachScreenshot(named: "photos-limited-access")
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

    private func waitForValue(_ value: String, of element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value),
            object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 3), .completed)
    }

    private func controlDetailChatButton(above chatTab: XCUIElement) throws -> XCUIElement {
        let buttons = try XCTUnwrap(self.app?.buttons.matching(NSPredicate(format: "label == 'Chat'")))
        return try XCTUnwrap(buttons.allElementsBoundByIndex.first { $0.frame.maxY < chatTab.frame.minY })
    }

    private func launchPairedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) throws -> XCUIApplication
    {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Set OPENCLAW_IOS_LIVE_GATEWAY=1 and provide a fresh setup code")

        if let setupCode = ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_SETUP_CODE"] {
            UIPasteboard.general.string = setupCode
        }

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

    private func sendLiveGatewayMessage(
        _ text: String,
        expecting replyMarker: String,
        in app: XCUIApplication)
    {
        let input = app.textFields["chat-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText(text)

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertTrue(send.isEnabled)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        send.tap()

        XCTAssertTrue(app.staticTexts[replyMarker].waitForExistence(timeout: 60))
        XCTAssertTrue(app.staticTexts["Writing"].waitForNonExistence(timeout: 5))
    }

    private func attachScreenshot(named name: String) {
        guard let app else { return }
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }
}
