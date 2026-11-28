import XCTest

extension OpenClawSnapshotUITests {
    private static let activityTarget = ScreenshotTarget(
        initialTab: "chat", initialDestination: "chat", name: "chat-activity-pills")

    private func activityPill(_ id: String, in app: XCUIApplication) -> XCUIElement {
        app.buttons["chat-activity-pill-\(id)"]
    }

    private func revealStop(_ row: XCUIElement) {
        let start = row.coordinate(withNormalizedOffset: CGVector(dx: 0.86, dy: 0.5))
        let end = row.coordinate(withNormalizedOffset: CGVector(dx: 0.54, dy: 0.5))
        start.press(forDuration: 0.08, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
    }

    func testSubagentPickerKeepsEqualWidthsAcrossDigitChanges() throws {
        self.continueAfterFailure = false
        self.launchApp(
            for: Self.activityTarget,
            additionalArguments: ["--openclaw-activity-fixture", "--openclaw-subagent-count-boundary"])
        let app = try XCTUnwrap(self.app)
        self.activityPill("subagents", in: app).tap()
        app.buttons["Sheet Grabber"].swipeUp()
        let tabs = app.segmentedControls.firstMatch
        let running = tabs.buttons["Running 10"], finished = tabs.buttons["Finished 99"]
        XCTAssertTrue(finished.waitForExistence(timeout: 5))
        let flight = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        let topRow = app.cells.containing(
            .button,
            identifier: "chat-activity-child-agent:main:subagent:activity-flights").firstMatch
        for _ in 0..<6 where !flight.isHittable {
            app.collectionViews.containing(
                .button,
                identifier: "chat-activity-child-agent:main:subagent:activity-route-0").firstMatch.swipeUp()
        }
        XCTAssertTrue(flight.isHittable)
        XCTAssertEqual(tabs.frame.minX, topRow.frame.minX, accuracy: 2)
        XCTAssertEqual(tabs.frame.maxX, topRow.frame.maxX, accuracy: 2)
        XCTAssertEqual(running.frame.width, finished.frame.width, accuracy: 2)
        let initial = [tabs.frame, running.frame, finished.frame]
        self.revealStop(flight)
        app.buttons["Stop"].firstMatch.tap()
        XCTAssertTrue(tabs.buttons["Finished 100"].waitForExistence(timeout: 6))
        let updated = [tabs.frame, tabs.buttons["Running 9"].frame, tabs.buttons["Finished 100"].frame]
        for (before, after) in zip(initial, updated) {
            XCTAssertEqual(before.minX, after.minX, accuracy: 1)
            XCTAssertEqual(before.width, after.width, accuracy: 1)
        }
    }

    func testSubagentHeaderUsesSessionChatControlFrames() throws {
        self.continueAfterFailure = false
        self.launchApp(for: Self.activityTarget, additionalArguments: ["--openclaw-chat-switch-fixture"])
        let normal = try XCTUnwrap(self.app)
        try self.openSidebarWithSlowEdgeDrag()
        let session = normal.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Launch plan")).firstMatch
        XCTAssertTrue(session.waitForExistence(timeout: 5))
        session.tap()
        XCTAssertTrue(normal.staticTexts["OPENCLAW_SWITCH_B_LATEST"].waitForExistence(timeout: 5))
        let leading = normal.buttons["RootTabs.Sidebar.Show"].frame
        let menu = normal.buttons["Chat actions"].frame
        self.attachScreenshot(named: "header-normal-scrolled")

        self.launchApp(for: Self.activityTarget, additionalArguments: ["--openclaw-activity-fixture"])
        let app = try XCTUnwrap(self.app)
        self.activityPill("subagents", in: app).tap()
        app.buttons["chat-activity-child-agent:main:subagent:activity-hotels"].tap()
        let title = app.staticTexts["chat-header-title"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "header-child-single-line")
        XCTAssertEqual(app.buttons["Chat actions"].frame, menu)
        XCTAssertEqual(app.buttons["Back"].firstMatch.frame, leading)
        XCTAssertEqual(title.frame.minX, leading.maxX + 8, accuracy: 1)
        XCTAssertEqual(title.frame.midY, leading.midY, accuracy: 1)
        if #available(iOS 27.1, *) {
            defer { XCUIDevice.shared.orientation = .portrait }
            XCUIDevice.shared.orientation = .landscapeLeft
            XCTAssertTrue(app.frame.width > app.frame.height)
            XCTAssertTrue(title.exists)
            app.navigationBars.buttons["BackButton"].firstMatch.tap()
            XCTAssertTrue(self.activityPill("subagents", in: app).waitForExistence(timeout: 5))
        }
    }

