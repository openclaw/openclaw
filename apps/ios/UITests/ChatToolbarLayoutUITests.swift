import UIKit
import XCTest

@MainActor
final class ChatToolbarLayoutUITests: XCTestCase {
    /// Native toolbar and safe-area geometry require the hosted scroll view.
    func testTranscriptUnderlapsBarsAndKeepsControlsReachable() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26, "Requires iOS 26")
        try XCTSkipUnless(UIDevice.current.userInterfaceIdiom == .phone, "Requires an iPhone")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-screenshot-mode", "--openclaw-long-chat-fixture",
            "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden",
            "--openclaw-ui-test-readiness",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.descendants(matching: .any)["RootTabs.Ready"].waitForExistence(timeout: 10))

        let transcript = app.scrollViews["chat-transcript"].firstMatch
        let composer = app.otherElements["chat-composer-surface"].firstMatch
        let latest = app.staticTexts["OPENCLAW_LONG_CHAT_LATEST"]
        XCTAssertTrue(transcript.waitForExistence(timeout: 8))
        XCTAssertTrue(composer.waitForExistence(timeout: 8))
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        let navigationBar = app.navigationBars.firstMatch
        XCTAssertGreaterThan(latest.frame.width, 0)
        XCTAssertGreaterThan(latest.frame.height, 0)
        XCTAssertGreaterThanOrEqual(latest.frame.minY, navigationBar.frame.maxY)
        XCTAssertLessThanOrEqual(latest.frame.maxY, composer.frame.minY + 1)

        XCTAssertLessThan(transcript.frame.minY, navigationBar.frame.maxY)
        XCTAssertGreaterThanOrEqual(transcript.frame.maxY, composer.frame.maxY)
        XCTAssertEqual(transcript.frame.minX, app.frame.minX, accuracy: 1)
        XCTAssertEqual(transcript.frame.maxX, app.frame.maxX, accuracy: 1)

        let input = app.descendants(matching: .any)["chat-message-input"].firstMatch
        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 5))
        let draft = "Native toolbar draft\nA second line"
        input.typeText(draft)
        XCTAssertEqual(input.value as? String, draft)
        XCTAssertLessThanOrEqual(composer.frame.maxY, keyboard.frame.minY + 1)
        transcript.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.15)).tap()
        XCTAssertTrue(keyboard.waitForNonExistence(timeout: 5))

        let actions = app.buttons["Chat actions"]
        XCTAssertTrue(actions.isHittable)
        // Tap near the edge of the required 44-point target, outside the ellipsis glyph.
        actions.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .withOffset(CGVector(dx: 18, dy: 0)).tap()
        let popover = app.descendants(matching: .any)["chat-actions-popover"].firstMatch
        XCTAssertTrue(popover.waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-show-reasoning-toggle"].exists)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.3)).tap()
        XCTAssertTrue(popover.waitForNonExistence(timeout: 5))

        let sidebar = app.buttons["RootTabs.Sidebar.Show"].firstMatch
        XCTAssertTrue(sidebar.isHittable)
        sidebar.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
            .withOffset(CGVector(dx: -18, dy: 0)).tap()
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.overview"].waitForExistence(timeout: 5))
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5)).tap()
        XCTAssertTrue(sidebar.waitForExistence(timeout: 5))
        XCTAssertEqual(input.value as? String, draft)
    }
}
