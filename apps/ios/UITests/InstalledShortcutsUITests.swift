import UIKit
import XCTest

@MainActor
final class InstalledShortcutsUITests: XCTestCase {
    private struct Fixture: Decodable {
        let setupCode: String
        let profileID: String
        let gatewayID: String
        let controlURL: URL
        let scenarios: [Scenario]
    }

    private struct Scenario: Decodable {
        let id: String
        let sessionKey: String
        let sessionName: String
        let otherSessionName: String
        let shortcutName: String
        let question: String
        let runID: String?
        let checkpointURL: String
        let successURL: String
        var automatic: Bool {
            !self.id.hasSuffix("-off")
        }

        var sends: Bool {
            self.id.hasPrefix("send")
        }

        var retires: Bool {
            self.id == "send-away" || self.id == "send-aba"
        }
    }

    private var app: XCUIApplication?
    private var shortcuts: XCUIApplication?

    override func setUpWithError() throws {
        try super.setUpWithError()
        self.continueAfterFailure = false
    }

    override func tearDownWithError() throws {
        self.app?.terminate()
        self.shortcuts?.terminate()
        try super.tearDownWithError()
    }

    func testInstalledAutomaticRunOpeningPreservesOrigin() async throws {
        guard let value = ProcessInfo.processInfo.environment["OPENCLAW_IOS_SHORTCUTS_FIXTURE"] else {
            throw XCTSkip("Requires the isolated hosted Shortcuts fixture")
        }
        let fixture = try JSONDecoder().decode(Fixture.self, from: Data(value.utf8))
        XCTAssertEqual(fixture.scenarios.map(\.id), [
            "send-on", "send-off", "inspect-on", "inspect-off", "send-away", "send-aba",
        ])
        let app = XCUIApplication()
        self.app = app
        self.pairGatewayForUITest(in: app, setupCode: fixture.setupCode, initialTab: "chat", initialDestination: "chat")
        let shortcuts = XCUIApplication(bundleIdentifier: "com.apple.shortcuts")
        self.shortcuts = shortcuts
        self.phase("onboarded")
        var finalRunID: String?
        for scenario in fixture.scenarios {
            InstalledShortcutsControls.dismissRun(in: app)
            let before = try InstalledShortcutsControls.assertIdleEditor(in: app)
            _ = try await self.control(fixture, scenario.id, "begin", ["observation": before])
            try self.create(scenario, in: shortcuts)
            try InstalledShortcutsControls.openEditor(scenario.shortcutName, in: shortcuts)
            InstalledShortcutsControls.expand(in: shortcuts)
            InstalledShortcutsControls.verifyToggle(scenario.automatic, in: shortcuts)
            InstalledShortcutsControls.assertHiddenParameters(in: shortcuts)
            InstalledShortcutsControls.choose("Done", in: shortcuts)
            var runURL = try XCTUnwrap(URLComponents(string: "shortcuts://x-callback-url/run-shortcut"))
            runURL.queryItems = [
                URLQueryItem(name: "name", value: scenario.shortcutName),
                URLQueryItem(name: "x-success", value: scenario.successURL),
            ]
            try shortcuts.open(XCTUnwrap(runURL.url))
            if scenario.sends {
                try self.confirm(scenario, fixture: fixture, in: app)
            }
            if scenario.retires {
                _ = try await self.control(fixture, scenario.id, "wait-held")
                app.activate()
                InstalledShortcutsControls.selectSession(scenario.otherSessionName, in: app)
                if scenario.id == "send-aba" { InstalledShortcutsControls.selectSession(scenario.sessionName, in: app) }
                let idle = try InstalledShortcutsControls.assertIdleEditor(in: app)
                _ = try await self.control(fixture, scenario.id, "release-ack", [
                    "emptyEditor": true, "selectedOwnerVerified": true, "observation": idle,
                ])
            }
            // The HTTP checkpoint may arrive before or after the returned intent.
            // Require actual owner completion independently, never infer its order.
            // OFF has no automatic completion to await. Its checkpoint proves the
            // producer returned after confirmation/ACK, not that a hidden task joined.
            if !scenario.automatic { try await self.waitForControl(fixture, scenario, key: "checkpoint") }
            var afterAutomatic = try InstalledShortcutsControls.waitForObservation(in: app) { value in
                (value["prepared"] as? Int) == (before["prepared"] as? Int).map { $0 + 1 } &&
                    (value["automaticCompletions"] as? Int) ==
                    (before["automaticCompletions"] as? Int).map { $0 + (scenario.automatic ? 1 : 0) }
            }
            if scenario.retires {
                XCTAssertEqual(afterAutomatic["automaticOutcome"] as? String, "skipped")
                InstalledShortcutsControls.assertSelectedSession(
                    scenario.id == "send-aba" ? scenario.sessionName : scenario.otherSessionName,
                    in: app)
                afterAutomatic = try InstalledShortcutsControls.assertIdleEditor(in: app)
                XCTAssertFalse(InstalledShortcutsControls.runSheet(in: app).exists)
            } else if scenario.automatic {
                XCTAssertTrue(InstalledShortcutsControls.runSheet(in: app).waitForExistence(timeout: 15))
            } else if !scenario.sends {
                // Inspect itself presents its result. OFF disables only its returned
                // automatic action; verify this producer-owned sheet separately.
                try InstalledShortcutsControls.verifyRun(
                    XCTUnwrap(scenario.runID),
                    session: scenario.sessionKey,
                    profile: fixture.profileID,
                    in: app)
                InstalledShortcutsControls.dismissRun(in: app)
            } else {
                XCTAssertFalse(InstalledShortcutsControls.runSheet(in: app).exists)
            }
            let observed = try await self.control(fixture, scenario.id, "observe", [
                "observation": afterAutomatic, "uiVerified": true,
            ])
            let runID = try XCTUnwrap(observed["runID"] as? String)
            if scenario.automatic, !scenario.retires {
                InstalledShortcutsControls.verifyRun(
                    runID,
                    session: scenario.sessionKey,
                    profile: fixture.profileID,
                    in: app)
                InstalledShortcutsControls.dismissRun(in: app)
            }
            try await self.waitForControl(fixture, scenario, key: "checkpoint")
            _ = try await self.control(fixture, scenario.id, "release-downstream")
            _ = try InstalledShortcutsControls.waitForObservation(in: app) { value in
                (value["explicitCompletions"] as? Int) == (before["explicitCompletions"] as? Int).map { $0 + 1 }
            }
            InstalledShortcutsControls.verifyRun(
                runID,
                session: scenario.sessionKey,
                profile: fixture.profileID,
                in: app)
            try await self.waitForControl(fixture, scenario, key: "finished")
            InstalledShortcutsControls.dismissRun(in: app)
            InstalledShortcutsControls.assertSelectedSession(scenario.sessionName, in: app)
            let settled = try InstalledShortcutsControls.assertIdleEditor(in: app)
            _ = try await self.control(fixture, scenario.id, "complete", [
                "observation": settled, "uiVerified": true,
            ])
            finalRunID = runID
            self.phase(scenario.id)
        }
        try await self.verifyExplicitDefaults(
            fixture,
            runID: XCTUnwrap(finalRunID),
            scenario: XCTUnwrap(fixture.scenarios.last),
            in: shortcuts,
            app: app)
        self.phase("complete")
    }

