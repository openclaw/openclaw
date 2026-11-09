import UIKit
import Vision
import XCTest

extension OpenClawSnapshotUITests {
    /// Opt-in integration against an isolated real Gateway and its configured model.
    /// The controller owns the Gateway, credentials, device, and server-side RPC trace.
    func testLiveLobbyAuthoringAndCompositionPersistence() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_LIVE_LOBBY_AUTHORING"] == "1" &&
                environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Requires an isolated real Gateway and explicit opt-in to two model requests")
        try XCTSkipIf(
            environment["OPENCLAW_IOS_LIVE_LOBBY_CONTINUE"] == "1",
            "Continuation must preserve the existing Lobby instead of resetting onboarding")
        let setupCode = try XCTUnwrap(
            environment["OPENCLAW_IOS_LIVE_SETUP_CODE"],
            "Provide a fresh setup code for the isolated real Gateway")
        XCTAssertFalse(setupCode.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)

        let app = try self.launchPairedLiveGatewayApp(initialTab: "lobby", initialDestination: "lobby")
        defer { self.attachScreenshot(named: "lobby-live-final-state") }

        if !app.navigationBars["Lobby"].waitForExistence(timeout: 5) {
            try self.selectSidebarDestination("Lobby")
        }
        XCTAssertTrue(app.descendants(matching: .any)["Lobby.Empty"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.descendants(matching: .any)["Lobby.Request"].exists)
        XCTAssertTrue(app.buttons["Lobby.Conversation"].exists)
        self.attachScreenshot(named: "lobby-live-empty-before-request")
        // These assertions establish empty presentation, not absence of server writes.
        // The controller must compare the Gateway session inventory/RPC trace for that claim.

        try self.sendLobbyLiveRequest(
            """
            Create exactly two compact, full-width HTML widgets in this Lobby's existing tab, stacked vertically.
            First: stable name lobby-timer, title Lobby timer, a 20-second local countdown with Start, Pause,
            and Reset timer buttons. Start changes to Pause while running; reset restores Start and 20 seconds.
            Second: stable name lobby-guide, title Lobby guide, containing the short text A quiet corner.
            Use responsive content for the available component page. Use inline HTML/CSS/JS only,
            no network, external assets, host capabilities, audio, shell commands, installations, or jobs.
            Use the existing dashboard/show_widget authoring tools and their bundled guidance.
            Keep the response short. Do not change any other conversation.
            """,
            expecting: "Lobby timer",
            in: app)
        let initialTimer = self.lobbyWidgetCards("Lobby timer", in: app)
        let guide = self.lobbyWidgetCards("Lobby guide", in: app)
        XCTAssertTrue(guide.firstMatch.waitForExistence(timeout: 15))
        XCTAssertEqual(initialTimer.count, 1)
        XCTAssertEqual(guide.count, 1)
        self.attachScreenshot(named: "lobby-live-created-composition")

        try self.verifyLocalInteractionAndEdit(in: app)
    }

