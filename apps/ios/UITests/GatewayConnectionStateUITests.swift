import Foundation
import XCTest

@MainActor
final class GatewayConnectionStateUITests: XCTestCase {
    /// Release-only boundary proof: unanswered WebSocket connect requests use the
    /// shipped handshake deadline. No app state or shortened timeout is injected.
    func testIndependentConnectionAndRecovery() async throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_CONNECTION_STATE_PROOF"] == "1",
            "Requires an owned loopback shell Gateway with --connection-state")
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        let fixtureURL = try XCTUnwrap(
            environment["OPENCLAW_IOS_CONNECTION_STATE_FIXTURE_URL"].flatMap(URL.init(string:)))
        guard fixtureURL.scheme == "http", fixtureURL.host == "127.0.0.1" else {
            XCTFail("Connection proof requires the owned loopback fixture")
            return
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        defer { app.terminate() }
        self.launchConnectionApp(app, setupCode: setupCode)
        _ = try await self.control(fixtureURL, path: "await?ready=1")
        let input = app.descendants(matching: .any)["chat-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 10))
        continueAfterFailure = true
        self.capture(app, named: "connection-healthy")

        _ = try await self.control(fixtureURL, path: "node-timeout", method: "POST")
        // Two real failed attempts ensure the first timeout has reached the UI.
        let nodeFailed = try await self.control(fixtureURL, path: "await?node=2")
        XCTAssertTrue(nodeFailed.connectedRoles.contains("operator"))
        let reconnecting = app.descendants(matching: .any).matching(identifier: "chat-status-strip-text")
            .matching(NSPredicate(format: "label BEGINSWITH %@", "Reconnecting to ")).firstMatch
        XCTAssertFalse(reconnecting.exists, "connection-state:healthy-operator:no-chat-reconnect-status")
        XCTAssertFalse(app.staticTexts["Connection timed out"].exists)
        XCTAssertTrue(input.isEnabled, "connection-state:healthy-operator:composer-enabled")
        self.capture(app, named: "connection-node-timeout-operator-healthy")
        if input.isEnabled {
            input.tap()
            input.typeText("Synthetic connection proof prompt.")
            let send = app.buttons["chat-send-message"]
            XCTAssertTrue(send.waitForExistence(timeout: 3))
            XCTAssertTrue(send.isEnabled)
            if send.isEnabled {
                send.tap()
                XCTAssertTrue(app.staticTexts["Connection proof: operator chat completed."]
                    .waitForExistence(timeout: 10))
                let sent = try await self.control(fixtureURL, path: "")
                XCTAssertEqual(sent.chatSends, 1)
                XCTAssertEqual(sent.chatSendRoles, ["operator"])
            }
        }
        self.capture(app, named: "connection-node-timeout-chat-completed")

        _ = try await self.control(fixtureURL, path: "both-timeout", method: "POST")
        let bothFailed = try await self.control(
            fixtureURL, path: "await?node=\(nodeFailed.timeouts.node + 1)&operator=1")
        XCTAssertTrue(reconnecting.waitForExistence(timeout: 5), "connection-state:operator-unavailable:reconnecting")
        XCTAssertTrue(input.isEnabled, "connection-state:operator-unavailable:composer-accepts-text")
        XCTAssertFalse(app.buttons["chat-status-strip-action"].exists, "The app is already retrying on its own")
        self.capture(app, named: "connection-both-timeout-reconnecting")
        _ = try await self.control(
            fixtureURL,
            path: "await?node=\(bothFailed.timeouts.node + 1)&operator=\(bothFailed.timeouts.operator + 1)")
        XCTAssertTrue(reconnecting.exists, "connection-state:repeated-timeout:still-reconnecting")
        self.capture(app, named: "connection-repeated-timeout-reconnecting")

        _ = try await self.control(fixtureURL, path: "recover", method: "POST")
        let recovered = try await self.control(fixtureURL, path: "await?ready=1")
        XCTAssertTrue(recovered.connectedRoles.contains("operator"))
        XCTAssertTrue(input.isEnabled, "connection-state:recovered:composer-enabled")
        XCTAssertTrue(reconnecting.waitForNonExistence(timeout: 5))
        self.capture(app, named: "connection-recovered")

        _ = try await self.control(fixtureURL, path: "pairing", method: "POST")
        let pairing = app.staticTexts["This device is not approved yet"]
        XCTAssertTrue(pairing.waitForExistence(timeout: 15), "connection-state:different-actionable-pairing:visible")
        self.capture(app, named: "connection-node-pairing-actionable")
    }

    /// An automatic reconnect keeps its handoff pending for as long as the saved Gateway
    /// never answers. Chat must still offer the sidebar route to the connection settings.
    func testToolbarStaysUsableWhileReconnectingToUnreachableGateway() {
        let app = XCUIApplication()
        defer { app.terminate() }
        // Argument defaults save a manual Gateway at an unroutable TEST-NET-1 address.
        app.launchArguments = [
            "--openclaw-initial-tab", "chat", "--openclaw-initial-destination", "chat", "-AppleLanguages", "(en)",
            "-gateway.onboardingComplete", "YES", "-gateway.hasConnectedOnce", "YES",
            "-onboarding.quickSetupDismissed", "YES", "-gateway.autoconnect", "YES",
            "-gateway.manual.enabled", "YES", "-gateway.manual.host", "192.0.2.10", "-gateway.manual.port", "18789",
        ]
        app.launch()
        let status = app.descendants(matching: .any)["chat-agent-identity"]
        XCTAssertTrue(status.waitForExistence(timeout: 15))
        XCTAssertFalse(status.label.contains("Gateway:"), status.label)
        XCTAssertFalse(app.textViews["chat-message-input"].isEnabled, "The chat surface waits out the handoff")

        for control in [app.buttons["RootTabs.Sidebar.Show"], app.buttons["Chat actions"]] {
            XCTAssertTrue(control.isEnabled, "\(control.identifier) \(control.label) must stay enabled")
        }
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let settings = app.buttons["RootTabs.Sidebar.GatewaySettings"]
        XCTAssertTrue(settings.waitForExistence(timeout: 5))
        XCTAssertTrue(settings.isEnabled)
        settings.tap()
        XCTAssertTrue(app.staticTexts["Settings.Title.gateway"].waitForExistence(timeout: 5))
    }

    private func launchConnectionApp(_ app: XCUIApplication, setupCode: String) {
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
    }

    private func control(_ baseURL: URL, path: String, method: String = "GET") async throws -> ConnectionState {
        var components = try XCTUnwrap(URLComponents(
            url: baseURL.appendingPathComponent("connection-state"), resolvingAgainstBaseURL: false))
        let parts = path.split(separator: "?", maxSplits: 1, omittingEmptySubsequences: false)
        if let action = parts.first, !action.isEmpty { components.path += "/" + String(action) }
        if parts.count == 2 { components.percentEncodedQuery = String(parts[1]) }
        var request = try URLRequest(url: XCTUnwrap(components.url))
        request.httpMethod = method
        request.timeoutInterval = 100
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let wire = XCTAttachment(data: data, uniformTypeIdentifier: "public.json")
        wire.name = "connection-wire-\(path)"
        wire.lifetime = .keepAlways
        self.add(wire)
        return try JSONDecoder().decode(ConnectionState.self, from: data)
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
    }

    private struct ConnectionState: Decodable {
        struct Timeouts: Decodable {
            let node: Int
            let `operator`: Int
        }

        let timeouts: Timeouts
        let connectedRoles: [String]
        let chatSends: Int
        let chatSendRoles: [String]
    }
}
