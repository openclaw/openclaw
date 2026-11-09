import XCTest

// Reproduce with scripts/test-ios-shell-gateway.mjs --session-artifacts and an owned simulator.
// Pair it using the synthetic setup code documented at the top of that script,
// then forward TEST_RUNNER_OPENCLAW_IOS_ARTIFACTS_PROOF=1 to xcodebuild test.
// A separate fixture conversation can use TEST_RUNNER_OPENCLAW_IOS_ARTIFACTS_SESSION_LABEL.
// apps/ios/Tests/Fixtures/session-artifacts.json owns the deterministic titles and bytes below.
// This UI proof does not replace the transport's TLS, authorization, or cancellation tests.

@MainActor
final class SessionArtifactsUITests: XCTestCase {
    func testFindPreviewAndShareSessionArtifacts() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_ARTIFACTS_PROOF"] == "1",
            "Requires Debug already paired with an isolated synthetic Gateway containing the artifact fixtures")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-tab", "chat", "--openclaw-initial-destination", "chat",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        let composer = app.descendants(matching: .any)["chat-message-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "Pair the isolated fixture Gateway before this proof")
        if let label = ProcessInfo.processInfo.environment["OPENCLAW_IOS_ARTIFACTS_SESSION_LABEL"] {
            let connected = app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "Gateway: Connected"))
                .firstMatch
            XCTAssertTrue(connected.waitForExistence(timeout: 20))
            app.buttons["RootTabs.Sidebar.Show"].tap()
            let session = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", label)).firstMatch
            XCTAssertTrue(session.waitForExistence(timeout: 10))
            session.tap()
            XCTAssertTrue(app.staticTexts["Project brief.txt"].waitForExistence(timeout: 10))
        }
        let draft = "Keep this unsent artifact review note."
        composer.tap()
        if let previous = composer.value as? String, !previous.isEmpty {
            composer.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count))
        }
        composer.typeText(draft)
        XCTAssertEqual(composer.value as? String, draft)
        let openArtifacts = app.buttons["chat-session-artifacts"]
        XCTAssertTrue(openArtifacts.waitForExistence(timeout: 5))
        XCTAssertTrue(openArtifacts.isHittable)
        self.capture(app, named: "session-artifacts-toolbar")
        openArtifacts.tap()

        let project = self.rows(in: app, title: "Project brief.txt").firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        self.capture(app, named: "session-artifacts-list")
        let notes = self.rows(in: app, title: "Notes.txt")
        XCTAssertTrue(notes.element(boundBy: 1).waitForExistence(timeout: 5))
        XCTAssertEqual(notes.count, 2, "Files with the same title must retain their distinct identities")

        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.tap()
        let textPreview = app.staticTexts["artifact-preview-text"]
        XCTAssertTrue(textPreview.waitForExistence(timeout: 10))
        XCTAssertTrue(textPreview.label.contains("A native place to find, preview, and save files"))
        self.capture(app, named: "session-artifact-text-preview")
        self.backToArtifacts(app)
        let pdf = self.rows(in: app, title: "Preview.pdf").firstMatch
        XCTAssertTrue(pdf.waitForExistence(timeout: 5))
        pdf.tap()
        XCTAssertTrue(app.staticTexts["Session artifacts preview"].waitForExistence(timeout: 10))
        XCTAssertTrue(app.staticTexts["Synthetic PDF - no personal information"].exists)
        self.capture(app, named: "session-artifact-pdf-preview")
        let share = app.buttons["artifact-share"]
        XCTAssertTrue(share.waitForExistence(timeout: 5))
        share.tap()
        XCTAssertTrue(app.otherElements["ActivityListView"].waitForExistence(timeout: 10))
        // System sharing can use a different language from the app.
        let closeShare = app.buttons["header.closeButton"]
        XCTAssertTrue(closeShare.waitForExistence(timeout: 10), "The authorized file must reach the system share sheet")
        self.capture(app, named: "session-artifact-system-share")
        closeShare.tap()
        // Verify dismissal by navigating back and checking the collection and draft below.
        // The system activity's cached AX elements can outlive its visible presentation.
        self.backToArtifacts(app)
        let done = app.buttons["artifacts-done"]
        XCTAssertTrue(done.waitForExistence(timeout: 5))
        done.tap()
        XCTAssertTrue(composer.waitForExistence(timeout: 5))
        XCTAssertEqual(composer.value as? String, draft, "Opening artifacts must not change the chat draft")
    }

    private func rows(in app: XCUIApplication, title: String) -> XCUIElementQuery {
        app.buttons.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ AND label CONTAINS %@", "artifact-row-", title))
    }

    private func backToArtifacts(_ app: XCUIApplication) {
        let back = app.navigationBars["Preview"].buttons["Outputs"]
        XCTAssertTrue(back.waitForExistence(timeout: 5))
        back.tap()
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let attachment = XCTAttachment(screenshot: app.screenshot())
        attachment.name = name
        attachment.lifetime = .keepAlways
        self.add(attachment)
    }
}
