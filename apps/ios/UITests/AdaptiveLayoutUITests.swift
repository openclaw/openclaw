import UIKit
import XCTest

@MainActor
final class AdaptiveLayoutUITests: XCTestCase {
    func testNewSessionOptionsRemainReachableAtAccessibilitySize() {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat",
            "--openclaw-screenshot-mode",
            "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "light",
            "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityXXXL",
        ]
        app.launch()
        defer { app.terminate() }

        let actions = app.buttons["Chat actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 30))
        actions.tap()
        let options = app.buttons["New session options…"]
        XCTAssertTrue(options.waitForExistence(timeout: 5))
        options.tap()

        let title = app.staticTexts["New Thread"]
        let cancel = app.buttons["Cancel"]
        let create = app.buttons["Create Thread"]
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertTrue(cancel.exists)
        XCTAssertTrue(create.exists)
        let window = app.windows.firstMatch.frame
        let observation = XCTAttachment(string: [
            "window=\(window)",
            "title=\(title.frame)",
            "cancel=\(cancel.frame); hittable=\(cancel.isHittable)",
            "create=\(create.frame)",
        ].joined(separator: "\n"))
        observation.name = "new-session-accessibility-baseline"
        observation.lifetime = .keepAlways
        add(observation)
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "new-session-accessibility-baseline"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        XCTAssertTrue(window.contains(title.frame), "New Thread title is clipped")
        XCTAssertTrue(title.isHittable, "New Thread title is not visible")
        for _ in 0..<3 where !cancel.isHittable {
            app.swipeUp()
        }
        XCTAssertTrue(window.contains(cancel.frame), "Cancel remains clipped after scrolling")
        XCTAssertTrue(window.contains(create.frame), "Create Thread remains clipped after scrolling")
        XCTAssertTrue(cancel.isHittable, "Cancel must be reachable")
        cancel.tap()
        XCTAssertTrue(cancel.waitForNonExistence(timeout: 5))
    }

