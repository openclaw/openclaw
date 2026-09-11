import UIKit
import XCTest

@MainActor
final class ChatCatalogUITests: XCTestCase {
    func testLiveCatalogControlsMatchPublishedModel() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(environment["OPENCLAW_IOS_CATALOG_PROOF"] == "1", "Requires an isolated fixture Gateway")
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        let catalogData = try XCTUnwrap(environment["OPENCLAW_IOS_CATALOG_ROW"]?.data(using: .utf8))
        let model = try JSONDecoder().decode(CatalogModel.self, from: catalogData)
        XCTAssertFalse(model.supportsFastMode, "Fixture must distinguish published applicability from provider inference")
        XCTAssertFalse(model.thinkingLevels.isEmpty)
        continueAfterFailure = false

        let app = XCUIApplication()
        defer { app.terminate() }
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-tab", "chat",
            "--openclaw-initial-destination", "chat", "-AppleLanguages", "(en)",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setupField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupField.waitForExistence(timeout: 5))
        setupField.tap()
        setupField.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()

        let modelPicker = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 30))
        modelPicker.tap()
        let modelRow = app.buttons["\(model.provider)/\(model.id)"]
        XCTAssertTrue(modelRow.waitForExistence(timeout: 10), app.debugDescription)
        self.capture(app, named: "published-model-picker")
        modelRow.tap()
        let effort = app.buttons["chat-composer-inline-effort"]
        XCTAssertTrue(effort.waitForExistence(timeout: 10))
        XCTAssertTrue(self.waitUntilEnabled(effort))
        effort.tap()
        let thinking = app.buttons["Thinking"]
        XCTAssertTrue(thinking.waitForExistence(timeout: 5), app.debugDescription)
        self.capture(app, named: "published-fast-unavailable")
        XCTAssertFalse(app.buttons["Fast"].exists, "Fast must follow this model's published supportsFastMode=false")
        thinking.tap()
        for level in model.thinkingLevels {
            XCTAssertTrue(app.buttons["\(level.label) (override)"].waitForExistence(timeout: 5), app.debugDescription)
        }
        self.capture(app, named: "published-thinking-choices")
        let evidence = XCTAttachment(data: catalogData, uniformTypeIdentifier: "public.json")
        evidence.name = "gateway-published-model"
        evidence.lifetime = .keepAlways
        self.add(evidence)
    }

    private func waitUntilEnabled(_ element: XCUIElement) -> Bool {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: element)
        return XCTWaiter.wait(for: [expectation], timeout: 15) == .completed
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
    }

    private struct CatalogModel: Decodable {
        let id: String
        let provider: String
        let supportsFastMode: Bool
        let thinkingLevels: [ThinkingLevel]
    }

    private struct ThinkingLevel: Decodable {
        let label: String
    }
}
