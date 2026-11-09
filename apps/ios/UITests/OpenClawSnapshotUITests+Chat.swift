import UIKit
import Vision
import XCTest

extension OpenClawSnapshotUITests {
    func testChatComposerAccessibilityControls() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat", initialDestination: "chat", name: "chat-accessibility-controls"))
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        let model = app.buttons["chat-composer-inline-model"]
        XCTAssertTrue(model.waitForExistence(timeout: 3))
        XCTAssertEqual(model.value as? String, "gpt-5.6-sol")
        self.assertMinimumTouchTarget(model)
        self.assertMinimumTouchTarget(app.buttons["chat-realtime-control"])
        self.assertMinimumTouchTarget(app.buttons["RootTabs.Sidebar.Show"])
        self.assertMinimumTouchTarget(app.buttons["Chat actions"])
        self.attachScreenshot(named: "accessibility-empty-composer-and-header")
        model.tap()
        let alternative = app.buttons["anthropic/claude-opus-4-1"]
        XCTAssertTrue(alternative.waitForExistence(timeout: 3))
        // Native menus can open scrolled to the selected item at accessibility sizes.
        // Navigate the actual menu before tapping; XCTest's implicit scroll can miss the row.
        let menu = app.collectionViews.containing(.button, identifier: "anthropic/claude-opus-4-1").firstMatch
        let visibleBounds = app.frame.insetBy(dx: 20, dy: 90)
        for _ in 0..<4 {
            print("MODEL_ROW_BOUNDS: \(alternative.frame), menu=\(menu.frame), hittable=\(alternative.isHittable)")
            if alternative.frame.intersection(visibleBounds).height >= 44, alternative.isHittable { break }
            let viewport = menu.frame.intersection(app.frame.insetBy(dx: 0, dy: 50))
            let origin = app.coordinate(withNormalizedOffset: .zero)
            let start = origin.withOffset(CGVector(dx: viewport.midX, dy: viewport.minY + 40))
            let end = origin.withOffset(CGVector(dx: viewport.midX, dy: viewport.maxY - 40))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        let visibleRow = alternative.frame.intersection(visibleBounds)
        XCTAssertGreaterThanOrEqual(visibleRow.height, 44, alternative.debugDescription)
        XCTAssertTrue(alternative.isHittable)
        self.attachScreenshot(named: "accessibility-model-choice-visible")
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: visibleRow.midX, dy: visibleRow.midY)).tap()
        self.waitForValue("claude-opus-4-1", of: model)
        input.tap()
        input.typeText("Accessible draft")
        XCTAssertTrue((input.value as? String ?? "").contains("Accessible draft"))
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        self.assertMinimumTouchTarget(send)
        let controls = [
            app.buttons["chat-attachment-picker"],
            app.buttons["chat-composer-inline-permissions"],
            app.buttons["chat-context-usage"],
            model,
            app.buttons["chat-composer-inline-effort"],
            app.buttons["chat-dictation-control"],
            send,
        ]
        let surface = app.otherElements["chat-composer-surface"]
        for control in controls {
            XCTAssertTrue(control.exists)
            self.assertMinimumTouchTarget(control)
            XCTAssertGreaterThanOrEqual(control.frame.minX, surface.frame.minX)
            XCTAssertLessThanOrEqual(control.frame.maxX, surface.frame.maxX)
            XCTAssertLessThanOrEqual(abs(control.frame.midY - send.frame.midY), 1)
        }
        self.assertNoHorizontalOverlap(controls)
        self.attachScreenshot(named: "accessibility-model-and-send-controls")
    }

    func testChatComposerReturnInsertsNewlineWithoutSending() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-return"))

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("first line\nsecond line")

        XCTAssertEqual(input.value as? String, "first line\nsecond line")
        XCTAssertTrue(app.buttons["chat-send-message"].waitForExistence(timeout: 3))
        XCTAssertFalse(app.staticTexts["first line\nsecond line"].exists)
        self.attachScreenshot(named: "chat-composer-return")
    }

    func testChatComposerPastesClipboardImageAsAttachment() throws {
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-composer-paste-image"))

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        // Match a cropped screenshot shared with "Copy and Delete": an image with no text.
        UIPasteboard.general.image = UIGraphicsImageRenderer(size: CGSize(width: 64, height: 64)).image { context in
            UIColor.systemOrange.setFill()
            context.fill(CGRect(x: 0, y: 0, width: 64, height: 64))
        }
        input.tap()
        input.press(forDuration: 1)
        self.attachScreenshot(named: "chat-composer-paste-menu")

        let paste = app.menuItems["Paste"]
        XCTAssertTrue(paste.waitForExistence(timeout: 5), "PASTE_MENU_MISSING")
        paste.tap()
        // Staging transcodes to JPEG, so the chip shows the converted name.
        let attachment = app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@", "pasted-image-1")).firstMatch
        XCTAssertTrue(attachment.waitForExistence(timeout: 5), "PASTED_IMAGE_MISSING")
        self.attachScreenshot(named: "chat-composer-paste-image")
    }

    func testStopIgnoresTapsForAMomentAfterItReplacesSend() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-stop-guard"),
            additionalArguments: ["--openclaw-hold-initial-chat-run"])

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Keep this response running.")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        self.waitForEnabled(send)
        // Cache an absolute screen coordinate before sending, so the second independent tap
        // reaches the replacement Stop without a stale Send lookup or an intervening snapshot.
        let sendFrame = send.frame
        let sendPosition = app.coordinate(withNormalizedOffset: .zero).withOffset(
            CGVector(dx: sendFrame.midX, dy: sendFrame.midY))
        sendPosition.tap()
        sendPosition.tap()

        let stop = app.buttons["Stop response"]
        XCTAssertTrue(
            stop.waitForExistence(timeout: 5),
            "STOP_GUARD_MISSING: double-tapping Send cancelled the response")
        self.waitForEnabled(stop)
        self.attachScreenshot(named: "stop-guard-response-survived-double-tap")

        // The held fixture cannot finish by itself, so disappearance proves deliberate cancellation.
        stop.tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 8))
        self.attachScreenshot(named: "stop-guard-deliberate-stop-cancelled-response")
    }

    func testTextDraftKeepsStopAvailableDuringActiveResponse() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-text-draft-stop-active-response"),
            additionalArguments: ["--openclaw-hold-initial-chat-run"])

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Keep this response running.")
        let send = app.buttons["chat-send-message"]
        self.waitForEnabled(send)
        send.tap()

        let stop = app.buttons["Stop response"]
        XCTAssertTrue(stop.waitForExistence(timeout: 8))
        self.waitForEnabled(stop)
        input.tap()
        input.typeText("Keep this follow-up draft")
        self.attachScreenshot(named: "text-draft-during-active-response")
        XCTAssertTrue(stop.exists, "Drafting must keep the current response stoppable")
        XCTAssertTrue(stop.isHittable)
        XCTAssertTrue(send.exists)
        self.assertMinimumTouchTarget(stop)
        self.assertNoHorizontalOverlap([stop, send])

        stop.tap()
        XCTAssertTrue(stop.waitForNonExistence(timeout: 8))
        XCTAssertEqual(input.value as? String, "Keep this follow-up draft")
        self.waitForEnabled(send)
        send.tap()
        XCTAssertTrue(app.staticTexts["Keep this follow-up draft"].waitForExistence(timeout: 8))
    }

    func testVoiceNoteDraftKeepsStopAvailableDuringActiveResponse() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone voice-note composer proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-voice-note-stop-active-response"),
            additionalArguments: ["--openclaw-hold-initial-chat-run"])

        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Keep this response running while I record a voice note.")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled)
        send.tap()

        let stop = app.buttons["Stop response"]
        XCTAssertTrue(stop.waitForExistence(timeout: 8))
        self.waitForEnabled(stop)

        let microphone = app.buttons["chat-dictation-control"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        microphone.press(forDuration: 0.8)

        let recordVoiceNote = app.buttons["Record Voice Note"]
        XCTAssertTrue(recordVoiceNote.waitForExistence(timeout: 5))
        recordVoiceNote.tap()

        let finishVoiceNote = app.buttons["Finish voice note"]
        XCTAssertTrue(finishVoiceNote.waitForExistence(timeout: 8))
        finishVoiceNote.tap()

        let voiceNote = app.staticTexts["Voice note"]
        XCTAssertTrue(voiceNote.waitForExistence(timeout: 8))
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        self.waitForEnabled(stop)
        self.attachScreenshot(named: "voice-note-stop-active-response")

        stop.tap()
        XCTAssertTrue(send.waitForExistence(timeout: 8))
        self.waitForEnabled(send)
        XCTAssertTrue(voiceNote.exists)
        send.tap()

        XCTAssertTrue(voiceNote.waitForNonExistence(timeout: 8))
        XCTAssertTrue(
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I can help with"))
                .firstMatch.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "voice-note-sent-after-stopping-response")
    }

    func testVoiceRenditionsStayVisibleBesideConsultAnswers() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "voice-consult-rows"),
            additionalArguments: ["--openclaw-voice-consult-rows-fixture"])
        let app = try XCTUnwrap(self.app)
        let latest = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "VOICE_SPOKEN_AFTER"))
            .firstMatch
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        let question = app.staticTexts["Which build is on my phone?"]
        for _ in 0..<6 where !question.isHittable {
            app.swipeDown()
        }
        self.attachScreenshot(named: "voice-consult-rows")
        let spokenFirst = app.staticTexts
            .matching(NSPredicate(format: "label BEGINSWITH %@", "VOICE_SPOKEN_FIRST"))
            .firstMatch
        XCTAssertTrue(spokenFirst.exists, "SPOKEN_ROW_FOLDED_INTO_WORK")
    }

    func testSystemNoticesExpandAndCollapseWithoutLosingTheirBody() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat", initialDestination: "chat", name: "system-notices"),
            additionalArguments: ["--openclaw-system-notices-fixture", "--openclaw-no-reactions-fixture"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.staticTexts["Notice fixture ready."].waitForExistence(timeout: 8))
        self.attachScreenshot(named: "system-notices-collapsed")

        for (label, start, end) in [
            ("injected context", "CONTEXT_START", "CONTEXT_END"),
            ("background task", "TASK_START", "TASK_END"),
        ] {
            let disclosure = app.buttons.matching(NSPredicate(format: "label CONTAINS[c] %@", label)).firstMatch
            let body = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", start)).firstMatch
            XCTAssertTrue(disclosure.waitForExistence(timeout: 5))
            XCTAssertFalse(body.exists, "System payload should start collapsed")
            for _ in 0..<4 where !disclosure.isHittable {
                app.swipeDown()
            }
            XCTAssertTrue(disclosure.isHittable)
            disclosure.tap()
            XCTAssertTrue(body.waitForExistence(timeout: 5))
            XCTAssertTrue(body.label.contains(end), "Expanded disclosure must expose the complete payload")
            self.attachScreenshot(named: "system-notice-expanded-\(start)")
            for _ in 0..<4 where !disclosure.isHittable {
                app.swipeDown()
            }
            XCTAssertTrue(disclosure.isHittable)
            disclosure.tap()
            XCTAssertTrue(body.waitForNonExistence(timeout: 5))
        }
        self.attachScreenshot(named: "system-notices-recollapsed")
    }

    func testKeyboardOpenPreservesTranscriptAndFollowsLiveEdgeAfterSend() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone keyboard proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "keyboard-follow"),
            additionalArguments: ["--openclaw-long-chat-fixture"])
        let app = try XCTUnwrap(self.app)

        let latestSeededReply = app.staticTexts["OPENCLAW_LONG_CHAT_LATEST"]
        XCTAssertTrue(latestSeededReply.waitForExistence(timeout: 8))
        let transcript = try self.chatTranscript(in: app)
        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 5))
        work.tap()
        let result = app.buttons["chat-tool-activity-fixture-long-review"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        result.tap()
        let earlier = app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Earlier response context.")).firstMatch
        XCTAssertTrue(earlier.waitForExistence(timeout: 5))
        // A visible text leaf can be unhittable inside its accessible message container.
        // This setup needs the reply's pixels in the viewport, not a tap target.
        for _ in 0..<12 where !latestSeededReply.exists || !transcript.frame.contains(latestSeededReply.frame) {
            transcript.swipeUp()
        }
        XCTAssertTrue(transcript.frame.contains(latestSeededReply.frame))
        self.assertElementHasRenderedContent(latestSeededReply, named: "seeded reply after expanding work")

        // Revealing the reply after expanding work does not establish live-edge following.
        let initialJumpToLatest = app.buttons["Jump to latest reply"]
        if initialJumpToLatest.exists {
            initialJumpToLatest.tap()
        }
        XCTAssertTrue(initialJumpToLatest.waitForNonExistence(timeout: 3))

        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        self.waitForEnabled(input)
        input.tap()
        let keyboard = app.keyboards.firstMatch
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        func visibleAreaAboveKeyboard() -> CGRect {
            transcript.frame.intersection(CGRect(
                x: app.frame.minX,
                y: app.frame.minY,
                width: app.frame.width,
                height: keyboard.frame.minY - app.frame.minY))
        }
        XCTAssertTrue(latestSeededReply.exists)
        XCTAssertTrue(latestSeededReply.frame.intersects(visibleAreaAboveKeyboard()))
        XCTAssertLessThanOrEqual(latestSeededReply.frame.maxY, keyboard.frame.minY + 1)
        self.assertElementHasRenderedContent(latestSeededReply, named: "seeded reply after keyboard opens")

        let promptPrefix = "Check the "
        let promptSuffix = "release plan."
        let prompt = promptPrefix + promptSuffix
        input.typeText(promptPrefix)
        XCTAssertTrue(latestSeededReply.exists)
        XCTAssertTrue(latestSeededReply.frame.intersects(visibleAreaAboveKeyboard()))
        self.assertElementHasRenderedContent(latestSeededReply, named: "seeded reply while typing")
        input.typeText(promptSuffix)
        XCTAssertEqual(input.value as? String, prompt)
        XCTAssertTrue(latestSeededReply.exists)
        XCTAssertTrue(latestSeededReply.frame.intersects(visibleAreaAboveKeyboard()))
        XCTAssertLessThanOrEqual(latestSeededReply.frame.maxY, keyboard.frame.minY + 1)
        self.attachScreenshot(named: "keyboard-transcript-visible-while-typing")

        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 5))
        XCTAssertTrue(send.isEnabled)
        send.tap()

        // Regression proof for #108692 and #135214: the transcript remains rendered while typing,
        // then the sent turn follows the live edge without a manual redraw or scroll.
        XCTAssertTrue(keyboard.exists)
        let sentPrompt = app.staticTexts.matching(
            NSPredicate(format: "label == %@", prompt))
            .firstMatch
        XCTAssertTrue(sentPrompt.waitForExistence(timeout: 8))
        let reply = app.staticTexts.matching(
            NSPredicate(format: "label CONTAINS %@", "keep the mobile workflow connected to the gateway"))
            .firstMatch
        XCTAssertTrue(reply.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Writing"].waitForNonExistence(timeout: 1))
        let visibleArea = visibleAreaAboveKeyboard()
        XCTAssertTrue(reply.frame.intersects(visibleArea))
        XCTAssertLessThanOrEqual(reply.frame.maxY, keyboard.frame.minY + 1)
        self.assertElementHasRenderedContent(reply, named: "reply after send")
        XCTAssertFalse(app.buttons["Jump to latest reply"].exists)
        self.attachScreenshot(named: "keyboard-transcript-visible-after-send")

        // Keep repeated typing and reader positioning on the real editor with deterministic history.
        // A multiline turn still follows the live edge; only a reader drag releases following.
        let anchoredPrompt = String(
            repeating: "Reader context keeps the question anchored as the reply arrives.\n",
            count: 9) + "Keep this reply anchored."
        self.waitForEnabled(input)
        input.tap()
        input.typeText(anchoredPrompt)
        XCTAssertTrue(keyboard.waitForExistence(timeout: 3))
        try self.dismissChatKeyboardThroughTranscript(in: app)
        XCTAssertTrue(sentPrompt.frame.intersects(transcript.frame))
        self.assertElementHasRenderedContent(sentPrompt, named: "sent prompt after keyboard dismissal")
        XCTAssertEqual(input.value as? String, anchoredPrompt)
        XCTAssertTrue(send.isEnabled)
        send.tap()
        let submitted = app.staticTexts.matching(NSPredicate(format: "label == %@", anchoredPrompt)).firstMatch
        XCTAssertTrue(submitted.waitForExistence(timeout: 5))
        let response = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@",
            "I can help with",
            "Keep this reply anchored.")).firstMatch
        XCTAssertTrue(response.waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Writing"].waitForNonExistence(timeout: 5))

        let jumpToLatest = app.buttons["Jump to latest reply"]
        // Pin-only policy: sending follows the reply, not the submitted question.
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))
        let finalReply = app.staticTexts.matching(NSPredicate(
            format: "label CONTAINS %@ AND label CONTAINS %@",
            "I can help with",
            "Keep this reply anchored.")).firstMatch
        XCTAssertTrue(finalReply.exists)
        self.assertElementHasRenderedContent(finalReply, named: "multiline reply at live edge")
        self.attachScreenshot(named: "multiline-reply-at-live-edge")

        transcript.swipeDown()
        XCTAssertTrue(jumpToLatest.waitForExistence(timeout: 3))
        self.attachScreenshot(named: "reader-manual-departure")
        jumpToLatest.tap()
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))
        let replyVisible = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                finalReply.exists && finalReply.frame.intersects(transcript.frame)
            },
            object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [replyVisible], timeout: 5), .completed)
        self.assertElementHasRenderedContent(finalReply, named: "reply after explicit Jump")
        self.attachScreenshot(named: "reader-returned-to-latest")

        // Status-bar navigation is reader intent, not a keyboard-avoidance animation.
        // The system status bar is visible but is not in this app's accessibility tree.
        // Target the visible clock, not the empty margin left of the status items.
        let navigationBar = app.navigationBars.firstMatch
        let statusBarHeight = navigationBar.frame.minY - app.frame.minY
        XCTAssertGreaterThan(statusBarHeight, 0)
        XCTAssertEqual(app.state, .runningForeground, "Native navigation requires the app in the foreground")
        self.attachScreenshot(named: "reader-before-status-bar-navigation")
        app.coordinate(withNormalizedOffset: .zero)
            .withOffset(CGVector(dx: app.frame.width * 0.18, dy: statusBarHeight * 0.4)).tap()
        guard app.state == .runningForeground else {
            XCTFail("Status-bar input left the app; this is not native-navigation evidence")
            return
        }
        self.attachScreenshot(named: "reader-after-status-bar-input")
        let readerDepartedLatest = XCTNSPredicateExpectation(
            predicate: NSPredicate { _, _ in
                app.state == .runningForeground &&
                    (!finalReply.exists || !finalReply.frame.intersects(transcript.frame))
            },
            object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [readerDepartedLatest], timeout: 5), .completed)
        XCTAssertEqual(app.state, .runningForeground)
        XCTAssertTrue(jumpToLatest.waitForExistence(timeout: 3))
        self.assertElementHasRenderedContent(transcript, named: "transcript after status bar scroll")
        self.attachScreenshot(named: "reader-status-bar-navigation")
        jumpToLatest.tap()
        XCTAssertTrue(jumpToLatest.waitForNonExistence(timeout: 3))
    }

    func testAnthropicWorkChunksKeepNarrationVisibleInOrder() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-anthropic-work-chunks-fixture", "--openclaw-no-reactions-fixture"])
        let app = try XCTUnwrap(self.app)
        let first = app.staticTexts["I will read the sample file."]
        let second = app.staticTexts["The file looks good. I will run the check."]
        let final = app.staticTexts["All checks passed."]
        XCTAssertTrue(final.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "180490-after-initial")
        XCTAssertTrue(first.exists)
        XCTAssertTrue(second.exists)
        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked"))
        XCTAssertEqual(work.count, 2, "Each adjacent tool/result pair needs its own disclosure")
        let firstWork = work.element(boundBy: 0)
        let secondWork = work.element(boundBy: 1)
        XCTAssertLessThan(first.frame.maxY, firstWork.frame.midY)
        XCTAssertLessThan(firstWork.frame.midY, second.frame.minY)
        XCTAssertLessThan(second.frame.maxY, secondWork.frame.midY)
        XCTAssertLessThan(secondWork.frame.midY, final.frame.minY)
        for (index, disclosure) in [firstWork, secondWork].enumerated() {
            disclosure.tap()
            XCTAssertTrue(first.exists)
            XCTAssertTrue(second.exists)
            XCTAssertTrue(final.exists)
            let detail = index == 0 ? "sample.txt" : "printf checked"
            let otherDetail = index == 0 ? "printf checked" : "sample.txt"
            let tool = app.descendants(matching: .any).matching(NSPredicate(
                format: "value CONTAINS %@", detail)).firstMatch
            let otherTool = app.descendants(matching: .any).matching(NSPredicate(
                format: "value CONTAINS %@", otherDetail)).firstMatch
            XCTAssertTrue(tool.waitForExistence(timeout: 5), "The selected tool did not expand")
            XCTAssertFalse(otherTool.exists, "Expanding one chunk must not expand the other")
            self.attachScreenshot(named: "180490-after-work-\(index + 1)-expanded")
            disclosure.tap()
        }
        self.assertElementHasRenderedContent(first, named: "first narration outside work")
        self.assertElementHasRenderedContent(second, named: "second narration outside work")
        self.assertElementHasRenderedContent(final, named: "final answer outside work")
        self.attachScreenshot(named: "180490-after-collapsed")
    }

    func testUnknownOutcomeStepUsesLocalToolTitle() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-step-labels-fixture"])
        let app = try XCTUnwrap(self.app)
        XCTAssertTrue(app.staticTexts["Local readiness checked."].waitForExistence(timeout: 8))
        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 5))
        work.tap()
        for (command, expectedStatus) in [
            ("printf ready", "Outcome unknown"),
            ("printf missing", "No result"),
            ("printf complete", "Finished"),
        ] {
            let row = app.descendants(matching: .any).matching(NSPredicate(
                format: "label CONTAINS %@ AND value CONTAINS %@", "Exec", command)).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 5), "Missing tool row: \(command)")
            XCTAssertTrue(
                (row.value as? String)?.hasPrefix(expectedStatus) == true,
                "The row must retain the prepared outcome for \(command)")
            // Preserve visible uncertainty even when the row has no disclosure.
            let image = try XCTUnwrap(row.screenshot().image.cgImage)
            let recognition = VNRecognizeTextRequest()
            recognition.recognitionLevel = .accurate
            recognition.recognitionLanguages = ["en-US"]
            try VNImageRequestHandler(cgImage: image, options: [:]).perform([recognition])
            let text = (recognition.results ?? []).compactMap { $0.topCandidates(1).first?.string }
                .joined(separator: " ").lowercased()
            XCTAssertTrue(text.contains("exec"), "Rendered tool title was not recognized: \(text)")
            XCTAssertEqual(
                text.contains("outcome unknown"),
                command == "printf ready",
                "Wrong visible outcome cue: \(text)")
            XCTAssertEqual(
                text.contains("no result"),
                command == "printf missing",
                "Wrong missing-output cue: \(text)")
            XCTAssertFalse(text.contains("finished"), "Collapsed row has a status badge: \(text)")
            if command == "printf ready" {
                row.tap()
                XCTAssertTrue(app.staticTexts["ready"].waitForExistence(timeout: 5))
                XCTAssertTrue(app.staticTexts["Outcome unknown"].waitForExistence(timeout: 5))
                self.attachScreenshot(named: "step-output-and-outcome")
                row.tap()
            }
        }
        self.attachScreenshot(named: "step-labels-expanded")
        XCTAssertTrue(app.staticTexts["Local readiness checked."].exists)
    }

    func testCompletedWorkDisclosureKeepsFinalReplyVisible() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-long-chat-fixture"])
        let app = try XCTUnwrap(self.app)
        let latest = app.staticTexts["OPENCLAW_LONG_CHAT_LATEST"]
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "completed-work-initial")

        let work = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 5))
        XCTAssertGreaterThanOrEqual(work.frame.height, 44)
        let earlier = app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Earlier response context.")).firstMatch
        XCTAssertFalse(earlier.exists)
        let composer = app.otherElements["chat-composer-surface"]
        XCTAssertLessThanOrEqual(latest.frame.maxY, composer.frame.minY)
        self.assertElementHasRenderedContent(latest, named: "final reply with work collapsed")
        work.tap()
        let result = app.buttons["chat-tool-activity-fixture-long-review"]
        XCTAssertTrue(result.waitForExistence(timeout: 5))
        result.tap()
        XCTAssertTrue(earlier.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "completed-work-expanded")
        let workLabel = work.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Worked")).firstMatch
        for _ in 0..<12 where !workLabel.isHittable {
            app.swipeDown()
        }
        XCTAssertTrue(workLabel.isHittable)
        workLabel.tap()
        XCTAssertTrue(earlier.waitForNonExistence(timeout: 5))
        XCTAssertLessThanOrEqual(latest.frame.maxY, composer.frame.minY)
        self.assertElementHasRenderedContent(latest, named: "final reply after collapsing work again")
        self.attachScreenshot(named: "completed-work-collapsed-again")
    }

    func testIPadTranscriptStaysInsideComposerColumn() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .pad, "iPad reading-column proof only")
        defer { XCUIDevice.shared.orientation = .portrait }
        for (orientation, name) in [
            (UIDeviceOrientation.portrait, "portrait"),
            (UIDeviceOrientation.landscapeLeft, "landscape"),
        ] {
            XCUIDevice.shared.orientation = orientation
            self.launchApp(
                for: Self.chatScreenshotTarget,
                additionalArguments: ["--openclaw-long-chat-fixture"])
            let app = try XCTUnwrap(self.app)
            let composer = app.otherElements["chat-composer-surface"]
            XCTAssertTrue(composer.waitForExistence(timeout: 8))
            let transcript = try self.chatTranscript(in: app)
            let assistant = app.otherElements["chat-assistant-message-body"].firstMatch
            XCTAssertTrue(assistant.waitForExistence(timeout: 8))
            // Check the assistant container, not a short text leaf that fits even in a full-width row.
            XCTAssertGreaterThanOrEqual(assistant.frame.minX, composer.frame.minX - 24)
            XCTAssertLessThanOrEqual(assistant.frame.maxX, composer.frame.maxX + 24)
            self.assertElementHasRenderedContent(assistant, named: "iPad assistant column \(name)")
            self.attachScreenshot(named: "ipad-assistant-column-\(name)")
            let user = app.staticTexts["Prepare a detailed project review."]
            for _ in 0..<4 where !user.exists || !user.frame.intersects(transcript.frame) {
                transcript.swipeDown()
            }
            XCTAssertTrue(user.exists)
            guard user.exists else { return }
            XCTAssertTrue(user.frame.intersects(transcript.frame))
            XCTAssertGreaterThanOrEqual(user.frame.minX, composer.frame.minX - 24)
            XCTAssertLessThanOrEqual(user.frame.maxX, composer.frame.maxX + 24)
            XCTAssertGreaterThanOrEqual(user.frame.maxX, composer.frame.maxX - 48)
            self.assertElementHasRenderedContent(user, named: "iPad user column \(name)")
            self.attachScreenshot(named: "ipad-user-column-\(name)")
        }
    }

    func testExistingSessionRestoresLatestOutput() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone reader positioning proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "existing-session-latest-output"),
            additionalArguments: ["--openclaw-long-chat-fixture"])
        let app = try XCTUnwrap(self.app)

        let latest = app.staticTexts["OPENCLAW_LONG_CHAT_LATEST"]
        XCTAssertTrue(latest.waitForExistence(timeout: 8))
        let composer = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(composer.waitForExistence(timeout: 3))
        XCTAssertLessThanOrEqual(latest.frame.maxY, composer.frame.minY + 1)
        XCTAssertFalse(app.buttons["Jump to latest reply"].exists)
        self.attachScreenshot(named: "existing-session-latest-output")
    }

    func testTaskListLongPressOffersRefreshDismissAndClear() throws {
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-progress-card-fixture"])
        let app = try XCTUnwrap(self.app)
        let card = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Plan, 1 of 3 steps done")).firstMatch
        XCTAssertTrue(card.waitForExistence(timeout: 8))
        // On touch the one-line header keeps only the collapse caret.
        let actions = ["refresh", "dismiss", "clear-saved"]
        for action in actions {
            XCTAssertFalse(
                app.buttons["chat-progress-card-\(action)"].exists,
                "Task list header still has a \(action) button")
        }
        self.attachScreenshot(named: "task-list-card")

        card.press(forDuration: 0.8)
        for action in actions {
            XCTAssertTrue(
                app.buttons["chat-progress-card-\(action)"].waitForExistence(timeout: 3),
                "Task list menu has no \(action) action")
        }
        self.attachScreenshot(named: "task-list-menu")
        app.buttons["chat-progress-card-dismiss"].tap()
        XCTAssertTrue(card.waitForNonExistence(timeout: 3))
        self.attachScreenshot(named: "task-list-dismissed")
    }

    func testChatPresentationInLightAppearance() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-light"),
            appearance: "light")

        XCTAssertTrue(self.app.map { self.agentIdentity(in: $0).waitForExistence(timeout: 8) } == true)
        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].exists == true)
        self.attachScreenshot(named: "chat-light")
    }

    func testChatKeepsLayeredCanvasInDarkAppearance() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone chat proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-dark-layered-canvas"))

        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].waitForExistence(timeout: 8) == true)
        self.assertChatCanvasIsNotSolidBlack()
        self.attachScreenshot(named: "chat-dark-layered-canvas")

        self.sendFixtureChatMessage("Check the release status and prepare the next steps.")
        self.attachScreenshot(named: "chat-dark-soft-bottom-edge")
    }

    func testSavedPromptReactionsAndQuickPalette() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone message reaction proof only")
        let prompt = "Check the release status and prepare the next steps."
        self.launchApp(
            for: Self.chatScreenshotTarget,
            additionalArguments: ["--openclaw-no-reactions-fixture"])
        self.sendFixtureChatMessage(prompt)
        let before = try XCTUnwrap(self.app)
        XCTAssertFalse(before.descendants(matching: .any).matching(NSPredicate(
            format: "identifier BEGINSWITH %@", "chat-message-reactions-")).firstMatch.exists)
        self.attachScreenshot(named: "ios-reactions-prompt-before")
        before.staticTexts[prompt].press(forDuration: 0.8)
        XCTAssertTrue(before.buttons["Copy Message"].waitForExistence(timeout: 3))
        XCTAssertFalse(before.buttons["chat-add-reaction"].exists)

        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "chat-message-reactions"))
        let app = try XCTUnwrap(self.app)
        self.sendFixtureChatMessage(prompt)

        let thumbsUp = app.buttons["chat-reaction-👍"]
        XCTAssertTrue(thumbsUp.waitForExistence(timeout: 5))
        XCTAssertTrue(thumbsUp.isSelected)
        XCTAssertTrue(thumbsUp.label.contains("You, Casey"))
        XCTAssertTrue(app.buttons["chat-reaction-🚀"].exists)
        self.attachScreenshot(named: "ios-reactions-prompt-after")

        thumbsUp.tap()
        XCTAssertTrue(thumbsUp.wait(for: \.isSelected, toEqual: false, timeout: 5))
        XCTAssertEqual(thumbsUp.label, "Casey reacted with 👍")
        thumbsUp.tap()
        XCTAssertTrue(thumbsUp.wait(for: \.isSelected, toEqual: true, timeout: 5))

        app.staticTexts[prompt].press(forDuration: 0.8)
        let addReaction = app.buttons["chat-add-reaction"]
        XCTAssertTrue(addReaction.waitForExistence(timeout: 3))
        addReaction.tap()
        let picker = app.descendants(matching: .any)["chat-reaction-picker"].firstMatch
        XCTAssertTrue(picker.waitForExistence(timeout: 3))
        let quickEmoji = ["👍", "❤️", "🎉", "👀", "🚀", "😂"]
        let choices = quickEmoji.map { app.buttons["chat-reaction-choice-\($0)"] }
        for choice in choices {
            XCTAssertTrue(choice.exists)
        }
        for (left, right) in zip(choices, choices.dropFirst()) {
            XCTAssertLessThan(left.frame.minX, right.frame.minX)
        }
        XCTAssertTrue(choices[0].isSelected)
        XCTAssertTrue(app.buttons["chat-reaction-more"].exists)
        self.attachScreenshot(named: "ios-reactions-quick-palette")

        app.buttons["chat-reaction-choice-😂"].tap()
        XCTAssertTrue(picker.waitForNonExistence(timeout: 3))
        let addedReaction = app.buttons["chat-reaction-😂"]
        XCTAssertTrue(addedReaction.waitForExistence(timeout: 5))
        XCTAssertTrue(addedReaction.isSelected)
    }

    func testAssistantLongPressKeepsTranscriptVisibleAndActionsReachable() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone message interaction proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "assistant-message-actions"))
        let app = try XCTUnwrap(self.app)

        let assistant = app.staticTexts[
            "Ready when you are. I can check a project, coordinate an agent, or prepare the next step.",
        ]
        XCTAssertTrue(assistant.waitForExistence(timeout: 8))
        XCTAssertFalse(app.buttons["chat-message-actions"].exists)
        assistant.press(forDuration: 0.8)
        XCTAssertTrue(assistant.exists)
        XCTAssertTrue(app.otherElements["chat-composer-surface"].exists)
        XCTAssertTrue(app.buttons["Copy Message"].waitForExistence(timeout: 3))
        XCTAssertTrue(app.buttons["chat-add-reaction"].exists)
        self.attachScreenshot(named: "assistant-message-actions")

        app.buttons["Select Text"].tap()
        let selectableText = app.textViews["chat-selectable-text"]
        XCTAssertTrue(selectableText.waitForExistence(timeout: 3))
        XCTAssertTrue((selectableText.value as? String)?.contains("Ready when you are") == true)
        self.attachScreenshot(named: "assistant-select-text")
        app.buttons["Close"].tap()
        XCTAssertTrue(selectableText.waitForNonExistence(timeout: 3))
    }

    func testCodeBlockCopyButtonCopiesRawCode() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone code block copy proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "chat",
            initialDestination: "chat",
            name: "code-block-copy"))
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("```swift\nlet copied = true\n```")
        let send = app.buttons["chat-send-message"]
        XCTAssertTrue(send.waitForExistence(timeout: 3))
        send.tap()

        // The user's block precedes any code parsed from the fixture's echoed reply.
        let copyCode = app.buttons["Copy code"].firstMatch
        XCTAssertTrue(copyCode.waitForExistence(timeout: 8))
        app.scrollViews.firstMatch.swipeDown()
        self.attachScreenshot(named: "code-block-copy")
        // iOS prompts before another process reads pasteboard contents, so the runner can only
        // observe that the tap wrote a string; ChatPasteboardTests covers the exact bytes in-process.
        UIPasteboard.general.items = []
        XCTAssertFalse(UIPasteboard.general.hasStrings)
        copyCode.tap()
        XCTAssertTrue(UIPasteboard.general.hasStrings)
        self.attachScreenshot(named: "code-block-copied")
    }

    func testEmptyChatStarterPromptSendsMessage() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-empty-starters"),
            additionalArguments: ["--openclaw-empty-chat-fixture"])

        let starter = try XCTUnwrap(self.app?.buttons["chat-starter-summarize-status"])
        XCTAssertTrue(starter.waitForExistence(timeout: 8))
        XCTAssertTrue(self.app?.staticTexts["What would you like to work on?"].exists == true)
        self.attachScreenshot(named: "chat-empty-starters")

        starter.tap()
        let sentText = "Summarize the current OpenClaw status and tell me what needs attention."
        let sentRows = self.app?.staticTexts.matching(NSPredicate(format: "label == %@", sentText))
        XCTAssertTrue(sentRows?.firstMatch.waitForExistence(timeout: 5) == true)
        XCTAssertEqual(sentRows?.count, 1)
        XCTAssertTrue(
            self.app?.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "I can help with"))
                .firstMatch.waitForExistence(timeout: 5) == true)
        self.attachScreenshot(named: "chat-starter-response")
    }

    func testEmptyChatStarterPromptsLocalizeInGerman() throws {
        self.launchApp(
            for: ScreenshotTarget(
                initialTab: "chat",
                initialDestination: "chat",
                name: "chat-empty-starters-german"),
            additionalArguments: [
                "--openclaw-empty-chat-fixture",
                "-AppleLanguages",
                "(de)",
                "-AppleLocale",
                "de_DE",
            ])

        XCTAssertTrue(self.app?.staticTexts["Woran möchtest du arbeiten?"].waitForExistence(timeout: 8) == true)
        let starter = try XCTUnwrap(self.app?.buttons["OpenClaw-Status prüfen"])
        XCTAssertTrue(starter.exists)
        starter.tap()
        XCTAssertTrue(
            self.app?.staticTexts[
                "Fasse den aktuellen OpenClaw-Status zusammen und sage mir, was Aufmerksamkeit erfordert.",
            ].waitForExistence(timeout: 5) == true)
        self.attachScreenshot(named: "chat-empty-starters-german")
    }

    func testOnboardingPairCommandAndCompletionOpenChat() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone onboarding proof only")
        self.addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }

        let app = XCUIApplication()
        app.launchArguments += ["--openclaw-reset-onboarding"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertFalse(app.staticTexts["Allow access"].exists)

        let copySetupCommand = app.buttons["Copy setup code command"]
        XCTAssertTrue(copySetupCommand.waitForExistence(timeout: 8))
        copySetupCommand.tap()
        XCTAssertEqual(copySetupCommand.value as? String, "Copied")
        self.attachScreenshot(named: "onboarding-copy-setup-code-command")

        app.buttons["Connect Manually"].tap()
        let setupCode = app.textFields["Enter setup code"]
        XCTAssertTrue(setupCode.waitForExistence(timeout: 5))
        setupCode.tap()
        setupCode.typeText("APPLE-REVIEW-DEMO")
        app.buttons["Dismiss Keyboard"].tap()
        app.buttons["Apply"].tap()

        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.staticTexts["Apple Review Demo Gateway"].exists)
        XCTAssertTrue(app.staticTexts["Local demo mode"].exists)
        self.attachScreenshot(named: "onboarding-connected-go-to-chat")

        app.buttons["Go to Chat"].tap()
        XCTAssertTrue(self.agentIdentity(in: app).waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Show"].exists)
    }

    func testChatAndOverviewNavigateThroughSidebar() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone sidebar proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "control",
            initialDestination: "overview",
            name: "control-chat-return"))

        let agentSession = try XCTUnwrap(self.app?.staticTexts["Agent session"])
        XCTAssertTrue(agentSession.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "control-overview-before-chat")

        try self.startNewChatFromSidebar()
        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].waitForExistence(timeout: 8) == true)
        self.attachScreenshot(named: "chat-return-to-overview")

        try self.selectSidebarDestination("Overview")
        XCTAssertTrue(agentSession.waitForExistence(timeout: 8))
        self.attachScreenshot(named: "control-overview-after-chat")

        let agentSessionRow = try XCTUnwrap(self.app?.buttons.matching(NSPredicate(
            format: "label BEGINSWITH[c] %@",
            "Molty, chat")).firstMatch)
        XCTAssertTrue(agentSessionRow.waitForExistence(timeout: 8))
        agentSessionRow.tap()

        XCTAssertTrue(self.app?.otherElements["chat-composer-surface"].waitForExistence(timeout: 8) == true)
        self.attachScreenshot(named: "chat-session-return-to-overview")
        try self.selectSidebarDestination("Overview")
        XCTAssertTrue(self.app?.staticTexts["Agent session"].waitForExistence(timeout: 8) == true)
    }

    func testAgentUsesToolbarFilter() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone Agent proof only")
        self.launchApp(for: ScreenshotTarget(
            initialTab: "agent",
            initialDestination: "agents",
            name: "agent-toolbar-filter"))

        let menu = try XCTUnwrap(app?.buttons["agent-status-filter-menu"])
        XCTAssertTrue(menu.waitForExistence(timeout: 8))
        XCTAssertFalse(self.app?.segmentedControls["Agent status"].exists == true)
        menu.tap()
        XCTAssertTrue(self.app?.buttons["All"].waitForExistence(timeout: 3) == true)
        XCTAssertTrue(self.app?.buttons["Online"].exists == true)
        XCTAssertTrue(self.app?.buttons["Ready"].exists == true)
        self.attachScreenshot(named: "agent-toolbar-filter")

        // Native context menus must finish their dismissal before teardown. Killing
        // the app with this menu open can leave the next app scene inactive.
        self.app?.buttons["Ready"].tap()
        self.waitForValue("Ready", of: menu)
        menu.tap()
        let all = try XCTUnwrap(self.app?.buttons["All"])
        XCTAssertTrue(all.waitForExistence(timeout: 3))
        all.tap()
        self.waitForValue("All", of: menu)
    }

    /// Real app onboarding, history decoder, artifact RPC, HTTP loader, and system share sheet.
    /// Only the loopback Gateway is synthetic; no production UI state is injected.
    func testManagedDocumentDownloadAndSystemShare() async throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_ATTACHMENT_FIXTURE_URL"] != nil,
            "Run through scripts/test-ios-chat-attachments.sh with the owned loopback fixture")
        let fixtureURL = try XCTUnwrap(ProcessInfo.processInfo.environment["OPENCLAW_IOS_ATTACHMENT_FIXTURE_URL"])
        let fixtureBaseURL = try XCTUnwrap(URL(string: fixtureURL))
        let app = try await self.launchPairedLiveGatewayApp(
            initialTab: "chat",
            initialDestination: "chat",
            readinessURL: fixtureBaseURL.appendingPathComponent("attachment-ready"))
        // A fixture/history failure must never produce the expected baseline regression marker.
        guard app.staticTexts["Your report is ready."].waitForExistence(timeout: 15) else {
            XCTFail("Managed document fixture history did not load")
            return
        }
        let download = app.buttons["chat-file-download"]
        let available = download.waitForExistence(timeout: 5)
        let stage = ProcessInfo.processInfo.environment["OPENCLAW_IOS_ATTACHMENT_BASELINE"] == "1"
            ? "before" : "after"
        self.attachScreenshot(named: "document-\(stage)")
        XCTAssertTrue(available, "MANAGED_DOCUMENT_DOWNLOAD_MISSING")
        XCTAssertTrue(download.isEnabled)
        download.tap()
        let saveToFiles = app.descendants(matching: .any)["Save to Files"].firstMatch
        XCTAssertTrue(saveToFiles.waitForExistence(timeout: 10), "Downloaded file must reach the system exporter")
        self.attachScreenshot(named: "document-system-share")

        let statusURL = fixtureBaseURL
        let (statusData, _) = try await URLSession.shared.data(from: statusURL)
        let status = try XCTUnwrap(JSONSerialization.jsonObject(with: statusData) as? [String: Any])
        XCTAssertEqual(status["documentDownloads"] as? Int, 1)
        let requests = try XCTUnwrap(status["requests"] as? [[String: Any]])
        let artifacts = requests.filter { $0["method"] as? String == "artifacts.download" }
        XCTAssertEqual(artifacts.count, 1)
        XCTAssertEqual(
            artifacts.first?["artifactId"] as? String,
            "artifact_managed_media_11111111-1111-4111-8111-111111111111")
        XCTAssertTrue(["main", "agent:main:main"].contains(artifacts.first?["sessionKey"] as? String ?? ""))

        // Relaunch exercises persisted history plus fresh scoped retrieval, not a retained ticket.
        let reloaded = self.relaunchConnectedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        let reloadedDownload = reloaded.buttons["chat-file-download"]
        XCTAssertTrue(reloadedDownload.waitForExistence(timeout: 15))
        let deniedURL = try XCTUnwrap(URL(string: fixtureURL + "/attachment-denied"))
        _ = try await URLSession.shared.data(from: deniedURL)
        reloadedDownload.tap()
        XCTAssertTrue(reloaded.alerts["Unable to Download File"].waitForExistence(timeout: 10))
        self.attachScreenshot(named: "document-expired")
        let (reloadedStatusData, _) = try await URLSession.shared.data(from: statusURL)
        let reloadedStatus = try XCTUnwrap(JSONSerialization.jsonObject(with: reloadedStatusData) as? [String: Any])
        let reloadedRequests = try XCTUnwrap(reloadedStatus["requests"] as? [[String: Any]])
        let refreshedArtifacts = reloadedRequests.filter { $0["method"] as? String == "artifacts.download" }
        XCTAssertEqual(refreshedArtifacts.count, 2, "Relaunch must obtain fresh artifact access, not reuse a ticket")
        XCTAssertEqual(refreshedArtifacts.last?["artifactId"] as? String, artifacts.first?["artifactId"] as? String)
        XCTAssertEqual(refreshedArtifacts.last?["sessionKey"] as? String, artifacts.first?["sessionKey"] as? String)
    }

    func testLiveGatewayPairAndSharePhoto() throws {
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        try self.sharePhotoFromPhotos(returningTo: app)
    }

    func testExistingGatewaySharesPhoto() throws {
        try XCTSkipUnless(ProcessInfo.processInfo.environment["OPENCLAW_IOS_LIVE_GATEWAY"] == "1")
        // Do not reset onboarding or credentials: this also drives an installed upgrade.
        let app = self.relaunchConnectedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        try self.sharePhotoFromPhotos(returningTo: app)
    }

    private func sharePhotoFromPhotos(returningTo app: XCUIApplication) throws {
        self.attachScreenshot(named: "share-app-paired")
        let photos = try self.openOpenClawPhotoShareSheet()
        let draft = photos.textViews["share-compose.draft"]
        XCTAssertTrue(draft.waitForExistence(timeout: 15), "Share compose card missing")
        XCTAssertTrue(photos.staticTexts["Preparing share…"].waitForNonExistence(timeout: 30))
        let marker = ProcessInfo.processInfo.environment["OPENCLAW_IOS_SHARE_MARKER"] ?? "OPENCLAW_E2E_SHARE"
        draft.tap()
        draft.typeText("Describe this image. \(marker)")
        let send = photos.buttons["share-compose.send"]
        self.waitForEnabled(send)
        let compose = XCTAttachment(screenshot: photos.screenshot())
        compose.name = "share-photo-ready"
        compose.lifetime = .keepAlways
        self.add(compose)
        send.tap()
        XCTAssertTrue(draft.waitForNonExistence(timeout: 30), "Successful share must dismiss the compose card")
        app.activate()
        let delivered = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", marker)).firstMatch
        XCTAssertTrue(delivered.waitForExistence(timeout: 30), "Shared message did not reach the app's chat")
        self.attachScreenshot(named: "share-photo-delivered")
        print("IOS_SHARE_CHECKPOINT delivered-without-companion-approval")
    }

    func testLiveGatewayPairChatAndRelaunch() throws {
        try XCTSkipIf(UIDevice.current.userInterfaceIdiom != .phone, "Phone lifecycle proof only")
        let app = try self.launchPairedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        XCTAssertEqual(app.state, .runningForeground)
        print("IOS_RELEASE_CHECKPOINT paired")
        for (stage, marker) in [("first", "OPENCLAW_E2E_FIRST"), ("second", "OPENCLAW_E2E_SECOND")] {
            try self.sendLiveGatewayMessage(
                "Reply exactly with \(marker) and no other text.",
                expecting: marker,
                stage: stage,
                in: app)
            print("IOS_RELEASE_CHECKPOINT \(stage)")
        }

        // A new request after process termination exercises the credentials persisted during pairing.
        let relaunchedApp = self.relaunchConnectedLiveGatewayApp(initialTab: "chat", initialDestination: "chat")
        print("IOS_RELEASE_CHECKPOINT relaunched")
        try self.sendLiveGatewayMessage(
            "Reply exactly with OPENCLAW_E2E_RELAUNCH and no other text.",
            expecting: "OPENCLAW_E2E_RELAUNCH",
            stage: "relaunch",
            in: relaunchedApp)
        print("IOS_RELEASE_CHECKPOINT relaunch")
        try self.selectSidebarDestination("Overview")
        XCTAssertTrue(relaunchedApp.staticTexts["Agent session"].waitForExistence(timeout: 8))
        XCTAssertTrue(relaunchedApp.buttons["RootTabs.Sidebar.Show"].exists)
        XCTAssertTrue(relaunchedApp.buttons["Gateway settings"].waitForExistence(timeout: 5))
        self.attachScreenshot(named: "live-gateway-overview")
        XCTAssertEqual(relaunchedApp.state, .runningForeground)
        print("IOS_RELEASE_CHECKPOINT overview")
    }

    func testManualAuthRetryUsesEditedToken() throws {
        try XCTSkipUnless(
            ProcessInfo.processInfo.environment["OPENCLAW_IOS_RETRY_E2E"] == "1",
            "Set OPENCLAW_IOS_RETRY_E2E=1 with a local token-auth Gateway on port 18920")
        let token = try XCTUnwrap(ProcessInfo.processInfo.environment["OPENCLAW_IOS_RETRY_TOKEN"])

        let app = XCUIApplication()
        addUIInterruptionMonitor(withDescription: "Local network access") { alert in
            guard alert.buttons["Allow"].exists else { return false }
            alert.buttons["Allow"].tap()
            return true
        }
        app.launchArguments += ["--openclaw-reset-onboarding"]
        app.launch()
        self.app = app

        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 8))
        app.buttons["Continue"].tap()
        app.tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 8))
        app.buttons["Connect Manually"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Home Network")).firstMatch.tap()
        app.buttons["Continue"].tap()

        let host = app.textFields["Host"]
        XCTAssertTrue(host.waitForExistence(timeout: 5))
        host.tap()
        self.clearTextField(host)
        host.typeText("localhost")

        let port = app.textFields["Port"]
        XCTAssertTrue(port.waitForExistence(timeout: 5))
        port.tap()
        self.clearTextField(port)
        port.typeText("18920")
        let unencrypted = app.buttons["Unencrypted"]
        XCTAssertTrue(unencrypted.waitForExistence(timeout: 5))
        unencrypted.tap()
        app.buttons["Connect"].tap()

        let tokenField = app.secureTextFields["Gateway Auth Token"]
        XCTAssertTrue(tokenField.waitForExistence(timeout: 20))
        tokenField.tap()
        tokenField.typeText(token)
        app.buttons["Dismiss Keyboard"].tap()
        app.buttons["Retry Connection"].tap()

        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 30))
        self.attachScreenshot(named: "manual-auth-retry-connected")
    }
}
