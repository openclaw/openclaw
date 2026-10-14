import UIKit
import XCTest

@MainActor
final class AdaptiveLayoutUITests: XCTestCase {
    func testOfflineChatAdaptsAcrossRotationAndRemembersHiddenSidebar() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "iPad adaptive navigation")
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
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let hide = app.buttons.matching(identifier: "RootTabs.Sidebar.Hide").firstMatch
        let usesCompactPortrait = app.frame.width < 800
        XCTAssertTrue((usesCompactPortrait ? show : hide).waitForExistence(timeout: 30))
        self.capture(usesCompactPortrait ? "ipad-portrait-drawer-closed" : "ipad-portrait-persistent-sidebar")

        XCUIDevice.shared.orientation = .landscapeLeft
        self.waitForLandscape(in: app)
        XCTAssertTrue(hide.waitForExistence(timeout: 10))
        XCTAssertGreaterThanOrEqual(app.frame.width, 800)
        self.capture("ipad-landscape-persistent-sidebar")
        hide.tap()
        XCTAssertTrue(show.waitForExistence(timeout: 5))
        self.capture("ipad-landscape-bounded-chat")

        XCUIDevice.shared.orientation = .portrait
        self.waitForPortrait(in: app)
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        XCUIDevice.shared.orientation = .landscapeLeft
        self.waitForLandscape(in: app)
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        XCTAssertFalse(hide.exists)
        self.capture("ipad-landscape-hidden-preference-restored")
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
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        XCTAssertTrue(show.waitForExistence(timeout: 30))
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        XCTAssertGreaterThan(composer.frame.width, app.frame.width - 32)
        self.capture("iphone-portrait-compact-chat")
        XCUIDevice.shared.orientation = .landscapeLeft
        self.waitForLandscape(in: app, minimumWidth: 0)
        XCTAssertTrue(show.exists)
        // Large iPhones must not inherit the iPad's 760pt reading cap.
        if app.frame.width >= 900 {
            XCTAssertGreaterThan(composer.frame.width, 760)
        }
        self.capture("iphone-landscape-compact-chat")
        XCUIDevice.shared.orientation = .portrait
        self.waitForPortrait(in: app)
        show.tap()
        let overview = app.buttons["RootTabs.Sidebar.Destination.overview"]
        XCTAssertTrue(overview.waitForExistence(timeout: 5))
        overview.tap()
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(for: NSPredicate(format: "value == %@", "ready:overview"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)
        XCTAssertTrue(show.waitForExistence(timeout: 5), "Selecting a drawer row must navigate and close it")
        show.tap()
        XCTAssertTrue(overview.waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(show.waitForExistence(timeout: 5), "Tapping exposed detail must dismiss the drawer")
    }

    /// Synthetic conversation content is used only to exercise native interaction.
    /// This test deliberately does not attach screenshots as product evidence.
    func testChatDraftAndFocusSurviveRotationAndWideSidebarToggles() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Requires an iPad")
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
        self.waitForPortrait(in: app)
        let usesCompactPortrait = app.frame.width < 800
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

        XCUIDevice.shared.orientation = .landscapeLeft
        self.waitForLandscape(in: app)
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

        XCUIDevice.shared.orientation = .portrait
        self.waitForPortrait(in: app)
        XCTAssertTrue((usesCompactPortrait ? show : hide).waitForExistence(timeout: 10))
        self.assertDraft("draft123", in: input)
        app.typeText("4")
        self.assertDraft("draft1234", in: input)
        XCTAssertEqual(hide.exists, !usesCompactPortrait)
    }

    /// Synthetic transport data exercises the real completed and streaming renderers.
    /// No fixture screenshots are attached as product evidence.
    func testAssistantAndStreamingResponsesShareComposerColumn() throws {
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .pad, "Requires an iPad")
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
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        let completed = app.descendants(matching: .any)["chat-assistant-message-body"].firstMatch
        XCTAssertTrue(completed.waitForExistence(timeout: 30))
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        self.waitForLandscape(in: app)
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
        self.assertReadingColumn(streaming, composer: composer, responseInset: 0)
        XCTAssertGreaterThan(streaming.frame.width, 700, "Must detect the former streaming bubble cap")
        show.tap()
        XCTAssertTrue(hide.waitForExistence(timeout: 5))
        self.assertReadingColumn(streaming, composer: composer, responseInset: 0)
        XCUIDevice.shared.orientation = .portrait
        self.waitForPortrait(in: app)
        self.assertReadingColumn(streaming, composer: composer, responseInset: 0)
    }

    private func assertReadingColumn(_ response: XCUIElement, composer: XCUIElement, responseInset: CGFloat) {
        let responseFrame = response.frame
        let composerFrame = composer.frame
        XCTAssertGreaterThan(responseFrame.height, 0)
        XCTAssertGreaterThan(composerFrame.width, 0)
        XCTAssertLessThanOrEqual(responseFrame.width, 760)
        // Composer chrome sits inside 4pt padding; completed rows inset their body by 2pt.
        print("Reading column: response=\(responseFrame), composer=\(composerFrame)")
        XCTAssertEqual(responseFrame.width + responseInset * 2, composerFrame.width + 8, accuracy: 1)
        XCTAssertEqual(responseFrame.midX, composerFrame.midX, accuracy: 2)
    }

    private func assertDraft(_ draft: String, in input: XCUIElement) {
        // Use XCUI's normal snapshot synchronization rather than a second deadline
        // that can expire while a successful accessibility query is still running.
        let started = Date()
        let actual = input.value as? String
        print("Draft snapshot in \(Date().timeIntervalSince(started))s: \(String(describing: actual))")
        XCTAssertEqual(actual, draft)
    }

    private func waitForPortrait(in app: XCUIApplication) {
        let portrait = NSPredicate { _, _ in
            MainActor.assumeIsolated { app.frame.width < app.frame.height }
        }
        self.expectation(for: portrait, evaluatedWith: app)
        self.waitForExpectations(timeout: 10)
    }

    private func waitForLandscape(in app: XCUIApplication, minimumWidth: CGFloat = 800) {
        let landscape = NSPredicate { _, _ in
            MainActor.assumeIsolated { app.frame.width >= minimumWidth && app.frame.width > app.frame.height }
        }
        self.expectation(for: landscape, evaluatedWith: app)
        self.waitForExpectations(timeout: 10)
    }

    private func capture(_ name: String) {
        let attachment = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
