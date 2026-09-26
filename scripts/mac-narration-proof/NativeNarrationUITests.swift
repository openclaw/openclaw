import Foundation
import XCTest

/// Opt-in desktop proof: exact baseline/grouped app bytes with the same loopback Gateway scenario.
/// iOS coverage cannot exercise AppKit accessibility, Mac transport, or desktop process recovery.
final class NativeNarrationUITests: XCTestCase {
    private let fixtureURL = URL(string: "http://127.0.0.1:19876")!

    @MainActor
    func testNativeRunGroupingAndProcessRecovery() async throws {
        self.continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        let stage = try XCTUnwrap(environment["OPENCLAW_MAC_PROOF_STAGE"])
        XCTAssertTrue(["before", "after"].contains(stage))
        let appPath = try XCTUnwrap(environment["OPENCLAW_MAC_PROOF_APP"])
        let proofHome = try XCTUnwrap(environment["OPENCLAW_MAC_PROOF_HOME"])
        let statePath = try XCTUnwrap(environment["OPENCLAW_MAC_PROOF_STATE"])
        let configPath = try XCTUnwrap(environment["OPENCLAW_MAC_PROOF_CONFIG"])
        XCTAssertTrue(appPath.hasSuffix(".app"))

        // XCUIApplication(url:) is Apple's macOS external-bundle launch API;
        // this test runner is never an app host or a replacement UI.
        let app = XCUIApplication(url: URL(fileURLWithPath: appPath))
        app.launchArguments = ["--attach-only", "-AppleInterfaceStyle", "Dark"]
        app.launchEnvironment = [
            "HOME": proofHome,
            "CFFIXED_USER_HOME": proofHome,
            "OPENCLAW_STATE_DIR": statePath,
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_PROFILE": "macproof",
            "NSUnbufferedIO": "YES",
        ]
        if let products = environment["OPENCLAW_MAC_PROOF_PRODUCTS"] {
            app.launchEnvironment["DYLD_FRAMEWORK_PATH"] = "\(appPath)/Contents/Frameworks:\(products)"
        }
        defer {
            let tree = XCTAttachment(string: app.debugDescription)
            tree.name = "mac-native-accessibility-tree"
            tree.lifetime = .keepAlways
            self.add(tree)
            app.terminate()
        }
        app.launch()
        self.openNativeChat(app)

        let input = app.textViews["chat-message-input"]
        XCTAssertTrue(input.waitForExistence(timeout: 30), "Native desktop composer did not open")
        input.click()
        input.typeText("Review the mobile layout.")
        let send = app.buttons["chat-send-message"]
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: send)
        let ready = await XCTWaiter.fulfillment(of: [enabled], timeout: 10)
        XCTAssertEqual(ready, .completed)
        XCTAssertTrue(send.isHittable)
        send.click()
        let accepted = try await self.control("await-send")
        XCTAssertEqual(accepted["phase"] as? String, "accepted")
        XCTAssertTrue(self.narration("Review the mobile layout.", in: app).waitForExistence(timeout: 5))

