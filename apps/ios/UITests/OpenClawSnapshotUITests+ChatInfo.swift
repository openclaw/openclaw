import XCTest

extension OpenClawSnapshotUITests {
    func testChatInfoMediaCatalogStates() throws {
        let target = ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "info-media")
        var contextY: CGFloat?
        var automationsY: CGFloat?
        for mode in ["empty", "populated", "failed", "loading"] {
            self.launchApp(for: target, appearance: "light", additionalArguments: [
                "--openclaw-chat-info-fixture", "--openclaw-chat-switch-fixture", "--openclaw-info-" + mode,
            ])
            let app = try XCTUnwrap(self.app)
            app.buttons["RootTabs.Sidebar.Show"].tap()
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Launch plan")).firstMatch.tap()
            let identity = app.buttons["chat-agent-identity"]
            XCTAssertTrue(app.staticTexts["OPENCLAW_SWITCH_B_LATEST"].waitForExistence(timeout: 8))
            identity.tap()
            XCTAssertTrue(app.staticTexts["Media and files"].waitForExistence(timeout: 8))
            let empty = app.staticTexts["Ask for an image or a file and it shows up here"]
            let failed = app.buttons["Couldn’t load media and files"]
            switch mode {
            case "empty":
                XCTAssertTrue(empty.waitForExistence(timeout: 3))
                contextY = app.staticTexts["Context"].frame.minY
            case "failed":
                XCTAssertTrue(failed.waitForExistence(timeout: 3))
                XCTAssertFalse(empty.exists)
                XCTAssertEqual(app.staticTexts["Context"].frame.minY, try XCTUnwrap(contextY), accuracy: 1)
            case "loading":
                // Placeholder tiles hold the loaded strip's height.
                XCTAssertFalse(failed.exists || empty.exists)
                XCTAssertEqual(app.staticTexts["Automations"].frame.minY, try XCTUnwrap(automationsY), accuracy: 1)
                self.attachScreenshot(named: "media-catalog-loading")
            default:
                XCTAssertTrue(app.buttons["chat-info-media-palette"].waitForExistence(timeout: 3))
                automationsY = app.staticTexts["Automations"].frame.minY
                XCTAssertTrue(app.buttons["chat-info-media-layout"].exists)
                XCTAssertTrue(app.buttons["chat-info-media-notes"].exists)
                XCTAssertFalse(empty.exists || failed.exists)
                self.attachScreenshot(named: "media-catalog-chat")
            }
        }
    }

    func testChatInfoOpensBeforeSlowCatalogsAndRetriesFailure() throws {
        let target = ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "info-in-place")
        for mode in ["slow", "failed-once"] {
            self.launchApp(for: target, appearance: "light", additionalArguments: [
                "--openclaw-chat-info-fixture", "--openclaw-chat-switch-fixture", "--openclaw-info-populated",
                "--openclaw-info-" + mode,
            ])
            let app = try XCTUnwrap(self.app)
            app.buttons["RootTabs.Sidebar.Show"].tap()
            app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Launch plan")).firstMatch.tap()
            XCTAssertTrue(app.staticTexts["OPENCLAW_SWITCH_B_LATEST"].waitForExistence(timeout: 8))
            app.buttons["chat-agent-identity"].tap()
            let palette = app.buttons["chat-info-media-palette"]
            let job = app.buttons["chat-info-automation-sweep"]
            if mode == "slow" {
                // The fixture answers after 7 s; the page must already be open without its items.
                XCTAssertTrue(app.staticTexts["Media and files"].waitForExistence(timeout: 5))
                XCTAssertFalse(palette.exists || job.exists)
                self.attachScreenshot(named: "in-place-loading")
                XCTAssertTrue(palette.waitForExistence(timeout: 12))
                XCTAssertTrue(job.waitForExistence(timeout: 2))
                self.attachScreenshot(named: "in-place-loaded")
            } else {
                let media = app.buttons["Couldn’t load media and files"]
                let automations = app.buttons["Couldn’t load automations"]
                XCTAssertTrue(media.waitForExistence(timeout: 5))
                XCTAssertTrue(automations.exists)
                self.attachScreenshot(named: "in-place-failed")
                media.tap()
                XCTAssertTrue(palette.waitForExistence(timeout: 5))
                automations.tap()
                XCTAssertTrue(job.waitForExistence(timeout: 5))
            }
        }
    }

    func testSessionProfileStripAndGallery() throws {
        try self.checkSessionProfileStripAndGallery(style: "light")
    }

    func testSessionProfileStripAndGalleryInDarkAppearance() throws {
        try self.checkSessionProfileStripAndGallery(style: "dark")
    }

    /// V9 proof frames: top, scrolled, strip at its See all tile, one to three items, and both gallery tabs.
    private func checkSessionProfileStripAndGallery(style: String) throws {
        let target = ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "info-v9")
        for count in [14, 1, 2, 3] {
            let app = try self.openSavedInfo(
                target,
                style: style,
                arguments: ["--openclaw-info-media-count=\(count)"])
            let link = app.buttons["chat-info-media-see-all"]
            let tile = app.buttons["chat-info-media-see-all-tile"]
            XCTAssertTrue(link.waitForExistence(timeout: 5))
            XCTAssertEqual(link.label, "See all media and files")
            XCTAssertEqual(
                app.buttons.matching(NSPredicate(format: "identifier BEGINSWITH %@", "chat-info-media-"))
                    .matching(NSPredicate(format: "NOT identifier BEGINSWITH %@", "chat-info-media-see-all")).count,
                min(count, 10))
            if count < 14 {
                XCTAssertFalse(tile.exists)
                self.attachScreenshot(named: "v9-m\(count)-\(style)")
                continue
            }
            self.attachScreenshot(named: "v9-top-\(style)")
            app.scrollViews.firstMatch.swipeUp()
            self.attachScreenshot(named: "v9-scrolled-\(style)")
            let strip = app.scrollViews["chat-info-media-strip"]
            for _ in 0..<4 where !tile.isHittable {
                strip.swipeLeft()
            }
            XCTAssertTrue(tile.isHittable)
            self.attachScreenshot(named: "v9-end-\(style)")
            tile.tap()
            XCTAssertTrue(app.navigationBars.staticTexts["Media and files"].waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["chat-info-media-layout-13"].waitForExistence(timeout: 5))
            self.attachScreenshot(named: "v9-gallery-media-\(style)")
            app.buttons["Files"].tap()
            XCTAssertTrue(app.buttons["chat-info-gallery-file-notes-12"].waitForExistence(timeout: 5))
            self.attachScreenshot(named: "v9-gallery-files-\(style)")
        }
    }

    func testSessionProfileGalleryRetainsTheStripOnReadFailure() throws {
        let target = ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "info-v9")
        // A failed re-read on return from the gallery keeps the strip and the automations already shown.
        let app = try self.openSavedInfo(target, style: "light", arguments: [
            "--openclaw-info-media-count=14", "--openclaw-info-failed-second",
        ])
        XCTAssertTrue(app.buttons["chat-info-media-palette-14"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-info-automation-sweep"].exists)
        app.buttons["chat-info-media-see-all"].tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Media and files"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(app.buttons["chat-info-media-palette-14"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["chat-info-automation-sweep"].exists)
        XCTAssertFalse(app.buttons["Couldn’t load media and files"].exists || app.buttons["Couldn’t load automations"]
            .exists)
    }

    /// Every thumbnail read after an artifact's first one fails, so only reused pictures can show.
    func testGalleryShowsTheStripsThumbnailsWithoutReadingThemAgain() throws {
        let app = try self.openSavedInfo(
            ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "info-v9"),
            style: "light",
            arguments: ["--openclaw-info-media-count=14", "--openclaw-info-thumbnail-once"])
        XCTAssertTrue(self.showsPicture(app.buttons["chat-info-media-palette-14"]))
        app.buttons["chat-info-media-see-all"].tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Media and files"].waitForExistence(timeout: 5))
        XCTAssertTrue(self.showsPicture(app.buttons["chat-info-media-palette-14"]))
        XCTAssertTrue(self.showsPicture(app.buttons["chat-info-media-palette-2"]))
        // Back on the page and into the gallery again: nothing starts from zero.
        app.navigationBars.buttons.firstMatch.tap()
        app.buttons["chat-info-media-see-all"].tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Media and files"].waitForExistence(timeout: 5))
        XCTAssertTrue(self.showsPicture(app.buttons["chat-info-media-palette-2"]))
    }

    /// Each artifact's first thumbnail read fails; the tile still shows its picture.
    func testAFailedThumbnailReadIsTriedAgain() throws {
        let app = try self.openSavedInfo(
            ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "info-v9"),
            style: "light",
            arguments: ["--openclaw-info-media-count=14", "--openclaw-info-thumbnail-fails-first"])
        XCTAssertTrue(self.showsPicture(app.buttons["chat-info-media-palette-14"]))
        app.buttons["chat-info-media-see-all"].tap()
        XCTAssertTrue(app.navigationBars.staticTexts["Media and files"].waitForExistence(timeout: 5))
        XCTAssertTrue(self.showsPicture(app.buttons["chat-info-media-palette-2"]))
    }

    /// The palette fixture is warm; the placeholder is neutral gray.
    private func showsPicture(_ tile: XCUIElement) -> Bool {
        guard tile.waitForExistence(timeout: 5) else { return false }
        let warm = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            MainActor.assumeIsolated { self.tileWarmth(tile) > 35 }
        }, object: nil)
        return XCTWaiter.wait(for: [warm], timeout: 5) == .completed
    }

    private func openSavedInfo(
        _ target: ScreenshotTarget,
        style: String,
        arguments: [String]) throws -> XCUIApplication
    {
        self.launchApp(for: target, appearance: style, additionalArguments: [
            "--openclaw-chat-info-fixture", "--openclaw-chat-switch-fixture", "--openclaw-activity-fixture",
            "--openclaw-activity-fixture-pr-only", "--openclaw-info-populated",
        ] + arguments)
        let app = try XCTUnwrap(self.app)
        app.buttons["RootTabs.Sidebar.Show"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Launch plan")).firstMatch.tap()
        XCTAssertTrue(app.staticTexts["OPENCLAW_SWITCH_B_LATEST"].waitForExistence(timeout: 8))
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "#148")).firstMatch
            .waitForExistence(timeout: 8))
        app.buttons["chat-agent-identity"].tap()
        XCTAssertTrue(app.staticTexts["chat-info-session-title"].waitForExistence(timeout: 5))
        return app
    }

    func testSavedCheckoutShowsItsOwnLineCounts() throws {
        self.launchApp(
            for: ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "checkout-counts"),
            additionalArguments: [
                "--openclaw-chat-info-fixture",
                "--openclaw-chat-switch-fixture",
                "--openclaw-activity-fixture",
                "--openclaw-activity-fixture-pr-only",
            ])
        let app = try XCTUnwrap(self.app)
        app.buttons["RootTabs.Sidebar.Show"].tap()
        app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Launch plan")).firstMatch.tap()
        XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "#148")).firstMatch
            .waitForExistence(timeout: 8))
        app.buttons["chat-agent-identity"].tap()
        let row = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", "2280 lines added"))
            .firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 5))
        XCTAssertTrue(row.label.contains("327 lines removed"))
        self.attachScreenshot(named: "info-checkout-summary")
    }

    func testChatHeaderOpensItsInfoAndStaticAgentRow() throws {
        // Capture all four layouts so a geometry failure includes its comparison frame.
        self.continueAfterFailure = true
        let target = ScreenshotTarget(initialTab: "chat", initialDestination: "chat", name: "chat-info")
        for appearance in ["light", "dark", "long", "ax1"] {
            let longTitle = appearance == "long" || appearance == "ax1"
            var arguments = [
                "--openclaw-chat-info-fixture",
                "--openclaw-chat-switch-fixture",
                "--openclaw-activity-fixture",
                "--openclaw-activity-fixture-pr-only",
            ]
            if longTitle { arguments.append("--openclaw-chat-info-long-title-fixture") }
            if appearance == "ax1" {
                arguments += ["-UIPreferredContentSizeCategoryName", "UICTContentSizeCategoryAccessibilityM"]
            }
            self.launchApp(
                for: target,
                appearance: appearance == "dark" ? "dark" : "light",
                additionalArguments: arguments)
            let app = try XCTUnwrap(self.app)
            let identity = app.buttons["chat-agent-identity"].firstMatch
            XCTAssertTrue(identity.waitForExistence(timeout: 8))
            identity.tap()
            let hero = app.staticTexts["chat-info-agent-title"]
            XCTAssertTrue(hero.waitForExistence(timeout: 5))
            XCTAssertEqual(hero.label, "Molty")
            XCTAssertFalse(app.staticTexts["Workspace"].exists)
            XCTAssertTrue(app.staticTexts["Context"].exists)
            XCTAssertFalse(app.staticTexts["Environment"].exists)
            XCTAssertFalse(app.buttons["Archive"].exists)
            XCTAssertFalse(app.buttons["Rename chat"].exists)
            XCTAssertTrue(app.buttons["Compact"].exists)
            XCTAssertTrue(app.buttons["Export chat"].exists)
            XCTAssertTrue(app.buttons["Reset chat"].exists)
            if !longTitle {
                XCTAssertTrue(app.staticTexts["Reset clears the messages in this chat. Molty and its workspace stay."]
                    .exists)
                self.attachScreenshot(named: "info-agent-\(appearance)")
            }
            let normalBarHeight = app.navigationBars.firstMatch.frame.height
            app.navigationBars.buttons.firstMatch.tap()
            app.buttons["RootTabs.Sidebar.Show"].tap()
            let row = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Launch plan")).firstMatch
            XCTAssertTrue(row.waitForExistence(timeout: 5))
            row.tap()
            let latest = app.staticTexts["OPENCLAW_SWITCH_B_LATEST"]
            XCTAssertTrue(latest.waitForExistence(timeout: 8))
            XCTAssertTrue(app.buttons.matching(NSPredicate(format: "label CONTAINS %@", "#148")).firstMatch
                .waitForExistence(timeout: 8))
            let latestFrame = latest.frame
            if appearance == "light" {
                XCTAssertTrue(latest.isHittable && app.windows.firstMatch.frame.contains(latestFrame))
                self.attachScreenshot(named: "return-before")
            }
            identity.tap()
            let title = app.staticTexts["chat-info-session-title"]
            XCTAssertTrue(title.waitForExistence(timeout: 5))
            if longTitle { XCTAssertGreaterThan(title.label.count, 100) } else { XCTAssertEqual(
                title.label,
                "Launch plan") }
            let edit = app.navigationBars.buttons["Rename chat"]
            XCTAssertTrue(edit.isHittable)
            XCTAssertTrue(app.windows.firstMatch.frame.contains(edit.frame))
            XCTAssertLessThanOrEqual(app.navigationBars.firstMatch.frame.height, normalBarHeight + 1)
            XCTAssertFalse(app.navigationBars.staticTexts["chat-info-bar-title"].exists)
            XCTAssertTrue(app.staticTexts["Environment"].exists)
            XCTAssertTrue(app.staticTexts["Pull requests"].exists)
            XCTAssertTrue(app.staticTexts["Context"].exists)
            XCTAssertFalse(app.staticTexts["Workspace"].exists)
            self.attachScreenshot(named: "info-session-\(appearance)")
            let pr = app.buttons["chat-info-pr-paper-trail/review-notes#148"]
            XCTAssertTrue(pr.label.hasPrefix("Open, "))
            if appearance == "light" {
                pr.tap()
                let close = app.buttons["chat-activity-sheet-close"]
                XCTAssertTrue(close.waitForExistence(timeout: 5))
                self.attachScreenshot(named: "info-pr-sheet")
                close.tap()
                self.checkStaticAgentRow(in: app)
                self.attachScreenshot(named: "agent-row-static")
                XCTAssertTrue(app.buttons["Archive"].exists)
                app.navigationBars.buttons.firstMatch.tap()
                let chatTitle = app.staticTexts["chat-header-title"]
                XCTAssertTrue(chatTitle.waitForExistence(timeout: 5))
                XCTAssertEqual(chatTitle.label, "Launch plan")
                XCTAssertTrue(latest.waitForExistence(timeout: 8) && latest.isHittable)
                if latest.exists {
                    XCTAssertTrue(app.windows.firstMatch.frame.contains(latest.frame))
                    XCTAssertEqual(latest.frame.minY, latestFrame.minY, accuracy: 1)
                }
                self.attachScreenshot(named: "return-after")
                // Rename can move the keyboard inset; it is not part of the profile-return measurement.
                identity.tap()
                app.buttons["Rename chat"].tap()
                XCTAssertTrue(app.alerts["Rename chat"].waitForExistence(timeout: 5))
                app.alerts.buttons["Cancel"].tap()
                let reset = app.buttons["Reset chat"]
                if !reset.isHittable { app.scrollViews.firstMatch.swipeUp() }
                reset.tap()
                let confirmation = app.staticTexts["Reset this chat?"]
                XCTAssertTrue(confirmation.waitForExistence(timeout: 5))
                // The native confirmation popover cancels when tapped outside.
                app.coordinate(withNormalizedOffset: CGVector(dx: 0.04, dy: 0.35)).tap()
                XCTAssertTrue(confirmation.waitForNonExistence(timeout: 5))
                app.navigationBars.buttons.firstMatch.tap()
                XCTAssertTrue(latest.waitForExistence(timeout: 5) && latest.isHittable)
                self.checkOlderPositionThroughProfile(in: app, identity: identity)
            }
            if appearance == "dark", #available(iOS 27.1, *) {
                app.navigationBars.buttons.firstMatch.tap()
                XCUIDevice.shared.orientation = .landscapeLeft
                defer { XCUIDevice.shared.orientation = .portrait }
                // The window rotates before the principal toolbar item finishes moving.
                let positioned = NSPredicate { _, _ in
                    app.frame.width > app.frame.height && identity.isHittable &&
                        abs(identity.frame.midX - app.frame.midX) <= 8
                }
                let stable = XCTNSPredicateExpectation(predicate: positioned, object: nil)
                XCTAssertEqual(XCTWaiter.wait(for: [stable], timeout: 6), .completed)
                self.attachScreenshot(named: "return-landscape-header")
                identity.tap()
                XCTAssertTrue(title.waitForExistence(timeout: 5))
                XCTAssertEqual(title.label, "Launch plan")
                app.navigationBars.buttons.firstMatch.tap()
            }
            if appearance == "ax1" {
                app.scrollViews.firstMatch.swipeUp()
                XCTAssertTrue(app.navigationBars.staticTexts["chat-info-bar-title"].waitForExistence(timeout: 3))
                self.attachScreenshot(named: "info-scrolled-ax1")
            }
        }
    }

    private func checkOlderPositionThroughProfile(in app: XCUIApplication, identity: XCUIElement) {
        let transcript = app.collectionViews.firstMatch
        transcript.swipeDown(velocity: .slow)
        let visible = app.windows.firstMatch.frame.insetBy(dx: 0, dy: 155)
        let turns = app.staticTexts.matching(NSPredicate(format: "label BEGINSWITH %@", "Next step "))
        let latest = app.staticTexts["OPENCLAW_SWITCH_B_LATEST"]
        XCTAssertFalse(latest.exists && latest.isHittable)
        guard let row = turns.allElementsBoundByIndex.first(where: { $0.isHittable && visible.contains($0.frame) })
        else { return XCTFail("Expected an older turn inside the chat viewport") }
        let message = app.staticTexts[row.label]
        let before = message.frame.minY
        identity.tap()
        XCTAssertTrue(app.staticTexts["chat-info-session-title"].waitForExistence(timeout: 5))
        app.navigationBars.buttons.firstMatch.tap()
        XCTAssertTrue(message.waitForExistence(timeout: 5) && message.isHittable)
        if message.exists { XCTAssertEqual(message.frame.minY, before, accuracy: 1) }
    }
}