    private func create(_ scenario: Scenario, in shortcuts: XCUIApplication) throws {
        try shortcuts.open(XCTUnwrap(URL(string: "shortcuts://create-shortcut")))
        InstalledShortcutsControls.addAction(scenario.sends ? "Send Message" : "Inspect Run", in: shortcuts)
        if scenario.sends {
            let field = shortcuts.textFields["Message"].firstMatch
            XCTAssertTrue(field.waitForExistence(timeout: 10))
            field.tap()
            field.typeText(scenario.question)
            XCTAssertEqual(field.value as? String, scenario.question)
            InstalledShortcutsControls.choose("Session", in: shortcuts)
            InstalledShortcutsControls.choose(scenario.sessionName, in: shortcuts)
        } else {
            InstalledShortcutsControls.choose("Run", in: shortcuts)
            try InstalledShortcutsControls.choose(XCTUnwrap(scenario.runID), in: shortcuts)
        }
        InstalledShortcutsControls.expand(in: shortcuts)
        let toggle = shortcuts.switches["Open When Run"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10), "Returned-intent toggle is unavailable")
        if (toggle.value as? String == "1") != scenario.automatic { toggle.tap() }
        InstalledShortcutsControls.verifyToggle(scenario.automatic, in: shortcuts)
        InstalledShortcutsControls.addAction("Get Contents of URL", in: shortcuts)
        let url = shortcuts.textFields["URL"].firstMatch
        XCTAssertTrue(url.waitForExistence(timeout: 10))
        url.tap()
        url.typeText(scenario.checkpointURL + "\n")
        InstalledShortcutsControls.addAction("Open Run", in: shortcuts)
        InstalledShortcutsControls.expand(in: shortcuts)
        InstalledShortcutsControls.assertHiddenParameters(in: shortcuts)
        // Explicitly select the earlier Send output, never the immediately prior
        // HTTP response. Inspect returns text, so its explicit control uses its catalog Run.
        let run = shortcuts.buttons.matching(identifier: "Run").allElementsBoundByIndex.last
        try XCTUnwrap(run).tap()
        if scenario.sends {
            InstalledShortcutsControls.choose("Select Variable", in: shortcuts)
            InstalledShortcutsControls.choose("Send Message", in: shortcuts)
        } else {
            try InstalledShortcutsControls.choose(XCTUnwrap(scenario.runID), in: shortcuts)
        }
        InstalledShortcutsControls.save(scenario.shortcutName, in: shortcuts)
    }

    private func verifyExplicitDefaults(
        _ fixture: Fixture,
        runID: String,
        scenario: Scenario,
        in shortcuts: XCUIApplication,
        app: XCUIApplication) async throws
    {
        let name = scenario.shortcutName + " Explicit"
        for id in ["explicit-fresh", "explicit-saved"] {
            InstalledShortcutsControls.dismissRun(in: app)
            let before = try InstalledShortcutsControls.assertIdleEditor(in: app)
            let control = try await self.control(fixture, id, "begin-explicit", ["observation": before])
            if id == "explicit-fresh" {
                try shortcuts.open(XCTUnwrap(URL(string: "shortcuts://create-shortcut")))
                InstalledShortcutsControls.addAction("Open Run", in: shortcuts)
                InstalledShortcutsControls.choose("Run", in: shortcuts)
                InstalledShortcutsControls.choose(runID, in: shortcuts)
            } else {
                try InstalledShortcutsControls.openEditor(name, in: shortcuts)
            }
            InstalledShortcutsControls.expand(in: shortcuts)
            InstalledShortcutsControls.assertHiddenParameters(in: shortcuts)
            if id == "explicit-fresh" {
                let run = shortcuts.buttons["Run Shortcut"].firstMatch
                XCTAssertTrue(run.waitForExistence(timeout: 10) && run.isEnabled)
                run.tap()
            } else {
                InstalledShortcutsControls.choose("Done", in: shortcuts)
                var url = try XCTUnwrap(URLComponents(string: "shortcuts://x-callback-url/run-shortcut"))
                url.queryItems = try [
                    URLQueryItem(name: "name", value: name),
                    URLQueryItem(
                        name: "x-success",
                        value: XCTUnwrap(control["successURL"] as? String)),
                ]
                try shortcuts.open(XCTUnwrap(url.url))
            }
            let after = try InstalledShortcutsControls.waitForObservation(in: app) { value in
                (value["explicitCompletions"] as? Int) == (before["explicitCompletions"] as? Int).map { $0 + 1 }
            }
            XCTAssertEqual(after["explicitOutcome"] as? String, "opened")
            for key in ["producers", "prepared", "automaticEntries", "automaticCompletions"] {
                XCTAssertEqual(after[key] as? Int, before[key] as? Int)
            }
            InstalledShortcutsControls.verifyRun(
                runID,
                session: scenario.sessionKey,
                profile: fixture.profileID,
                in: app)
            if id == "explicit-fresh" {
                shortcuts.activate()
                InstalledShortcutsControls.assertEditorRunCompleted(in: shortcuts)
                InstalledShortcutsControls.save(name, in: shortcuts)
            } else {
                let deadline = ContinuousClock.now + .seconds(40)
                var finished = false
                while ContinuousClock.now < deadline {
                    let status = try await self.control(fixture, id, "explicit-status")
                    if status["finished"] as? Bool == true { finished = true
                        break
                    }
                    try await Task.sleep(for: .milliseconds(50))
                }
                XCTAssertTrue(finished, "Saved explicit Shortcut did not complete")
            }
            _ = try await self.control(fixture, id, "complete-explicit", [
                "observation": after, "uiVerified": true, "shortcutSucceeded": true,
            ])
            self.phase(id)
        }
    }

    private func control(
        _ fixture: Fixture, _ id: String, _ action: String, _ facts: [String: Any] = [:]) async throws -> [String: Any]
    {
        XCTAssertEqual(fixture.controlURL.host, "127.0.0.1")
        var request = URLRequest(url: fixture.controlURL)
        request.httpMethod = "POST"
        request.timeoutInterval = 40
        var payload = facts
        payload["action"] = action
        payload["id"] = id
        request.httpBody = try JSONSerialization.data(withJSONObject: payload)
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Installed fixture refused evidence")
        XCTAssertLessThan(data.count, 4096)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }

    private func waitForControl(_ fixture: Fixture, _ scenario: Scenario, key: String) async throws {
        let deadline = ContinuousClock.now + .seconds(40)
        while ContinuousClock.now < deadline {
            let status = try await self.control(fixture, scenario.id, "status")
            if status[key] as? Bool == true { return }
            try await Task.sleep(for: .milliseconds(50))
        }
        XCTFail("Actual Shortcuts checkpoint or success callback was not observed")
        throw CancellationError()
    }

    private func confirm(_ scenario: Scenario, fixture: Fixture, in app: XCUIApplication) throws {
        let text = "Send to \(scenario.sessionKey) with qa as \(fixture.profileID) on \(fixture.gatewayID)?"
            + "\n\n\(scenario.question)"
        let containers = app.descendants(matching: .any).matching(NSPredicate(
            format: "elementType IN %@", [
                XCUIElement.ElementType.alert.rawValue,
                XCUIElement.ElementType.sheet.rawValue,
            ] as NSArray))
            .containing(.staticText, identifier: text)
        let confirmation = containers.firstMatch
        XCTAssertTrue(confirmation.waitForExistence(timeout: 30))
        XCTAssertEqual(containers.count, 1)
        XCTAssertTrue(confirmation.isHittable)
        let send = confirmation.buttons["Send"].firstMatch
        XCTAssertTrue(send.isEnabled && send.isHittable)
        send.tap()
    }

    private func phase(_ id: String) {
        print("[ios-shortcuts-installed] phase=\(id)")
    }
}
