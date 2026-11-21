import XCTest

@MainActor
final class SidebarRefreshUITests: XCTestCase {
    func testSameAgentChatSwitchKeepsSidebarLoadsAndSubscription() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_SIDEBAR_REFRESH_FIXTURE_URL"] != nil,
            "Requires a fresh test-ios-shell-gateway.mjs --session-mutations fixture")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_SIDEBAR_REFRESH_FIXTURE_URL"]
            .flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        continueAfterFailure = false
        let app = XCUIApplication()
        defer { app.terminate() }
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-destination", "chat",
            "--openclaw-ui-test-readiness", "--openclaw-appearance", "light",
            "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
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
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(for: NSPredicate(format: "value == %@", "ready:chat"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)

        // Finish startup and one chat load before counting warm same-agent switches.
        self.openSession(1, in: app)
        let before = try await self.requests(fixture)
        XCTAssertTrue(before.contains { $0.method == "sessions.list" && $0.limit == 200 })
        for method in ["usage.cost", "cron.list", "sessions.subscribe"] {
            XCTAssertTrue(before.contains { $0.method == method }, "Initial sidebar load must issue \(method)")
        }
        for index in [2, 1, 2, 1, 2] {
            self.openSession(index, in: app)
        }
        let after = try await self.requests(fixture)
        let switched = Array(after.dropFirst(before.count))
        let evidence = XCTAttachment(data: try JSONEncoder().encode(switched), uniformTypeIdentifier: "public.json")
        evidence.name = "same-agent-chat-switch-requests"
        evidence.lifetime = .keepAlways
        add(evidence)
        // Chat bootstrap still owns its 50-row metadata read. Only the root's
        // 200-row roster and gateway-wide dashboard/subscription work must stop.
        let extraRosterLoads = switched.filter { $0.method == "sessions.list" && $0.limit == 200 }.count
        XCTAssertEqual(extraRosterLoads, 0, "Selecting a chat must not reload the sidebar roster")
        for method in ["usage.cost", "cron.list", "sessions.subscribe"] {
            XCTAssertEqual(
                switched.filter { $0.method == method }.count, 0,
                "Selecting a chat must not restart \(method)")
        }
        for index in [1, 2] {
            XCTAssertTrue(switched.contains {
                $0.method == "chat.history" && $0.sessionKey == "agent:main:navigation-\(index)"
            }, "The selected conversation must still load")
        }
    }

    private func openSession(_ index: Int, in app: XCUIApplication) {
        let show = app.buttons["RootTabs.Sidebar.Show"]
        if show.waitForExistence(timeout: 5), show.isHittable { show.tap() }
        let row = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Synthetic session \(index)")).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10))
        XCTAssertTrue(row.isHittable)
        row.tap()
        XCTAssertTrue(app.staticTexts["Opened agent:main:navigation-\(index)"].waitForExistence(timeout: 10))
    }

    private func requests(_ fixture: URL) async throws -> [Request] {
        let (data, response) = try await URLSession.shared.data(from: fixture)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(FixtureState.self, from: data).requests
    }

    private struct FixtureState: Decodable {
        let requests: [Request]
    }

    private struct Request: Codable {
        let method: String
        let limit: Int?
        let sessionKey: String?
    }
}
