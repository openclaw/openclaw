import XCTest

extension OpenClawSnapshotUITests {
    /// The Nov 24 report: a turn whose dispatched calls failed drew each failure twice, in red, one row
    /// per call, with a raw session key. Each failure now shows once, repeats share a row with a count,
    /// the chat is named, and the reason opens on tap.
    func testRepeatedToolFailuresReadAsOneQuietRowPerTarget() throws {
        self.executionTimeAllowance = 60
        self.launchApp(
            for: Self.chatScreenshotTarget,
            appearance: "light",
            additionalArguments: ["--openclaw-tool-failures-fixture"])
        let app = try XCTUnwrap(self.app)
        let row = { (id: String) in app.buttons["chat-tool-activity-" + id] }

        let composer = row("tool_call:tf-call-2:sessions_send:2")
        XCTAssertTrue(composer.waitForExistence(timeout: 10))
        let transcript = try self.chatTranscript(in: app)
        for _ in 0..<4 where !composer.isHittable {
            transcript.swipeDown()
        }
        XCTAssertEqual(composer.label, "Send to Composer fixes")
        XCTAssertEqual(composer.value as? String, "3 failed")
        let toasts = row("tool_call:tf-call-1:sessions_send:1")
        XCTAssertEqual(toasts.label, "Send to Toasts board")
        XCTAssertEqual(toasts.value as? String, "2 failed")
        for launch in ["tool_call:tf-call-3:sessions_spawn:3", "tool_call:tf-call-4:sessions_spawn:4"] {
            XCTAssertTrue(row(launch).exists, "Each launch is its own target and keeps its row")
            XCTAssertTrue((row(launch).value as? String)?.hasPrefix("Failed") == true)
        }
        // Repeats live in their first row; envelopes never get one.
        for absent in [
            "tool_call:tf-call-6:sessions_send:6", "tool_call:tf-call-7:sessions_send:7",
            "tool_call:tf-call-8:sessions_send:8", "tf-call-1", "tf-call-3",
        ] {
            XCTAssertFalse(row(absent).exists, absent)
        }
        XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Couldn't launch")).count, 2)
        XCTAssertFalse(app.staticTexts["agent:main:subagent:fixture-composer"].exists, "The key is never a name")
        self.attachScreenshot(named: "tool-failures-collapsed")

        composer.tap()
        for index in 0..<3 {
            let attempt = app.descendants(matching: .any)["chat-tool-attempt-\(index)"]
            XCTAssertTrue(attempt.waitForExistence(timeout: 5))
            XCTAssertEqual(attempt.label, "Followup completion requires in-process caller custody.")
        }
        XCTAssertEqual(composer.value as? String, "3 failed", "Opening the row keeps its box and status")
        self.attachScreenshot(named: "tool-failures-open")
    }
}
