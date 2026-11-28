import Vision
import XCTest

extension OpenClawSnapshotUITests {
    func testSettledSingleCallOpensDetailAndBackFindsItInTheTurn() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-tool-run-fixture", "--openclaw-tool-run-interval-ms", "80"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.staticTexts["All checks passed."].waitForExistence(timeout: 12))
        XCTAssertEqual(app.buttons.matching(identifier: "chat-tool-group").count, 1)
        let selected = app.buttons["chat-tool-activity-slot-report"]
        XCTAssertTrue(selected.exists)
        selected.tap()
        XCTAssertTrue(app.staticTexts["Checked report.txt"].waitForExistence(timeout: 5))
        app.navigationBars.buttons["BackButton"].tap()
        let step = app.buttons["chat-tool-step-slot-report"]
        XCTAssertTrue(step.waitForExistence(timeout: 5))
        XCTAssertTrue(step.isHittable, "Back positions the list on the thirteenth call")
        step.tap()
        let output = app.staticTexts["Checked report.txt"]
        XCTAssertTrue(output.waitForExistence(timeout: 3))
        let sheet = app.descendants(matching: .any)["chat-tool-sheet"].firstMatch
        let edge = sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.007, dy: 0.42))
        edge.press(forDuration: 0.05, thenDragTo: sheet.coordinate(withNormalizedOffset: CGVector(dx: 0.91, dy: 0.42)))
        XCTAssertTrue(output.waitForNonExistence(timeout: 5), "The system edge swipe pops the detail")
        XCTAssertTrue(step.isHittable)
    }

    func testSentMessageShowsOnlyTheTargetOnOneLine() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: ["--openclaw-sent-messages-fixture"])
        let app = try XCTUnwrap(self.app)
        let named = app.buttons["chat-tool-activity-named-send"]
        let unnamed = app.buttons["chat-tool-activity-unnamed-send"]
        XCTAssertTrue(named.waitForExistence(timeout: 8))
        XCTAssertTrue(unnamed.exists)
        self.attachScreenshot(named: "sent-message-transcript")
        let target = "iOS R3: new-chat composer shows provider and raw model id, and breaks into two rows"
        XCTAssertEqual(named.label, "Sent message to " + target, "VoiceOver keeps the unabridged target name")
        XCTAssertEqual(unnamed.label, "Sent message", "A session key is not a label")
        let recognition = VNRecognizeTextRequest()
        recognition.recognitionLevel = .accurate
        try VNImageRequestHandler(cgImage: XCTUnwrap(named.screenshot().image.cgImage)).perform([recognition])
        let visible = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
        XCTAssertEqual(visible.count, 1, "The long target stays on one painted line")
        XCTAssertTrue(visible.first?.contains("Sent message to iOS R3") == true)
        XCTAssertFalse(visible.first?.contains("two rows") == true, "Truncate at the tail")
        named.tap()
        XCTAssertFalse(app.buttons["chat-tool-step-named-send"].exists)
        let input = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@",
            "The composer is ready for review"))
        XCTAssertTrue(input.firstMatch.waitForExistence(timeout: 5))
        XCTAssertTrue(input.firstMatch.label.contains(target), "Inspection retains both recipient and message")
    }

    func testLoneFinishedCommandOpensDetailDirectly() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: [
            "--openclaw-single-command-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        let command = app.buttons["chat-tool-activity-width"]
        XCTAssertTrue(command.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "single-command-transcript")
        command.tap()
        XCTAssertFalse(app.buttons["chat-tool-step-width"].exists)
        XCTAssertTrue(app.buttons["chat-tool-sheet-close"].exists)
        XCTAssertTrue(app.staticTexts["pixelWidth: 1206"].waitForExistence(timeout: 5))
        self.attachScreenshot(named: "single-command-detail")
        app.buttons["chat-tool-sheet-close"].tap()
        XCTAssertTrue(command.isHittable)
        XCTAssertFalse(app.staticTexts["pixelWidth: 1206"].exists)
    }

    func testQuietReactionNamesItsActionAndOpensTheToolSheet() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: ["--openclaw-reaction-tool-fixture"])
        let app = try XCTUnwrap(self.app)
        let row = app.buttons["chat-tool-activity-reaction"]
        XCTAssertTrue(row.waitForExistence(timeout: 8))
        XCTAssertEqual(row.label, "Reacted to message")
        self.attachScreenshot(named: "quiet-reaction-row")
        row.tap()
        XCTAssertTrue(app.buttons["chat-tool-sheet-close"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-tool-step-reaction"].exists)
        XCTAssertTrue(app.staticTexts["Input"].exists)
        self.attachScreenshot(named: "quiet-reaction-sheet")
    }

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
        XCTAssertEqual(composer.label, "Send message to Composer fixes")
        XCTAssertEqual(composer.value as? String, "3 failed")
        let toasts = row("tool_call:tf-call-1:sessions_send:1")
        XCTAssertEqual(toasts.label, "Send message to Toasts board")
        XCTAssertEqual(toasts.value as? String, "2 failed")
        for launch in ["tool_call:tf-call-3:sessions_spawn:3", "tool_call:tf-call-4:sessions_spawn:4"] {
            XCTAssertTrue(row(launch).exists, "Each launch is its own target and keeps its row")
            XCTAssertFalse((row(launch).value as? String)?.contains("Failed") == true, "The title already says it")
        }
        // Repeats live in their first row; envelopes never get one.
        for absent in [
            "tool_call:tf-call-6:sessions_send:6", "tool_call:tf-call-7:sessions_send:7",
            "tool_call:tf-call-8:sessions_send:8", "tf-call-1", "tf-call-3",
        ] {
            XCTAssertFalse(row(absent).exists, absent)
        }
        self.attachScreenshot(named: "tool-failures-collapsed")

        composer.tap()
        XCTAssertTrue(app.buttons["chat-tool-sheet-close"].waitForExistence(timeout: 5))
        for index in [2, 7, 8] {
            XCTAssertTrue(app.buttons["chat-tool-step-tool_call:tf-call-\(index):sessions_send:\(index)"].exists)
        }
        self.attachScreenshot(named: "tool-failures-open")
        app.buttons["chat-tool-sheet-close"].tap()
        XCTAssertEqual(composer.value as? String, "3 failed", "Inspecting the row preserves its status")
    }
}
