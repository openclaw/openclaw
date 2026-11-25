import XCTest

/// Frame pacing of a long chat transcript: XCTest's hitch metric over five iterations of flings,
/// disclosure expand/collapse and sidebar open/close. Numbers mean something on a device; on the
/// simulator the tests only prove the workload drives.
///
/// The chat is TEST_RUNNER_PARITY_SESSION_LABEL (an existing chat opened through sidebar search,
/// e.g. a long chat on the device), else TEST_RUNNER_PERF_SESSION_KEY (a session key the app opens
/// at launch, e.g. the `ux-history-…` chat `pnpm ios:behavior` seeds and prints).
/// Tests skip when neither session fixture is configured.
/// TEST_RUNNER_PERF_FLINGS sets flings per direction per iteration (default 6).
///
/// XCTest prints every metric as one line, `Test Case '-[… <test>]' measured [<metric>, <unit>]
/// average: …, values: [<one per iteration>], performanceMetricID:…`. Each test first prints
/// `CHAT_PERF test=<test> chat=<chat> iterations=5 …` naming its workload.
@MainActor
final class ChatScrollPerformanceUITests: XCTestCase {
    private static let iterations = 5
    private static let headerPredicate = NSPredicate(
        format: "label BEGINSWITH %@ OR label BEGINSWITH %@ OR label BEGINSWITH %@",
        argumentArray: ["Worked", "Ran ", "Called "])

    private var env: [String: String] {
        ProcessInfo.processInfo.environment
    }

    private var options: XCTMeasureOptions {
        let options = XCTMeasureOptions()
        options.iterationCount = Self.iterations
        return options
    }

    /// Flings toward older history and back to the latest turn, so every iteration starts where the
    /// previous one did. A warm-up pass loads the older pages first.
    func testTranscriptFlingHitches() throws {
        let (app, transcript, chat) = try self.openLongChat()
        let flings = Int(self.env["PERF_FLINGS"] ?? "") ?? 6
        let pass = {
            for _ in 0..<flings {
                transcript.swipeDown(velocity: .fast)
            }
            for _ in 0..<flings {
                transcript.swipeUp(velocity: .fast)
            }
        }
        pass()
        self.announce("testTranscriptFlingHitches", chat: chat, "flings=\(flings)")
        self.measure(
            metrics: [XCTHitchMetric(application: app), XCTOSSignpostMetric.scrollingAndDecelerationMetric],
            options: self.options,
            block: pass)
    }

    /// Expands and collapses one Worked/tool disclosure three times per iteration.
    func testDisclosureToggleHitches() throws {
        let (app, transcript, chat) = try self.openLongChat()
        let header = app.buttons.matching(Self.headerPredicate).firstMatch
        var swipes = 0
        while !(header.exists && header.isHittable && header.frame.midY > 250), swipes < 40 {
            transcript.swipeDown(velocity: .slow)
            swipes += 1
        }
        XCTAssertTrue(header.isHittable, "no disclosure header after \(swipes) swipes")
        let before = header.frame.minY
        self.announce("testDisclosureToggleHitches", chat: chat, "toggles=3")
        self.measure(metrics: [XCTHitchMetric(application: app)], options: self.options) {
            for _ in 0..<3 {
                header.tap()
                usleep(600_000)
                header.tap()
                usleep(600_000)
            }
        }
        print("CHAT_PERF test=testDisclosureToggleHitches headerDriftPt=\(abs(header.frame.minY - before))")
    }

    /// Opens the sidebar with an edge pan (the gesture readers use) and closes it by tapping the
    /// slid-out chat, three times per iteration.
    func testSidebarOpenCloseHitches() throws {
        let (app, _, chat) = try self.openLongChat()
        let search = app.buttons["Search sessions"]
        let edge = app.coordinate(withNormalizedOffset: CGVector(dx: 0.01, dy: 0.5))
        let open = app.coordinate(withNormalizedOffset: CGVector(dx: 0.8, dy: 0.5))
        let card = app.coordinate(withNormalizedOffset: CGVector(dx: 0.95, dy: 0.5))
        var attempts = 0
        var opened = 0
        self.announce("testSidebarOpenCloseHitches", chat: chat, "toggles=3")
        self.measure(metrics: [XCTHitchMetric(application: app)], options: self.options) {
            for _ in 0..<3 {
                attempts += 1
                edge.press(forDuration: 0.05, thenDragTo: open, withVelocity: .fast, thenHoldForDuration: 0)
                if search.waitForExistence(timeout: 2) {
                    opened += 1
                }
                card.tap()
                usleep(600_000)
            }
        }
        print("CHAT_PERF test=testSidebarOpenCloseHitches opened=\(opened) attempts=\(attempts)")
        XCTAssertEqual(opened, attempts, "the edge pan did not open the sidebar every time")
    }

    private func announce(_ test: String, chat: String, _ workload: String) {
        print("CHAT_PERF test=\(test) chat=\(chat) iterations=\(Self.iterations) \(workload)")
    }

    /// Launches into the configured chat and lets its history load and settle at the latest turn.
    private func openLongChat() throws -> (XCUIApplication, XCUIElement, String) {
        let label = self.env["PARITY_SESSION_LABEL"].flatMap { $0.isEmpty ? nil : $0 }
        let key = self.env["PERF_SESSION_KEY"].flatMap { $0.isEmpty ? nil : $0 }
        guard let chat = label ?? key else {
            throw XCTSkip("set TEST_RUNNER_PARITY_SESSION_LABEL or TEST_RUNNER_PERF_SESSION_KEY")
        }
        continueAfterFailure = false
        let app = XCUIApplication()
        if label == nil {
            app.launchArguments += ["--openclaw-chat-session", chat]
        }
        // Writer-attribution runs only: the probe adds work, so metric runs leave it off.
        if self.env["PERF_PROBE"] == "1" {
            app.launchArguments += ["--openclaw-behavior-probe"]
        }
        app.launch()
        let transcript = app.descendants(matching: .any)["chat-transcript"].firstMatch
        if let label {
            self.openFromSidebar(app, label: label)
        }
        XCTAssertTrue(transcript.waitForExistence(timeout: 30), app.debugDescription)
        sleep(6)
        return (app, transcript, chat)
    }

    /// Opens the chat titled `label` through sidebar search, unless the app restored it.
    private func openFromSidebar(_ app: XCUIApplication, label: String) {
        let title = app.navigationBars.staticTexts[label]
        if title.waitForExistence(timeout: 10) {
            return
        }
        let show = app.buttons.matching(identifier: "RootTabs.Sidebar.Show").firstMatch
        let search = app.buttons["Search sessions"]
        let deadline = Date().addingTimeInterval(30)
        while Date() < deadline, !(search.exists && search.isHittable), !show.exists {
            sleep(1)
        }
        if !(search.exists && search.isHittable) {
            XCTAssertTrue(show.waitForExistence(timeout: 5), app.debugDescription)
            show.tap()
        }
        search.tap()
        let field = app.searchFields.firstMatch.exists ? app.searchFields.firstMatch : app.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 10), app.debugDescription)
        field.tap()
        field.typeText(label)
        let row = app.descendants(matching: .any)
            .matching(NSPredicate(format: "label BEGINSWITH[c] %@", label)).firstMatch
        for _ in 0..<5 where !title.exists {
            if row.waitForExistence(timeout: 10), row.isHittable { row.tap() } else { sleep(1) }
            _ = title.waitForExistence(timeout: 10)
        }
        XCTAssertTrue(title.exists, "chat \(label) did not open")
    }
}