    func testChatToolbarFitsCurrentWindow() throws {
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "chat",
            "--openclaw-screenshot-mode",
            "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "light",
        ]
        app.launch()
        defer { app.terminate() }
        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30))
        let identity = app.buttons["chat-agent-identity"].firstMatch
        let actions = app.buttons["Chat actions"].firstMatch
        for control in [identity, actions] {
            XCTAssertTrue(control.waitForExistence(timeout: 5))
            let geometry = XCTAttachment(string: "window=\(app.windows.firstMatch.frame) control=\(control.frame)")
            geometry.lifetime = .keepAlways
            add(geometry)
            XCTAssertTrue(control.isHittable)
            XCTAssertGreaterThanOrEqual(control.frame.width, 44)
            XCTAssertGreaterThanOrEqual(control.frame.height, 44)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(control.frame))
        }
        self.capture("chat-toolbar-current-window", in: app)
        try self.assertToolbarPainted([identity, actions], in: app.windows.firstMatch)
        if abs(identity.frame.midY - actions.frame.midY) > 44 {
            identity.tap()
            let status = app.descendants(matching: .any)["chat-gateway-status-details"].firstMatch
            XCTAssertTrue(status.waitForExistence(timeout: 5), "Side-toolbar status needs visible feedback")
            input.tap()
            XCTAssertTrue(status.waitForNonExistence(timeout: 5))
        }
        actions.tap()
        let gatewaySettings = app.buttons["chat-gateway-settings"].firstMatch
        XCTAssertTrue(gatewaySettings.waitForExistence(timeout: 5))
        let menu = app.descendants(matching: .any)["chat-actions-popover"].firstMatch
        for _ in 0..<3 where !gatewaySettings.isHittable {
            menu.swipeUp()
        }
        XCTAssertTrue(gatewaySettings.isHittable)
        gatewaySettings.tap()
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(for: NSPredicate(format: "value == %@", "ready:gateway"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)
    }

    /// AX hit testing remains true when an ancestor mask clips native bar pixels.
    /// Use the light fixture to distinguish painted glyphs from the empty side strip.
    private func assertToolbarPainted(_ controls: [XCUIElement], in window: XCUIElement) throws {
        let bounds = CGRect(origin: .zero, size: window.frame.size)
        let format = UIGraphicsImageRendererFormat()
        format.scale = 1
        format.preferredRange = .standard
        let screenshot = window.screenshot().image
        let rendered = UIGraphicsImageRenderer(bounds: bounds, format: format).image { _ in
            screenshot.draw(in: bounds)
        }
        let image = try XCTUnwrap(rendered.cgImage)
        XCTAssertEqual(image.bitsPerPixel, 32)
        let data = try XCTUnwrap(image.dataProvider?.data)
        let pixels = try XCTUnwrap(CFDataGetBytePtr(data))
        for control in controls {
            let frame = control.frame.offsetBy(dx: -window.frame.minX, dy: -window.frame.minY)
                .intersection(bounds).integral
            var paintedPixels = 0
            for y in Int(frame.minY)..<Int(frame.maxY) {
                for x in Int(frame.minX)..<Int(frame.maxX) {
                    let offset = y * image.bytesPerRow + x * 4
                    if min(pixels[offset], pixels[offset + 1], pixels[offset + 2]) < 180 {
                        paintedPixels += 1
                    }
                }
            }
            XCTAssertGreaterThan(
                paintedPixels,
                20,
                "Toolbar control is tappable but visually clipped: \(control.label)")
        }
    }

    func testOfflineChatAdaptsAcrossRotationAndRemembersHiddenSidebar() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "chat",
            "--openclaw-appearance", "light",
            "--openclaw-ui-test-readiness",
            "-onboarding.completed", "YES",
            "-gateway.preferredStableID", "adaptive-offline",
            "-onboarding.quickSetupDismissed", "YES",
        ]
        app.launch()
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try self.requireExpandedWindow(in: app)
        self.rotateWindow(in: app, portrait: true)
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let hide = app.buttons.matching(identifier: "RootTabs.Sidebar.Hide").firstMatch
        let usesCompactPortrait = app.windows.firstMatch.frame.width < 800
        XCTAssertTrue((usesCompactPortrait ? show : hide).waitForExistence(timeout: 30))
        self.capture(
            usesCompactPortrait ? "expanded-portrait-drawer-closed" : "expanded-portrait-persistent-sidebar",
            in: app)

        self.rotateWindow(in: app, portrait: false)
        XCTAssertTrue(hide.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(app.windows.firstMatch.frame.width, 800)
        self.capture("expanded-landscape-persistent-sidebar", in: app)
        hide.tap()
        XCTAssertTrue(show.waitForExistence(timeout: 5))
        self.capture("expanded-landscape-bounded-chat", in: app)

        self.rotateWindow(in: app, portrait: true)
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        self.rotateWindow(in: app, portrait: false)
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        XCTAssertFalse(hide.exists)
        self.capture("expanded-landscape-hidden-preference-restored", in: app)
    }

    func testPhoneOfflineChatKeepsCompactLayout() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "iPhone compact layout")
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "chat",
            "--openclaw-appearance", "light",
            "--openclaw-ui-test-readiness",
            "-onboarding.completed", "YES",
            "-gateway.preferredStableID", "adaptive-offline",
            "-onboarding.quickSetupDismissed", "YES",
        ]
        app.launch()
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try XCTSkipUnless(
            min(app.windows.firstMatch.frame.width, app.windows.firstMatch.frame.height) < 500,
            "Requires compact phone space")
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        XCTAssertTrue(show.waitForExistence(timeout: 30))
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let transcript = app.descendants(matching: .any)["chat-transcript"].firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        // The composer surface is the reading column of whatever width the chat pane gets.
        XCTAssertEqual(composer.frame.width, Self.expectedColumn(paneWidth: transcript.frame.width), accuracy: 1)
        self.capture("iphone-portrait-compact-chat", in: app)
        self.rotateWindow(in: app, portrait: false, minimumWidth: 0)
        XCTAssertTrue(show.exists)
        self.capture("iphone-landscape-compact-chat", in: app)
        self.rotateWindow(in: app, portrait: true)
        show.tap()
        let overview = app.buttons["RootTabs.Sidebar.Destination.overview"]
        XCTAssertTrue(overview.waitForExistence(timeout: 5))
        overview.tap()
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(for: NSPredicate(format: "value == %@", "ready:overview"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)
        XCTAssertTrue(show.waitForExistence(timeout: 5), "Selecting a drawer row must navigate and close it")
        let viewport = app.scrollViews.containing(.button, identifier: "Gateway settings").firstMatch
        XCTAssertTrue(viewport.waitForExistence(timeout: 5))
        let detailFrame = viewport.frame
        let window = app.windows.firstMatch
        let windowFrame = window.frame
        // Save the visible detail's trailing edge before the drawer hides its accessibility tree.
        let dismissalPoint = window.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(
            dx: detailFrame.maxX - windowFrame.minX - 8,
            dy: detailFrame.midY - windowFrame.minY))
        show.tap()
        XCTAssertTrue(overview.waitForExistence(timeout: 5))
        dismissalPoint.tap()
        XCTAssertTrue(show.waitForExistence(timeout: 5), "Tapping exposed detail must dismiss the drawer")
    }

    /// Synthetic conversation content is used only to exercise native interaction.
    /// This test deliberately does not attach screenshots as product evidence.
    func testChatDraftAndFocusSurviveRotationAndWideSidebarToggles() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "chat",
            "--openclaw-screenshot-mode",
            "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "light",
        ]
        app.launch()
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try self.requireExpandedWindow(in: app)
        self.rotateWindow(in: app, portrait: true)
        let usesCompactPortrait = app.windows.firstMatch.frame.width < 800
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        XCTAssertTrue(readiness.waitForExistence(timeout: 30))
        self.expectation(for: NSPredicate(format: "value == %@", "ready:chat"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 15)

        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let hide = app.buttons.matching(identifier: "RootTabs.Sidebar.Hide").firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        XCTAssertTrue((usesCompactPortrait ? show : hide).waitForExistence(timeout: 10))
        input.tap()
        // Application-level typing does not re-tap the field: subsequent keystrokes
        // prove that the same composer remains the keyboard's recipient. One
        // identifying key per transition avoids conflating focus with batch typing latency.
        app.typeText("draft")
        self.assertDraft("draft", in: input)

        self.rotateWindow(in: app, portrait: false)
        XCTAssertTrue(hide.waitForExistence(timeout: 10))
        self.assertDraft("draft", in: input)
        app.typeText("1")
        self.assertDraft("draft1", in: input)

        hide.tap()
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        self.assertDraft("draft1", in: input)
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        XCTAssertTrue(composer.exists)
        XCTAssertGreaterThan(composer.frame.width, 700)
        XCTAssertLessThanOrEqual(composer.frame.width, 768)
        app.typeText("2")
        self.assertDraft("draft12", in: input)

        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 10))
        self.assertDraft("draft12", in: input)
        app.typeText("3")
        self.assertDraft("draft123", in: input)

        self.rotateWindow(in: app, portrait: true)
        XCTAssertTrue((usesCompactPortrait ? show : hide).waitForExistence(timeout: 10))
        self.assertDraft("draft123", in: input)
        app.typeText("4")
        self.assertDraft("draft1234", in: input)
        XCTAssertEqual(hide.exists, !usesCompactPortrait)
    }

    /// Synthetic transport data exercises the real completed and streaming renderers.
    /// No fixture screenshots are attached as product evidence.
    func testAssistantAndStreamingResponsesShareComposerColumn() throws {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .landscapeLeft
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "chat",
            "--openclaw-screenshot-mode", "--openclaw-ui-test-readiness",
            "--openclaw-sidebar-visibility", "hidden",
            "--openclaw-hold-initial-chat-run", "--openclaw-streaming-layout-fixture",
        ]
        app.launch()
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        try self.requireExpandedWindow(in: app)
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        let completed = app.descendants(matching: .any)["chat-assistant-message-body"].firstMatch
        XCTAssertTrue(completed.waitForExistence(timeout: 30))
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        self.rotateWindow(in: app, portrait: false)
        self.assertReply(completed, in: app)
        XCTAssertGreaterThan(completed.frame.width, 700, "Must detect the former 560pt assistant cap")

        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let hide = app.buttons.matching(identifier: "RootTabs.Sidebar.Hide").firstMatch
        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        self.assertReply(completed, in: app)
        hide.tap()
        XCTAssertTrue(show.waitForExistence(timeout: 5))

        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        input.tap()
        input.typeText("Check streaming width")
        app.buttons["chat-send-message"].tap()
        let streaming = app.descendants(matching: .any)["chat-streaming-assistant-body"].firstMatch
        XCTAssertTrue(streaming.waitForExistence(timeout: 10))
        self.assertReply(streaming, in: app)
        XCTAssertGreaterThan(streaming.frame.width, 650, "Must detect the former streaming bubble cap")
        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        self.assertReply(streaming, in: app)
        self.rotateWindow(in: app, portrait: true)
        self.assertReply(streaming, in: app)
    }

    /// Spec §2: one width rule from the measured pane, on iPhone and on iPad in both orientations.
    func testTranscriptColumnFollowsWidthRule() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = self.launchColumnFixture()
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30))
        // A long prompt reaches the bubble cap; the fixture's own prompt is a single short line.
        input.tap()
        input.typeText(String(repeating: "Check how wide a long user message may grow. ", count: 6))
        app.buttons["chat-send-message"].tap()
        self.assertColumnGeometry(in: app, context: "portrait")

        // Only iPad landscape is free of horizontal safe areas that the pane excludes.
        guard UIDevice.current.userInterfaceIdiom == .pad else { return }
        self.rotateWindow(in: app, portrait: false, minimumWidth: 0)
        self.assertColumnGeometry(in: app, context: "landscape")
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let hide = app.buttons.matching(identifier: "RootTabs.Sidebar.Hide").firstMatch
        if hide.exists {
            hide.tap()
            XCTAssertTrue(show.waitForExistence(timeout: 5))
            self.assertColumnGeometry(in: app, context: "landscape-hidden-sidebar")
        }
    }

    /// The width rule ignores text size, and the largest size clips neither the header nor the composer.
    func testTranscriptColumnHoldsAtAccessibilityTextSize() {
        continueAfterFailure = false
        XCUIDevice.shared.orientation = .portrait
        let app = self.launchColumnFixture(contentSize: "UICTContentSizeCategoryAccessibilityXXXL")
        defer {
            app.terminate()
            XCUIDevice.shared.orientation = .portrait
        }
        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        XCTAssertTrue(input.waitForExistence(timeout: 30))
        let window = app.windows.firstMatch.frame
        let identity = app.buttons["chat-agent-identity"].firstMatch
        let actions = app.buttons["Chat actions"].firstMatch
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        for (name, element) in [("identity", identity), ("actions", actions), ("composer", composer)] {
            XCTAssertTrue(element.waitForExistence(timeout: 5), "\(name) is missing")
            XCTAssertTrue(window.contains(element.frame), "\(name) is clipped: \(element.frame) in \(window)")
        }
        XCTAssertTrue(identity.isHittable)
        XCTAssertTrue(actions.isHittable)
        XCTAssertTrue(input.isHittable)
        self.capture("accessibility-xxxl-column-portrait", in: app)
        self.assertColumnGeometry(in: app, context: "accessibility-xxxl-portrait")
        guard UIDevice.current.userInterfaceIdiom == .pad else { return }
        self.rotateWindow(in: app, portrait: false, minimumWidth: 0)
        XCTAssertTrue(app.windows.firstMatch.frame.contains(composer.frame), "Composer is clipped in landscape")
        self.assertColumnGeometry(in: app, context: "accessibility-xxxl-landscape")
    }

    private func launchColumnFixture(contentSize: String? = nil) -> XCUIApplication {
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-destination", "chat",
            "--openclaw-screenshot-mode",
            "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "light",
            "--openclaw-long-chat-fixture",
        ] + (contentSize.map { ["-UIPreferredContentSizeCategoryName", $0] } ?? [])
        app.launch()
        app.activate()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        return app
    }

    private func requireExpandedWindow(in app: XCUIApplication) throws {
        try XCTSkipUnless(
            min(app.windows.firstMatch.frame.width, app.windows.firstMatch.frame.height) >= 500,
            "Requires expanded window space")
    }

    /// Spec §2, restated: the UI test process cannot import the app's `ChatColumnLayout`.
    private static func expectedColumn(paneWidth: CGFloat) -> CGFloat {
        let margin: CGFloat = paneWidth < 700 ? 16 : 24
        return min(768, paneWidth - 2 * margin)
    }

    private static func expectedUserBubbleMax(column: CGFloat) -> CGFloat {
        (column < 600 ? 0.82 : 0.68) * column
    }

    /// A reply spans the column: it ends on the column's trailing edge and starts on its leading
    /// edge, or one avatar gutter (30pt avatar + 8pt gap) inside it where the avatar shows.
    private func assertReply(_ reply: XCUIElement, in app: XCUIApplication, context: String = "") {
        let pane = app.descendants(matching: .any)["chat-transcript"].firstMatch.frame
        let composer = app.otherElements["chat-composer-surface"].firstMatch.frame
        let column = Self.expectedColumn(paneWidth: pane.width)
        let replyFrame = reply.frame
        print("Column \(context): pane=\(pane) column=\(column) composer=\(composer) reply=\(replyFrame)")
        XCTAssertGreaterThan(replyFrame.height, 0, context)
        XCTAssertEqual(composer.width, column, accuracy: 1, "\(context): composer surface is not the column")
        XCTAssertEqual(composer.midX, pane.midX, accuracy: 1, "\(context): column is not centred")
        XCTAssertEqual(replyFrame.maxX, composer.maxX, accuracy: 1, "\(context): reply stops short of the column")
        let gutter = replyFrame.minX - composer.minX
        XCTAssertTrue(
            abs(gutter) <= 1 || (UIDevice.current.userInterfaceIdiom == .pad && abs(gutter - 38) <= 1),
            "\(context): reply is inset by \(gutter)pt instead of spanning the column")
    }

    private func assertColumnGeometry(in app: XCUIApplication, context: String) {
        let pane = app.descendants(matching: .any)["chat-transcript"].firstMatch
        let reply = app.descendants(matching: .any)["chat-assistant-message-body"].firstMatch
        XCTAssertTrue(pane.waitForExistence(timeout: 10), context)
        XCTAssertTrue(reply.waitForExistence(timeout: 10), context)
        self.assertReply(reply, in: app, context: context)
        let column = Self.expectedColumn(paneWidth: pane.frame.width)
        let composer = app.otherElements["chat-composer-surface"].firstMatch.frame
        let users = app.descendants(matching: .any).matching(identifier: "chat-user-message-body")
            .allElementsBoundByIndex.filter { $0.exists && $0.frame.intersects(pane.frame) }
        XCTAssertFalse(users.isEmpty, "\(context): no user bubble on screen")
        for user in users {
            XCTAssertLessThanOrEqual(
                user.frame.width,
                Self.expectedUserBubbleMax(column: column) + 1,
                "\(context): user bubble exceeds the rule's cap")
            XCTAssertEqual(user.frame.maxX, composer.maxX, accuracy: 1, "\(context): user bubble leaves the column")
        }
        self.capture("column-\(context)", in: app)
    }

    private func assertDraft(_ draft: String, in input: XCUIElement) {
        // Use XCUI's normal snapshot synchronization rather than a second deadline
        // that can expire while a successful accessibility query is still running.
        let started = Date()
        let actual = input.value as? String
        print("Draft snapshot in \(Date().timeIntervalSince(started))s: \(String(describing: actual))")
        XCTAssertEqual(actual, draft)
    }

    private func rotateWindow(in app: XCUIApplication, portrait: Bool, minimumWidth: CGFloat = 800) {
        let window = app.windows.firstMatch
        let orientation = NSPredicate { _, _ in
            MainActor.assumeIsolated {
                let bounds = window.frame
                return portrait
                    ? bounds.width < bounds.height
                    : bounds.width >= minimumWidth && bounds.width > bounds.height
            }
        }
        guard !orientation.evaluate(with: window) else { return }
        // The Duo's inner display can be naturally wide. Toggle the device axis
        // once and verify the active window, rather than assuming portrait is tall.
        switch XCUIDevice.shared.orientation {
        case .landscapeLeft, .landscapeRight:
            XCUIDevice.shared.orientation = .portrait
        default:
            XCUIDevice.shared.orientation = .landscapeLeft
        }
        self.expectation(for: orientation, evaluatedWith: window)
        self.waitForExpectations(timeout: 10)
    }

    private func capture(_ name: String, in app: XCUIApplication) {
        let attachment = XCTAttachment(screenshot: app.windows.firstMatch.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
