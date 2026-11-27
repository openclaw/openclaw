import UIKit
import XCTest

@MainActor
final class AgentWorkspaceFilesUITests: XCTestCase {
    func testPreviewDistinguishesReadFailuresFromSizeAndFormat() async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_WORKSPACE_FIXTURE_URL"] != nil,
            "Requires test-ios-shell-gateway.mjs --workspace-preview")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_WORKSPACE_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        let app = XCUIApplication()
        defer { app.terminate() }
        let arguments = [
            "--openclaw-initial-destination", "chat", "--openclaw-ui-test-readiness",
            "-sidebar.pinnedPages", "files",
            "--openclaw-appearance", "light", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launchArguments = arguments + ["--openclaw-reset-onboarding"]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setup = app.textFields["Enter setup code"]
        XCTAssertTrue(setup.waitForExistence(timeout: 5))
        setup.tap()
        setup.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let files = app.buttons["RootTabs.Sidebar.Destination.files"]
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        files.tap()
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(for: NSPredicate(format: "value == %@", "ready:files"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)

        let readFailure = "Could not read this file. Return to Files and reopen it when available."
        let unsupported = "This file cannot be previewed. It may be binary or too large."
        let restored = "Restored project notes."
        let updated = "Updated project notes."
        for (phase, expected, canShare) in [
            ("missing", readFailure, false),
            ("restored", restored, true),
            ("too-large", unsupported, false),
            ("unsupported", unsupported, false),
            ("unavailable", readFailure, false),
            ("updated", updated, true),
        ] {
            var request = URLRequest(url: fixture.appendingPathComponent("workspace-preview")
                .appending(queryItems: [URLQueryItem(name: "phase", value: phase)]))
            request.httpMethod = "POST"
            let (_, response) = try await URLSession.shared.data(for: request)
            XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
            let entry = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Project notes.txt"))
                .firstMatch
            XCTAssertTrue(entry.waitForExistence(timeout: 10))
            entry.tap()
            let share = app.buttons["Share file"]
            XCTAssertTrue(share.waitForExistence(timeout: 5))
            let visible = app.staticTexts[expected].waitForExistence(timeout: 10)
            self.capture("preview-\(phase)", in: app)
            XCTAssertTrue(visible, "\(phase) must give truthful preview feedback")
            XCTAssertEqual(share.isEnabled, canShare)
            XCTAssertFalse(app.staticTexts.matching(NSPredicate(
                format: "label CONTAINS %@", "Private synthetic server diagnostic")).firstMatch.exists)
            for stale in [readFailure, unsupported, restored, updated] where stale != expected {
                XCTAssertFalse(app.staticTexts[stale].exists, "\(phase) retained stale preview state")
            }
            let back = app.navigationBars.buttons.firstMatch
            XCTAssertTrue(back.exists)
            XCTAssertNotEqual(back.label, "Share file")
            back.tap()
        }
    }

    private func capture(_ name: String, in app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }
}
