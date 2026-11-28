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
        initialDestination: "sessions",
        name: "01-control-connected")
    static let chatScreenshotTarget = ScreenshotTarget(
        initialTab: "chat",
        initialDestination: "chat",
        name: "02-chat-connected")
    private static let agentScreenshotTarget = ScreenshotTarget(
        initialTab: "chat",
        initialDestination: "chat",
        name: "03-agent-connected")
    private static let settingsScreenshotTarget = ScreenshotTarget(
        initialTab: "settings",
        initialDestination: "settings",
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

    /// User-made session groups live on the Sessions screen (the drawer lists sessions without group headers
    /// since the prototype snapshot). The header is the shared fold control; its actions sit on a long press.
    func testSessionsGroupHeaderControls() throws {
        self.launchApp(for: Self.controlScreenshotTarget, additionalArguments: ["--openclaw-group-controls-fixture"])
        let app = try XCTUnwrap(self.app)
        let header = app.buttons["SessionGroup.Header.Projects"]
        XCTAssertTrue(header.waitForExistence(timeout: 8))
        let projectNotes = app.buttons["SessionDashboard.Session.agent:main:dashboard:fixture-project"]
        XCTAssertTrue(projectNotes.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "sessions-groups-landing")
        header.press(forDuration: 0.8)
        for item in [
            "New Session in This Group",
            "New Session Defaults…",
            "Rename Group…",
            "New Group…",
            "Move Up",
            "Move Down",
            "Delete Group…",
        ] {
            XCTAssertTrue(app.buttons[item].waitForExistence(timeout: 4), "Missing group menu item: \(item)")
        }
        XCTAssertFalse(app.buttons["Move Up"].isEnabled)
        XCTAssertTrue(app.buttons["Move Down"].isEnabled)
        self.attachScreenshot(named: "sessions-groups-menu")
        app.buttons["New Session Defaults…"].tap()
        XCTAssertTrue(app.staticTexts["Group defaults"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["/work/repo"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.switches["Separate working copy"].exists)
        self.attachScreenshot(named: "sessions-groups-defaults")
        app.buttons["Cancel"].tap()

        // A tap folds and unfolds the group; it never opens the menu.
        XCTAssertEqual(header.value as? String, "Expanded")
        header.tap()
        XCTAssertEqual(header.value as? String, "Collapsed")
        XCTAssertTrue(projectNotes.waitForNonExistence(timeout: 5), "A folded group must hide its sessions")
        XCTAssertFalse(app.buttons["New Session Defaults…"].exists, "A header tap must not open the context menu")
        self.attachScreenshot(named: "sessions-groups-collapsed")
        header.tap()
        XCTAssertTrue(projectNotes.waitForExistence(timeout: 5))

        header.press(forDuration: 0.8)
        app.buttons["Move Down"].tap()
        let pending = app.descendants(matching: .any)["SessionGroup.Pending.Projects"].firstMatch
        XCTAssertTrue(pending.waitForExistence(timeout: 4), "Group mutation must show a pending spinner")
        self.attachScreenshot(named: "sessions-groups-pending")
        XCTAssertTrue(pending.waitForNonExistence(timeout: 10))
        let research = app.buttons["SessionGroup.Header.Research"]
        XCTAssertTrue(research.waitForExistence(timeout: 5))
        XCTAssertLessThan(research.frame.minY, header.frame.minY)
        self.attachScreenshot(named: "sessions-groups-reordered")

        header.press(forDuration: 0.8)
        app.buttons["New Session in This Group"].tap()
        // Creating the session in this group opens it.
        let created = app.otherElements["chat-agent-identity"]
        XCTAssertTrue(created.waitForExistence(timeout: 8))
        XCTAssertTrue(created.label.hasSuffix("New grouped session"), created.label)
        self.attachScreenshot(named: "sessions-groups-new-session")
    }

    func testSessionsGroupHeaderFailedMutationKeepsError() throws {
        self.launchApp(for: Self.controlScreenshotTarget, additionalArguments: [
            "--openclaw-group-controls-fixture", "--openclaw-failed-group-change-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        let header = app.buttons["SessionGroup.Header.Projects"]
        XCTAssertTrue(header.waitForExistence(timeout: 8))
        header.press(forDuration: 0.8)
        app.buttons["Move Down"].tap()
        XCTAssertTrue(app.staticTexts["Fixture group mutation rejected"].waitForExistence(timeout: 5))
        XCTAssertLessThan(header.frame.minY, app.buttons["SessionGroup.Header.Research"].frame.minY)
        XCTAssertFalse(app.descendants(matching: .any)["SessionGroup.Pending.Projects"].exists)
        self.attachScreenshot(named: "sessions-groups-failed-mutation")
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
        self.captureReleaseScreenshot(Self.agentScreenshotTarget) { app in
            let showSidebar = app.buttons["RootTabs.Sidebar.Show"]
            XCTAssertTrue(showSidebar.waitForExistence(timeout: 5))
            showSidebar.tap()
            XCTAssertTrue(app.buttons["RootTabs.Sidebar.AgentSelector"].waitForExistence(timeout: 5))
        }
    }

    func testReleaseSettingsScreenshot() {
        self.captureReleaseScreenshot(Self.settingsScreenshotTarget) { app in
            XCTAssertTrue(app.descendants(matching: .any)["SettingsHub.Native"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.staticTexts["General"].isHittable)
            XCTAssertFalse(app.webViews.firstMatch.exists)
        }
        guard let app = self.app else { return }
        let hub = app.descendants(matching: .any)["SettingsHub.Native"]
        let gateway = hub.buttons["SettingsHub.Gateway"]
        for _ in 0..<8 where !gateway.isHittable {
            hub.swipeUp()
        }
        gateway.tap()
        let details = app.buttons["Connection details"]
        XCTAssertTrue(details.waitForExistence(timeout: 5))
        // A healthy connection needs neither recovery nor the first-run pairing hero.
        XCTAssertFalse(app.buttons["Reconnect"].exists)
        XCTAssertFalse(app.buttons["Scan QR to Pair"].exists)
        details.tap()
        // After capture: the fixture never loads the saved manual Gateway, so controls that would
        // act on its route or credentials stay hidden down to the last row of the screen.
        let savedGatewayControls = [
            app.textFields["Host"],
            app.buttons["SettingsHub.ManualConnect"],
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
        XCTAssertTrue(app.descendants(matching: .any)["SettingsHub.Native"].waitForExistence(timeout: 8))
        let accessories = app.buttons["Accessories"]
        XCTAssertTrue(accessories.waitForExistence(timeout: 5))
        accessories.tap()
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

    func testCustomHeaderInvalidNameStaysAndValidNameSurvivesReopen() {
        XCUIDevice.shared.orientation = .portrait
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        let app = XCUIApplication()
        // Argument-domain flags outrank the reset's application-domain writes, so
        // onboarding stays dismissed while the manual host field starts empty.
        app.launchArguments += [
            "--openclaw-reset-onboarding",
            "--openclaw-initial-tab", "settings",
            "--openclaw-initial-destination", "gateway",
            "--openclaw-ui-test-readiness",
            "-gateway.onboardingComplete", "YES",
            "-gateway.hasConnectedOnce", "YES",
            "-onboarding.completed", "YES",
            "-onboarding.quickSetupDismissed", "YES",
            "-AppleLanguages", "(en)",
            "-AppleLocale", "en_US",
        ]
        app.launch()
        self.app = app
        let gatewayBar = app.navigationBars["Gateway"]
        guard gatewayBar.waitForExistence(timeout: 8) else {
            self.recordHeaderHierarchy(app)
            XCTFail("Gateway settings did not open")
            return
        }
        let statusBarHeight = gatewayBar.frame.minY - app.frame.minY
        if statusBarHeight > 0 {
            app.coordinate(withNormalizedOffset: .zero)
                .withOffset(CGVector(dx: 20, dy: statusBarHeight / 2)).tap()
        }
        self.tapLabeled("Connection details", in: app)
        XCTAssertTrue(app.navigationBars["Connection details"].waitForExistence(timeout: 5))
        let host = app.textFields["Host"]
        self.reveal(host, in: app)
        guard host.isHittable else {
            self.recordHeaderHierarchy(app)
            XCTFail("Manual host field did not appear")
            return
        }
        host.tap()
        host.typeText("headers.example.com")
        self.dismissKeyboard(in: app)
        self.tapLabeled("Custom Headers", in: app)
        let name = app.textFields["Header name"]
        guard name.waitForExistence(timeout: 6) else {
            self.recordHeaderHierarchy(app)
            XCTFail("Custom header editor did not open")
            return
        }
        name.tap()
        let invalidName = "X Client ID"
        let validName = "X-Client-ID"
        name.typeText(invalidName)
        let add = app.buttons["Add Header"].firstMatch
        XCTAssertTrue(add.waitForExistence(timeout: 4))
        XCTAssertFalse(add.isEnabled)
        XCTAssertTrue(app.staticTexts[
            "Header names can’t include spaces or special characters.",
        ].waitForExistence(timeout: 4))
        XCTAssertEqual(name.value as? String, invalidName)
        self.saveScreen(named: "invalid-name-kept")

        // Keep focus so the cursor is still at the end of the invalid name.
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: invalidName.count) + validName)
        XCTAssertEqual(name.value as? String, validName)
        let value = app.secureTextFields["Header value"]
        XCTAssertTrue(value.waitForExistence(timeout: 4))
        value.tap()
        value.typeText("synthetic-value")
        self.dismissKeyboard(in: app)
        XCTAssertTrue(add.isEnabled)
        add.tap()
        XCTAssertTrue(app.staticTexts[validName].waitForExistence(timeout: 6))
        app.navigationBars["Custom Headers"].buttons.element(boundBy: 0).tap()
        XCTAssertTrue(app.navigationBars["Connection details"].waitForExistence(timeout: 5))
        self.tapLabeled("Custom Headers", in: app)
        XCTAssertTrue(app.staticTexts[validName].waitForExistence(timeout: 6))
        let draft = app.textFields["Header name"]
        // An empty SwiftUI field may report its prompt as the accessibility value.
        let draftValue = draft.value as? String ?? ""
        XCTAssertTrue(draftValue.isEmpty || draftValue == draft.placeholderValue)
        self.saveScreen(named: "valid-name-reopened")
    }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication) {
        for _ in 0..<14 where !element.isHittable {
            app.swipeUp()
        }
    }

    private func tapLabeled(_ label: String, in app: XCUIApplication) {
        let button = app.buttons[label]
        let text = app.staticTexts[label]
        for _ in 0..<14 {
            if button.isHittable {
                button.tap()
                return
            }
            if text.isHittable {
                text.tap()
                return
            }
            app.swipeUp()
        }
        self.recordHeaderHierarchy(app)
        XCTFail("Could not tap \(label)")
    }

    private func dismissKeyboard(in app: XCUIApplication) {
        guard app.keyboards.firstMatch.waitForExistence(timeout: 2) else { return }
        let bar = app.navigationBars.firstMatch
        if bar.exists {
            bar.tap()
        }
        if app.keyboards.firstMatch.exists {
            app.swipeDown()
        }
    }

    private func recordHeaderHierarchy(_ app: XCUIApplication) {
        try? app.debugDescription.write(
            to: URL(fileURLWithPath: "/tmp/oc-header-ui.txt"),
            atomically: true,
            encoding: .utf8)
    }

    private func saveScreen(named name: String) {
        self.attachScreenshot(named: name)
        let directory = URL(fileURLWithPath: "/tmp/oc-193595-ui-shots", isDirectory: true)
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        let screenshot = self.app?.screenshot() ?? XCUIScreen.main.screenshot()
        try? screenshot.pngRepresentation.write(to: directory.appendingPathComponent("\(name).png"))
    }

    func testSessionsNavigateToSettingsThroughSidebar() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar navigation only")
        self.launchApp(for: Self.controlScreenshotTarget)
        let app = try XCTUnwrap(self.app)
        let sessions = app.staticTexts["Sessions"]
        XCTAssertTrue(sessions.waitForExistence(timeout: 8))

        try self.selectSidebarDestination("Settings")
        let settings = app.descendants(matching: .any)["SettingsHub.Native"]
        XCTAssertTrue(settings.waitForExistence(timeout: 8))
        app.buttons["SettingsHub.Close"].tap()
        XCTAssertTrue(settings.waitForNonExistence(timeout: 5))

        let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
        self.waitForHittable(true, of: hideSidebar)
        hideSidebar.tap()
        self.waitForHittable(true, of: sessions)
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

    func testLiveGatewayApprovalNotificationsFromSettings() async throws {
        try await self.verifyApprovalNotificationsNavigation()
    }

    func testTabletSidebarRootsRenderWithPersistentSidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Tablet split navigation only")
        XCUIDevice.shared.orientation = .landscapeLeft
        defer { XCUIDevice.shared.orientation = .portrait }
        for target in [
            Self.controlScreenshotTarget,
            Self.chatScreenshotTarget,
            Self.settingsFallbackTarget,
        ] {
            self.launchApp(for: target)
            let app = try XCTUnwrap(self.app)
            XCTAssertGreaterThan(app.frame.width, app.frame.height)
            XCTAssertTrue(self.destinationAnchor(in: app, destination: target.initialDestination).exists)
            if target.initialDestination == "settings" {
                // Settings is a sheet over the root; dismiss it before exercising the sidebar.
                app.buttons["SettingsHub.Close"].tap()
                XCTAssertTrue(app.descendants(matching: .any)["SettingsHub.Native"]
                    .waitForNonExistence(timeout: 5))
            }
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
            "docs",
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

        let app = try XCTUnwrap(self.app)
        if !app.descendants(matching: .any)["SettingsHub.Native"].exists,
           app.buttons["Close"].waitForExistence(timeout: 2)
        {
            app.buttons["Close"].tap()
        }
        // A clean normal-state launch can auto-route to Gateway setup.
        if !app.descendants(matching: .any)["SettingsHub.Native"].exists {
            try self.selectSidebarDestination("Settings")
        }
        let about = app.buttons["About"]
        for _ in 0..<8 where !about.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(about.isHittable)
        about.tap()
        let licenses = app.buttons["Licenses"]
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

    func testGatewaySettingsOpenedFromChatReturnsToChat() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar navigation only")
        self.launchApp(for: Self.chatScreenshotTarget)
        let app = try XCTUnwrap(self.app)
        let composer = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(composer.waitForExistence(timeout: 8))

        try self.openChatGatewaySettings()
        let gateway = app.navigationBars["Gateway"]
        XCTAssertTrue(gateway.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].isHittable)
        XCTAssertFalse(gateway.buttons["BackButton"].exists)
        self.attachScreenshot(named: "chat-gateway-root")

        try self.selectSidebarDestination("Settings")
        let settings = app.descendants(matching: .any)["SettingsHub.Native"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertTrue(gateway.waitForNonExistence(timeout: 5))
        try self.openSidebarWithSlowEdgeDrag()
        try self.selectSidebarDestination("Home")
        self.waitForHittable(true, of: composer)
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
        let collapsedSurfaceHeight = composerSurface.frame.height
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
        textField.tap()
        let inlinePermissions = app.buttons["chat-composer-inline-permissions"]
        let inlineModel = app.buttons["chat-composer-inline-model"]
        let inlineEffort = app.buttons["chat-composer-inline-effort"]
        XCTAssertTrue(inlinePermissions.waitForExistence(timeout: 5))
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 5))
        XCTAssertTrue(inlineEffort.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(inlinePermissions)
        self.assertMinimumTouchTarget(inlineModel)
        self.assertMinimumTouchTarget(inlineEffort)
        for inlineControl in [inlinePermissions, inlineModel, inlineEffort] {
            XCTAssertGreaterThanOrEqual(inlineControl.frame.minX, composerSurface.frame.minX)
            XCTAssertLessThanOrEqual(inlineControl.frame.maxX, composerSurface.frame.maxX)
            XCTAssertLessThanOrEqual(abs(inlineControl.frame.midY - dictationButton.frame.midY), 1)
        }
        XCTAssertEqual(inlinePermissions.value as? String, "Ask me")
        XCTAssertFalse((inlineModel.value as? String ?? "").isEmpty)
        XCTAssertFalse((inlineEffort.value as? String ?? "").isEmpty)
        self.assertNoHorizontalOverlap([
            attachmentButton,
            inlinePermissions,
            inlineModel,
            inlineEffort,
            dictationButton,
            talkButton,
        ])
        XCTAssertFalse(app.buttons["chat-context-usage"].exists)
        let compactHeight = textField.frame.height
        let compactSurfaceHeight = composerSurface.frame.height
        XCTAssertGreaterThan(compactSurfaceHeight, collapsedSurfaceHeight)
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
        let model = self.inlineModelChip(in: app)
        XCTAssertTrue(model.waitForExistence(timeout: 8))
        model.tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "model-menu-default-accessible")
        // The picker is SwiftUI content; this app's accessibility hit test answers with the hosting view for
        // any SwiftUI element (the base build does the same), so rows are checked for being enabled instead.
        let alternative = self.pickerModelRow("anthropic/claude-opus-4-1", provider: "anthropic", in: app)
        XCTAssertTrue(alternative.isEnabled)
        alternative.tap()
        self.waitForValue("Claude Opus 4.1", of: model)
        model.tap()
        XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 3))
        // The session's model is the one in effect, picked or not: no row offers a way back to another.
        XCTAssertFalse(app.buttons["chat-model-picker-agent-default"].exists)
        self.attachScreenshot(named: "model-menu-selected-accessible")
        let original = self.pickerModelRow("openai/gpt-5.6-sol", provider: "openai", in: app)
        XCTAssertTrue(original.isEnabled)
        original.tap()
        self.waitForValue("GPT-5.6", of: model)
    }
}

