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
        XCTAssertFalse(
            model.supportsFastMode,
            "Fixture must distinguish published applicability from provider inference")
        XCTAssertFalse(model.thinkingLevels.isEmpty)
        continueAfterFailure = false

        let app = XCUIApplication()
        defer { app.terminate() }
        self.launchCatalogApp(app, setupCode: setupCode)

        let modelPicker = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(modelPicker.waitForExistence(timeout: 30))
        XCTAssertTrue(self.waitUntilEnabled(modelPicker), app.debugDescription)
        modelPicker.tap()
        self.capture(app, named: "opened-model-menu")
        let unknownRow = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "catalog-proof/fixture")).firstMatch
        XCTAssertTrue(unknownRow.waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(unknownRow.isEnabled)
        let authRequiredRow = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "anthropic/claude-fixture")).firstMatch
        XCTAssertTrue(authRequiredRow.waitForExistence(timeout: 10))
        XCTAssertFalse(authRequiredRow.isEnabled)
        let modelRow = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "\(model.provider)/\(model.id)")).firstMatch
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
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        app.buttons["chat-model-sign-in"].tap()
        let signIn = app.buttons["Catalog fixture sign-in"]
        XCTAssertTrue(signIn.waitForExistence(timeout: 15))
        signIn.tap()
        XCTAssertTrue(app.staticTexts["Provider sign-in"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.staticTexts["CATALOG-1234"].waitForExistence(timeout: 15))
        XCTAssertTrue(app.descendants(matching: .any)["model-auth-external-url"].exists)
        XCTAssertFalse(app.staticTexts["Sign-in finished."].exists)
        self.capture(app, named: "published-device-code")
        app.buttons["Continue"].tap()
        let confirm = app.switches["Confirm"]
        XCTAssertTrue(confirm.waitForExistence(timeout: 10))
        confirm.tap()
        app.buttons["Continue"].tap()
        let account = app.descendants(matching: .any)["model-auth-provider-catalog-proof"]
        let connected = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "Connected"), object: account)
        XCTAssertEqual(XCTWaiter.wait(for: [connected], timeout: 20), .completed)
        self.capture(app, named: "published-auth-state")
        let evidence = XCTAttachment(data: catalogData, uniformTypeIdentifier: "public.json")
        evidence.name = "gateway-published-model"
        evidence.lifetime = .keepAlways
        self.add(evidence)
    }

    func testGuestModelPolicyRetiresOpenChoices() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_GUEST_MODEL_POLICY_PROOF"] == "1",
            "Requires the isolated shell Gateway with --guest-model-policy")
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        let fixtureURL = try XCTUnwrap(
            environment["OPENCLAW_IOS_MODEL_POLICY_FIXTURE_URL"].flatMap(URL.init(string:)))
        guard fixtureURL.scheme == "http", fixtureURL.host == "127.0.0.1" else {
            XCTFail("Guest model proof requires the owned loopback fixture")
            return
        }
        // The same assertions run on the true pre-fix app. Keep capturing later
        // states after its expected policy failures; do not turn them into passes.
        continueAfterFailure = true
        let app = XCUIApplication()
        defer { app.terminate() }
        self.launchCatalogApp(app, setupCode: setupCode)

        let inlineModel = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(inlineModel.waitForExistence(timeout: 30))
        let initial = try await self.policyRequest(fixtureURL, path: "await-catalog")
        XCTAssertFalse(initial.operatorGrants.isEmpty)
        for grant in initial.operatorGrants {
            XCTAssertEqual(grant, ["operator.sessions.write"])
        }
        XCTAssertEqual(initial.savedModel, "fixture/excluded")
        let history = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@", initial.historyText)).firstMatch
        XCTAssertTrue(history.waitForExistence(timeout: 8))
        let draft = "Unsent Guest policy draft."
        let input = app.descendants(matching: .any)["chat-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText(draft)
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2)).tap()
        XCTAssertTrue(app.keyboards.firstMatch.waitForNonExistence(timeout: 3))

        self.assertGuestInlineModel(
            inlineModel, value: "primary", failureID: "guest-model-policy:permitted:current-selection")
        self.capture(app, named: "guest-model-permitted-inline")
        let permitted = self.openPolicyActions(app)
        self.expandPolicyProvider(permitted)
        XCTAssertTrue(permitted.buttons["fixture/primary"].exists)
        XCTAssertFalse(permitted.buttons["fixture/excluded"].exists)
        let defaultRow = permitted.buttons["Default: fixture/primary"]
        XCTAssertTrue(defaultRow.exists, "guest-model-policy:permitted:approved-default")
        if defaultRow.exists {
            XCTAssertEqual(defaultRow.value as? String, "Selected")
        }
        self.capture(app, named: "guest-model-permitted-actions")
        self.dismissPolicyActions(app)

        _ = try await self.policyRequest(fixtureURL, path: "null", method: "POST")
        _ = try await self.policyRequest(fixtureURL, path: "await-catalog")
        self.assertGuestInlineModel(
            inlineModel, value: "Default", failureID: "guest-model-policy:null:current-selection")
        self.capture(app, named: "guest-model-null-inline")
        let opened = self.openPolicyActions(app)
        self.expandPolicyProvider(opened)
        XCTAssertTrue(opened.buttons["fixture/custom"].waitForExistence(timeout: 3))
        XCTAssertTrue(opened.buttons["fixture/primary"].waitForNonExistence(timeout: 3))
        self.assertNoPolicyDefault(in: opened, failureID: "guest-model-policy:null:default-absent")
        self.capture(app, named: "guest-model-null-actions")

        _ = try await self.policyRequest(fixtureURL, path: "hold", method: "POST")
        let held = try await self.policyRequest(fixtureURL, path: "await-catalog")
        XCTAssertGreaterThan(held.heldReads, 0, "The real app must request the invalidated catalog")
        XCTAssertTrue(
            opened.buttons["chat-model-provider-drawer-fixture"].waitForNonExistence(timeout: 3),
            "guest-model-policy:held:open-provider-retired")
        XCTAssertFalse(opened.buttons["fixture/custom"].exists, "guest-model-policy:held:open-choice-retired")
        self.assertNoPolicyDefault(in: opened, failureID: "guest-model-policy:held:default-absent")
        self.capture(app, named: "guest-model-held-actions")

        let failed = try await self.policyRequest(fixtureURL, path: "fail", method: "POST")
        XCTAssertTrue(failed.reads.contains { $0.phase == "held" && $0.outcome == "failed" })
        self.dismissPolicyActions(app)
        let loadError = app.staticTexts["Model choices could not load. Reconnect and try again."]
        XCTAssertTrue(loadError.waitForExistence(timeout: 3))
        self.assertGuestInlineModel(
            inlineModel, value: "Default", failureID: "guest-model-policy:failed:current-selection")
        XCTAssertEqual(input.value as? String, draft)
        XCTAssertTrue(history.exists)
        self.capture(app, named: "guest-model-failed-inline")
        let failedMenu = self.openPolicyActions(app)
        XCTAssertFalse(
            failedMenu.buttons["chat-model-provider-drawer-fixture"].exists,
            "guest-model-policy:failed:provider-retired")
        self.assertNoPolicyDefault(in: failedMenu, failureID: "guest-model-policy:failed:default-absent")
        self.capture(app, named: "guest-model-failed-actions")
        self.dismissPolicyActions(app)

        _ = try await self.policyRequest(fixtureURL, path: "recover", method: "POST")
        let recovered = try await self.policyRequest(fixtureURL, path: "await-catalog")
        self.assertGuestInlineModel(
            inlineModel, value: "primary", failureID: "guest-model-policy:recovered:current-selection")
        XCTAssertTrue(loadError.waitForNonExistence(timeout: 3))
        XCTAssertEqual(input.value as? String, draft)
        XCTAssertTrue(history.exists)
        XCTAssertEqual(recovered.savedModel, initial.savedModel)
        XCTAssertEqual(recovered.historyText, initial.historyText)
        XCTAssertGreaterThan(recovered.historyReads, 0)
        XCTAssertEqual(recovered.patchCount, 0, "Projection and invalidation must not rewrite the saved session")
        XCTAssertTrue(recovered.events.allSatisfy { $0.delivered > 0 })
        self.capture(app, named: "guest-model-recovered-inline")
        let finalMenu = self.openPolicyActions(app)
        self.expandPolicyProvider(finalMenu)
        XCTAssertTrue(
            finalMenu.buttons["Default: fixture/primary"].exists,
            "guest-model-policy:recovered:approved-default")
        XCTAssertTrue(finalMenu.buttons["fixture/fallback"].exists)
        XCTAssertFalse(finalMenu.buttons["fixture/custom"].exists)
        XCTAssertFalse(finalMenu.buttons["fixture/excluded"].exists)
        self.capture(app, named: "guest-model-recovered-actions")
    }

    private func launchCatalogApp(_ app: XCUIApplication, setupCode: String) {
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
    }

    private func assertGuestInlineModel(_ element: XCUIElement, value: String, failureID: String) {
        let expectation = XCTNSPredicateExpectation(predicate: NSPredicate(format: "value == %@", value), object: element)
        XCTAssertEqual(XCTWaiter.wait(for: [expectation], timeout: 3), .completed, failureID)
        // Current iOS gates the inline menu on operator.write. This proves the
        // Guest's visible label without granting a broader scope to open it.
        XCTAssertFalse(element.isEnabled)
    }

    private func openPolicyActions(_ app: XCUIApplication) -> XCUIElement {
        let actions = app.buttons["Chat actions"]
        XCTAssertTrue(actions.waitForExistence(timeout: 3))
        actions.tap()
        let popover = app.descendants(matching: .any)["chat-actions-popover"]
        XCTAssertTrue(popover.waitForExistence(timeout: 5))
        return popover
    }

    private func expandPolicyProvider(_ popover: XCUIElement) {
        let provider = popover.buttons["chat-model-provider-drawer-fixture"]
        XCTAssertTrue(provider.waitForExistence(timeout: 3))
        if provider.exists, provider.value as? String != "Expanded" {
            provider.tap()
        }
    }

    private func assertNoPolicyDefault(in popover: XCUIElement, failureID: String) {
        let defaultRow = popover.buttons.matching(NSPredicate(
            format: "label == %@ OR label BEGINSWITH %@", "Default", "Default: ")).firstMatch
        XCTAssertTrue(defaultRow.waitForNonExistence(timeout: 3), failureID)
    }

    private func dismissPolicyActions(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.05, dy: 0.5)).tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-actions-popover"].waitForNonExistence(timeout: 3))
    }

    private func policyRequest(
        _ baseURL: URL,
        path: String,
        method: String = "GET") async throws -> GuestPolicyState
    {
        let url = baseURL.appendingPathComponent("model-policy").appendingPathComponent(path)
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.timeoutInterval = 3
        let (data, response) = try await URLSession.shared.data(for: request)
        let evidence = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        evidence.name = "guest-model-wire-\(path)"
        evidence.lifetime = .keepAlways
        self.add(evidence)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(GuestPolicyState.self, from: data)
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

    private struct GuestPolicyState: Decodable {
        struct Read: Decodable {
            let phase: String
            let outcome: String
        }

        struct Event: Decodable {
            let delivered: Int
        }

        let operatorGrants: [[String]]
        let reads: [Read]
        let heldReads: Int
        let patchCount: Int
        let events: [Event]
        let savedModel: String
        let historyText: String
        let historyReads: Int
    }
}