    func testSubagentHeaderRemainsStableOnFailure() throws {
        self.continueAfterFailure = false
        self.launchApp(
            for: Self.activityTarget,
            appearance: "light",
            additionalArguments: [
                "--openclaw-activity-fixture",
                "--openclaw-native-child-chat-fixture",
                "--openclaw-subagent-header-failure",
            ])
        let app = try XCTUnwrap(self.app)
        self.activityPill("subagents", in: app).tap()
        app.buttons["chat-activity-child-agent:main:subagent:activity-flights"].tap()
        let menu = app.buttons["Chat actions"].firstMatch
        let title = app.descendants(matching: .any)["chat-header-title"].firstMatch
        let note = app.descendants(matching: .any)["chat-header-subtitle"].firstMatch
        XCTAssertTrue(title.waitForExistence(timeout: 5))
        XCTAssertFalse(note.exists)
        let running = title.frame, bounds = menu.frame
        XCTAssertGreaterThan(running.height, 30)
        XCTAssertTrue(note.waitForExistence(timeout: 16))
        XCTAssertTrue(note.label.contains("Failed"))
        XCTAssertLessThan(title.frame.height, 30)
        XCTAssertEqual(title.frame.minX, running.minX, accuracy: 1)
        XCTAssertEqual(bounds, menu.frame)
        self.attachScreenshot(named: "header-live-failed")
    }

    func testSubagentCodeScrollAndNativeEdgeBack() throws {
        self.continueAfterFailure = false
        self.launchApp(
            for: Self.activityTarget,
            additionalArguments: [
                "--openclaw-activity-fixture",
                "--openclaw-native-child-chat-fixture",
                "--openclaw-subagent-code-swipe",
                "-openclaw.chat.wrapCodeLines",
                "NO",
            ])
        let app = try XCTUnwrap(self.app)
        let input = self.chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Parent draft")
        let activity = self.activityPill("subagents", in: app)
        XCTAssertTrue(activity.waitForExistence(timeout: 5))
        activity.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let tabs = app.segmentedControls.firstMatch
        XCTAssertTrue(tabs.waitForExistence(timeout: 6))
        tabs.buttons["Finished 2"].tap()
        app.buttons["chat-activity-child-agent:main:subagent:activity-packing"].tap()
        let code = app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", "let departureTimes")).firstMatch
        let title = app.descendants(matching: .any)["chat-header-title"].firstMatch
        XCTAssertTrue(code.waitForExistence(timeout: 8))
        XCTAssertTrue(title.exists)
        let y = code.frame.midY / app.frame.height
        XCTAssertGreaterThan(y, 0.15)
        XCTAssertLessThan(y, 0.9)
        func point(_ x: CGFloat) -> XCUICoordinate {
            app.coordinate(withNormalizedOffset: CGVector(dx: x, dy: y))
        }
        self.attachScreenshot(named: "edge-code-rest")
        point(0.72).press(forDuration: 0.06, thenDragTo: point(0.24), withVelocity: .slow, thenHoldForDuration: 0.25)
        XCTAssertTrue(title.exists)
        self.attachScreenshot(named: "edge-code-left")
        point(0.24).press(forDuration: 0.06, thenDragTo: point(0.72), withVelocity: .slow, thenHoldForDuration: 0.25)
        XCTAssertTrue(title.exists)
        self.attachScreenshot(named: "edge-code-right")
        point(0.002).press(forDuration: 0.06, thenDragTo: point(0.89))
        XCTAssertTrue(title.waitForNonExistence(timeout: 6))
        XCTAssertFalse(tabs.exists)
        XCTAssertEqual(input.value as? String, "Parent draft")
        let pill = self.activityPill("subagents", in: app)
        XCTAssertEqual(pill.label, "2 subagents working")
        pill.tap()
        XCTAssertTrue(tabs.buttons["Running 2"].waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["Stop"].firstMatch.exists)
    }

    func testSubagentScrollEdgeDark() throws {
        try self.checkSubagentScrollEdge(appearance: "dark")
    }

    func testSubagentScrollEdgeLight() throws {
        try self.checkSubagentScrollEdge(appearance: "light")
    }