        _ = try await self.control("work", method: "POST")
        let current = self.narration("Preparing the layout summary.", in: app)
        // This marker follows every narration event on the socket. A failed
        // connection must not be mistaken for the baseline rendering defect.
        XCTAssertTrue(current.waitForExistence(timeout: 10), "Native desktop live traffic did not arrive")
        let first = self.narration("Reading the mobile layout.", in: app)
        let second = self.narration("Checking spacing and contrast.", in: app)
        let activeVisible = first.waitForExistence(timeout: 2) && second.waitForExistence(timeout: 2)
        if activeVisible {
            XCTAssertLessThan(first.frame.minY, second.frame.minY)
            XCTAssertLessThan(second.frame.minY, current.frame.minY)
        }
        XCTAssertTrue(activeVisible, "Both narration segments must remain visible while working")
        let liveRead = app.otherElements["Read"]
        XCTAssertTrue(liveRead.waitForExistence(timeout: 5), "Pending tool must be visible")
        // macOS omits AXValue for this row. The driver checks its actual pixels
        // with CPU-based OCR after XCTest, avoiding unavailable VM Vision engines.
        let toolImagePath = try XCTUnwrap(environment["OPENCLAW_MAC_PROOF_TOOL_IMAGE"])
        try liveRead.screenshot().pngRepresentation.write(to: URL(fileURLWithPath: toolImagePath))
        if stage == "after" {
            XCTAssertLessThan(first.frame.minY, liveRead.frame.minY)
            XCTAssertLessThan(liveRead.frame.minY, second.frame.minY)
        }
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "active")

        _ = try await self.control("persist-tool", method: "POST")
        let read = app.buttons["chat-tool-activity-layout-read"]
        XCTAssertTrue(read.waitForExistence(timeout: 5))
        XCTAssertEqual(
            app.buttons.matching(identifier: "chat-tool-activity-layout-read").count,
            1,
            "Persisting the tool must not duplicate it")
        if stage == "after" {
            XCTAssertLessThan(first.frame.minY, read.frame.minY)
            XCTAssertLessThan(read.frame.minY, second.frame.minY)
        }
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "tool-persisted")

        let activePanel = try await self.openQuickChat(app)
        let quickCurrent = self.narration("Preparing the layout summary.", in: activePanel)
        XCTAssertTrue(quickCurrent.waitForExistence(timeout: 10), "Quick Chat active history did not load")
        let quickFirst = self.narration("Reading the mobile layout.", in: activePanel)
        let quickSecond = self.narration("Checking spacing and contrast.", in: activePanel)
        let quickVisible = quickFirst.waitForExistence(timeout: 2) && quickSecond.waitForExistence(timeout: 2)
        if quickVisible {
            XCTAssertLessThan(quickFirst.frame.minY, quickSecond.frame.minY)
            XCTAssertTrue(activePanel.frame.intersects(quickFirst.frame))
            XCTAssertTrue(activePanel.frame.intersects(quickSecond.frame))
        }
        self.assertRunPresentation(in: activePanel, stage: stage)
        self.attachScreenshot(activePanel, name: "mac-quick-chat-\(stage)-active")
        self.closeQuickChat(app)

        app.terminate()
        app.launch()
        self.openNativeChat(app)
        _ = try await self.control("await-reconnect")
        XCTAssertTrue(current.waitForExistence(timeout: 10), "Native desktop in-flight history did not load")
        let recoveredVisible = first.waitForExistence(timeout: 2) && second.waitForExistence(timeout: 2)
        if recoveredVisible {
            XCTAssertLessThan(first.frame.minY, second.frame.minY)
            XCTAssertLessThan(second.frame.minY, current.frame.minY)
        }
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "reconnected")

        XCTAssertTrue(read.waitForExistence(timeout: 5), "Recovered tool result must remain interactive")
        XCTAssertTrue(read.isHittable)
        read.click()
        let toolResult = self.narration("Layout checked.", in: app)
        XCTAssertTrue(toolResult.waitForExistence(timeout: 5))
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "tool-expanded")
        read.click()
        XCTAssertTrue(toolResult.waitForNonExistence(timeout: 5))

        _ = try await self.control("complete", method: "POST")
        let finalReply = self.narration("The mobile layout is ready.", in: app)
        XCTAssertTrue(finalReply.waitForExistence(timeout: 10), "Native desktop final reply did not arrive")
        let work = app.disclosureTriangles.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ OR label BEGINSWITH %@",
            "chat-completed-work-", "Worked")).firstMatch
        XCTAssertTrue(work.waitForExistence(timeout: 8), "Native completed-work disclosure is missing")
        XCTAssertTrue(first.waitForNonExistence(timeout: 5))
        XCTAssertTrue(second.waitForNonExistence(timeout: 5))
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "completed")

        XCTAssertTrue(work.isHittable)
        self.clickDisclosureChevron(work)
        XCTAssertTrue(first.waitForExistence(timeout: 5))
        XCTAssertTrue(second.waitForExistence(timeout: 5))
        XCTAssertLessThan(first.frame.minY, second.frame.minY)
        XCTAssertTrue(finalReply.exists, "Expanding work must preserve the final reply")
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "expanded")

        XCTAssertTrue(work.isHittable)
        self.clickDisclosureChevron(work)
        XCTAssertTrue(first.waitForNonExistence(timeout: 5))
        XCTAssertTrue(second.waitForNonExistence(timeout: 5))
        XCTAssertTrue(finalReply.exists, "Collapsing work must preserve the final reply")
        self.assertRunPresentation(in: app.windows.firstMatch, stage: stage)
        try await self.capture(app, stage: stage, state: "collapsed")

        let completedPanel = try await self.openQuickChat(app)
        let quickFinal = self.narration("The mobile layout is ready.", in: completedPanel)
        XCTAssertTrue(quickFinal.waitForExistence(timeout: 10), "Quick Chat completed history did not load")
        let quickWork = completedPanel.disclosureTriangles.matching(NSPredicate(
            format: "identifier BEGINSWITH %@ OR label BEGINSWITH %@",
            "chat-completed-work-", "Worked")).firstMatch
        XCTAssertTrue(quickWork.waitForExistence(timeout: 5))
        let completedFirst = self.narration("Reading the mobile layout.", in: completedPanel)
        let completedSecond = self.narration("Checking spacing and contrast.", in: completedPanel)
        XCTAssertFalse(completedFirst.exists)
        XCTAssertFalse(completedSecond.exists)
        self.assertRunPresentation(in: completedPanel, stage: stage)
        self.attachScreenshot(completedPanel, name: "mac-quick-chat-\(stage)-completed")
        self.clickDisclosureChevron(quickWork)
        XCTAssertTrue(completedFirst.waitForExistence(timeout: 5))
        XCTAssertTrue(completedSecond.waitForExistence(timeout: 5))
        XCTAssertLessThan(completedFirst.frame.minY, completedSecond.frame.minY)
        XCTAssertTrue(quickFinal.exists)
        self.assertRunPresentation(in: completedPanel, stage: stage)
        self.attachScreenshot(completedPanel, name: "mac-quick-chat-\(stage)-expanded")
        self.clickDisclosureChevron(quickWork)
        XCTAssertTrue(completedFirst.waitForNonExistence(timeout: 5))
        XCTAssertTrue(quickFinal.exists)
        self.closeQuickChat(app)

        // Both product variants must preserve the existing narration/recovery contract.
        XCTAssertTrue(activeVisible && recoveredVisible && quickVisible, "NARRATION_MISSING_WHILE_RUNNING")
    }

    @MainActor
    private func assertRunPresentation(in root: XCUIElement, stage: String) {
        let frames = root.descendants(matching: .any).matching(identifier: "chat-assistant-run")
        XCTAssertEqual(
            frames.count,
            stage == "after" ? 1 : 0,
            "Grouped candidate must expose exactly one run container in each native chat surface")
    }

    @MainActor
    private func clickDisclosureChevron(_ disclosure: XCUIElement) {
        // Xcode 27 includes the label and expanded body in AXDisclosureTriangle.
        // Its visible header chevron stays 26pt right and 7.5pt below the origin in both states.
        disclosure.coordinate(withNormalizedOffset: CGVector(dx: 0, dy: 0))
            .withOffset(CGVector(dx: 26, dy: 7.5)).click()
    }

    @MainActor
    private func openNativeChat(_ app: XCUIApplication) {
        // Exercise the ordinary Gateway menu action after app startup. The CLI
        // auto-open request races primary-connection initialization on both revisions.
        app.activate()
        let gateways = app.menuBars.menuBarItems["Gateways"]
        XCTAssertTrue(gateways.waitForExistence(timeout: 10))
        gateways.click()
        let primary = app.menuItems.matching(identifier: "primary").firstMatch
        XCTAssertTrue(primary.waitForExistence(timeout: 10))
        XCTAssertTrue(primary.isHittable)
        primary.click()
    }

    @MainActor
    private func narration(_ text: String, in root: XCUIElement) -> XCUIElement {
        root.staticTexts.matching(NSPredicate(format: "label CONTAINS %@ OR value CONTAINS %@", text, text)).firstMatch
    }

    @MainActor
    private func openQuickChat(_ app: XCUIApplication) async throws -> XCUIElement {
        // The app intentionally disables global hotkey registration under XCTest.
        // Use the ordinary status-menu action without changing that safety contract.
        let statusItem = app.descendants(matching: .statusItem).firstMatch
        XCTAssertTrue(statusItem.waitForExistence(timeout: 5))
        statusItem.rightClick()
        let quickChat = app.menuItems["Quick Chat"]
        XCTAssertTrue(quickChat.waitForExistence(timeout: 5))
        quickChat.click()
        // macOS exposes this NSPanel as a dialog. SwiftUI inherits the composer
        // container identifier onto its children, so use the real control label.
        let panel = app.dialogs.firstMatch
        XCTAssertTrue(panel.waitForExistence(timeout: 8))
        let deferPermissions = panel.buttons["Not now"]
        if deferPermissions.exists { deferPermissions.click() }
        let toggle = panel.buttons["Expand conversation"]
        XCTAssertTrue(toggle.waitForExistence(timeout: 8), "Status menu did not open Quick Chat")
        let enabled = XCTNSPredicateExpectation(predicate: NSPredicate(format: "enabled == true"), object: toggle)
        let result = await XCTWaiter.fulfillment(of: [enabled], timeout: 10)
        XCTAssertEqual(result, .completed)
        toggle.click()
        // The full chat stays behind the panel with identical text. Keep all
        // transcript queries scoped to this dialog, not the whole application.
        return panel
    }

    @MainActor
    private func closeQuickChat(_ app: XCUIApplication) {
        app.typeKey(.escape, modifierFlags: [])
        XCTAssertTrue(app.dialogs.firstMatch.waitForNonExistence(timeout: 5))
    }

    @MainActor
    private func attachScreenshot(_ element: XCUIElement, name: String) {
        let screenshot = XCTAttachment(screenshot: element.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
    }

    @MainActor
    private func capture(_ app: XCUIApplication, stage: String, state: String) async throws {
        self.attachScreenshot(app, name: "mac-grouping-\(stage)-\(state)")
        _ = try await self.control("capture/\(stage)-\(state)", method: "POST")
    }

    @MainActor
    private func control(_ action: String, method: String = "GET") async throws -> [String: Any] {
        var request = URLRequest(url: self.fixtureURL.appendingPathComponent("narration/\(action)"))
        request.httpMethod = method
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200, "Narration fixture transition failed")
        return try XCTUnwrap(JSONSerialization.jsonObject(with: data) as? [String: Any])
    }
}
