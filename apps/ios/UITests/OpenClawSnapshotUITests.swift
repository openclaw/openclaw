import UIKit
import Vision
import XCTest

@MainActor
final class OpenClawSnapshotUITests: XCTestCase {
    struct ScreenshotTarget {
        let initialTab: String
        let initialDestination: String
        let name: String
    }

    private static let controlScreenshotTarget = ScreenshotTarget(
        initialTab: "control",
        initialDestination: "overview",
        name: "01-control-connected")
    static let chatScreenshotTarget = ScreenshotTarget(
        initialTab: "chat",
        initialDestination: "chat",
        name: "02-chat-connected")
    private static let agentScreenshotTarget = ScreenshotTarget(
        initialTab: "agent",
        initialDestination: "agents",
        name: "03-agent-connected")
    private static let settingsScreenshotTarget = ScreenshotTarget(
        initialTab: "settings",
        initialDestination: "gateway",
        name: "04-settings-connected")
    private static let settingsFallbackTarget = ScreenshotTarget(
        initialTab: "settings",
        initialDestination: "settings",
        name: "settings-fallback")
    static let appReadinessAccessibilityIdentifier = "RootTabs.Ready"

    var app: XCUIApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        self.terminateCurrentApp()
        try super.tearDownWithError()
    }

    func testReleaseControlScreenshot() {
        self.captureReleaseScreenshot(Self.controlScreenshotTarget)
    }

    func testTaskListProgressTagRendersAsBar() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-progress-bar-fixture"])
        let app = try XCTUnwrap(self.app)
        let card = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Plan, ")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "progress-card-collapsed")
        card.tap()
        let hasBar = app.progressIndicators.firstMatch.waitForExistence(timeout: 5)
        self.attachScreenshot(named: "progress-card-expanded")
        XCTAssertTrue(hasBar, "Task list has no progress bar")
        XCTAssertTrue(app.staticTexts["Now: reading the sample diff."].exists)
        let rawTag = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "<progress"))
        XCTAssertEqual(rawTag.count, 0, "Task list still displays a raw progress tag")
        XCTAssertEqual(card.label, "Plan, Now: reading the sample diff.")
    }

    func testStreamedReplyIsNotDuplicatedWithSavedRow() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-empty-chat-fixture", "--openclaw-dup-filter-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        let prompt = "Show the fixture reply."
        input.typeText(prompt)
        XCTAssertEqual(input.value as? String, prompt, "Fixture prompt was not entered")
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5), "Fixture Send button is missing")
        XCTAssertTrue(send.isEnabled, "Fixture Send button is disabled")
        send.tap()
        let userRow = app.staticTexts[prompt]
        XCTAssertTrue(userRow.waitForExistence(timeout: 5), "The explicit fixture send was not accepted")
        // Only dismiss after sending: the empty-chat starter buttons also send on tap.
        app.scrollViews["chat-transcript"].coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.05)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3), "Fixture keyboard stayed open")

        // This tool row is emitted after both sources, not after deduplication succeeds.
        let receipt = app.descendants(matching: .any).matching(NSPredicate(
            format: "value CONTAINS %@", "dup-filter-inputs-received")).firstMatch
        XCTAssertTrue(receipt.waitForExistence(timeout: 8), "FIFO receipt did not arrive after both reply sources")
        let copies = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", "The cobalt lighthouse is ready."))
        XCTAssertTrue(copies.firstMatch.waitForExistence(timeout: 5), "Fixture reply marker is missing")
        let retry = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Retrying… 2/3")).firstMatch
        XCTAssertTrue(retry.waitForExistence(timeout: 5), "Fixture retry status is missing")
        self.attachScreenshot(named: "dup-filter-streaming")
        // The indicator groups accessibility under its phase; inspect its actual pixels for telemetry.
        let image = try XCTUnwrap(retry.screenshot().image.cgImage)
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        recognition.recognitionLanguages = ["en-US"]
        try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition])
        let text = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
            .joined(separator: " ").lowercased()
        XCTAssertTrue(
            text.contains("485 tokens"),
            "RETRY_TOKENS_MISSING: retry hides cumulative output tokens: \(text)")
        XCTAssertEqual(copies.count, 1, "Saved and streaming reply render duplicate copies")

        let stop = app.buttons["Stop response"]
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        self.waitForEnabled(stop)
        stop.tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 8))
        self.attachScreenshot(named: "dup-filter-settled")
        XCTAssertEqual(copies.count, 1, "The saved reply must remain after stopping the run")
    }

    func testReleaseChatScreenshot() {
        self.captureReleaseScreenshot(Self.chatScreenshotTarget) { app in
            let input = self.chatMessageInput(in: app)
            XCTAssertTrue(input.waitForExistence(timeout: 8))
            input.tap()
            let keyboard = app.keyboards.firstMatch
            if UIDevice.current.userInterfaceIdiom == .phone {
                XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
            }
            let focusProbe = "focus"
            input.typeText(focusProbe)
            XCTAssertEqual(input.value as? String, focusProbe)
            self.clearTextField(input)
            XCTAssertEqual(input.value as? String, "")
            // Dismiss through the transcript gutter, not a diagram that opens its preview on tap.
            let gutterPoint = app.scrollViews["chat-transcript"]
                .coordinate(withNormalizedOffset: CGVector(dx: 0.99, dy: 0.05)).screenPoint
            // The layout stays stationary until this tap. Avoid resolving the transcript during synthesis.
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let originPoint = origin.screenPoint
            origin.withOffset(CGVector(
                dx: gutterPoint.x - originPoint.x,
                dy: gutterPoint.y - originPoint.y)).tap()
            if keyboard.exists {
                XCTAssertTrue(keyboard.waitForNonExistence(timeout: 3))
            }
            XCTAssertFalse(app.buttons["Close diagram preview"].exists)
            let diagram = app.buttons["Mermaid diagram"]
            XCTAssertTrue(diagram.waitForExistence(timeout: 8))
            XCTAssertTrue(diagram.isHittable)
        }
    }

    func testExternalRunShowsStatusAndToolsBeforeReplyText() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-external-run-fixture"])
        let app = try XCTUnwrap(self.app)
        let waiting = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Waiting for a response…")).firstMatch
        let showsWaiting = waiting.waitForExistence(timeout: 15)
        self.attachScreenshot(named: "external-run-before-reply-status")
        XCTAssertTrue(showsWaiting, "EXTERNAL_RUN_STATUS_MISSING: another client's run shows no startup status")
        XCTAssertTrue(app.buttons["Stop response"].exists)
        let tool = app.descendants(matching: .any)
            .matching(NSPredicate(format: "value CONTAINS %@", "external-fixture.txt")).firstMatch
        XCTAssertTrue(tool.waitForExistence(timeout: 15), "EXTERNAL_RUN_TOOL_MISSING")
        self.attachScreenshot(named: "external-run-before-reply-tool")
    }

    func testStartupStatusShowsWaitingForResponse() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-hold-initial-chat-run", "--openclaw-startup-status-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Check the project.")
        app.buttons["chat-send-message"].tap()
        XCTAssertTrue(app.buttons["Stop response"].waitForExistence(timeout: 8))
        let waiting = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Waiting for a response…")).firstMatch
        let showsWaiting = waiting.waitForExistence(timeout: 5)
        self.attachScreenshot(named: "startup-status-waiting")
        XCTAssertTrue(showsWaiting, "STARTUP_STATUS_MISSING: waiting run has no Gateway startup label")
        let stop = app.buttons["Stop response"]
        self.waitForEnabled(stop)
        stop.tap()
        XCTAssertTrue(waiting.waitForNonExistence(timeout: 5))
    }

    func testFinishedTurnShowsWaitingHelperAndOpensItsSession() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-subagent-wait-fixture"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.otherElements["chat-composer-surface"].waitForExistence(timeout: 8))
        let waiting = app.staticTexts["Waiting on subagents"]
        let isWaiting = waiting.waitForExistence(timeout: 5)
        self.attachScreenshot(named: "subagent-wait-parent")
        XCTAssertTrue(isWaiting, "Finished turn has no Waiting on subagents line")
        let child = app.buttons["chat-subagent-wait-child"]
        XCTAssertTrue(child.exists)
        XCTAssertEqual(child.label, "Project helper")
        child.tap()
        XCTAssertTrue(waiting.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["OPENCLAW_HELPER_SESSION"].waitForExistence(timeout: 5))
        self.attachScreenshot(named: "subagent-wait-child")
    }

    func testAssistantRepliesNameTheSpeakerWhenTheAvatarIsHidden() throws {
        self.launchApp(for: Self.chatScreenshotTarget)
        let app = try XCTUnwrap(self.app)
        let reply = app.descendants(matching: .any)["chat-assistant-message-body"].firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 8))
        let run = app.descendants(matching: .any)["chat-assistant-run"].firstMatch
        let named = run.exists ? run : reply
        let avatar = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label == %@", "Molty avatar")).firstMatch
        if UIDevice.current.userInterfaceIdiom == .phone {
            XCTAssertFalse(avatar.exists, "A compact width shows no avatar beside a reply")
        }
        // The reply names the assistant exactly where no avatar does.
        XCTAssertEqual(named.label, avatar.exists ? "" : "Molty")
    }

    func testReleaseAgentScreenshot() {
        self.captureReleaseScreenshot(Self.agentScreenshotTarget)
    }

    func testReleaseSettingsScreenshot() {
        self.captureReleaseScreenshot(Self.settingsScreenshotTarget) { app in
            // The connected fixture must not also render the first-run pairing hero.
            XCTAssertTrue(app.buttons["Reconnect"].waitForExistence(timeout: 5))
            XCTAssertFalse(app.buttons["Scan QR to Pair"].exists)
        }
        guard let app = self.app else { return }
        // After capture: the fixture never loads the saved manual Gateway, so controls that would
        // act on its route or credentials stay hidden down to the last row of the screen.
        let savedGatewayControls = [
            app.textFields["Host"],
            app.buttons["Connect Manual"],
            app.secureTextFields["Gateway Auth Token"],
            app.secureTextFields["Gateway Password"],
        ]
        let resetOnboarding = app.buttons["Reset Onboarding"]
        for _ in 0..<8 {
            for control in savedGatewayControls {
                XCTAssertFalse(control.exists)
            }
            if resetOnboarding.isHittable { break }
            app.swipeUp()
        }
        XCTAssertTrue(resetOnboarding.isHittable)
    }

    func testWatchMessageDeliveryIsReachableFromSettings() throws {
        self.launchApp(for: Self.settingsFallbackTarget)
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.descendants(matching: .any)["SettingsHub.Fallback"].waitForExistence(timeout: 8))
        let watch = app.buttons["settings-watch-row"]
        for _ in 0..<12 where !watch.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(watch.isHittable)
        watch.tap()
        let delivery = app.buttons.containing(.staticText, identifier: "Message Delivery").firstMatch
        XCTAssertTrue(delivery.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "watch-delivery-settings")
        XCTAssertTrue(app.buttons["Connect Apple Watch"].exists)
        XCTAssertFalse(app.buttons["Enable Standalone Voice"].exists)
        XCTAssertFalse(app.buttons["Enable Direct Gateway Connection"].exists)
        delivery.tap()
        XCTAssertTrue(app.navigationBars["Message Delivery"].waitForExistence(timeout: 8))
        let loaded = app.descendants(matching: .any).matching(NSPredicate(
            format: "label == %@ OR label == %@", "No saved Watch messages", "Discard…")).firstMatch
        XCTAssertTrue(loaded.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "watch-message-delivery")
    }

    func testAgentsNavigateToSettingsThroughSidebar() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar navigation only")
        self.launchApp(for: Self.agentScreenshotTarget)

        XCTAssertTrue(self.app?.buttons["agent-status-filter-menu"].waitForExistence(timeout: 8) == true)
        try self.selectSidebarDestination("Settings")
        XCTAssertTrue(
            self.app?.descendants(matching: .any)["SettingsHub.Fallback"]
                .waitForExistence(timeout: 8) == true)
    }

    func testOnboardingExplainsCapabilitiesAndTrust() {
        let app = XCUIApplication()
        app.launchArguments += ["--openclaw-reset-onboarding", "-AppleLanguages", "(en)", "-AppleLocale", "en_US"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        self.attachScreenshot(named: "onboarding-capabilities-and-trust")
        let device = UIDevice.current.userInterfaceIdiom == .pad ? "iPad" : "iPhone"
        XCTAssertTrue(app.staticTexts[
            "Your agent, in your pocket. Pair this \(device) with your gateway to get started.",
        ].exists)
        let setupInstruction = app.descendants(matching: .any).matching(NSPredicate(
            format: "label CONTAINS %@", "Pair this \(device) by scanning a setup code")).firstMatch
        XCTAssertTrue(setupInstruction.exists)
        XCTAssertTrue(app.staticTexts["Security notice"].exists)
        let disclosure = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS[c] 'camera' AND label CONTAINS[c] 'trust the gateway and agent'")).firstMatch
        XCTAssertTrue(disclosure.exists)
    }

    func testSidebarOverviewNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "overview",
            name: "control-overview-navigation"))

        XCTAssertTrue(self.app?.staticTexts["Agent session"].waitForExistence(timeout: 8) == true)
        try self.selectSidebarDestination("Overview")

        XCTAssertTrue(self.app?.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Gateway settings"].waitForExistence(timeout: 5) == true)
        XCTAssertEqual(self.app?.state, .runningForeground)
    }

    func testLiveGatewayApprovalNotificationsFromOverview() async throws {
        try await self.verifyApprovalNotificationsNavigation(fromOverview: true)
    }

    func testLiveGatewayApprovalNotificationsFromSettings() async throws {
        try await self.verifyApprovalNotificationsNavigation(fromOverview: false)
    }

    func testTabletSidebarRootsRenderWithPersistentSidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Tablet split navigation only")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        for target in [
            Self.controlScreenshotTarget,
            Self.chatScreenshotTarget,
            Self.agentScreenshotTarget,
            Self.settingsFallbackTarget,
        ] {
            self.launchApp(for: target)
            let app = try XCTUnwrap(self.app)
            XCTAssertGreaterThan(app.frame.width, app.frame.height)
            XCTAssertTrue(self.destinationAnchor(in: app, destination: target.initialDestination).exists)
            self.tapSidebarReveal(in: app)
            let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
            XCTAssertTrue(hideSidebar.waitForExistence(timeout: 5))
            self.attachScreenshot(named: "tablet-split-\(target.initialDestination)")
            hideSidebar.tap()
            XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5))
        }
    }

    func testSidebarAgentSelectorShowsAllAgentsAndKeepsFooterVisible() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "sidebar-agent-selector"))

        let showSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Show"])
        XCTAssertTrue(showSidebar.waitForExistence(timeout: 8))
        showSidebar.tap()

        let agentSelector = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.AgentSelector"])
        XCTAssertTrue(agentSelector.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(agentSelector.frame.height, 44)
        XCTAssertEqual(agentSelector.value as? String, "Molty")

        let newChat = try XCTUnwrap(self.app?.buttons["New Chat"])
        XCTAssertTrue(newChat.exists)
        XCTAssertGreaterThanOrEqual(newChat.frame.height, 44)
        XCTAssertGreaterThan(newChat.frame.minY, agentSelector.frame.maxY)

        let gatewayFooter = try XCTUnwrap(self.app?.buttons.matching(
            NSPredicate(format: "label CONTAINS %@", "OpenClaw Gateway")).firstMatch)
        XCTAssertTrue(gatewayFooter.exists)
        let settings = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Destination.settings"])
        XCTAssertTrue(settings.exists)
        XCTAssertGreaterThan(settings.frame.midX, gatewayFooter.frame.midX)
        XCTAssertEqual(settings.frame.midY, gatewayFooter.frame.midY, accuracy: 2)
        self.attachScreenshot(named: "sidebar-agent-selector")

        agentSelector.tap()

        XCTAssertTrue(self.app?.buttons["Molty"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Research"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Automation"].exists == true)
        self.attachScreenshot(named: "sidebar-agent-selector-open")

        self.app?.buttons["Research"].tap()
        XCTAssertEqual(agentSelector.value as? String, "Research")
        agentSelector.tap()
        XCTAssertTrue(self.app?.buttons["Molty"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["Research"].exists == true)
        XCTAssertTrue(self.app?.buttons["Automation"].exists == true)
    }

    func testSidebarSlowEdgeDragOpensFromEveryRootDestination() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        let destinations = [
            "chat", "overview", "activity", "agents", "workboard", "skillWorkshop",
            "instances", "sessions", "files", "dreaming", "usage", "cron", "terminal",
            "docs", "settings", "gateway",
        ]
        var testedDestinations: [String] = []

        for destination in destinations {
            self.launchApp(for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: destination,
                name: "sidebar-slow-edge-drag-\(destination)"))

            let showSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Show"])
            XCTAssertTrue(showSidebar.waitForExistence(timeout: 8), destination)
            XCTAssertTrue(showSidebar.isHittable, destination)
            if destination == "overview" {
                showSidebar.tap()
                let hideSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Hide"])
                self.waitForHittable(true, of: hideSidebar)
                hideSidebar.tap()
                self.waitForHittable(true, of: showSidebar)
            }
            try self.openSidebarWithSlowEdgeDrag()
            if destination == "overview" {
                self.attachScreenshot(named: "sidebar-slow-edge-drag-overview")
            }
            try self.closeSidebarWithSlowDrag()
            testedDestinations.append(destination)
        }
        XCTAssertEqual(testedDestinations, destinations)
    }

    func testSidebarEdgeDragPreservesPushedScreenBackGesture() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "settings",
                initialDestination: "settings",
                name: "sidebar-pushed-screen-back-gesture"),
            appearance: nil,
            screenshotMode: false)

        if self.app?.buttons["Close"].waitForExistence(timeout: 2) == true {
            self.app?.buttons["Close"].tap()
        }
        // A clean normal-state launch can auto-route to Gateway setup.
        try self.selectSidebarDestination("Settings")
        let app = try XCTUnwrap(self.app)
        let licenses = app.buttons["settings-licenses-row"]
        for _ in 0..<12 where !licenses.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(licenses.isHittable)
        licenses.tap()
        XCTAssertTrue(self.app?.navigationBars["Licenses"].waitForExistence(timeout: 5) == true)

        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.78, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.1)
        self.attachScreenshot(named: "sidebar-pushed-screen-after-back-swipe")

        self.waitForHittable(false, of: app.buttons["RootTabs.Sidebar.Hide"])
        self.waitForHittable(true, of: licenses)
        XCTAssertFalse(app.navigationBars["Licenses"].exists)
    }

    func testGatewaySettingsOpenedFromChatUsesRootSidebarNavigation() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar navigation only")

        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-settings-back"))

        try self.openChatGatewaySettings()
        let gatewayNavigationBar = try XCTUnwrap(self.app?.navigationBars["Gateway"])
        XCTAssertTrue(gatewayNavigationBar.waitForExistence(timeout: 5))
        XCTAssertTrue(self.app?.buttons["RootTabs.Sidebar.Show"].exists == true)
        XCTAssertFalse(gatewayNavigationBar.buttons["BackButton"].exists)
        self.attachScreenshot(named: "chat-gateway-root")

        let showSidebar = try XCTUnwrap(self.app?.buttons["RootTabs.Sidebar.Show"])
        showSidebar.tap()
        let settings = try XCTUnwrap(self.app?.buttons["Settings"])
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        settings.tap()

        XCTAssertTrue(self.app?.navigationBars["Settings"].waitForExistence(timeout: 5) == true)
        XCTAssertTrue(self.app?.buttons["RootTabs.Sidebar.Show"].exists == true)
        self.attachScreenshot(named: "gateway-to-settings-via-sidebar")
    }

    func testChatComposerStartsCompactAndGrowsWithDraft() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone composer proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-growth"))

        let app = try XCTUnwrap(self.app)
        let textField = self.chatMessageInput(in: app)
        XCTAssertTrue(textField.waitForExistence(timeout: 8))
        let talkButton = app.buttons["chat-realtime-control"]
        XCTAssertTrue(talkButton.waitForExistence(timeout: 5))
        let attachmentButton = app.buttons["chat-attachment-picker"]
        XCTAssertTrue(attachmentButton.waitForExistence(timeout: 5))
        let dictationButton = app.buttons["chat-dictation-control"]
        XCTAssertTrue(dictationButton.waitForExistence(timeout: 5))
        let composerSurface = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(composerSurface.waitForExistence(timeout: 5))
        let agentIdentity = self.agentIdentity(in: app)
        XCTAssertTrue(agentIdentity.waitForExistence(timeout: 5))
        XCTAssertEqual(agentIdentity.value as? String, "Collapsed")
        agentIdentity.tap()
        self.waitForValue("Expanded", of: agentIdentity)
        let sendButton = app.buttons["chat-send-message"]
        XCTAssertFalse(sendButton.exists)
        XCTAssertLessThanOrEqual(agentIdentity.frame.maxY, composerSurface.frame.minY)
        XCTAssertGreaterThanOrEqual(attachmentButton.frame.minX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(attachmentButton.frame.maxX, composerSurface.frame.maxX)
        XCTAssertGreaterThanOrEqual(dictationButton.frame.minX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(dictationButton.frame.maxX, composerSurface.frame.maxX)
        XCTAssertGreaterThanOrEqual(talkButton.frame.minX, composerSurface.frame.minX)
        XCTAssertLessThanOrEqual(talkButton.frame.maxX, composerSurface.frame.maxX)
        self.assertMinimumTouchTarget(attachmentButton)
        self.assertMinimumTouchTarget(dictationButton)
        self.assertMinimumTouchTarget(talkButton)
        let contextUsage = app.buttons["chat-context-usage"]
        XCTAssertTrue(contextUsage.waitForExistence(timeout: 5))
        let inlinePermissions = app.buttons["chat-composer-inline-permissions"]
        let inlineModel = app.buttons["chat-composer-inline-model"]
        let inlineEffort = app.buttons["chat-composer-inline-effort"]
        XCTAssertTrue(inlinePermissions.waitForExistence(timeout: 5))
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 5))
        XCTAssertTrue(inlineEffort.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(inlinePermissions)
        self.assertMinimumTouchTarget(inlineModel)
        self.assertMinimumTouchTarget(inlineEffort)
        for inlineControl in [inlinePermissions, contextUsage, inlineModel, inlineEffort] {
            XCTAssertGreaterThanOrEqual(inlineControl.frame.minX, composerSurface.frame.minX)
            XCTAssertLessThanOrEqual(inlineControl.frame.maxX, composerSurface.frame.maxX)
            XCTAssertLessThanOrEqual(abs(inlineControl.frame.midY - dictationButton.frame.midY), 1)
        }
        XCTAssertEqual(inlinePermissions.value as? String, "Guarded")
        XCTAssertFalse((inlineModel.value as? String ?? "").isEmpty)
        XCTAssertFalse((inlineEffort.value as? String ?? "").isEmpty)
        self.assertMinimumTouchTarget(contextUsage)
        self.assertNoHorizontalOverlap([
            attachmentButton,
            inlinePermissions,
            contextUsage,
            inlineModel,
            inlineEffort,
            dictationButton,
            talkButton,
        ])
        XCTAssertEqual(contextUsage.value as? String, "19 percent of the context window used")
        let compactHeight = textField.frame.height
        let compactSurfaceHeight = composerSurface.frame.height
        XCTAssertGreaterThanOrEqual(compactSurfaceHeight, 96)
        XCTAssertLessThanOrEqual(compactHeight, 44)
        XCTAssertLessThanOrEqual(textField.frame.maxY, attachmentButton.frame.minY + 2)
        XCTAssertLessThanOrEqual(abs(attachmentButton.frame.midY - dictationButton.frame.midY), 1)
        XCTAssertLessThanOrEqual(abs(talkButton.frame.midY - dictationButton.frame.midY), 1)
        self.attachScreenshot(named: "chat-composer-inline-controls")

        self.verifyComposerMenus(in: app)

        textField.tap()
        textField.typeText(
            "Draft a polished launch note that covers the new design, validation, rollout plan, " +
                "and follow-up details for the team.")
        let composerGrew = expectation(
            for: NSPredicate { _, _ in textField.frame.height >= compactHeight + 12 },
            evaluatedWith: textField)
        wait(for: [composerGrew], timeout: 4)
        XCTAssertTrue(sendButton.waitForExistence(timeout: 3))
        XCTAssertTrue(talkButton.waitForNonExistence(timeout: 3))
        self.assertMinimumTouchTarget(sendButton)
        XCTAssertGreaterThanOrEqual(composerSurface.frame.height, compactSurfaceHeight + 12)
        XCTAssertLessThanOrEqual(textField.frame.maxY, attachmentButton.frame.minY + 2)
        XCTAssertLessThanOrEqual(abs(attachmentButton.frame.midY - dictationButton.frame.midY), 1)
        XCTAssertLessThanOrEqual(abs(sendButton.frame.midY - dictationButton.frame.midY), 1)
        self.attachScreenshot(named: "chat-composer-expanded")

        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(self.app?.keyboards.firstMatch.waitForNonExistence(timeout: 3) == true)
    }

    func testChatComposerBlankDraftAreaFocusesInput() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat", initialDestination: "chat", name: "blank-draft-focus"))
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        let footer = app.buttons["chat-attachment-picker"]
        XCTAssertTrue(footer.exists)
        XCTAssertFalse(app.keyboards.firstMatch.exists)
        let blankHeight = footer.frame.minY - input.frame.maxY
        XCTAssertGreaterThan(blankHeight, 4)
        self.attachScreenshot(named: "blank-draft-before-focus")
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: input.frame.midX, dy: input.frame.maxY + blankHeight / 2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 3))
        input.typeText("Blank area focus")
        XCTAssertEqual(input.value as? String, "Blank area focus")
        self.attachScreenshot(named: "blank-draft-after-focus")
    }

    func testChatModelMenuAccessibility() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat", initialDestination: "chat", name: "model-menu-accessibility"))
        let app = try XCTUnwrap(self.app)
        let model = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(model.waitForExistence(timeout: 8))
        model.tap()
        let target = app.buttons["chat-composer-model-selection-target"]
        XCTAssertTrue(target.waitForExistence(timeout: 3))
        XCTAssertEqual(target.label, "Changes the global default")
        let defaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(defaultModel.waitForExistence(timeout: 3))
        XCTAssertTrue(defaultModel.isHittable)
        self.attachScreenshot(named: "model-menu-default-accessible")
        let alternative = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(alternative.exists)
        alternative.tap()
        self.waitForValue("claude-opus-4-1", of: model)
        model.tap()
        XCTAssertTrue(target.waitForExistence(timeout: 3))
        XCTAssertEqual(target.label, "Changes the global default")
        XCTAssertTrue(alternative.waitForExistence(timeout: 3))
        XCTAssertTrue(alternative.isHittable)
        self.attachScreenshot(named: "model-menu-selected-accessible")
        let original = app.buttons["openai/gpt-5.6-sol"]
        XCTAssertTrue(original.exists)
        original.tap()
        self.waitForValue("gpt-5.6-sol", of: model)
    }
}

