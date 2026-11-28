import Vision
import XCTest

extension OpenClawSnapshotUITests {
    func testHistoryReloadDoesNotDuplicateTheWorkingTools() throws {
        try self.assertImportedTools()
    }

    func testReconnectKeepsTheRunningToolNameAndCompletedSteps() throws {
        try self.assertImportedTools(reconnect: true)
    }

    func testReconnectFinishesTheCallThatEndedWhileOffline() throws {
        try self.assertImportedTools(reconnect: true, finishedOffline: true)
    }

    private func assertImportedTools(reconnect: Bool = false, finishedOffline: Bool = false) throws {
        var arguments = ["--openclaw-tool-run-fixture", "--openclaw-imported-tool-fixture"]
        if reconnect { arguments.append("--openclaw-reconnect-tool-fixture") }
        if finishedOffline { arguments.append("--openclaw-finish-tool-offline") }
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: arguments)
        let app = try XCTUnwrap(self.app)
        let note = app.staticTexts["Checking the sample shelves."]
        XCTAssertTrue(note.waitForExistence(timeout: 12), "History did reload")
        let claw = app.descendants(matching: .any)["chat-working-status"].firstMatch
        XCTAssertTrue(claw.waitForExistence(timeout: 3))
        if finishedOffline {
            XCTAssertEqual(claw.label, "Thinking")
        } else {
            XCTAssertEqual(claw.label, "Running cat west.txt")
        }
        XCTAssertGreaterThanOrEqual(claw.frame.minY, note.frame.maxY, "The claw stays below the saved transcript")
        let captureRow = reconnect && !finishedOffline
        let attachment = XCTAttachment(screenshot: captureRow ? claw.screenshot() : app.screenshot())
        attachment.name = captureRow ? "working-row-after-reconnect" : "imported-tools"
        attachment.lifetime = .keepAlways
        add(attachment)
        let rows = app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-tool-activity-"))
        for file in ["north.txt", "east.txt"] {
            XCTAssertLessThanOrEqual(rows.matching(NSPredicate(format: "value CONTAINS %@", file)).count, 1)
        }
        if !finishedOffline {
            XCTAssertEqual(rows.matching(NSPredicate(format: "value CONTAINS %@", "west.txt")).count, 0)
        }
        for row in rows.allElementsBoundByIndex {
            XCTAssertLessThanOrEqual(row.frame.maxY, claw.frame.minY)
        }
        XCTAssertEqual(claw.elementType, .button, "The run’s calls remain inspectable after reconnect")
        claw.tap()
        for shelf in ["north", "east", "west"] {
            let step = app.buttons.matching(identifier: "chat-tool-step-toolu_sample_" + shelf)
            XCTAssertTrue(step.firstMatch.waitForExistence(timeout: 4), "Keep the whole run inspectable")
            XCTAssertEqual(step.count, 1)
            if reconnect {
                let verb = shelf == "west" && !finishedOffline ? "Running" : "Ran"
                XCTAssertTrue(step.firstMatch.label.contains(verb + " cat " + shelf + ".txt"), step.firstMatch.label)
            }
        }
    }

    func testWorkingClawNarratesTheOnlyActiveToolRow() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: [
            "--openclaw-tool-run-fixture", "--openclaw-tool-run-interval-ms", "3000",
        ])
        let app = try XCTUnwrap(self.app)
        let claw = app.buttons["chat-working-status"]
        guard claw.waitForExistence(timeout: 10) else { return XCTFail("The working claw must own the tool action") }
        var frame: CGRect?
        for file in ["icons.txt", "buttons.txt", "forms.txt"] {
            expectation(for: NSPredicate(format: "label == %@", "Running cat " + file), evaluatedWith: claw)
            waitForExpectations(timeout: 22)
            XCTAssertEqual(app.buttons.matching(identifier: "chat-working-status").count, 1)
            XCTAssertEqual(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", file)).count, 1)
            if let frame { XCTAssertEqual(claw.frame, frame, "A new call must not move the claw or its hit target") }
            XCTAssertGreaterThanOrEqual(claw.frame.height, 44, "The claw needs a full-size touch target")
            frame = claw.frame
        }
        XCTAssertTrue(app.buttons["chat-tool-activity-slot-index"].exists, "Commentary settled the first stretch")
        XCTAssertFalse(app.buttons["chat-tool-activity-slot-outline"].exists)
    }

    func testOpenWorkingClawListKeepsCallsAcrossCommentary() throws {
        self.launchApp(for: Self.chatScreenshotTarget, additionalArguments: [
            "--openclaw-tool-run-fixture", "--openclaw-tool-run-interval-ms", "3000",
            // XCUITest waits for foreground and root readiness before looking for this early call.
            "--openclaw-tool-run-start-delay-ms", "12000",
        ])
        let app = try XCTUnwrap(self.app)
        let current = app.buttons["chat-working-status"]
        expectation(for: NSPredicate(format: "label == %@", "Running cat outline.txt"), evaluatedWith: current)
        waitForExpectations(timeout: 20)
        current.tap()
        XCTAssertTrue(app.buttons["chat-tool-step-slot-outline"].waitForExistence(timeout: 4))
        XCTAssertTrue(app.buttons["chat-tool-step-slot-index"].exists, "The list starts at the beginning of the run")
        XCTAssertTrue(app.buttons["chat-tool-step-slot-palette"].waitForExistence(timeout: 8))
        let tail = app.buttons["chat-tool-step-slot-menus"]
        XCTAssertTrue(tail.waitForExistence(timeout: 24))
        XCTAssertTrue(tail.isHittable, "Watching the live list follows calls past the first viewport")
    }

    func testSettledSingleCallOpensDetailAndBackFindsItInTheTurn() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-tool-run-fixture", "--openclaw-tool-run-interval-ms", "80"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.staticTexts["All checks passed."].waitForExistence(timeout: 12))
        XCTAssertFalse(app.buttons["chat-working-status"].exists)
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