    private func checkSubagentScrollEdge(appearance: String) throws {
        self.continueAfterFailure = false
        self.launchApp(for: Self.activityTarget, appearance: appearance, additionalArguments: [
            "--openclaw-activity-fixture", "--openclaw-subagent-scroll-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        self.activityPill("subagents", in: app).tap()
        let tabs = app.segmentedControls.firstMatch
        XCTAssertTrue(tabs.buttons["Running 2"].waitForExistence(timeout: 8))
        app.buttons["Sheet Grabber"].swipeUp()
        let header = tabs.frame
        let flight = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        let hotels = app.buttons["chat-activity-child-agent:main:subagent:activity-hotels"]
        XCTAssertTrue(flight.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "edge-\(appearance)-short")
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.63, dy: 0.74))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.63, dy: 0.47))
        func scroll() {
            start.press(forDuration: 0.12, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.25)
        }
        let resting = flight.frame
        scroll()
        XCTAssertEqual(flight.frame.minY, resting.minY, accuracy: 2)
        tabs.buttons["Finished 122"].tap()
        let first = app.buttons["chat-activity-child-agent:main:subagent:activity-visit-120"]
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "edge-\(appearance)-rest")
        let initial = first.frame
        scroll()
        XCTAssertEqual(tabs.frame, header)
        XCTAssertTrue(!first.exists || first.frame.minY < initial.minY - 30)
        self.attachScreenshot(named: "edge-\(appearance)-scrolled")
        tabs.buttons["Running 2"].tap()
        XCTAssertTrue(flight.isHittable)
        self.revealStop(flight)
        app.buttons["Stop"].firstMatch.tap()
        XCTAssertTrue(tabs.buttons["Finished 123"].waitForExistence(timeout: 5))
        hotels.press(forDuration: 1)
        app.buttons["Stop"].firstMatch.tap()
        XCTAssertTrue(tabs.buttons["Finished 124"].waitForExistence(timeout: 5))
    }

    func testNativeSubagentConversation() throws {
        self.continueAfterFailure = false
        self.launchApp(for: Self.activityTarget, additionalArguments: [
            "--openclaw-activity-fixture", "--openclaw-native-child-chat-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        let tabs = app.segmentedControls.firstMatch
        let back = app.buttons["Back"].firstMatch
        let title = app.descendants(matching: .any)["chat-header-title"].firstMatch
        let stop = app.buttons["chat-stop-response"].firstMatch
        let transcript = app.collectionViews["chat-transcript"].firstMatch
        func row(_ name: String) -> XCUIElement {
            app
                .buttons["chat-activity-child-agent:main:subagent:activity-" + name]
        }
        func openList() {
            let pill = self.activityPill("subagents", in: app)
            XCTAssertTrue(pill.waitForExistence(timeout: 8))
            pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
            XCTAssertTrue(tabs.waitForExistence(timeout: 5))
        }
        func read(_ text: String) -> XCUIElement {
            app.staticTexts.matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
        }
        func visible(_ text: XCUIElement) -> Bool {
            text.exists && text.frame.midY > app.buttons["Chat actions"].firstMatch.frame.maxY && text.frame.midY < app
                .frame
                .maxY - 90
        }
        openList()
        let flights = row("flights")
        XCTAssertTrue(flights.waitForExistence(timeout: 5))
        XCTAssertFalse(flights.label.contains("Checking the bag fee"))
        self.attachScreenshot(named: "native-child-01-list")
        self.revealStop(flights)
        XCTAssertTrue(app.buttons["Stop"].firstMatch.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "native-child-02-swipe")
        flights.swipeRight(velocity: .slow)
        flights.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Stop"].firstMatch.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "native-child-03-menu")
        app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.45)).tap()
        flights.tap()
        XCTAssertTrue(back.waitForExistence(timeout: 8))
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        XCTAssertEqual(title.label, "Compare nonstop flights from San Francisco to Lisbon")
        XCTAssertGreaterThan(title.frame.height, 30, "The long name must actually wrap in the chat header")
        XCTAssertFalse(app.descendants(matching: .any)["chat-header-subtitle"].firstMatch.exists)
        XCTAssertTrue(stop.waitForExistence(timeout: 10))
        let order = read("Compare round-trip flights for May")
        for _ in 0..<5 where !visible(order) {
            transcript.swipeDown(velocity: .fast)
        }
        XCTAssertTrue(visible(order))
        self.attachScreenshot(named: "native-child-04-running-top")
        let titleAtTop = title.frame
        let menuAtTop = app.buttons["Chat actions"].firstMatch.frame
        let delta = read("The first fare includes a checked bag")
        for _ in 0..<5 where !visible(delta) {
            transcript.swipeUp(velocity: .fast)
        }
        XCTAssertTrue(visible(delta))
        XCTAssertFalse(visible(order))
        XCTAssertEqual(title.frame.midY, titleAtTop.midY, accuracy: 2)
        self.attachScreenshot(named: "native-child-05-running-scrolled")
        stop.tap()
        let mark = app.descendants(matching: .any)["chat-header-subtitle"].firstMatch
        XCTAssertTrue(mark.waitForExistence(timeout: 6))
        XCTAssertTrue(mark.label.contains("Stopped"))
        XCTAssertLessThan(title.frame.height, 30, "A terminal title must occupy one line above its status")
        XCTAssertEqual(title.frame.minX, titleAtTop.minX, accuracy: 1)
        XCTAssertEqual(app.buttons["Chat actions"].firstMatch.frame, menuAtTop)
        XCTAssertTrue(stop.waitForNonExistence(timeout: 6))
        self.attachScreenshot(named: "native-child-06-stopped")
        back.tap()
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))
        XCTAssertFalse(tabs.exists)
        openList()
        tabs.buttons["Finished 3"].tap()
        XCTAssertTrue(flights.label.contains("Stopped"))
        row("packing").tap()
        XCTAssertTrue(read("Take the 7:41 from Rossio").waitForExistence(timeout: 8))
        XCTAssertTrue(read("Worked for 3m").waitForExistence(timeout: 5))
        XCTAssertFalse(mark.exists)
        XCTAssertFalse(stop.exists)
        self.attachScreenshot(named: "native-child-07-finished")
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.002, dy: 0.54))
        edge.press(forDuration: 0.05, thenDragTo: app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.54)))
        XCTAssertTrue(title.waitForNonExistence(timeout: 6), "Native edge-back must pop the child, not open the drawer")
        XCTAssertFalse(tabs.exists)
        openList()
        tabs.buttons["Finished 3"].tap()
        row("tickets").tap()
        XCTAssertTrue(read("Check whether two morning tickets").waitForExistence(timeout: 8))
        XCTAssertTrue(mark.label.contains("Failed"))
        XCTAssertEqual(title.frame.minX, titleAtTop.minX, accuracy: 1)
        XCTAssertEqual(mark.frame.minX, title.frame.minX, accuracy: 1)
        XCTAssertFalse(stop.exists)
        self.attachScreenshot(named: "native-child-08-failed")
        back.tap()
        openList()
        let hotels = row("hotels")
        hotels.press(forDuration: 1)
        app.buttons["Stop"].firstMatch.tap()
        XCTAssertTrue(tabs.buttons["Finished 4"].waitForExistence(timeout: 8))
    }

    func testSubagentBackKeepsActiveVoiceNoteInItsChat() throws {
        self.continueAfterFailure = false
        XCUIApplication().resetAuthorizationStatus(for: .microphone)
        self.launchApp(for: Self.activityTarget, additionalArguments: [
            "--openclaw-activity-fixture", "--openclaw-native-child-chat-fixture", "--openclaw-voice-note-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        let pill = self.activityPill("subagents", in: app)
        XCTAssertTrue(pill.waitForExistence(timeout: 8))
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        let flights = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        XCTAssertTrue(flights.waitForExistence(timeout: 5))
        flights.tap()
        let back = app.buttons["Back"].firstMatch
        XCTAssertTrue(back.waitForExistence(timeout: 8))
        let microphone = app.buttons["chat-dictation-control"]
        XCTAssertTrue(microphone.waitForExistence(timeout: 5))
        microphone.press(forDuration: 0.8)
        let record = app.buttons["Record Voice Note"]
        XCTAssertTrue(record.waitForExistence(timeout: 5))
        record.tap()
        let alert = XCUIApplication(bundleIdentifier: "com.apple.springboard").alerts.firstMatch
        let allow = alert.buttons["Allow"].firstMatch
        XCTAssertTrue(allow.wait(for: \.isHittable, toEqual: true, timeout: 8))
        allow.tap()
        let finish = app.buttons["Finish voice note"]
        XCTAssertTrue(finish.waitForExistence(timeout: 8))

        let title = app.descendants(matching: .any).matching(identifier: "chat-header-title")
            .matching(NSPredicate(format: "label == %@", "Compare nonstop flights from San Francisco to Lisbon"))
            .firstMatch
        XCTAssertTrue(title.exists)
        XCTAssertFalse(back.isEnabled, "Back must not pop while the child owns the recording")
        // Start across transcript text, not a tool row that can present a sheet when back is disabled.
        let toolSheet = app.descendants(matching: .any)["chat-tool-sheet"].firstMatch
        XCTAssertFalse(toolSheet.exists)
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.002, dy: 0.25))
        let edgeEnd = app.coordinate(withNormalizedOffset: CGVector(dx: 0.9, dy: 0.25))
        let backCenter = back.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5))
        edge.press(forDuration: 0.05, thenDragTo: edgeEnd)
        XCTAssertTrue(title.exists, "Edge-back must also keep the child route while recording")
        XCTAssertFalse(toolSheet.exists)
        self.waitForHittable(true, of: finish)
        self.attachScreenshot(named: "subagent-edge-back-recording")
        finish.tap()
        let voiceNote = app.staticTexts["Voice note"]
        XCTAssertTrue(voiceNote.waitForExistence(timeout: 8))
        XCTAssertTrue(finish.waitForNonExistence(timeout: 5))
        // This offline fixture cannot persist the attachment in a durable session draft.
        XCTAssertFalse(back.isEnabled)
        backCenter.tap()
        XCTAssertTrue(title.exists, "Back must keep the child route with an unsaved attachment")
        edge.press(forDuration: 0.05, thenDragTo: edgeEnd)
        XCTAssertTrue(voiceNote.exists, "Edge-back must also preserve the unsaved attachment")
        XCTAssertTrue(title.exists)
        XCTAssertFalse(toolSheet.exists)
        let removeVoiceNote = app.buttons.matching(NSPredicate(
            format: "label BEGINSWITH %@", "Remove attachment: voice-note-")).firstMatch
        XCTAssertTrue(removeVoiceNote.waitForExistence(timeout: 5))
        removeVoiceNote.tap()
        XCTAssertTrue(voiceNote.waitForNonExistence(timeout: 5))
        self.waitForEnabled(back)
        edge.press(forDuration: 0.05, thenDragTo: edgeEnd)
        XCTAssertTrue(back.waitForNonExistence(timeout: 5))
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))

        XCTAssertTrue(pill.waitForExistence(timeout: 5))
        pill.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
        XCTAssertTrue(flights.waitForExistence(timeout: 5))
        flights.tap()
        XCTAssertTrue(title.waitForExistence(timeout: 8))
        self.waitForEnabled(back)
        backCenter.tap()
        XCTAssertTrue(back.waitForNonExistence(timeout: 5))
        XCTAssertTrue(title.waitForNonExistence(timeout: 5))
    }

    func testWaitingSubagentRemainsInRunningAndOffersStop() throws {
        self.launchApp(for: Self.activityTarget, additionalArguments: [
            "--openclaw-activity-fixture", "--openclaw-native-child-chat-fixture",
            "--openclaw-subagent-waiting-fixture",
        ])
        let app = try XCTUnwrap(self.app)
        self.activityPill("subagents", in: app).tap()
        app.buttons["Sheet Grabber"].swipeUp()
        let tabs = app.segmentedControls.firstMatch
        XCTAssertTrue(tabs.buttons["Running 2"].waitForExistence(timeout: 5))
        XCTAssertTrue(tabs.buttons["Finished 2"].exists)
        let row = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        XCTAssertTrue(row.isHittable)
        XCTAssertTrue(row.label.contains("Waiting"))
        self.attachScreenshot(named: "waiting-child-listed")
        self.revealStop(row)
        let stop = app.buttons["Stop"].firstMatch
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        XCTAssertEqual(stop.label, "Stop")
        self.attachScreenshot(named: "waiting-child-swipe")
        stop.tap()
        XCTAssertTrue(tabs.buttons["Running 1"].waitForExistence(timeout: 5))
        XCTAssertFalse(row.exists)
        let hotel = app.buttons["chat-activity-child-agent:main:subagent:activity-hotels"]
        self.revealStop(hotel)
        XCTAssertTrue(stop.waitForExistence(timeout: 5))
        XCTAssertEqual(stop.label, "Stop")
        self.attachScreenshot(named: "one-line-child-swipe")
        hotel.swipeRight(velocity: .slow)
        tabs.buttons["Finished 3"].tap()
        XCTAssertTrue(row.label.contains("Stopped"))
    }

    func testNativeSubagentSwipeStopsWithoutLeavingList() throws {
        self.launchApp(
            for: Self.activityTarget, appearance: "light",
            additionalArguments: ["--openclaw-activity-fixture", "--openclaw-native-child-chat-fixture"])
        let app = try XCTUnwrap(self.app)
        self.activityPill("subagents", in: app).tap()
        let row = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        self.revealStop(row)
        let hotels = app.buttons["chat-activity-child-agent:main:subagent:activity-hotels"]
        XCTAssertTrue(hotels.exists)
        XCTAssertEqual(app.buttons["Stop"].firstMatch.label, "Stop")
        self.attachScreenshot(named: "light-child-swipe")
        app.buttons["Stop"].firstMatch.tap()
        let tabs = app.segmentedControls.firstMatch
        XCTAssertTrue(tabs.buttons["Finished 3"].waitForExistence(timeout: 5))
        XCTAssertFalse(row.exists)
        XCTAssertTrue(hotels.isHittable)
        tabs.buttons["Finished 3"].tap()
        XCTAssertTrue(row.label.contains("Stopped"))
        XCTAssertFalse(hotels.exists)
        tabs.buttons["Running 1"].tap()
        let start = hotels.coordinate(withNormalizedOffset: CGVector(dx: 0.98, dy: 0.5))
        let end = hotels.coordinate(withNormalizedOffset: CGVector(dx: 0.02, dy: 0.5))
        start.press(forDuration: 0.08, thenDragTo: end, withVelocity: .fast, thenHoldForDuration: 0.1)
        XCTAssertTrue(tabs.buttons["Finished 4"].waitForExistence(timeout: 6))
        XCTAssertFalse(hotels.exists)
        tabs.buttons["Finished 4"].tap()
        app.buttons["Sheet Grabber"].swipeUp()
        XCTAssertTrue(hotels.waitForExistence(timeout: 5))
        XCTAssertTrue(hotels.label.contains("Stopped"))
    }

    func testActivityPillsSitInOneRowAboveTheComposer() throws {
        launchApp(for: Self.activityTarget, additionalArguments: ["--openclaw-activity-fixture"])
        let app = try XCTUnwrap(self.app)
        let subagents = self.activityPill("subagents", in: app)
        let goal = self.activityPill("goal", in: app)
        let progress = self.activityPill("progress", in: app)
        XCTAssertTrue(progress.waitForExistence(timeout: 8))
        XCTAssertTrue(subagents.waitForExistence(timeout: 5))
        XCTAssertTrue(goal.exists)
        attachScreenshot(named: "activity-pills-row")
        // His web order: subagents, Goal, task progress; one line, never a second row.
        XCTAssertLessThan(subagents.frame.minX, goal.frame.minX)
        XCTAssertLessThan(goal.frame.minX, progress.frame.minX)
        XCTAssertLessThanOrEqual(abs(subagents.frame.midY - progress.frame.midY), 1)
        XCTAssertEqual(subagents.label, "2 subagents working")
        XCTAssertTrue(goal.label.hasPrefix("Goal active: Plan a week in Lisbon"))
        XCTAssertTrue(progress.label.hasPrefix(
            "Task progress, Compare flights and hotel reviews, 2 of 5 completed"))
        // The row rests on the composer, never under it.
        let surface = app.otherElements["chat-composer-surface"]
        XCTAssertTrue(surface.exists)
        XCTAssertLessThanOrEqual(progress.frame.maxY, surface.frame.minY)
        assertMinimumTouchTarget(goal)
        // The old wide bar is gone above the composer.
        XCTAssertFalse(app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Plan, ")).firstMatch.exists)
    }

    func testActivityPillsOpenTheirSheetsAndKeepTheDraft() throws {
        launchApp(for: Self.activityTarget, additionalArguments: ["--openclaw-activity-fixture"])
        let app = try XCTUnwrap(self.app)
        let input = chatMessageInput(in: app)
        XCTAssertTrue(input.waitForExistence(timeout: 8))
        input.tap()
        input.typeText("Parent draft")
        let goal = self.activityPill("goal", in: app)
        XCTAssertTrue(goal.waitForExistence(timeout: 5))
        goal.tap()

        let close = app.buttons["chat-activity-sheet-close"]
        XCTAssertTrue(close.waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["chat-activity-goal-objective"].exists)
        // Close sits on the leading side of the bar.
        XCTAssertLessThan(close.frame.midX, app.frame.midX)
        attachScreenshot(named: "activity-sheet-goal")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))

        self.activityPill("progress", in: app).tap()
        XCTAssertTrue(app.otherElements["chat-activity-progress-summary"].waitForExistence(timeout: 5)
            || app.staticTexts["2 of 5 completed"].waitForExistence(timeout: 2))
        app.buttons["Sheet Grabber"].swipeUp()
        XCTAssertTrue(app.staticTexts["Outline each day"].waitForExistence(timeout: 5))
        attachScreenshot(named: "activity-sheet-progress")
        close.tap()
        XCTAssertTrue(close.waitForNonExistence(timeout: 5))

        self.activityPill("subagents", in: app).tap()
        let tabs = app.segmentedControls.firstMatch
        XCTAssertTrue(tabs.buttons["Running 2"].waitForExistence(timeout: 5))
        let tabFrame = tabs.frame
        tabs.buttons["Finished 1"].tap()
        XCTAssertTrue(app.buttons["chat-activity-child-agent:main:subagent:activity-packing"].exists)
        XCTAssertEqual(tabs.frame, tabFrame)
        tabs.buttons["Running 2"].tap()
        attachScreenshot(named: "activity-sheet-subagents")
        let child = app.buttons["chat-activity-child-agent:main:subagent:activity-flights"]
        XCTAssertTrue(child.waitForExistence(timeout: 5))
        child.tap()
        let order = app.staticTexts.matching(NSPredicate(
            format: "label BEGINSWITH %@",
            "Compare round-trip fares from SFO to Lisbon")).firstMatch
        XCTAssertTrue(order.waitForExistence(timeout: 8))
        XCTAssertTrue(app.descendants(matching: .any)["chat-header-title"].firstMatch.exists)
        XCTAssertFalse(close.exists)
        app.buttons["Back"].firstMatch.tap()
        XCTAssertTrue(self.activityPill("subagents", in: app).waitForExistence(timeout: 5))
        XCTAssertFalse(tabs.exists)

        XCTAssertTrue((input.value as? String ?? "").contains("Parent draft"))
    }

    func testGoalControlsReflectConfirmedChanges() throws {
        let flags = [
            "--openclaw-activity-fixture",
            "--openclaw-activity-fixture-goal-only",
            "--openclaw-goal-controls-fixture",
        ]
        self.launchApp(for: Self.activityTarget, additionalArguments: flags)
        let app = try XCTUnwrap(self.app)
        let pill = self.activityPill("goal", in: app)
        XCTAssertTrue(pill.waitForExistence(timeout: 8))
        pill.tap()
        app.buttons["Pause goal"].tap()
        let status = app.staticTexts["chat-goal-status"]
        XCTAssertTrue(self.waitForLabelPrefix("Paused · ", on: status))
        self.attachScreenshot(named: "goal-proof-paused")
        app.buttons["Resume goal"].tap()
        XCTAssertTrue(self.waitForLabelPrefix("Active · ", on: status))
        self.attachScreenshot(named: "goal-proof-sheet-after")
        app.buttons["chat-activity-sheet-close"].tap()
        self.chatMessageInput(in: app).tap()
        XCTAssertTrue(pill.label.hasPrefix("Goal active:"))
        self.attachScreenshot(named: "goal-proof-pill-after")
        pill.tap()
        let objective = app.staticTexts["chat-activity-goal-objective"]
        let restingTop = objective.frame.minY
        app.buttons["Edit goal"].tap()
        let save = app.buttons["Save"]
        XCTAssertFalse(save.isEnabled)
        let field = app.descendants(matching: .any)["Goal text"].firstMatch
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        field.typeText(" Discard this.")
        app.buttons["Cancel"].tap()
        XCTAssertFalse(objective.label.contains("Discard this"))
        XCTAssertEqual(objective.frame.minY, restingTop, accuracy: 12, "Cancel restores the compact Goal sheet")
        app.buttons["Edit goal"].tap()
        field.typeText(" Keep it concise.")
        XCTAssertTrue(save.isEnabled)
        XCTAssertTrue(app.keyboards.firstMatch.waitForExistence(timeout: 5))
        let editing = XCTAttachment(screenshot: XCUIScreen.main.screenshot())
        editing.name = "goal-proof-edit"
        editing.lifetime = .keepAlways
        add(editing)
        save.tap()
        XCTAssertTrue(objective.label.contains("Keep it concise"))
        // Saving a longer prompt can grow the fitted sheet; the editor does not stay on screen.
        XCTAssertTrue(field.waitForNonExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Edit goal"].isHittable)
        let delete = app.buttons["chat-goal-delete"]
        delete.tap()
        let question = app.staticTexts["Delete this goal?"]
        XCTAssertTrue(question.waitForExistence(timeout: 5))
        self.attachScreenshot(named: "goal-proof-delete-confirm")
        // A compact confirmation can be dismissed by tapping outside it.
        if app.buttons["Cancel"].exists {
            app.buttons["Cancel"].tap()
        } else {
            app.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.15)).tap()
        }
        delete.tap()
        app.buttons.matching(NSPredicate(format: "label == %@ AND identifier != %@", "Delete goal", "chat-goal-delete"))
            .firstMatch.tap()
        XCTAssertTrue(pill.waitForNonExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-activity-sheet-close"].exists)
    }

    private func waitForLabelPrefix(_ prefix: String, on element: XCUIElement) -> Bool {
        let condition = XCTNSPredicateExpectation(
            predicate: NSPredicate(format: "label BEGINSWITH %@", prefix),
            object: element)
        return XCTWaiter.wait(for: [condition], timeout: 5) == .completed
    }

    func testGoalRequestFailuresKeepTheGoalAndDraft() throws {
        self.launchApp(for: Self.activityTarget, appearance: "light", additionalArguments: [
            "--openclaw-activity-fixture", "--openclaw-activity-fixture-goal-only", "--openclaw-goal-controls-fixture",
            "--openclaw-activity-fixture-failures",
        ])
        let app = try XCTUnwrap(self.app)
        self.activityPill("goal", in: app).tap()
        self.attachScreenshot(named: "goal-proof-light")
        app.buttons["Pause goal"].tap()
        XCTAssertTrue(app.staticTexts["Couldn’t change the goal. Review its status and try again."]
            .waitForExistence(timeout: 5))
        XCTAssertTrue(self.waitForLabelPrefix("Active · ", on: app.staticTexts["chat-goal-status"]))
        app.buttons["Edit goal"].tap()
        let field = app.descendants(matching: .any)["Goal text"].firstMatch
        field.typeText(" Keep this draft.")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.staticTexts["Couldn’t save the goal. Try again."].waitForExistence(timeout: 5))
        XCTAssertTrue((field.value as? String)?.contains("Keep this draft") == true)
    }

    func testActivitySheetsShowFailuresInPlace() throws {
        launchApp(
            for: Self.activityTarget,
            additionalArguments: ["--openclaw-activity-fixture", "--openclaw-activity-fixture-failures"])
        let app = try XCTUnwrap(self.app)
        let subagents = self.activityPill("subagents", in: app)
        XCTAssertTrue(subagents.waitForExistence(timeout: 8))
        subagents.tap()
        // The roster still shows the children; only the full list failed, and says so where it would be.
        XCTAssertTrue(app.staticTexts["Couldn’t load every subagent."].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-activity-try-again"].exists)
        app.buttons["chat-activity-child-agent:main:subagent:activity-hotels"].tap()
        XCTAssertTrue(app.descendants(matching: .any)["chat-header-title"].firstMatch
            .waitForExistence(timeout: 5))
        XCTAssertFalse(app.buttons["chat-activity-sheet-close"].exists)
        XCTAssertTrue(app.buttons["Back"].firstMatch.isHittable)
    }

    func testPullRequestPillsOpenTheirSheet() throws {
        let checks = (1...16).map { ["name": "Check \($0)", "state": "success"] }
        let overview = try JSONSerialization.data(withJSONObject: [[
            "url": "https://github.com/lisbon-trip/itinerary/pull/4182", "checks": ["items": checks],
        ]])
        launchApp(for: Self.activityTarget, additionalArguments: [
            "--openclaw-activity-fixture", "--pr-reader-fixtures", String(decoding: overview, as: UTF8.self),
        ])
        let app = try XCTUnwrap(self.app)
        let open = self.activityPill("pr-lisbon-trip/itinerary#4182", in: app)
        let merged = self.activityPill("pr-lisbon-trip/itinerary#4170", in: app)
        XCTAssertTrue(open.waitForExistence(timeout: 8))
        XCTAssertTrue(merged.exists)
        // Open before merged, after the other pills.
        XCTAssertLessThan(open.frame.minX, merged.frame.minX)
        XCTAssertTrue(open.label.hasPrefix("Pull request #4182 in lisbon-trip/itinerary"))
        open.tap()
        XCTAssertTrue(app.staticTexts["chat-activity-pr-title"].waitForExistence(timeout: 5))
        let action = app.buttons["chat-activity-pr-open"]
        let rows = app.scrollViews.containing(.staticText, identifier: "Check 16").firstMatch
        XCTAssertTrue(rows.waitForExistence(timeout: 5))
        XCTAssertGreaterThan(rows.frame.maxY, action.frame.maxY)
        let last = rows.staticTexts["Check 16"]
        let frame = action.frame
        for _ in 0..<6 where last.frame.maxY >= frame.minY {
            rows.swipeUp()
        }
        XCTAssertLessThan(last.frame.maxY, frame.minY)
        XCTAssertTrue(last.isHittable)
        XCTAssertEqual(action.frame, frame)
        attachScreenshot(named: "activity-sheet-pr")
        app.buttons["chat-activity-sheet-close"].tap()
    }
}