extension OpenClawSnapshotUITests {
    func testUnavailableModelRejectsElementAndCoordinateActivationInInlinePicker() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-unavailable-model-fixture"])
        let app = try XCTUnwrap(self.app)
        let inlineModel = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 8))
        let originalValue = inlineModel.value as? String
        inlineModel.tap()

        let unavailable = app.buttons["anthropic/claude-opus-4-1 — Sign-in needed"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 3))
        unavailable.tap()
        XCTAssertEqual(app.buttons["chat-composer-inline-model"].value as? String, originalValue)

        if !unavailable.waitForExistence(timeout: 1) {
            inlineModel.tap()
            XCTAssertTrue(unavailable.waitForExistence(timeout: 3))
        }
        self.attachScreenshot(named: "chat-composer-model-unavailable")
        unavailable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(app.buttons["chat-composer-inline-model"].value as? String, originalValue)
    }

    func testUnavailableModelIsDisabledInChatActions() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: [
                "--openclaw-unavailable-model-fixture",
                "-openclaw.chat.modelFavorites", "",
                "-openclaw.chat.modelRecents", "",
            ])
        let app = try XCTUnwrap(self.app)
        app.buttons["Chat actions"].tap()
        let popover = app.descendants(matching: .any)["chat-actions-popover"]
        XCTAssertTrue(popover.waitForExistence(timeout: 5))
        let drawer = popover.buttons["chat-model-provider-drawer-anthropic"]
        XCTAssertTrue(drawer.waitForExistence(timeout: 3))
        drawer.tap()

        let unavailable = popover.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(unavailable.waitForExistence(timeout: 3))
        XCTAssertFalse(unavailable.isEnabled)
        XCTAssertTrue(popover.staticTexts["Sign-in needed"].exists)
        unavailable.tap()
        XCTAssertTrue(popover.exists)

        unavailable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(popover.exists)
        self.attachScreenshot(named: "chat-actions-model-unavailable")
    }

    func testSelectedAuthFailedModelDisablesOnlineSend() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-selected-model-auth-failure-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("This send should stay local")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertFalse(send.isEnabled)
        XCTAssertTrue(app.staticTexts[
            "Authentication failed. Review the provider credential or sign-in, then retry.",
        ].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["chat-model-sign-in"].exists)
        self.attachScreenshot(named: "chat-composer-model-auth-failed")
    }

    func testModelSignInMovesToModelMenuWhileSelectedModelCanSend() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", "ordinary"])
        let app = try XCTUnwrap(self.app)
        let modelMenu = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(modelMenu.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-model-sign-in"].exists)
        self.attachScreenshot(named: "chat-composer-no-sign-in-row")
        modelMenu.tap()
        XCTAssertTrue(app.buttons["chat-model-sign-in"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-model-menu-sign-in")
        self.assertModelSignInSheetOpens(in: app)
    }

    func testModelSignInRemainsReachableDuringActiveResponse() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: [
                "--openclaw-model-sign-in-fixture", "ordinary",
                "--openclaw-hold-initial-chat-run", "--openclaw-startup-status-fixture",
            ])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Check the project.")
        app.buttons["chat-send-message"].tap()
        XCTAssertTrue(app.buttons["Stop response"].waitForExistence(timeout: 8))
        self.openSignInMenuWithModelChangesDisabled(in: app)
        self.attachScreenshot(named: "chat-model-sign-in-active-response")
        self.assertModelSignInSheetOpens(in: app)
        XCTAssertTrue(app.buttons["Stop response"].exists)
        app.buttons["Stop response"].tap()
    }

    func testModelSignInRemainsReachableWithoutModelChoices() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", "empty"])
        let app = try XCTUnwrap(self.app)
        let modelMenu = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(modelMenu.waitForExistence(timeout: 8))
        XCTAssertTrue(modelMenu.isEnabled, "Empty catalog must not disable sign-in")
        modelMenu.tap()
        self.assertModelSignInSheetOpens(in: app)
    }

    func testModelSignInRemainsReachableWithoutModelMutationPermission() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", "read-only"])
        let app = try XCTUnwrap(self.app)
        self.openSignInMenuWithModelChangesDisabled(in: app)
        self.assertModelSignInSheetOpens(in: app)
    }

    func openSignInMenuWithModelChangesDisabled(in app: XCUIApplication) {
        let modelMenu = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(modelMenu.waitForExistence(timeout: 8))
        XCTAssertTrue(modelMenu.isEnabled, "Model mutation restrictions must not disable sign-in")
        modelMenu.tap()
        let choice = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(choice.waitForExistence(timeout: 3))
        XCTAssertFalse(choice.isEnabled, "Opening sign-in must not enable restricted model changes")
    }

    func assertModelSignInSheetOpens(in app: XCUIApplication) {
        let signIn = app.buttons["chat-model-sign-in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 3))
        XCTAssertTrue(signIn.isEnabled)
        signIn.tap()
        XCTAssertTrue(app.staticTexts[
            "No native sign-in options are available. Open Models in the Dashboard, or update the Gateway.",
        ].waitForExistence(timeout: 5))
        app.buttons["Close"].tap()
    }

    func testModelSelectionTargetVariantsPersistAcrossBothPickers() throws {
        for (target, disclosure) in [
            ("session", "Changes this session only"),
            ("agent", "Changes this agent's default"),
            ("global", "Changes the global default"),
        ] {
            self.launchApp(
                for: Self.chatScreenshotTarget,
                additionalArguments: [
                    "--openclaw-model-selection-target", target,
                    "-openclaw.chat.modelFavorites", "",
                    "-openclaw.chat.modelRecents", "",
                ])
            let app = try XCTUnwrap(self.app)
            let inlineModel = app.buttons["chat-composer-inline-model"]
            XCTAssertTrue(inlineModel.waitForExistence(timeout: 8))
            inlineModel.tap()
            XCTAssertTrue(app.buttons[disclosure].waitForExistence(timeout: 3))

            let alternateModel = app.buttons["anthropic/claude-opus-4-1"]
            XCTAssertTrue(alternateModel.waitForExistence(timeout: 3))
            alternateModel.tap()
            self.waitForValue("claude-opus-4-1", of: inlineModel)

            inlineModel.tap()
            XCTAssertTrue(app.buttons[disclosure].waitForExistence(timeout: 3))
            XCTAssertTrue(app.buttons["anthropic/claude-opus-4-1"]
                .waitForExistence(timeout: 3))
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()

            let actions = app.buttons["Chat actions"]
            XCTAssertTrue(actions.waitForExistence(timeout: 3))
            actions.tap()
            XCTAssertTrue(app.staticTexts[disclosure].waitForExistence(timeout: 3))
            XCTAssertTrue(app.descendants(matching: .any)["chat-actions-popover"].exists)
            self.attachScreenshot(named: "chat-model-selection-target-\(target)")
        }
    }

    func testChatActionsModelRowsScreenshot() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: [
                "-openclaw.chat.modelFavorites", "",
                "-openclaw.chat.modelRecents", "",
            ])
        let app = try XCTUnwrap(self.app)
        let actions = app.buttons["Chat actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 8))
        self.assertMinimumTouchTarget(actions)
        self.assertMinimumTouchTarget(app.buttons["RootTabs.Sidebar.Show"])
        self.attachScreenshot(named: "chat-actions-header")
        actions.tap()

        let popover = app.descendants(matching: .any)["chat-actions-popover"]
        XCTAssertTrue(popover.waitForExistence(timeout: 5))
        XCTAssertFalse(popover.buttons["New Chat"].exists)
        XCTAssertFalse(popover.buttons["Sessions…"].exists)
        XCTAssertFalse(popover.buttons["Dashboard"].exists)
        XCTAssertTrue(popover.buttons["New session options…"].exists)
        let defaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(defaultModel.waitForExistence(timeout: 5))
        let defaultLogo = defaultModel.images["chat-model-provider-icon-openai"]
        XCTAssertTrue(defaultLogo.exists)

        let providerDrawer = app.buttons["chat-model-provider-drawer-openai"]
        XCTAssertTrue(providerDrawer.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(providerDrawer)
        XCTAssertEqual(providerDrawer.value as? String, "Collapsed")
        let explicitModel = app.buttons["openai/gpt-5.6-sol"]
        let initialExplicitModelCount = app.buttons.matching(
            NSPredicate(format: "label == %@", "openai/gpt-5.6-sol")).count
        providerDrawer.tap()
        XCTAssertEqual(providerDrawer.value as? String, "Expanded")
        XCTAssertTrue(explicitModel.exists)
        XCTAssertTrue(explicitModel.images["chat-model-provider-icon-openai"].exists)
        XCTAssertGreaterThan(
            app.buttons.matching(NSPredicate(format: "label == %@", "openai/gpt-5.6-sol")).count,
            initialExplicitModelCount)
        let explicitIsSelected = explicitModel.value as? String == "Selected"
        let selectedModel = explicitIsSelected ? explicitModel : defaultModel
        self.assertMinimumTouchTarget(selectedModel)
        let selectedCheckmark = selectedModel.images["chat-menu-selection-checkmark"]
        XCTAssertTrue(selectedCheckmark.exists)
        XCTAssertGreaterThan(selectedCheckmark.frame.minX, selectedModel.frame.midX)
        self.attachScreenshot(named: "chat-actions-model-rows")

        self.verifyModelSelection(in: app, actions: actions, popover: popover)

        let thinkingSlider = app.sliders["chat-thinking-slider"]
        XCTAssertTrue(thinkingSlider.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(app.descendants(matching: .any)["chat-thinking-slider-hit-target"])
        let thinkingNotches = app.descendants(matching: .any)["chat-thinking-notches"]
        XCTAssertTrue(thinkingNotches.waitForExistence(timeout: 5))
        XCTAssertEqual(thinkingNotches.value as? String, "4 stops")
        let thinkingValues = ["Default (Auto)", "Low", "Medium", "High"]
        self.waitForValue(thinkingValues[0], of: thinkingSlider)
        for (index, expectedValue) in thinkingValues.enumerated().dropFirst() {
            thinkingSlider.adjust(
                toNormalizedSliderPosition: CGFloat(index) / CGFloat(thinkingValues.count - 1))
            self.waitForValue(expectedValue, of: thinkingSlider)
        }
        let thinkingDefault = app.buttons["chat-thinking-use-default"]
        XCTAssertTrue(thinkingDefault.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(thinkingDefault)
        self.waitForEnabled(thinkingSlider)
        let selectedThinkingValue = try XCTUnwrap(thinkingSlider.value as? String)
        XCTAssertFalse(selectedThinkingValue.hasPrefix("Default"))
        XCTAssertTrue(popover.exists)

        let fastMode = app.switches["chat-fast-mode-toggle"]
        XCTAssertTrue(fastMode.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(app.descendants(matching: .any)["chat-fast-mode-hit-target"])
        self.assertMinimumTouchTarget(fastMode)
        self.waitForEnabled(fastMode)
        XCTAssertFalse(app.buttons["chat-fast-mode-use-default"].exists)
        fastMode.tap()
        self.waitForValue("1", of: fastMode)
        let fastModeDefault = app.buttons["chat-fast-mode-use-default"]
        XCTAssertTrue(fastModeDefault.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(fastModeDefault)
        self.waitForEnabled(fastModeDefault)
        self.attachScreenshot(named: "chat-actions-compact-controls")
        XCTAssertTrue(popover.exists)

        let verbosity = app.segmentedControls["chat-verbosity-control"]
        XCTAssertTrue(verbosity.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(app.descendants(matching: .any)["chat-verbosity-hit-target"])
        XCTAssertEqual(verbosity.buttons.count, 3)
        verbosity.buttons["Full"].tap()
        let verbosityDefault = app.buttons["chat-verbosity-use-default"]
        XCTAssertTrue(verbosityDefault.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(verbosityDefault)
        self.waitForEnabled(verbosityDefault)
        verbosityDefault.tap()
        XCTAssertTrue(verbosityDefault.waitForNonExistence(timeout: 5))
        let restoredVerbosity = app.segmentedControls["chat-verbosity-control"]
        XCTAssertTrue(restoredVerbosity.waitForExistence(timeout: 5))
        self.waitForEnabled(restoredVerbosity)
        let settledDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue((settledDefaultModel.value as? String)?.contains("Selected") == true)
        XCTAssertTrue(popover.exists)

        let toolDetails = app.staticTexts["Tool details"]
        let reasoning = app.buttons["chat-show-reasoning-toggle"]
        XCTAssertTrue(toolDetails.exists)
        XCTAssertTrue(reasoning.exists)
        XCTAssertGreaterThan(reasoning.frame.minY, toolDetails.frame.maxY)

        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 3))
        let reopenedActions = app.buttons["Chat actions"]
        XCTAssertTrue(reopenedActions.waitForExistence(timeout: 5))
        self.waitForHittable(true, of: reopenedActions)
        reopenedActions.tap()
        let reopenedDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(reopenedDefaultModel.waitForExistence(timeout: 5))
        XCTAssertEqual(reopenedDefaultModel.label, "Default: openai/gpt-5.6-sol")
        XCTAssertTrue((reopenedDefaultModel.value as? String)?.contains("Selected") == true)
        let reopenedThinkingSlider = app.sliders["chat-thinking-slider"]
        XCTAssertTrue(reopenedThinkingSlider.waitForExistence(timeout: 5))
        self.waitForValue(selectedThinkingValue, of: reopenedThinkingSlider)
        XCTAssertTrue(app.buttons["chat-thinking-use-default"].exists)
        let reopenedFastMode = app.switches["chat-fast-mode-toggle"]
        XCTAssertTrue(reopenedFastMode.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-fast-mode-use-default"].exists)
        XCTAssertFalse(app.buttons["chat-verbosity-use-default"].exists)

        let sidebarFrame = app.buttons["RootTabs.Sidebar.Show"].frame
        let thinkingHitTargetFrame = app.descendants(matching: .any)["chat-thinking-slider-hit-target"].frame
        let fastHitTargetFrame = app.descendants(matching: .any)["chat-fast-mode-hit-target"].frame
        let verbosityHitTargetFrame = app.descendants(matching: .any)["chat-verbosity-hit-target"].frame
        let receipt = XCTAttachment(string: [
            "header.sidebar=\(sidebarFrame)",
            "header.chatActions=\(reopenedActions.frame)",
            "provider.openai=collapsed-expanded-collapsed",
            "provider.anthropic=collapsed-expanded",
            "model.nonDefault=selected-with-trailing-checkmark",
            "model.default=restored-selected-with-trailing-checkmark",
            "thinking.stops=4;exercised=\(thinkingValues.joined(separator: ","));selected=\(selectedThinkingValue)",
            "thinking.hitTarget=\(thinkingHitTargetFrame)",
            "fast.hitTarget=\(fastHitTargetFrame)",
            "toolDetails.hitTarget=\(verbosityHitTargetFrame)",
            "reopen=thinking-and-fast-selected-tool-details-default",
        ].joined(separator: "\n"))
        receipt.name = "chat-actions-observations"
        receipt.lifetime = .keepAlways
        self.add(receipt)

        popover.buttons["New session options…"].tap()
        XCTAssertTrue(app.staticTexts["New Thread Options"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.staticTexts["No agents are available on this gateway."].exists)
        let create = app.buttons["Create"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        self.waitForEnabled(create)
        create.tap()
        XCTAssertTrue(app.staticTexts["New Thread Options"].waitForNonExistence(timeout: 5))
    }

    func testLocalDeviceSettingsWorkWithoutDashboard() throws {
        self.launchApp(for: Self.settingsFallbackTarget, appearance: "dark", screenshotMode: false)
        let app = try XCTUnwrap(self.app)
        let onboardingClose = app.buttons["Close"]
        if onboardingClose.waitForExistence(timeout: 3) {
            onboardingClose.tap()
        }
        let localSettings = app.buttons["settings-device-row"]
        XCTAssertTrue(localSettings.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "local-settings-fallback")
        localSettings.tap()

        let appearance = app.buttons["LocalDeviceSettings.Appearance"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5))
        appearance.tap()
        app.buttons["Light"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "LocalDeviceSettings.Appearance")
            .matching(NSPredicate(format: "label == %@", "Appearance, Light"))
            .firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertFalse(app.secureTextFields.firstMatch.exists)
        self.attachScreenshot(named: "local-settings-appearance")

        let keepAwake = app.switches["LocalDeviceSettings.capabilities.keepAwakeEnabled"]
        let original = try XCTUnwrap(keepAwake.value as? String)
        keepAwake.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        self.waitForValue(original == "1" ? "0" : "1", of: keepAwake, timeout: 5)
        keepAwake.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        self.waitForValue(original, of: keepAwake, timeout: 5)

        // Navigate away and back: read from the shared preference owner, not a temporary editor value.
        app.navigationBars.buttons.element(boundBy: 0).tap()
        XCTAssertTrue(localSettings.waitForExistence(timeout: 5))
        localSettings.tap()
        XCTAssertTrue(app.buttons.matching(identifier: "LocalDeviceSettings.Appearance")
            .matching(NSPredicate(format: "label == %@", "Appearance, Light"))
            .firstMatch.waitForExistence(timeout: 5))
        let systemSettings = app.buttons["Open iOS Settings"]
        for _ in 0..<8 where !systemSettings.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(systemSettings.isHittable)
        XCTAssertTrue(app.staticTexts["Precise Location"].exists)
        self.attachScreenshot(named: "local-settings-permissions")
    }
}
