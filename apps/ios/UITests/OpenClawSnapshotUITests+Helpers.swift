import UIKit
import Vision
import XCTest

extension OpenClawSnapshotUITests {
    func verifyApprovalNotificationsNavigation(fromOverview: Bool) async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_APPROVAL_FIXTURE_URL"] != nil,
            "Requires a task-owned synthetic Gateway approval fixture")
        let fixtureURL = try XCTUnwrap(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_APPROVAL_FIXTURE_URL"]
                .flatMap(URL.init(string:)),
            "Provide a task-owned synthetic Gateway approval fixture")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        let (_, response) = try await URLSession.shared.data(from: fixtureURL.appendingPathComponent("approval"))
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        if app.buttons["Not Now"].waitForExistence(timeout: 8) {
            app.buttons["Not Now"].tap()
        }
        let approvalDialog = app.descendants(matching: .any)["exec-approval-review-scroll"]
        XCTAssertTrue(approvalDialog.waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons["Cancel"].waitForExistence(timeout: 8))
        app.buttons["Cancel"].tap()

        if fromOverview {
            try self.selectSidebarDestination("Overview")
            let approvals = app.buttons.containing(.staticText, identifier: "Pending approvals").firstMatch
            XCTAssertTrue(approvals.waitForExistence(timeout: 8))
            approvals.tap()
        } else {
            try self.selectSidebarDestination("Settings")
            let approvals = app.buttons.containing(.staticText, identifier: "Approvals").firstMatch
            XCTAssertTrue(approvals.waitForExistence(timeout: 8))
            approvals.tap()
        }

        let origin = fromOverview ? "overview" : "settings"
        let review = app.buttons["Review exec approval"].firstMatch
        XCTAssertTrue(review.waitForExistence(timeout: 5))
        review.tap()
        XCTAssertTrue(app.staticTexts["Reviewing"].waitForExistence(timeout: 5))
        let notifications = app.buttons["Open Notifications"]
        XCTAssertTrue(notifications.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "\(origin)-approvals-before-notifications")
        notifications.tap()
        let reachedNotifications = app.navigationBars["Notifications"].waitForExistence(timeout: 8)
        self.attachScreenshot(named: "\(origin)-approvals-notifications-result")
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(origin)-approvals-notifications-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
        XCTAssertTrue(
            reachedNotifications,
            "Open Notifications must open Dashboard notification settings from \(origin) Approvals")
        let dashboard = app.webViews.firstMatch
        XCTAssertTrue(
            dashboard.waitForExistence(timeout: 8),
            "Notification settings must render in the embedded Dashboard")
        XCTAssertTrue(dashboard.staticTexts["Notifications"].waitForExistence(timeout: 8))
        XCTAssertFalse(
            approvalDialog.exists,
            "The approval being reviewed must not cover Dashboard notification settings")
        let close = app.buttons["DashboardPage.Close"]
        XCTAssertTrue(close.exists)
        close.tap()
        XCTAssertTrue(notifications.waitForExistence(timeout: 5), "Done must return to Approvals")
        self.attachScreenshot(named: "\(origin)-approvals-after-back")
    }

    func agentIdentity(in app: XCUIApplication) -> XCUIElement {
        app.buttons.matching(identifier: "chat-agent-identity").firstMatch
    }

    func readinessMarker(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)[Self.appReadinessAccessibilityIdentifier]
    }

    func destinationAnchor(in app: XCUIApplication, destination: String) -> XCUIElement {
        switch destination {
        case "overview": app.staticTexts["Agent session"]
        case "chat": app.otherElements["chat-composer-surface"]
        case "agents": app.buttons["agent-status-filter-menu"]
        case "settings": app.descendants(matching: .any)["SettingsHub.Fallback"]
        case "gateway": app.navigationBars["Gateway"]
        default: self.readinessMarker(in: app)
        }
    }

    func launchApp(
        for target: ScreenshotTarget,
        appearance: String? = "dark",
        screenshotMode: Bool = true,
        additionalArguments: [String] = [])
    {
        self.terminateCurrentApp()

        let app = self.configuredApp(
            for: target,
            appearance: appearance,
            screenshotMode: screenshotMode,
            additionalArguments: additionalArguments)
        app.launch()
        self.app = app
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        if screenshotMode {
            self.dismissScreenshotNotificationPrompt()
        }
        let readiness = self.readinessMarker(in: app)
        XCTAssertTrue(
            readiness.waitForExistence(timeout: 8),
            "OpenClaw root readiness marker did not appear")
        if screenshotMode {
            self.waitForValue("ready:\(target.initialDestination)", of: readiness, timeout: 8)
        }
    }

    func configuredApp(
        for target: ScreenshotTarget,
        appearance: String?,
        screenshotMode: Bool,
        additionalArguments: [String]) -> XCUIApplication
    {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-initial-tab",
            target.initialTab,
            "--openclaw-initial-destination",
            target.initialDestination,
            "--openclaw-sidebar-visibility",
            "hidden",
            "--openclaw-ui-test-readiness",
        ]
        if screenshotMode {
            app.launchArguments.append("--openclaw-screenshot-mode")
        }
        app.launchArguments += additionalArguments
        if let appearance {
            app.launchArguments += ["--openclaw-appearance", appearance]
        }
        return app
    }

    func captureReleaseScreenshot(
        _ target: ScreenshotTarget,
        beforeCapture: ((XCUIApplication) -> Void)? = nil)
    {
        self.launchApp(for: target)
        self.waitForReleaseScreenshotTarget(target)
        guard let app = self.app else {
            XCTFail("OpenClaw is not running for screenshot target \(target.name)")
            return
        }
        beforeCapture?(app)
        snapshot(target.name, timeWaitingForIdle: 5)
        self.attachScreenshot(named: target.name)
    }

    func waitForReleaseScreenshotTarget(_ target: ScreenshotTarget) {
        guard let app = self.app else {
            XCTFail("OpenClaw is not running for screenshot target \(target.name)")
            return
        }
        let anchor = self.destinationAnchor(in: app, destination: target.initialDestination)
        XCTAssertTrue(
            anchor.waitForExistence(timeout: 8),
            "Screenshot target \(target.name) did not render its readiness anchor")
    }

    func terminateCurrentApp(
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        guard let app = self.app else { return }
        app.terminate()
        XCTAssertTrue(
            app.wait(for: .notRunning, timeout: 5),
            "OpenClaw did not terminate before the next launch",
            file: file,
            line: line)
        self.app = nil
    }

    func waitForValue(
        _ value: String,
        of element: XCUIElement,
        timeout: TimeInterval = 3)
    {
        XCTAssertTrue(self.element(element, hasValue: value, timeout: timeout))
    }

    func assertMinimumTouchTarget(
        _ element: XCUIElement,
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        let minimum: CGFloat = 44
        // XCUI converts screen coordinates through floating-point transforms.
        // Permit rounding noise without accepting a genuinely undersized target.
        let tolerance = minimum.ulp * 16
        XCTAssertGreaterThanOrEqual(element.frame.width + tolerance, minimum, file: file, line: line)
        XCTAssertGreaterThanOrEqual(element.frame.height + tolerance, minimum, file: file, line: line)
    }

    func assertNoHorizontalOverlap(
        _ elements: [XCUIElement],
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        let ordered = elements.sorted { $0.frame.minX < $1.frame.minX }
        for (left, right) in zip(ordered, ordered.dropFirst()) {
            XCTAssertLessThanOrEqual(
                left.frame.maxX,
                right.frame.minX + 0.5,
                "\(left.identifier) overlaps \(right.identifier)",
                file: file,
                line: line)
        }
    }

    func element(_ element: XCUIElement, hasValue value: String, timeout: TimeInterval) -> Bool {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "value == %@", value),
            object: element)
        return XCTWaiter.wait(for: [expectation], timeout: timeout) == .completed
    }

    func waitForEnabled(_ element: XCUIElement, timeout: TimeInterval = 5) {
        XCTAssertTrue(element.wait(for: \.isEnabled, toEqual: true, timeout: timeout))
    }

    func waitForHittable(_ isHittable: Bool, of element: XCUIElement) {
        let expectation = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "hittable == %@", NSNumber(value: isHittable)),
            object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 5), .completed)
    }

    func tapSidebarReveal(
        in app: XCUIApplication,
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        let reveal = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertTrue(reveal.waitForExistence(timeout: 5), file: file, line: line)
        if reveal.isHittable {
            reveal.tap()
            return
        }

        // iOS 18 can mirror the nested SwiftUI button's accessibility frame
        // while the visible control remains at the navigation bar's leading edge.
        let navigationBar = app.navigationBars.firstMatch
        XCTAssertTrue(navigationBar.waitForExistence(timeout: 5), file: file, line: line)
        let appFrame = app.frame
        let navigationFrame = navigationBar.frame
        let coordinate = app.coordinate(withNormalizedOffset: CGVector(
            dx: (navigationFrame.minX + 38) / appFrame.width,
            dy: (navigationFrame.minY + 22) / appFrame.height))
        coordinate.tap()
    }

    func openSidebarWithSlowEdgeDrag(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.78, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.1)

        self.waitForHittable(true, of: app.buttons["RootTabs.Sidebar.Hide"])
    }

    func closeSidebarWithSlowDrag(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        // Start inside the exposed sidebar, not on the translated detail card.
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.72, dy: 0.5))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5))
        start.press(
            forDuration: 0.1,
            thenDragTo: end,
            withVelocity: .slow,
            thenHoldForDuration: 0.1)

        self.waitForHittable(true, of: app.buttons["RootTabs.Sidebar.Show"])
    }

    func selectSidebarDestination(
        _ title: String,
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
        if !hideSidebar.isHittable {
            self.tapSidebarReveal(in: app, file: file, line: line)
            self.waitForHittable(true, of: hideSidebar)
        }

        let destination = app.buttons.matching(NSPredicate(
            format: "label == %@ OR label BEGINSWITH %@",
            title,
            "\(title),")).firstMatch
        XCTAssertTrue(destination.waitForExistence(timeout: 5), file: file, line: line)
        self.waitForHittable(true, of: destination)
        destination.tap()

        self.waitForHittable(false, of: hideSidebar)
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5), file: file, line: line)
    }

    func startNewChatFromSidebar(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let app = try XCTUnwrap(self.app, file: file, line: line)
        let hideSidebar = app.buttons["RootTabs.Sidebar.Hide"]
        if !hideSidebar.isHittable {
            self.tapSidebarReveal(in: app, file: file, line: line)
            self.waitForHittable(true, of: hideSidebar)
        }

        let newChat = app.buttons["New Chat"]
        XCTAssertTrue(newChat.waitForExistence(timeout: 5), file: file, line: line)
        XCTAssertTrue(newChat.isEnabled, file: file, line: line)
        self.waitForHittable(true, of: newChat)
        newChat.tap()

        self.waitForHittable(false, of: hideSidebar)
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].waitForExistence(timeout: 5), file: file, line: line)
    }

    func launchPairedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) throws -> XCUIApplication
    {
        let app = try self.startPairedLiveGatewayApp(
            initialTab: initialTab,
            initialDestination: initialDestination)
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 45))
        app.buttons["Go to Chat"].tap()
        return app
    }

    func launchPairedLiveGatewayApp(
        initialTab: String,
        initialDestination: String,
        readinessURL: URL) async throws -> XCUIApplication
    {
        let app = try self.startPairedLiveGatewayApp(
            initialTab: initialTab,
            initialDestination: initialDestination)
        var request = URLRequest(url: readinessURL)
        request.timeoutInterval = 45
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let readiness = try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
        XCTAssertEqual(readiness["ready"] as? Bool, true)
        XCTAssertTrue(app.staticTexts["You're connected"].exists)
        app.buttons["Go to Chat"].tap()
        return app
    }

    func startPairedLiveGatewayApp(
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
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()

        let setupCodeField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupCodeField.waitForExistence(timeout: 5))
        setupCodeField.tap()
        setupCodeField.press(forDuration: 1)
        XCTAssertTrue(app.menuItems["Paste"].waitForExistence(timeout: 3))
        app.menuItems["Paste"].tap()
        app.buttons["Apply"].tap()
        return app
    }

    func relaunchConnectedLiveGatewayApp(
        initialTab: String,
        initialDestination: String) -> XCUIApplication
    {
        self.terminateCurrentApp()
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

    func chatTranscript(in app: XCUIApplication) throws -> XCUIElement {
        let candidates = app.descendants(matching: .any).matching(identifier: "chat-transcript").allElementsBoundByIndex
        return try XCTUnwrap(
            candidates.count == 1 ? candidates.first : nil,
            "Expected one chat transcript")
    }

    func sendLiveGatewayMessage(
        _ text: String,
        expecting replyMarker: String,
        stage: String,
        in app: XCUIApplication) throws
    {
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        self.waitForEnabled(input)
        input.tap()
        input.typeText(text)

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        XCTAssertTrue(send.isEnabled)
        XCTAssertEqual(input.value as? String, text)
        send.tap()

        let failureContext = { (checkpoint: String) in
            "IOS_RELEASE_CHAT_FAILURE \(stage) \(checkpoint) draft=\(input.value as? String == text) " +
                "keyboard=\(app.keyboards.firstMatch.exists) reply=\(app.staticTexts[replyMarker].exists) " +
                "writing=\(app.staticTexts["Writing"].exists) jump=\(app.buttons["Jump to latest reply"].exists) " +
                "foreground=\(app.state == .runningForeground) input=\(input.exists) " +
                "transcript=\(app.scrollViews["chat-transcript"].exists) send=\(send.exists)"
        }
        let submittedText = app.staticTexts.matching(NSPredicate(format: "label == %@", text)).firstMatch
        XCTAssertTrue(submittedText.waitForExistence(timeout: 5), failureContext("submission"))
        XCTAssertTrue(
            app.staticTexts[replyMarker].waitForExistence(timeout: 60),
            failureContext("reply"))
        XCTAssertTrue(app.staticTexts["Writing"].waitForNonExistence(timeout: 5))
    }

    func dismissChatKeyboardThroughTranscript(in app: XCUIApplication) throws {
        // Typing can move historical replies off-screen; tap visible text without activating an action.
        let transcript = try self.chatTranscript(in: app)
        let actionQueries = [transcript.buttons, transcript.links]
        let dismissalText = try XCTUnwrap(
            transcript.staticTexts.allElementsBoundByIndex.first { candidate in
                guard candidate.isHittable,
                      !candidate.buttons.firstMatch.exists,
                      !candidate.links.firstMatch.exists
                else {
                    return false
                }
                let label = NSPredicate(format: "label == %@", candidate.label)
                return actionQueries.allSatisfy {
                    !$0.matching(label).firstMatch.exists && !$0.containing(label).firstMatch.exists
                }
            },
            "Expected visible noninteractive transcript text")
        dismissalText.tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
    }

    func openChatGatewaySettings(
        file: StaticString = #filePath,
        line: UInt = #line) throws
    {
        let actions = try XCTUnwrap(self.app?.buttons["Chat actions"], file: file, line: line)
        XCTAssertTrue(actions.waitForExistence(timeout: 8), file: file, line: line)
        actions.tap()

        let app = try XCTUnwrap(self.app, file: file, line: line)
        let gatewaySettings = app.buttons["chat-gateway-settings"]
        let actionsMenu = app.collectionViews.firstMatch
        for _ in 0..<3 {
            if gatewaySettings.waitForExistence(timeout: 1) { break }
            actionsMenu.swipeUp()
        }
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 3), file: file, line: line)
        gatewaySettings.tap()
    }

    func assertElementHasRenderedContent(
        _ element: XCUIElement,
        named name: String,
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        guard let app, let image = app.screenshot().image.cgImage else {
            XCTFail("App screenshot has no CGImage", file: file, line: line)
            return
        }

        let appFrame = app.frame
        let elementFrame = element.frame.intersection(appFrame)
        guard !elementFrame.isNull, elementFrame.width > 1, elementFrame.height > 1 else {
            XCTFail("\(name) has no visible screenshot region", file: file, line: line)
            return
        }

        let scaleX = CGFloat(image.width) / appFrame.width
        let scaleY = CGFloat(image.height) / appFrame.height
        let crop = CGRect(
            x: (elementFrame.minX - appFrame.minX) * scaleX,
            y: (elementFrame.minY - appFrame.minY) * scaleY,
            width: elementFrame.width * scaleX,
            height: elementFrame.height * scaleY).integral
            .intersection(CGRect(x: 0, y: 0, width: image.width, height: image.height))
        guard let cropped = image.cropping(to: crop), crop.width > 1, crop.height > 1 else {
            XCTFail("Could not crop screenshot for \(name)", file: file, line: line)
            return
        }

        let width = cropped.width
        let height = cropped.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else {
                return false
            }
            context.draw(cropped, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else {
            XCTFail("Could not render screenshot crop for \(name)", file: file, line: line)
            return
        }

        func luminance(at offset: Int) -> Int {
            (Int(pixels[offset]) * 299 + Int(pixels[offset + 1]) * 587 + Int(pixels[offset + 2]) * 114) / 1000
        }

        var contrastingEdges = 0
        var comparedEdges = 0
        for y in 0..<height {
            for x in 1..<width {
                let offset = (y * width + x) * 4
                let previousOffset = offset - 4
                if abs(luminance(at: offset) - luminance(at: previousOffset)) >= 12 {
                    contrastingEdges += 1
                }
                comparedEdges += 1
            }
        }

        XCTAssertGreaterThan(
            Double(contrastingEdges) / Double(max(1, comparedEdges)),
            0.002,
            "\(name) must contain rendered glyph edges, not only an accessibility frame",
            file: file,
            line: line)
    }

    func assertChatCanvasIsNotSolidBlack(
        file: StaticString = #filePath,
        line: UInt = #line)
    {
        guard let app, let image = app.screenshot().image.cgImage else {
            XCTFail("App screenshot has no CGImage", file: file, line: line)
            return
        }
        let width = image.width
        let height = image.height
        var pixels = [UInt8](repeating: 0, count: width * height * 4)
        let rendered = pixels.withUnsafeMutableBytes { buffer in
            guard let context = CGContext(
                data: buffer.baseAddress,
                width: width,
                height: height,
                bitsPerComponent: 8,
                bytesPerRow: width * 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            else {
                return false
            }
            context.draw(image, in: CGRect(x: 0, y: 0, width: width, height: height))
            return true
        }
        guard rendered else {
            XCTFail("Could not render the chat screenshot", file: file, line: line)
            return
        }

        // The fixture leaves this canvas region empty. A pure-black host makes
        // both system scroll-edge effects collapse into hard black clipping.
        let sampleX = (width / 8)..<(width * 7 / 8)
        let sampleY = (height * 2 / 5)..<(height * 7 / 10)
        var layeredPixels = 0
        for y in sampleY {
            for x in sampleX {
                let offset = (y * width + x) * 4
                if pixels[offset] > 3 || pixels[offset + 1] > 3 || pixels[offset + 2] > 3 {
                    layeredPixels += 1
                }
            }
        }
        let sampledPixels = max(1, sampleX.count * sampleY.count)
        XCTAssertGreaterThan(
            Double(layeredPixels) / Double(sampledPixels),
            0.95,
            "Dark Chat must retain a layered canvas behind its translucent edge chrome",
            file: file,
            line: line)
    }

    func sendFixtureChatMessage(_ text: String) {
        guard let app else {
            XCTFail("Fixture app is unavailable")
            return
        }
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText(text)

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))
        send.tap()

        XCTAssertTrue(app.staticTexts[text].waitForExistence(timeout: 5))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I can help with"))
                .firstMatch.waitForExistence(timeout: 5))
    }

    func attachScreenshot(named name: String) {
        guard let app else { return }
        let screenshot = UIDevice.current.userInterfaceIdiom == .pad
            ? XCUIScreen.main.screenshot()
            : app.screenshot()
        let attachment = XCTAttachment(screenshot: screenshot)
        attachment.name = name
        attachment.lifetime = .keepAlways
        add(attachment)
    }

    func chatMessageInput(in app: XCUIApplication) -> XCUIElement {
        app.descendants(matching: .any)["chat-message-input"]
    }

    /// A burst of synthetic key events can drop a keystroke under simulator load, so one
    /// delete-per-character `typeText` does not reliably empty a field. Re-send against
    /// whatever is actually left instead of assuming the first burst landed in full.
    func clearTextField(_ element: XCUIElement, attempts: Int = 4) {
        for _ in 0..<attempts {
            let value = element.value as? String ?? ""
            if value.isEmpty {
                return
            }
            element.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
    }

    func verifyComposerMenus(in app: XCUIApplication) {
        let inlinePermissions = app.buttons["chat-composer-inline-permissions"]
        let inlineEffort = app.buttons["chat-composer-inline-effort"]
        let contextUsage = app.buttons["chat-context-usage"]
        let attachmentButton = app.buttons["chat-attachment-picker"]
        inlinePermissions.tap()
        XCTAssertTrue(app.buttons["Default (inherited)"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Read-only"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Guarded"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Workspace"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Full"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-permissions")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        inlineEffort.tap()
        XCTAssertTrue(app.buttons["Thinking"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Fast"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-effort")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        contextUsage.tap()
        XCTAssertTrue(
            app.descendants(matching: .any)["24.0k of 128.0k tokens used"]
                .waitForExistence(timeout: 3))
        let compactThread = app.buttons["Compact Thread"]
        XCTAssertTrue(compactThread.waitForExistence(timeout: 3))
        XCTAssertTrue(compactThread.isEnabled)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        attachmentButton.tap()
        let photoLibrary = app.buttons["Photo Library"]
        XCTAssertTrue(photoLibrary.waitForExistence(timeout: 3))
        XCTAssertTrue(photoLibrary.isEnabled)
        XCTAssertTrue(app.buttons["Camera"].waitForExistence(timeout: 3))
        let mediaFile = app.buttons["File"]
        XCTAssertTrue(mediaFile.waitForExistence(timeout: 3))
        XCTAssertTrue(mediaFile.isEnabled)
        XCTAssertTrue(app.buttons["Verbosity"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Web Search"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Skills"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Connectors"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.buttons["Permissions"].exists)
        XCTAssertEqual(
            app.buttons.matching(NSPredicate(format: "label == %@", "Model")).count,
            1)
        XCTAssertFalse(app.buttons["Thinking"].exists)
        XCTAssertFalse(app.buttons["Fast"].exists)
        XCTAssertFalse(self.app?.buttons["Voice Memo"].exists == true)
        self.attachScreenshot(named: "chat-composer-capabilities")
        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        attachmentButton.tap()
        app.buttons["Skills"].tap()
        XCTAssertTrue(app.buttons["Auto Review"].waitForExistence(timeout: 3))
        let disabledSkill = app.buttons["Disabled Skill — Disabled in the Gateway configuration."]
        XCTAssertTrue(disabledSkill.waitForExistence(timeout: 3))
        XCTAssertFalse(disabledSkill.isEnabled)
        self.attachScreenshot(named: "chat-composer-skills")
        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()

        attachmentButton.tap()
        app.buttons["Connectors"].tap()
        XCTAssertTrue(app.buttons["GitHub"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Linear"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-connectors")
        app.buttons["GitHub"].tap()
        XCTAssertTrue(app.buttons["Enabled for this session"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Tool Access"].waitForExistence(timeout: 3))
        app.buttons["Tool Access"].tap()
        XCTAssertTrue(app.buttons["Search code"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["Create issue"].waitForExistence(timeout: 3))
        self.attachScreenshot(named: "chat-composer-tool-access")
        self.app?.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        self.attachScreenshot(named: "chat-composer-compact")
    }

    func verifyModelSelection(in app: XCUIApplication, actions: XCUIElement, popover: XCUIElement) {
        let expandedProviderDrawer = app.buttons["chat-model-provider-drawer-openai"]
        XCTAssertTrue(expandedProviderDrawer.waitForExistence(timeout: 5))
        expandedProviderDrawer.tap()
        let collapsedProviderDrawer = app.buttons["chat-model-provider-drawer-openai"]
        self.waitForValue("Collapsed", of: collapsedProviderDrawer)
        let anthropicDrawer = app.buttons["chat-model-provider-drawer-anthropic"]
        XCTAssertTrue(anthropicDrawer.waitForExistence(timeout: 5))
        self.assertMinimumTouchTarget(anthropicDrawer)
        XCTAssertEqual(anthropicDrawer.value as? String, "Collapsed")
        anthropicDrawer.tap()
        let expandedAnthropicDrawer = app.buttons["chat-model-provider-drawer-anthropic"]
        self.waitForValue("Expanded", of: expandedAnthropicDrawer)
        let nonDefaultModel = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(nonDefaultModel.waitForExistence(timeout: 5))
        XCTAssertTrue(nonDefaultModel.images["chat-model-provider-icon-anthropic"].exists)
        self.assertMinimumTouchTarget(nonDefaultModel)
        nonDefaultModel.tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 3))

        actions.tap()
        let selectedNextModel = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(selectedNextModel.waitForExistence(timeout: 5))
        XCTAssertEqual(selectedNextModel.value as? String, "Selected")
        XCTAssertGreaterThan(
            selectedNextModel.images["chat-menu-selection-checkmark"].frame.minX,
            selectedNextModel.frame.midX)
        let restoredDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(restoredDefaultModel.waitForExistence(timeout: 5))
        restoredDefaultModel.tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 3))

        actions.tap()
        let reselectedDefaultModel = app.buttons["Default: openai/gpt-5.6-sol"]
        XCTAssertTrue(reselectedDefaultModel.waitForExistence(timeout: 5))
        XCTAssertEqual(reselectedDefaultModel.value as? String, "Selected")
        XCTAssertGreaterThan(
            reselectedDefaultModel.images["chat-menu-selection-checkmark"].frame.minX,
            reselectedDefaultModel.frame.midX)
    }

    /// A fresh simulator can show this system alert before the scene becomes active.
    /// Screenshot fixtures do not exercise notification authorization; leave the
    /// readiness assertion intact and answer only that specific launch prompt.
    func dismissScreenshotNotificationPrompt() {
        let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
        let alert = springboard.alerts.firstMatch
        let notificationTitle = alert.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "Would Like to Send You Notifications")).firstMatch
        guard notificationTitle.waitForExistence(timeout: 2) else { return }
        for title in ["Don’t Allow", "Don't Allow"] where alert.buttons[title].exists {
            alert.buttons[title].tap()
            return
        }
        XCTFail("Notification launch prompt has no denial action")
    }
}
