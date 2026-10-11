import UIKit
import XCTest

/// Runs wholly against DrawerGroupFixture: no Gateway, account, or external mutation.
@MainActor
final class RootSidebarMenuParityUITests: XCTestCase {
    func testWholeHeaderAndRowLongPressMenusOpenNativeControls() {
        self.continueAfterFailure = false
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--openclaw-screenshot-mode", "--openclaw-group-controls-fixture",
            "--openclaw-initial-tab", "chat", "--openclaw-initial-destination", "chat",
            "--openclaw-sidebar-visibility", "hidden", "--openclaw-ui-test-readiness",
            "--openclaw-appearance", "dark", "-AppleLanguages", "(en)",
            "-openclaw.ios.sidebar.status", "active", "-openclaw.ios.sidebar.owner", "",
            "-openclaw.ios.sidebar.grouping", "category", "-openclaw.ios.sidebar.sort", "created",
            "-sidebar.pinnedPages", "overview,usage,cron",
        ]
        app.launch()
        XCTAssertTrue(app.wait(for: .runningForeground, timeout: 10))
        let show = app.buttons["RootTabs.Sidebar.Show"]
        if show.waitForExistence(timeout: 10), show.isHittable { show.tap() }
        XCTAssertTrue(app.buttons["RootTabs.Sidebar.Destination.chat"].waitForExistence(timeout: 10))
        XCTAssertFalse(app.buttons["Plugin Pages & Actions…"].exists)
        self.capture(app, named: "sidebar-menu-landing")

