import UIKit
import XCTest

@MainActor
final class AdaptiveLayoutUITests: XCTestCase {
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
        let transcript = app.scrollViews["chat-transcript"].firstMatch
        XCTAssertTrue(transcript.waitForExistence(timeout: 10))
        // Use available chat width; the Duo can reserve a side region for system UI.
        XCTAssertGreaterThan(composer.frame.width, transcript.frame.width - 32)
        self.capture("iphone-portrait-compact-chat", in: app)
        self.rotateWindow(in: app, portrait: false, minimumWidth: 0)
        XCTAssertTrue(show.exists)
        // Large iPhones must not inherit the iPad's 760pt reading cap.
        if transcript.frame.width >= 800 {
            XCTAssertGreaterThan(composer.frame.width, 760)
        }
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
        XCTAssertLessThanOrEqual(composer.frame.width, 760)
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
        self.assertReadingColumn(completed, composer: composer, responseInset: 2)
        XCTAssertGreaterThan(completed.frame.width, 700, "Must detect the former 560pt assistant cap")

        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let hide = app.buttons.matching(identifier: "RootTabs.Sidebar.Hide").firstMatch
        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        self.assertReadingColumn(completed, composer: composer, responseInset: 2)
        hide.tap()
        XCTAssertTrue(show.waitForExistence(timeout: 5))

        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        input.tap()
        input.typeText("Check streaming width")
        app.buttons["chat-send-message"].tap()
        let streaming = app.descendants(matching: .any)["chat-streaming-assistant-body"].firstMatch
        XCTAssertTrue(streaming.waitForExistence(timeout: 10))
        self.assertReadingColumn(streaming, composer: composer, responseInset: 12)
        XCTAssertGreaterThan(streaming.frame.width, 650, "Must detect the former streaming bubble cap")
        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        self.assertReadingColumn(streaming, composer: composer, responseInset: 12)
        self.rotateWindow(in: app, portrait: true)
        self.assertReadingColumn(streaming, composer: composer, responseInset: 12)
    }

    private func requireExpandedWindow(in app: XCUIApplication) throws {
        try XCTSkipUnless(
            min(app.windows.firstMatch.frame.width, app.windows.firstMatch.frame.height) >= 500,
            "Requires expanded window space")
    }

    private func assertReadingColumn(_ response: XCUIElement, composer: XCUIElement, responseInset: CGFloat) {
        let responseFrame = response.frame
        let composerFrame = composer.frame
        XCTAssertGreaterThan(responseFrame.height, 0)
        XCTAssertGreaterThan(composerFrame.width, 0)
        XCTAssertLessThanOrEqual(responseFrame.width, 760)
        // Expanded rows reserve 30pt for the avatar plus an 8pt gap.
        // Composer chrome sits inside 4pt padding. Completed rows inset by 2pt;
        // the streaming run adds 4pt padding plus 8pt clean-bubble chrome per side.
        print("Reading column: response=\(responseFrame), composer=\(composerFrame)")
        XCTAssertEqual(responseFrame.width + responseInset * 2 + 38, composerFrame.width + 8, accuracy: 1)
        XCTAssertEqual(responseFrame.midX, composerFrame.midX + 19, accuracy: 2)
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
