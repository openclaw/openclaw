import XCTest

// Reproduce with scripts/test-ios-shell-gateway.mjs --session-artifacts and an owned simulator.
// Pair it using the synthetic setup code documented at the top of that script, select Main Session,
// then forward TEST_RUNNER_OPENCLAW_IOS_ARTIFACTS_PROOF=1 to xcodebuild test.
// apps/ios/Tests/Fixtures/session-artifacts.json owns the deterministic titles and bytes below.
// This UI proof does not replace the transport's TLS, authorization, or cancellation tests.

@MainActor
final class SessionArtifactsUITests: XCTestCase {
    func testFindPreviewAndShareSessionArtifacts() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_ARTIFACTS_PROOF"] == "1",
            "Requires Debug already paired with an isolated synthetic Gateway and its Main Session selected")
        continueAfterFailure = false
        let app = XCUIApplication()
        app.launchArguments = [
            "--openclaw-initial-tab", "chat", "--openclaw-initial-destination", "chat",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        let composer = app.descendants(matching: .any)["chat-message-input"]
        XCTAssertTrue(composer.waitForExistence(timeout: 20), "Pair the isolated fixture Gateway before this proof")
        let draft = composer.value as? String
        let openArtifacts = app.buttons["chat-session-artifacts"]
        XCTAssertTrue(openArtifacts.waitForExistence(timeout: 5))
        XCTAssertTrue(openArtifacts.isHittable)
        XCTAssertLessThanOrEqual(openArtifacts.frame.maxX, app.buttons["Chat actions"].frame.minX)
        self.capture(app, named: "session-artifacts-toolbar")
        openArtifacts.tap()

        let project = self.rows(in: app, title: "Project brief.txt").firstMatch
        XCTAssertTrue(project.waitForExistence(timeout: 15))
        self.capture(app, named: "session-artifacts-list")
        let search = app.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        search.typeText("Notes")
        let notes = self.rows(in: app, title: "Notes.txt")
        XCTAssertTrue(notes.element(boundBy: 1).waitForExistence(timeout: 5))
        XCTAssertEqual(notes.count, 2, "Files with the same title must retain their distinct identities")

        self.replaceSearch(search, with: "Project")
        XCTAssertTrue(project.waitForExistence(timeout: 5))
        project.tap()
        let textPreview = app.staticTexts["artifact-preview-text"]
        XCTAssertTrue(textPreview.waitForExistence(timeout: 10))
        XCTAssertTrue(textPreview.label.contains("A native place to find, preview, and save files"))
        self.capture(app, named: "session-artifact-text-preview")
        self.backToArtifacts(app)
        XCTAssertEqual(search.value as? String, "Project", "Returning from preview preserves the search")
        self.replaceSearch(search, with: "")
        // Native search uses a close icon on newer iOS, and Cancel on older layouts.
        let closeSearch = app.buttons.matching(NSPredicate(format: "label IN %@", ["close", "Cancel"])).firstMatch
        XCTAssertTrue(closeSearch.waitForExistence(timeout: 5))
        closeSearch.tap()
        XCTAssertTrue(app.buttons["artifacts-done"].waitForExistence(timeout: 5))

        let typeFilter = app.buttons["artifact-type-filter"]
        XCTAssertTrue(typeFilter.waitForExistence(timeout: 5))
        typeFilter.tap()
        app.buttons["Images"].tap()
        let image = self.rows(in: app, title: "Color study.png").firstMatch
        XCTAssertTrue(image.waitForExistence(timeout: 5))
        XCTAssertFalse(project.exists)
        typeFilter.tap()
        app.buttons["Documents"].tap()
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
        XCTAssertTrue(closeShare.waitForNonExistence(timeout: 5))
        self.backToArtifacts(app)
        XCTAssertTrue(typeFilter.label.contains("Documents") || typeFilter.value as? String == "Documents")
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

    private func replaceSearch(_ search: XCUIElement, with value: String) {
        search.tap()
        let previous = search.value as? String ?? ""
        search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: previous.count) + value)
    }

    private func backToArtifacts(_ app: XCUIApplication) {
        let back = app.navigationBars["Preview"].buttons["Artifacts"]
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