extension OpenClawSnapshotUITests {
    func testUnavailableModelRejectsElementAndCoordinateActivationInInlinePicker() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-unavailable-model-fixture"])
        let app = try XCTUnwrap(self.app)
        let inlineModel = self.inlineModelChip(in: app)
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 8))
        let originalValue = inlineModel.value as? String
        inlineModel.tap()

        let unavailable = self.pickerModelRow("anthropic/claude-opus-4-1", provider: "anthropic", in: app)
        XCTAssertTrue(unavailable.label.hasSuffix("Sign-in needed"), unavailable.label)
        unavailable.tap()
        XCTAssertEqual(app.buttons["chat-composer-inline-model"].value as? String, originalValue)
        XCTAssertTrue(unavailable.exists, "A disabled row keeps the picker open")
        self.attachScreenshot(named: "chat-composer-model-unavailable")
        unavailable.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertEqual(app.buttons["chat-composer-inline-model"].value as? String, originalValue)
    }

    func testUnavailableModelIsDisabledInComposer() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: [
                "--openclaw-unavailable-model-fixture",
                "-openclaw.chat.modelFavorites", "",
                "-openclaw.chat.modelRecents", "",
            ])
        let app = try XCTUnwrap(self.app)
        let modelPicker = self.inlineModelChip(in: app)
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 8))
        modelPicker.tap()

        let unavailable = self.pickerModelRow("anthropic/claude-opus-4-1", provider: "anthropic", in: app)
        XCTAssertFalse(unavailable.isEnabled)
        self.attachScreenshot(named: "chat-composer-model-unavailable")
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
        let modelMenu = self.inlineModelChip(in: app)
        XCTAssertTrue(modelMenu.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-model-sign-in"].exists)
        self.attachScreenshot(named: "chat-composer-no-sign-in-row")
        modelMenu.tap()
        XCTAssertTrue(self.pickerSignInRow(in: app).exists)
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
        // A running reply does not lock model choices; the new model answers from the next message.
        self.openSignInMenu(in: app, modelChangesEnabled: true)
        self.attachScreenshot(named: "chat-model-sign-in-active-response")
        self.assertModelSignInSheetOpens(in: app)
        XCTAssertTrue(app.buttons["Stop response"].exists)
        app.buttons["Stop response"].tap()
    }

    func testEffortChipOpensTheBarDuringActiveResponse() throws {
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
        let effort = app.buttons["chat-composer-inline-effort"]
        XCTAssertTrue(effort.waitForExistence(timeout: 5))
        effort.tap()
        self.attachScreenshot(named: "chat-effort-tap-active-response")
        // A reply in progress does not lock the levels; a change applies from the next message.
        XCTAssertTrue(app.descendants(matching: .any)["chat-effort-bar"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.descendants(matching: .any)["chat-effort-bar-slider"].isEnabled)
        XCTAssertFalse(app.descendants(matching: .any)["chat-effort-bar-locked"].exists)
        self.attachScreenshot(named: "chat-effort-bar-active-response")
        app.buttons["Stop response"].tap()
    }

    func testModelSignInRemainsReachableWithoutModelChoices() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-model-sign-in-fixture", "empty"])
        let app = try XCTUnwrap(self.app)
        let modelMenu = self.inlineModelChip(in: app)
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
        self.openSignInMenu(in: app, modelChangesEnabled: false)
        self.assertModelSignInSheetOpens(in: app)
    }

    func openSignInMenu(in app: XCUIApplication, modelChangesEnabled: Bool) {
        let modelMenu = self.inlineModelChip(in: app)
        XCTAssertTrue(modelMenu.waitForExistence(timeout: 8))
        XCTAssertTrue(modelMenu.isEnabled, "Model mutation restrictions must not disable sign-in")
        modelMenu.tap()
        let choice = self.pickerModelRow("anthropic/claude-opus-4-1", provider: "anthropic", in: app)
        XCTAssertEqual(choice.isEnabled, modelChangesEnabled)
        // The provider page is a system push; its back button is the first one in the bar.
        app.navigationBars.firstMatch.buttons.firstMatch.tap()
    }

    func assertModelSignInSheetOpens(in app: XCUIApplication) {
        let signIn = self.pickerSignInRow(in: app)
        XCTAssertTrue(signIn.isEnabled)
        signIn.tap()
        XCTAssertTrue(app.staticTexts[
            "No native sign-in options are available. Open Models in the web app, or update the Gateway.",
        ].waitForExistence(timeout: 5))
        app.buttons["Close"].tap()
    }

    func testModelSelectionTargetVariantsPersistInComposer() throws {
        // Whatever a pick changes on the Gateway, the picker only lists models: no scope note in any scope.
        for target in ["session", "agent", "global"] {
            self.launchApp(
                for: Self.chatScreenshotTarget,
                additionalArguments: [
                    "--openclaw-model-selection-target", target,
                    "-openclaw.chat.modelFavorites", "",
                    "-openclaw.chat.modelRecents", "",
                ])
            let app = try XCTUnwrap(self.app)
            let inlineModel = self.inlineModelChip(in: app)
            XCTAssertTrue(inlineModel.waitForExistence(timeout: 8))
            let note = app.descendants(matching: .any)["chat-composer-model-selection-target"]
            inlineModel.tap()
            XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 3))
            XCTAssertFalse(note.exists, "No scope note for a \(target) pick")

            let alternateModel = self.pickerModelRow("anthropic/claude-opus-4-1", provider: "anthropic", in: app)
            alternateModel.tap()
            self.waitForValue("Claude Opus 4.1", of: inlineModel)

            inlineModel.tap()
            XCTAssertTrue(app.navigationBars["Model"].waitForExistence(timeout: 3))
            XCTAssertFalse(note.exists, "No scope note for a \(target) pick")
            let picked = self.pickerModelRow("anthropic/claude-opus-4-1", provider: "anthropic", in: app)
            XCTAssertTrue(picked.isSelected, "The picked model stays the current one")
            self.attachScreenshot(named: "chat-model-selection-target-\(target)")
        }
    }

    func testChatActionsAndNewSessionOptionsHaveSeparateEntryPoints() throws {
        self.launchApp(for: Self.chatScreenshotTarget)
        let app = try XCTUnwrap(self.app)
        let actions = app.buttons["Chat actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 8))
        self.assertMinimumTouchTarget(actions)
        let input = self.chatMessageInput(in: app)
        input.tap()
        XCTAssertTrue(app.buttons["chat-composer-inline-model"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-composer-inline-effort"].exists)
        actions.tap()

        XCTAssertTrue(app.buttons["Rename…"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Export chat"].exists)
        // The closed drawer still exposes its own New Chat button to XCTest.
        XCTAssertFalse(app.buttons.matching(identifier: "New Chat").allElementsBoundByIndex.contains { $0.isHittable })
        XCTAssertFalse(app.buttons["New session options…"].exists)
        XCTAssertFalse(app.buttons["Show reasoning & tool activity"].exists)
        self.attachScreenshot(named: "chat-actions-compact")
        // Close through a menu action so the tap cannot open the diagram underneath.
        app.buttons["Rename…"].tap()
        app.alerts.buttons["Cancel"].tap()

        // The keyboard is still up. Open the drawer with its native edge gesture.
        try self.openSidebarWithSlowEdgeDrag()
        try self.startNewChatFromSidebar()
        let draft = self.chatMessageInput(in: app)
        draft.tap()
        draft.typeText("/new")
        let options = app.buttons["chat-new-session-options"]
        XCTAssertTrue(options.waitForExistence(timeout: 5))
        options.tap()
        XCTAssertTrue(app.staticTexts["New Thread"].waitForExistence(timeout: 5))
        let create = app.buttons["Create Thread"]
        XCTAssertTrue(create.waitForExistence(timeout: 5))
        self.waitForEnabled(create)
        create.tap()
        XCTAssertTrue(app.staticTexts["New Thread"].waitForNonExistence(timeout: 5))
    }

    func testLocalDeviceSettingsWorkWithoutDashboard() throws {
        func openOfflineSettings(appearance: String?) throws -> XCUIApplication {
            self.launchApp(for: Self.settingsFallbackTarget, appearance: appearance, screenshotMode: false)
            let app = try XCTUnwrap(self.app)
            let onboardingClose = app.buttons["Close"]
            if onboardingClose.waitForExistence(timeout: 3) {
                onboardingClose.tap()
                XCTAssertTrue(onboardingClose.waitForNonExistence(timeout: 5))
            }
            // A previously onboarded device without a saved Gateway opens Connection first.
            if app.navigationBars["Gateway"].exists {
                try self.selectSidebarDestination("Settings")
            }
            let settings = app.descendants(matching: .any)["SettingsHub.Native"]
            XCTAssertTrue(settings.waitForExistence(timeout: 8))
            return app
        }

        let app = try openOfflineSettings(appearance: "dark")
        self.attachScreenshot(named: "native-settings-dark")

        let appearance = app.buttons["SettingsHub.Appearance"]
        XCTAssertTrue(appearance.waitForExistence(timeout: 5))
        appearance.tap()
        app.buttons["Light"].tap()
        XCTAssertTrue(app.buttons.matching(identifier: "SettingsHub.Appearance")
            .matching(NSPredicate(format: "label == %@", "Appearance, Light"))
            .firstMatch.waitForExistence(timeout: 5))
        XCTAssertFalse(app.webViews.firstMatch.exists)
        XCTAssertFalse(app.secureTextFields.firstMatch.exists)
        self.attachScreenshot(named: "native-settings-light")

        let keepAwake = app.switches["SettingsHub.KeepAwake"]
        let original = try XCTUnwrap(keepAwake.value as? String)
        keepAwake.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        self.waitForValue(original == "1" ? "0" : "1", of: keepAwake, timeout: 5)
        keepAwake.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.5)).tap()
        self.waitForValue(original, of: keepAwake, timeout: 5)

        app.buttons["Permissions"].tap()
        let systemSettings = app.buttons["Open iOS Settings"]
        for _ in 0..<8 where !systemSettings.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(systemSettings.isHittable)
        // Precise Location shows only once Location is granted; the access row is always there.
        XCTAssertTrue(app.staticTexts["Location access"].exists)
        self.attachScreenshot(named: "native-settings-permissions")

        app.navigationBars["Permissions"].buttons.element(boundBy: 0).tap()
        // Relaunch without the screenshot appearance override to verify the saved preference.
        let relaunchedApp = try openOfflineSettings(appearance: nil)
        XCTAssertTrue(relaunchedApp.buttons.matching(identifier: "SettingsHub.Appearance")
            .matching(NSPredicate(format: "label == %@", "Appearance, Light"))
            .firstMatch.waitForExistence(timeout: 5))
    }
}
