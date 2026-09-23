import UIKit
import XCTest

/// The original Shortcuts proof and native control witnesses use the same public UI actions.
@MainActor
enum InstalledShortcutsControls {
    static func assertEditorRunCompleted(in shortcuts: XCUIApplication) {
        let run = shortcuts.buttons["Run Shortcut"].firstMatch
        let completed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            run.exists && run.isEnabled && !shortcuts.buttons["Stop Shortcut"].exists
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [completed], timeout: 30), .completed)
    }

    static func observation(in app: XCUIApplication) throws -> [String: Any] {
        app.activate()
        let marker = app.descendants(matching: .any)["RootTabs.InstalledNativeProof"].firstMatch
        XCTAssertTrue(marker.waitForExistence(timeout: 10), "Proof build observer is absent")
        let value = try XCTUnwrap(marker.value as? String)
        XCTAssertLessThan(value.utf8.count, 1024)
        return try XCTUnwrap(JSONSerialization.jsonObject(with: Data(value.utf8)) as? [String: Any])
    }

    static func waitForObservation(
        in app: XCUIApplication, matching: @escaping ([String: Any]) -> Bool) throws -> [String: Any]
    {
        var last: [String: Any]?
        let expected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            guard let value = try? Self.observation(in: app), matching(value) else { return false }
            last = value
            return true
        }, object: nil)
        XCTAssertEqual(XCTWaiter.wait(for: [expected], timeout: 45), .completed, "Actual native owner did not complete")
        return try XCTUnwrap(last)
    }

    static func selectSession(_ name: String, in app: XCUIApplication) {
        self.dismissRun(in: app)
        let sidebar = app.buttons["RootTabs.Sidebar.Show"].firstMatch
        XCTAssertTrue(sidebar.waitForExistence(timeout: 10))
        sidebar.tap()
        let row = app.buttons.containing(.staticText, identifier: name).firstMatch
        XCTAssertTrue(row.waitForExistence(timeout: 15))
        row.tap()
        Self.assertSelectedSession(name, in: app)
    }

    static func assertSelectedSession(_ name: String, in app: XCUIApplication) {
        let identity = app.descendants(matching: .any)["chat-agent-identity"].firstMatch
            .descendants(matching: .any)["chat-gateway-status"].firstMatch
        XCTAssertTrue(identity.waitForExistence(timeout: 15))
        let selected = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in
            identity.label.hasSuffix(". \(name)")
        }, object: nil)
        XCTAssertEqual(
            XCTWaiter.wait(for: [selected], timeout: 15),
            .completed,
            "Visible owner did not adopt the selected session")
    }

    @discardableResult
    static func assertIdleEditor(in app: XCUIApplication) throws -> [String: Any] {
        // Read the existing owner predicates; Send-button visibility alone can
        // hide submitting, advertised-run, branch-switch or attachment custody.
        let value = try Self.waitForObservation(in: app) { $0["idleUnprotectedComposer"] as? Bool == true }
        let editor = app.textViews["chat-message-input"].firstMatch
        XCTAssertTrue(editor.waitForExistence(timeout: 10))
        XCTAssertEqual(editor.value as? String, "")
        XCTAssertTrue(app.buttons["chat-send-message"].waitForExistence(timeout: 15))
        XCTAssertFalse(app.buttons["Stop response"].exists)
        XCTAssertFalse(Self.runSheet(in: app).exists)
        return value
    }

    static func runSheet(in app: XCUIApplication) -> XCUIElement {
        app.sheets.containing(.navigationBar, identifier: "Run").firstMatch
    }

    static func dismissRun(in app: XCUIApplication) {
        let sheet = Self.runSheet(in: app)
        if sheet.exists {
            sheet.buttons["Done"].firstMatch.tap()
            let dismissed = XCTNSPredicateExpectation(predicate: NSPredicate { _, _ in !sheet.exists }, object: nil)
            XCTAssertEqual(XCTWaiter.wait(for: [dismissed], timeout: 15), .completed)
        }
    }

    static func verifyRun(_ run: String, session: String, profile: String, in app: XCUIApplication) {
        app.activate()
        let sheet = Self.runSheet(in: app)
        XCTAssertTrue(sheet.waitForExistence(timeout: 15))
        XCTAssertTrue(sheet.isHittable)
        for value in [run, session, profile, "qa"] {
            XCTAssertTrue(
                sheet.staticTexts[value].firstMatch.waitForExistence(timeout: 10),
                "Run association is not visible")
        }
    }

    static func expand(in shortcuts: XCUIApplication) {
        for _ in 0..<8 {
            let more = shortcuts.buttons["Show More"].firstMatch
            if !more.exists { return }
            more.tap()
        }
        XCTAssertFalse(shortcuts.buttons["Show More"].firstMatch.exists)
    }

    static func assertHiddenParameters(in shortcuts: XCUIApplication) {
        for title in ["Automatic", "Presentation"] {
            XCTAssertEqual(
                shortcuts.descendants(matching: .any).matching(NSPredicate(format: "label == %@", title)).count,
                0,
                "Technical continuation parameters are exposed in Shortcuts")
        }
    }

    static func verifyToggle(_ enabled: Bool, in shortcuts: XCUIApplication) {
        let toggle = shortcuts.switches["Open When Run"].firstMatch
        XCTAssertTrue(toggle.waitForExistence(timeout: 10))
        XCTAssertEqual(toggle.value as? String, enabled ? "1" : "0")
    }

    static func choose(_ label: String, in shortcuts: XCUIApplication) {
        let item = shortcuts.descendants(matching: .any).matching(NSPredicate(format: "label == %@", label)).firstMatch
        XCTAssertTrue(item.waitForExistence(timeout: 15), "Required Shortcuts control is missing")
        item.tap()
    }

    static func addAction(_ title: String, in shortcuts: XCUIApplication) {
        let search = shortcuts.searchFields.firstMatch
        XCTAssertTrue(search.waitForExistence(timeout: 10))
        search.tap()
        if let value = search.value as? String, !value.isEmpty, value != search.placeholderValue {
            search.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: value.count))
        }
        search.typeText(title)
        let action = shortcuts.buttons[title].firstMatch
        XCTAssertTrue(action.waitForExistence(timeout: 20), "Action is absent from Shortcuts")
        action.tap()
    }

    static func save(_ name: String, in shortcuts: XCUIApplication) {
        self.choose("New Shortcut", in: shortcuts)
        self.choose("Rename", in: shortcuts)
        let field = shortcuts.textFields.firstMatch
        XCTAssertTrue(field.waitForExistence(timeout: 5))
        field.tap()
        field.typeText(String(repeating: XCUIKeyboardKey.delete.rawValue, count: (field.value as? String ?? "").count))
        field.typeText(name + "\n")
        Self.choose("Done", in: shortcuts)
    }

    static func openEditor(_ name: String, in shortcuts: XCUIApplication) throws {
        var url = try XCTUnwrap(URLComponents(string: "shortcuts://open-shortcut"))
        url.queryItems = [URLQueryItem(name: "name", value: name)]
        try shortcuts.open(XCTUnwrap(url.url))
    }
}
