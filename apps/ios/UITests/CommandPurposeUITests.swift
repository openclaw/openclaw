import XCTest

@MainActor
final class CommandPurposeUITests: XCTestCase {
    /// The row names what ran; the agent's stated purpose stays in inspection
    /// (web ui/src/pages/chat/components/chat-tool-purpose.test.ts:32-63).
    func testCommandStepKeepsSuppliedPurposeInInspection() {
        let app = XCUIApplication()
        setupSnapshot(app)
        app.launchArguments += [
            "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden",
            "--openclaw-ui-test-readiness", "--openclaw-screenshot-mode",
            "--openclaw-appearance", "dark",
            "--openclaw-step-labels-fixture", "--openclaw-command-purpose-fixture",
        ]
        continueAfterFailure = false
        app.launch()
        defer { app.terminate() }
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 8))
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"]
        XCTAssertTrue(readiness.waitForExistence(timeout: 8))
        let ready = NSPredicate(format: "value == %@", "ready:chat")
        expectation(for: ready, evaluatedWith: readiness)
        waitForExpectations(timeout: 8)
        XCTAssertTrue(app.staticTexts["Local readiness checked."].waitForExistence(timeout: 8))
        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 5))
        work.tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(
            format: "value CONTAINS %@", "printf ready")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertFalse(row.label.contains("Check local readiness"), "Purpose replaced the command: \(row.label)")
        row.tap()
        XCTAssertTrue(app.staticTexts["Check local readiness"].waitForExistence(timeout: 5))
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = "command-purpose-expanded"
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