        let sessions = app.descendants(matching: .any)
            .matching(identifier: "RootTabs.Sidebar.SessionViewMenu").firstMatch
        XCTAssertTrue(sessions.waitForExistence(timeout: 10), app.debugDescription)
        self.reveal(sessions, in: app, direction: .up)
        sessions.press(forDuration: 1)
        for label in ["Status", "Owner", "Sort By", "Group By", "Hide Empty Groups", "New Group…"] {
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 5), "Missing session header action: \(label)")
        }
        XCTAssertFalse(app.buttons["Session Sources…"].exists)
        self.capture(app, named: "sidebar-sessions-longpress")
        self.tapMenu("Status", in: app)
        for label in ["Active", "Snoozed", "Archived", "All"] {
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 5), "Missing status: \(label)")
        }
        self.capture(app, named: "sidebar-status-submenu")
        self.tapMenu("All", in: app)
        XCTAssertTrue(app.buttons["All"].waitForNonExistence(timeout: 5))
        sessions.press(forDuration: 1)
        self.tapMenu("Status", in: app)
        self.tapMenu("Active", in: app)
        XCTAssertTrue(app.buttons["Active"].waitForNonExistence(timeout: 5))

        let pages = app.staticTexts.matching(NSPredicate(format: "label ==[c] %@", "Pages")).firstMatch
        XCTAssertTrue(pages.waitForExistence(timeout: 5))
        self.reveal(pages, in: app, direction: .down)
        pages.press(forDuration: 1)
        XCTAssertTrue(app.buttons["Edit Pages…"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["Reset Pages"].exists)
        self.capture(app, named: "sidebar-pages-longpress")
        self.tapMenu("Edit Pages…", in: app)
        XCTAssertTrue(app.navigationBars["Customize Sidebar"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.switches.firstMatch.waitForExistence(timeout: 5))
        self.capture(app, named: "sidebar-pages-native-editor")
        app.navigationBars["Customize Sidebar"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Customize Sidebar"].waitForNonExistence(timeout: 5))

        let row = app.descendants(matching: .any)
            .matching(identifier: "RootTabs.Sidebar.Session.agent:main:dashboard:fixture-project").firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 10), app.debugDescription)
        self.reveal(row, in: app, direction: .up)
        row.press(forDuration: 1)
        for label in ["Rename…", "Icon & Color…", "Assign to…", "Copy", "Open in…"] {
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 5), "Missing row action: \(label)")
        }
        XCTAssertFalse(app.buttons["Plugin Actions…"].exists)
        self.capture(app, named: "sidebar-session-longpress")
        self.tapMenu("Icon & Color…", in: app)
        XCTAssertTrue(app.navigationBars["Icon & Color"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.buttons["No Icon"].exists)
        self.capture(app, named: "sidebar-session-appearance")
        app.navigationBars["Icon & Color"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Icon & Color"].waitForNonExistence(timeout: 5))

        row.press(forDuration: 1)
        self.tapMenu("Assign to…", in: app)
        XCTAssertTrue(app.navigationBars["Assign to"].waitForExistence(timeout: 5))
        XCTAssertTrue(app.staticTexts["Fixture Collaborator"].waitForExistence(timeout: 10), app.debugDescription)
        XCTAssertTrue(app.staticTexts["Fixture Agent"].exists)
        self.capture(app, named: "sidebar-session-assignment")
        app.navigationBars["Assign to"].buttons["Done"].tap()
        XCTAssertTrue(app.navigationBars["Assign to"].waitForNonExistence(timeout: 5))

        row.press(forDuration: 1)
        self.tapMenu("Rename…", in: app)
        XCTAssertTrue(app.navigationBars["Rename Session"].waitForExistence(timeout: 5))
        let name = app.textFields["Session name"]
        XCTAssertTrue(name.waitForExistence(timeout: 5))
        name.tap()
        let existing = name.value as? String ?? ""
        name.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: existing.count))
        name.typeText("Menu Parity Rename")
        self.capture(app, named: "sidebar-session-rename-editor")
        app.buttons["Save"].tap()
        XCTAssertTrue(app.navigationBars["Rename Session"].waitForNonExistence(timeout: 5))
        XCTAssertTrue(row.staticTexts["Menu Parity Rename"].waitForExistence(timeout: 5), app.debugDescription)

        row.press(forDuration: 1)
        self.tapMenu("Copy", in: app)
        for label in ["Session Link", "Session Preview Link", "Markdown", "Session ID"] {
            XCTAssertTrue(app.buttons[label].waitForExistence(timeout: 5), "Missing copy action: \(label)")
            XCTAssertTrue(app.buttons[label].isEnabled, "Fixture copy action is unexpectedly disabled: \(label)")
        }
        self.capture(app, named: "sidebar-session-copy-submenu")
        self.tapMenu("Session ID", in: app)
        let copied = app.alerts["Copy"]
        XCTAssertTrue(copied.waitForExistence(timeout: 5))
        XCTAssertTrue(copied.staticTexts["Session ID copied."].exists)
        self.capture(app, named: "sidebar-session-copy-confirmation")
        copied.buttons["OK"].tap()
        XCTAssertTrue(copied.waitForNonExistence(timeout: 5))
        XCTAssertTrue(row.isHittable)
    }

    private enum ScrollDirection { case up, down }

    private func reveal(_ element: XCUIElement, in app: XCUIApplication, direction: ScrollDirection) {
        for _ in 0..<6 where !element.isHittable {
            switch direction {
            case .up: app.swipeUp()
            case .down: app.swipeDown()
            }
        }
        XCTAssertTrue(element.isHittable, "Long-press target is not reachable: \(element)")
    }

    private func tapMenu(_ title: String, in app: XCUIApplication) {
        let button = app.buttons[title]
        XCTAssertTrue(button.waitForExistence(timeout: 5), app.debugDescription)
        let containers = app.otherElements.containing(.button, identifier: title).allElementsBoundByIndex
        guard let menu = containers.filter({ !$0.frame.isEmpty }).min(by: {
            $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height
        }) else {
            XCTFail("Menu container is missing: \(title)")
            return
        }
        for _ in 0..<6 where !menu.frame.contains(button.frame) {
            let start = menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.85))
            let end = menu.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.2))
            start.press(forDuration: 0.05, thenDragTo: end)
        }
        XCTAssertTrue(menu.frame.contains(button.frame), "Menu action is clipped: \(title)")
        XCTAssertTrue(app.frame.contains(button.frame), "Menu action is outside the viewport: \(title)")
        XCTAssertTrue(button.isEnabled, "Menu action is disabled: \(title)")
        // Native context-menu rows can expose a valid frame but no AX activation point.
        button.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap()
    }

    private func capture(_ app: XCUIApplication, named name: String) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        self.add(screenshot)
        let hierarchy = XCTAttachment(string: app.debugDescription)
        hierarchy.name = "\(name)-hierarchy"
        hierarchy.lifetime = .keepAlways
        self.add(hierarchy)
    }
}