    /// Resumes a recorded first authoring turn without onboarding reset or another create request.
    func testLiveLobbyContinueCompositionValidation() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_LIVE_LOBBY_CONTINUE"] == "1" &&
                environment["OPENCLAW_IOS_LIVE_LOBBY_AUTHORING"] == "1" &&
                environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1",
            "Explicitly opt in to continuing the existing isolated Lobby with one editing request")
        let app = self.relaunchConnectedLiveGatewayApp(initialTab: "lobby", initialDestination: "lobby")
        defer { self.attachScreenshot(named: "lobby-live-continuation-final-state") }
        if !app.navigationBars["Lobby"].waitForExistence(timeout: 5) {
            try self.selectSidebarDestination("Lobby")
        }
        XCTAssertTrue(app.buttons["Lobby.Conversation"].waitForExistence(timeout: 20))
        XCTAssertTrue(self.lobbyWidgetCards("Lobby timer", in: app).firstMatch.waitForExistence(timeout: 20))
        XCTAssertEqual(self.lobbyWidgetCards("Lobby timer", in: app).count, 1)
        XCTAssertEqual(self.lobbyWidgetCards("Lobby guide", in: app).count, 1)
        XCTAssertEqual(self.lobbyWidgetCards("Quiet timer", in: app).count, 0)
        self.attachScreenshot(named: "lobby-live-continuation-existing-composition")
        try self.verifyLocalInteractionAndEdit(in: app)
    }

    /// Verifies the edited fixture's local behavior without another model request.
    func testLiveLobbyEditedLocalInteraction() throws {
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1" &&
                environment["OPENCLAW_IOS_LIVE_LOBBY_INTERACTION"] == "1",
            "Requires the existing edited, capless Lobby fixture")
        let app = self.relaunchConnectedLiveGatewayApp(initialTab: "lobby", initialDestination: "lobby")
        XCTAssertTrue(app.buttons["Lobby.Conversation"].waitForExistence(timeout: 20))
        try self.assertEditedLobbyComposition(in: app)
        let timer = self.lobbyWidgetCards("Quiet timer", in: app).firstMatch
        app.buttons["Open Quiet timer"].tap()
        try self.tapLobbyRenderedText("Begin", in: timer)
        _ = try self.lobbyRenderedTextBounds("Pause", in: timer)
        try self.tapLobbyRenderedText("Reset", in: timer)
        _ = try self.lobbyRenderedTextBounds("Begin", in: timer)
        self.attachScreenshot(named: "lobby-live-edited-local-interaction")
        app.buttons["Back to Lobby"].tap()
    }

    private func verifyLocalInteractionAndEdit(in app: XCUIApplication) throws {
        let timer = self.lobbyWidgetCards("Lobby timer", in: app).firstMatch
        app.buttons["Open Lobby timer"].tap()
        // WKWebView exposes the board's card but omits controls inside its sandboxed iframe.
        // Locate the rendered label in this card's pixels; do not inject JavaScript or guess a point.
        try self.tapLobbyRenderedText("Reset", in: timer)
        _ = try self.lobbyRenderedTextBounds("Start", in: timer)
        try self.tapLobbyRenderedText("Start", in: timer)
        _ = try self.lobbyRenderedTextBounds("Pause", in: timer)
        try self.tapLobbyRenderedText("Reset", in: timer)
        _ = try self.lobbyRenderedTextBounds("Start", in: timer)
        self.attachScreenshot(named: "lobby-live-local-timer-reset")
        app.buttons["Back to Lobby"].tap()

        try self.sendLobbyLiveRequest(
            """
            Read this Lobby's current board and the complete HTML source of both existing widgets before editing.
            Keep exactly the same two stable names, lobby-timer and lobby-guide; create no additional widgets.
            Move lobby-guide before lobby-timer, keeping both full-width. Keep layout fluid within the available page.
            Preserve all existing content and behavior except these requested changes. Change the timer title
            to Quiet timer and its Start button label to Begin; keep the countdown, Pause, and Reset timer working.
            Preserve the guide title Lobby guide and its text A quiet corner. Use dashboard/show_widget authoring
            with no network, external assets, host capabilities, jobs, shell commands, installations,
            or changes to another conversation.
            """,
            expecting: "Quiet timer",
            in: app)
        try self.assertEditedLobbyComposition(in: app)
        self.attachScreenshot(named: "lobby-live-edited-composition")

        let reloaded = self.relaunchConnectedLiveGatewayApp(initialTab: "lobby", initialDestination: "lobby")
        XCTAssertTrue(reloaded.buttons["Lobby.Conversation"].waitForExistence(timeout: 20))
        try self.assertEditedLobbyComposition(in: reloaded)
        XCTAssertFalse(reloaded.descendants(matching: .any)["Lobby.Empty"].exists)
        XCTAssertFalse(reloaded.buttons["Lobby.Stop"].exists)
        self.attachScreenshot(named: "lobby-live-persisted-composition")
    }

    private func sendLobbyLiveRequest(_ text: String, expecting title: String, in app: XCUIApplication) throws {
        let conversation = app.buttons["Lobby.Conversation"]
        XCTAssertTrue(conversation.waitForExistence(timeout: 10))
        conversation.tap()
        let history = app.navigationBars["Lobby conversation"]
        XCTAssertTrue(history.waitForExistence(timeout: 10))
        let marker = "Lobby task complete"
        try self.sendLiveGatewayMessage(
            text + "\nWhen finished, reply exactly: " + marker,
            expecting: marker,
            stage: "lobby-authoring",
            in: app)
        history.buttons["Done"].tap()
        XCTAssertTrue(history.waitForNonExistence(timeout: 5))
        XCTAssertTrue(self.lobbyWidgetCards(title, in: app).firstMatch.waitForExistence(timeout: 20))
    }

    private func lobbyWidgetCards(_ title: String, in app: XCUIApplication) -> XCUIElementQuery {
        // BoardWidgetCell owns this accessible list-item label. Counting visible title text
        // would mistake a matching heading inside a widget for an additional widget.
        app.webViews.descendants(matching: .any).matching(NSPredicate(
            format: "label BEGINSWITH %@",
            "Dashboard widget: \(title)."))
    }

    private func assertEditedLobbyComposition(in app: XCUIApplication) throws {
        let timer = self.lobbyWidgetCards("Quiet timer", in: app)
        let guide = self.lobbyWidgetCards("Lobby guide", in: app)
        XCTAssertTrue(timer.firstMatch.waitForExistence(timeout: 20))
        XCTAssertTrue(guide.firstMatch.waitForExistence(timeout: 10))
        XCTAssertEqual(timer.count, 1, "Editing must replace the named timer, not append another card")
        XCTAssertEqual(guide.count, 1, "Reordering must preserve one guide")
        XCTAssertEqual(self.lobbyWidgetCards("Lobby timer", in: app).count, 0)
        XCTAssertTrue(timer.firstMatch.isHittable)
        XCTAssertTrue(guide.firstMatch.isHittable)
        XCTAssertLessThan(guide.firstMatch.frame.midY, timer.firstMatch.frame.midY)
        app.buttons["Open Quiet timer"].tap()
        _ = try self.lobbyRenderedTextBounds("Begin", in: timer.firstMatch)
        app.buttons["Back to Lobby"].tap()
    }

    private func tapLobbyRenderedText(_ text: String, in card: XCUIElement) throws {
        let bounds = try self.lobbyRenderedTextBounds(text, in: card)
        // Vision uses a lower-left origin; XCUI normalized coordinates start at the top left.
        card.coordinate(withNormalizedOffset: CGVector(dx: bounds.midX, dy: 1 - bounds.midY)).tap()
    }

    private func lobbyRenderedTextBounds(_ text: String, in card: XCUIElement) throws -> CGRect {
        XCTAssertTrue(card.waitForExistence(timeout: 5))
        let deadline = Date().addingTimeInterval(5)
        var recognized = ""
        repeat {
            let frame = card.frame
            let image = try XCTUnwrap(card.screenshot().image.cgImage)
            guard frame.width > 0, frame.height > 0,
                  abs(CGFloat(image.width) / CGFloat(image.height) - frame.width / frame.height) < 0.03
            else {
                throw NSError(domain: "LobbyUITest", code: 2, userInfo: [
                    NSLocalizedDescriptionKey: "The card screenshot is cropped; normalized tapping would be unsafe.",
                ])
            }
            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            recognition.recognitionLanguages = ["en-US"]
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition])
            let candidates = (recognition.results ?? []).compactMap { $0.topCandidates(1).first }
            recognized = candidates.map(\.string).joined(separator: " | ")
            let matches = try candidates.compactMap { candidate -> CGRect? in
                guard let range = candidate.string.range(
                    of: "\\b\(NSRegularExpression.escapedPattern(for: text))\\b",
                    options: [.regularExpression, .caseInsensitive])
                else { return nil }
                return try candidate.boundingBox(for: range)?.boundingBox
            }
            if matches.count == 1, let match = matches.first,
               match.width > 0, match.height > 0,
               CGRect(x: 0, y: 0, width: 1, height: 1).contains(match)
            {
                return match
            }
            RunLoop.current.run(until: Date().addingTimeInterval(0.25))
        } while Date() < deadline
        let evidence = XCTAttachment(string: recognized)
        evidence.name = "lobby-rendered-text-lookup-failed"
        evidence.lifetime = .keepAlways
        self.add(evidence)
        throw NSError(domain: "LobbyUITest", code: 1, userInfo: [
            NSLocalizedDescriptionKey: "Expected one rendered '\(text)' control in timer card; found: \(recognized)",
        ])
    }
}
