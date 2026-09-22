import UIKit
import XCTest

@MainActor
final class SidebarAttentionUITests: XCTestCase {
    func testPendingDetailsSurviveNavigationAndClearWithGatewayEvents() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"] != nil,
            "Requires an isolated synthetic Gateway")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_ATTENTION_FIXTURE_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        continueAfterFailure = false
        try await self.changeFixture(fixture, path: "reset")
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
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setupField = app.textFields["Enter setup code"]
        XCTAssertTrue(setupField.waitForExistence(timeout: 5))
        setupField.tap()
        setupField.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()
        XCTAssertTrue(app.staticTexts["Your research workspace is ready."].waitForExistence(timeout: 30))
        self.openSidebar(app)
        let review = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Pending review")).firstMatch
        XCTAssertTrue(review.waitForExistence(timeout: 15), app.debugDescription)
        let parent = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Website refresh")).firstMatch
        XCTAssertTrue(parent.waitForExistence(timeout: 10))
        self.capture(app, named: "sidebar-pending")

        let question = app.buttons.matching(identifier: "sidebar-attention-question").firstMatch
        let approval = app.buttons.matching(identifier: "sidebar-attention-approval").firstMatch
        XCTAssertTrue(
            question.waitForExistence(timeout: 10),
            "Inactive thread questions must be discoverable in the sidebar")
        XCTAssertFalse(approval.exists, "Each row must show only its oldest pending request kind")
        XCTAssertTrue(question.label.contains("Which draft should we review first?"))
        XCTAssertTrue(question.label.contains("2 more questions"))
        let threadQuestion = try XCTUnwrap(
            app.buttons.matching(identifier: "sidebar-attention-question")
                .allElementsBoundByIndex.first { $0.isHittable && abs($0.frame.midY - review.frame.midY) < 2 },
            "The inactive Pending review row must expose its own question details button")
        let historyBefore = try await historyRequests(fixture)
        let parentQuestion = try XCTUnwrap(
            app.buttons.matching(identifier: "sidebar-attention-question")
                .allElementsBoundByIndex.first { $0.isHittable && abs($0.frame.midY - parent.frame.midY) < 2 },
            "The Website refresh parent row must expose pending questions from its child")
        XCTAssertTrue(parentQuestion.label.contains("Which draft should we review first?"))
        XCTAssertTrue(parentQuestion.label.contains("2 more questions"))
        try await self.changeFixture(fixture, path: "questions/add-parent")
        let parentPreview = XCTNSPredicateExpectation(
            predicate: NSPredicate(
                format: "label CONTAINS %@ AND label CONTAINS %@",
                "Which page should we refresh first?",
                "3 more questions"), object: parentQuestion)
        XCTAssertEqual(XCTWaiter.wait(for: [parentPreview], timeout: 10), .completed)
        XCTAssertTrue(threadQuestion.label.contains("Which draft should we review first?"))
        XCTAssertTrue(threadQuestion.label.contains("2 more questions"))
        parentQuestion.tap()
        XCTAssertTrue(app.staticTexts["Which page should we refresh first?"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["3 more questions"].exists)
        self.capture(app, named: "parent-question-details")
        try await self.changeFixture(fixture, path: "questions/cancel-parent")
        XCTAssertTrue(
            app.staticTexts["Waiting for answer"].waitForNonExistence(timeout: 10),
            "Cancelling the parent's oldest request must dismiss its popup")
        XCTAssertTrue(parentQuestion.label.contains("Which draft should we review first?"))
        XCTAssertTrue(parentQuestion.label.contains("2 more questions"))
        threadQuestion.tap()
        XCTAssertTrue(app.staticTexts["Waiting for answer"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Which draft should we review first?"].exists)
        XCTAssertTrue(app.staticTexts["2 more questions"].exists)
        self.capture(app, named: "question-details")
        self.dismissPopover(app)
        let historyAfter = try await historyRequests(fixture)
        XCTAssertEqual(
            historyAfter,
            historyBefore,
            "Opening attention details must not navigate to the inactive conversation")
        app.buttons["RootTabs.Sidebar.Destination.overview"].tap()
        XCTAssertTrue(app.staticTexts["Agent session"].waitForExistence(timeout: 10), app.debugDescription)
        self.openSidebar(app)
        XCTAssertTrue(
            question.waitForExistence(timeout: 10),
            "Questions must stay available after navigating away from Chat")
        question.tap()
        XCTAssertTrue(app.staticTexts["Which draft should we review first?"].waitForExistence(timeout: 5))
        self.capture(app, named: "overview-question-details")
        let priorReadbacks = try await self.approvalReadbackCount(fixture, id: "attention-approval-6")
        try await self.changeFixture(fixture, path: "approvals/expire-last")
        try await self.waitForApprovalReadback(fixture, id: "attention-approval-6", after: priorReadbacks)
        XCTAssertTrue(
            app.staticTexts["Waiting for answer"].exists,
            "Settling another request kind must preserve the open question details")
        XCTAssertTrue(app.staticTexts["2 more questions"].exists)
        self.capture(app, named: "question-details-after-other-kind-expiry")
        try await self.changeFixture(fixture, path: "questions/expire-newer")
        XCTAssertTrue(
            app.staticTexts["1 more question"].waitForExistence(timeout: 10),
            "The open details must update the total number of pending questions")
        XCTAssertTrue(app.staticTexts["Which draft should we review first?"].exists)
        self.capture(app, named: "question-details-after-newer-expiry")
        try await self.changeFixture(fixture, path: "questions/answer-oldest")
        XCTAssertTrue(
            app.staticTexts["Waiting for answer"].waitForNonExistence(timeout: 10),
            "Answering the oldest request must dismiss its details")
        XCTAssertFalse(
            app.staticTexts["Waiting for approval"].exists,
            "The dismissed popover must not turn into another request's details")
        XCTAssertTrue(question.waitForNonExistence(timeout: 10))
        XCTAssertTrue(
            approval.waitForExistence(timeout: 10),
            "The next request kind must appear after questions settle")
        XCTAssertTrue(approval.label.contains("Inspect the synthetic review folder"))
        let loadedApprovals = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label CONTAINS %@", "4 more approvals"), object: approval)
        XCTAssertEqual(XCTWaiter.wait(for: [loadedApprovals], timeout: 10), .completed)
        let threadApproval = try XCTUnwrap(
            app.buttons.matching(identifier: "sidebar-attention-approval")
                .allElementsBoundByIndex.first { $0.isHittable && abs($0.frame.midY - review.frame.midY) < 2 },
            "The inactive Pending review row must expose its own approval details button")
        threadApproval.tap()
        XCTAssertTrue(app.staticTexts["Waiting for approval"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Inspect the synthetic review folder"].exists)
        XCTAssertTrue(app.staticTexts["4 more approvals"].exists)
        self.capture(app, named: "approval-details")
        self.dismissPopover(app)
        try await self.changeFixture(fixture, path: "approvals/cancel")
        XCTAssertTrue(approval.waitForNonExistence(timeout: 10))
        self.capture(app, named: "sidebar-cleared")
    }

    private func openSidebar(_ app: XCUIApplication) {
        let show = app.buttons["RootTabs.Sidebar.Show"]
        if show.exists, show.isHittable {
            show.tap()
        }
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.chat"].waitForExistence(timeout: 10))
    }

    private func dismissPopover(_ app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.94, dy: 0.88)).tap()
        XCTAssertTrue(app.staticTexts["Waiting for answer"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Waiting for approval"].waitForNonExistence(timeout: 5))
    }

    private func changeFixture(_ fixture: URL, path: String) async throws {
        var request = URLRequest(url: fixture.appendingPathComponent(path))
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
    }

    private func historyRequests(_ fixture: URL) async throws -> [String] {
        let state = try await self.fixtureState(fixture)
        return state.requests.filter { $0.method == "chat.history" }.compactMap(\.sessionKey)
    }

    private func fixtureState(_ fixture: URL) async throws -> FixtureState {
        let (data, _) = try await URLSession.shared.data(from: fixture)
        return try JSONDecoder().decode(FixtureState.self, from: data)
    }

    private func approvalReadbackCount(_ fixture: URL, id: String) async throws -> Int {
        let state = try await self.fixtureState(fixture)
        return state.requests.filter { $0.method == "approval.get" && $0.id == id }.count
    }

    private func waitForApprovalReadback(_ fixture: URL, id: String, after priorCount: Int) async throws {
        let deadline = ContinuousClock().now + .seconds(10)
        while ContinuousClock().now < deadline {
            if try await self.approvalReadbackCount(fixture, id: id) > priorCount { return }
            try await Task.sleep(for: .milliseconds(100))
        }
        XCTFail("Native approval owner did not read the fixture's terminal record")
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let captured = app.screenshot()
        let output = FileManager.default.temporaryDirectory.appendingPathComponent("apple-ios-\(name).png")
        do {
            try captured.pngRepresentation.write(to: output)
            print("Sidebar attention screenshot: \(output.path)")
        } catch {
            XCTFail("Could not save sidebar screenshot: \(error)")
        }
        let screenshot = XCTAttachment(screenshot: captured)
        screenshot.name = "apple-ios-\(name)"
        screenshot.lifetime = .keepAlways
        add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "apple-ios-\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        add(hierarchy)
    }

    private struct FixtureState: Decodable {
        struct Request: Decodable {
            let method: String
            let sessionKey: String?
            let id: String?
        }

        let requests: [Request]
    }
}
