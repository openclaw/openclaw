import XCTest

extension OpenClawSnapshotUITests {
    private func launchDiscovery(mode: String, style: String, type: String = "L", arguments: [String] = []) throws
    -> XCUIApplication {
        self.launchApp(
            for: ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "discovery"),
            appearance: style,
            additionalArguments: [
                "--openclaw-chat-info-fixture", "--openclaw-chat-switch-fixture", "--openclaw-activity-fixture",
                "--openclaw-activity-fixture-pr-only",
                "--openclaw-info-" + mode,
                "-UIPreferredContentSizeCategoryName", "UICTContentSizeCategory" + type,
            ] + arguments)
        return try XCTUnwrap(self.app)
    }

    private func savedDiscovery(in app: XCUIApplication) throws {
        try self.selectSidebarDestination("Launch plan")
        XCTAssertTrue(app.staticTexts["OPENCLAW_SWITCH_B_LATEST"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "#148")).firstMatch
            .waitForExistence(timeout: 8))
        app.buttons["chat-agent-identity"].tap()
        XCTAssertTrue(app.staticTexts["Media and files"].waitForExistence(timeout: 8))
    }

    /// The agent row only names the chat's agent; it is not a way into the agent profile.
    func checkStaticAgentRow(in app: XCUIApplication) {
        let agent = app.staticTexts["chat-info-agent-row"]
        for _ in 0..<3 where !agent.isHittable {
            app.scrollViews.firstMatch.swipeDown()
        }
        XCTAssertTrue(agent.isHittable)
        XCTAssertEqual(agent.label, "Agent, Molty")
        XCTAssertFalse(app.buttons["chat-info-agent-row"].exists)
        agent.tap()
        XCTAssertFalse(app.staticTexts["chat-info-agent-title"].waitForExistence(timeout: 1))
        XCTAssertTrue(app.staticTexts["chat-info-session-title"].exists)
    }

    private func checkDiscoveryOrder(_ app: XCUIApplication, isChat: Bool) {
        let headings = (isChat ? ["Environment", "Pull requests"] : []) + ["Media and files", "Automations", "Context"]
        let frames = headings.map { app.staticTexts[$0].frame }
        for (name, frame) in zip(headings, frames) {
            XCTAssertGreaterThan(frame.height, 0, name)
        }
        for i in 1..<frames.count {
            XCTAssertLessThan(frames[i - 1].maxY, frames[i].minY, headings[i])
        }
        print("INFO_DISCOVERY_FRAMES", zip(headings, frames).map { "\($0.0)=\($0.1)" }.joined(separator: ";"))
    }

    func testDiscoveryPagesInBothAppearances() throws {
        for style in ["light", "dark"] {
            let app = try self.launchDiscovery(mode: "empty", style: style)
            app.buttons["chat-agent-identity"].tap()
            XCTAssertTrue(app.staticTexts["chat-info-agent-title"].waitForExistence(timeout: 8))
            XCTAssertTrue(app.staticTexts["Files from the main chat show up here"].exists)
            XCTAssertTrue(app.staticTexts["Ask the agent to do something on a schedule"].exists)
            XCTAssertTrue(app.buttons["Export chat"].exists && app.buttons["Compact"].exists)
            self.checkDiscoveryOrder(app, isChat: false)
            self.attachScreenshot(named: "disc-full-" + style)
            app.navigationBars.buttons.firstMatch.tap()
            try self.savedDiscovery(in: app)
            XCTAssertTrue(app.buttons["Compact"].exists)
            XCTAssertTrue(app.staticTexts["Ask the agent to do something on a schedule"].exists)
            self.checkDiscoveryOrder(app, isChat: true)
            XCTAssertTrue(app.staticTexts["No files yet"].exists)
            XCTAssertTrue(app.staticTexts["No automations yet"].exists)
            XCTAssertFalse(app.buttons["No files yet"].exists || app.buttons["No automations yet"].exists)
            self.attachScreenshot(named: "disc-empty-chat-" + style)
            app.scrollViews.firstMatch.swipeUp()
            self.attachScreenshot(named: "disc-empty-chat-bottom-" + style)
            self.checkStaticAgentRow(in: app)
            let populated = try self.launchDiscovery(
                mode: "populated",
                style: style,
                arguments: ["--openclaw-info-main-media"])
            populated.buttons["chat-agent-identity"].tap()
            XCTAssertTrue(populated.buttons["chat-info-media-main-notes"].waitForExistence(timeout: 8))
            XCTAssertTrue(populated.buttons["chat-info-automation-brief"].label.contains("Weekdays at 5:00 PM"))
            self.attachScreenshot(named: "disc-populated-profile-" + style)
            populated.navigationBars.buttons.firstMatch.tap()
            try self.savedDiscovery(in: populated)
            self.checkDiscoveryOrder(populated, isChat: true)
            XCTAssertTrue(populated.buttons["chat-info-media-palette"].exists)
            let sweep = populated.buttons["chat-info-automation-sweep"]
            XCTAssertTrue(sweep.label.contains("Every 6 hours") && sweep.label.contains("Run failed"))
            let release = populated.buttons["chat-info-automation-release"]
            XCTAssertTrue(release.label.contains("0 9 * * FRI#2") && release.label.contains("Paused"))
            XCTAssertFalse(populated.buttons["chat-info-automation-brief"].exists)
            self.attachScreenshot(named: "disc-populated-chat-" + style)
            self.checkStaticAgentRow(in: populated)
        }
    }

    func testMediaTilesUsePicturesWithoutMovingTheirNeighbors() throws {
        for style in ["light", "dark"] {
            for state in ["ready", "loading", "failed"] {
                let app = try self.launchDiscovery(
                    mode: "populated",
                    style: style,
                    arguments: ["--openclaw-info-thumbnail-" + state])
                try self.savedDiscovery(in: app)
                let palette = app.buttons["chat-info-media-palette"]
                let layout = app.buttons["chat-info-media-layout"]
                let notes = app.buttons["chat-info-media-notes"]
                // Test rendered pixels: the two image buttons have the same accessibility semantics as before.
                let rendered = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
                    MainActor.assumeIsolated {
                        self.tileWarmth(palette) > 35 && (state != "ready" || self.tileWarmth(layout) < -25)
                    }
                }, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [rendered], timeout: 7), .completed)
                if state != "ready" { XCTAssertLessThan(abs(self.tileWarmth(layout)), 15) }
                XCTAssertLessThan(abs(self.tileWarmth(notes)), 15)
                XCTAssertEqual(palette.label, "Palette.png")
                XCTAssertEqual(layout.label, "Layout.jpg")
                XCTAssertEqual(notes.label, "Notes.pdf")
                XCTAssertEqual(palette.frame.width, 72, accuracy: 1 / 3)
                XCTAssertEqual(layout.frame.height, 72, accuracy: 1 / 3)
                XCTAssertEqual(layout.frame.minX - palette.frame.maxX, 6, accuracy: 1 / 3)
                let heading = app.staticTexts["Media and files"].frame
                let next = app.staticTexts["Automations"].frame
                XCTAssertEqual(palette.frame.minY - 12 - heading.maxY, 8, accuracy: 1 / 3)
                XCTAssertEqual(next.minY - (palette.frame.maxY + 12), 24, accuracy: 1 / 3)
                self.attachScreenshot(named: "tiles-" + state + "-" + style)
            }
        }
    }

    func tileWarmth(_ element: XCUIElement) -> Int {
        guard let image = element.screenshot().image.cgImage else { return 0 }
        var pixel = [UInt8](repeating: 0, count: 4)
        pixel.withUnsafeMutableBytes { bytes in
            let context = CGContext(
                data: bytes.baseAddress,
                width: 1,
                height: 1,
                bitsPerComponent: 8,
                bytesPerRow: 4,
                space: CGColorSpaceCreateDeviceRGB(),
                bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)
            context?.interpolationQuality = .high
            context?.draw(image, in: CGRect(x: 0, y: 0, width: 1, height: 1))
        }
        return Int(pixel[0]) - Int(pixel[2])
    }

    func testDiscoveryRowsWithMixedLoadingAndFailedCatalogs() throws {
        for style in ["light", "dark"] {
            for state in ["mixed", "loading", "failed"] {
                let app = try self.launchDiscovery(
                    mode: state == "mixed" ? "populated" : state,
                    style: style,
                    arguments: state == "mixed" ? ["--openclaw-info-automations-only"] :
                        [])
                try self.savedDiscovery(in: app)
                XCTAssertEqual(app.staticTexts["No files yet"].exists, state == "mixed")
                XCTAssertEqual(
                    app.staticTexts["Ask for an image or a file and it shows up here"].exists,
                    state == "mixed")
                XCTAssertFalse(app.staticTexts["No automations yet"].exists)
                XCTAssertFalse(app.staticTexts["Ask the agent to do something on a schedule"].exists)
                XCTAssertEqual(app.buttons["chat-info-automation-sweep"].exists, state == "mixed")
                XCTAssertEqual(app.buttons["Couldn’t load media and files"].exists, state == "failed")
                XCTAssertEqual(app.buttons["Couldn’t load automations"].exists, state == "failed")
                self.checkDiscoveryOrder(app, isChat: true)
                self.attachScreenshot(named: "disc-row-" + state + "-" + style)
                app.scrollViews.firstMatch.swipeUp()
                self.attachScreenshot(named: "disc-row-" + state + "-bottom-" + style)
            }
        }
    }

    func testDiscoveryDynamicTypeAndFailureHeight() throws {
        for style in ["light", "dark"] {
            for size in ["XS", "AccessibilityM"] {
                let app = try self.launchDiscovery(mode: "empty", style: style, type: size)
                app.buttons["chat-agent-identity"].tap()
                XCTAssertTrue(app.staticTexts["Ask the agent to do something on a schedule"]
                    .waitForExistence(timeout: 8))
                self.checkDiscoveryOrder(app, isChat: false)
                self.attachScreenshot(named: "disc-type-" + size + "-" + style)
                app.navigationBars.buttons.firstMatch.tap()
                try self.savedDiscovery(in: app)
                XCTAssertTrue(app.staticTexts["No files yet"].exists)
                XCTAssertTrue(app.staticTexts["No automations yet"].exists)
                self.attachScreenshot(named: "disc-chat-type-" + size + "-" + style)
                if size == "AccessibilityM" {
                    app.scrollViews.firstMatch.swipeUp(velocity: .slow)
                    self.attachScreenshot(named: "disc-chat-type-scrolled-" + size + "-" + style)
                }
            }
        }
        var reference: [CGFloat] = []
        for mode in ["empty", "loading", "failed"] {
            let app = try self.launchDiscovery(mode: mode, style: "light", type: "AccessibilityM")
            app.buttons["chat-agent-identity"].tap()
            XCTAssertTrue(app.staticTexts["Automations"].waitForExistence(timeout: 8))
            let context = app.staticTexts["Context"]
            XCTAssertTrue(context.exists)
            let positions = [app.staticTexts["Automations"].frame.minY, context.frame.minY]
            // Loading holds the loaded strip's height instead (testChatInfoMediaCatalogStates).
            if mode == "empty" { reference = positions } else if mode == "failed" {
                for i in positions.indices {
                    XCTAssertEqual(positions[i], reference[i], accuracy: 1)
                }
            }
            XCTAssertEqual(app.staticTexts["Ask the agent to do something on a schedule"].exists, mode == "empty")
            XCTAssertEqual(app.buttons["Couldn’t load automations"].exists, mode == "failed")
            XCTAssertEqual(app.buttons["Couldn’t load media and files"].exists, mode == "failed")
            if mode != "empty" { self.attachScreenshot(named: "disc-state-" + mode) }
        }
    }
}
