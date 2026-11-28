import UIKit
import XCTest

extension OpenClawSnapshotUITests {
    private func openFixtureSearch(appearance: String) throws -> (XCUIApplication, URL) {
        let address = ProcessInfo.processInfo.environment["OPENCLAW_IOS_SEARCH_FIXTURE_URL"]
        try XCTSkipIf(address == nil, "Requires test-ios-shell-gateway.mjs --search-order")
        let fixture = try XCTUnwrap(address.flatMap(URL.init(string:)))
        let app = try self.startPairedLiveGatewayApp(
            initialTab: "chat",
            initialDestination: "chat",
            appearance: appearance)
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 45))
        app.buttons["Go to Chat"].tap()
        self.openSearch(in: app)
        let field = app.textFields["Search.Field"]
        field.typeText("ios")
        let sessions = app.buttons["Search.Tab.sessions"]
        self.waitForValue("11", of: sessions, timeout: 10)
        sessions.tap()
        let start = app.coordinate(withNormalizedOffset: CGVector(dx: 0.46, dy: 0.43))
        let end = app.coordinate(withNormalizedOffset: CGVector(dx: 0.46, dy: 0.32))
        start.press(forDuration: 0.1, thenDragTo: end, withVelocity: .slow, thenHoldForDuration: 0.2)
        self.attachScreenshot(named: "search-tabs-\(appearance)")
        field.tap()
        field.typeText(" release")
        self.waitForValue("3", of: sessions, timeout: 10)
        return (app, fixture)
    }

    private func openSearch(in app: XCUIApplication) {
        let show = app.buttons["RootTabs.Sidebar.Show"]
        XCTAssertTrue(show.waitForExistence(timeout: 10))
        show.tap()
        let search = app.buttons["RootTabs.Sidebar.Search"]
        XCTAssertTrue(search.waitForExistence(timeout: 5))
        search.tap()
        XCTAssertTrue(app.textFields["Search.Field"].waitForExistence(timeout: 5))
    }

    func testSearchPlacesArchivedResultsLast() throws {
        let (app, _) = try self.openFixtureSearch(appearance: "light")
        let sessions = app.buttons["Search.Tab.sessions"]
        let rows = app.scrollViews.containing(.button, identifier: "iOS Release archive").firstMatch.buttons
        let active = rows["iOS Release checklist"]
        let archived = rows["iOS Release archive"]
        let message = rows["Release discussion"]
        self.waitForValue("2", of: app.buttons["Search.Tab.messages"], timeout: 10)
        XCTAssertTrue(archived.waitForExistence(timeout: 5))
        self.continueAfterFailure = true
        XCTAssertLessThan(active.frame.midY, archived.frame.midY, "All: active title before archived title")
        XCTAssertLessThan(message.frame.midY, archived.frame.midY, "All: active message before archived title")
        sessions.tap()
        XCTAssertLessThan(active.frame.midY, archived.frame.midY, "Sessions")
        app.buttons["Search.Tab.messages"].tap()
        let hits = app.scrollViews.containing(.button, identifier: "Past discussion").firstMatch.buttons
        XCTAssertLessThan(hits["Release discussion"].frame.midY, hits["Past discussion"].frame.midY, "Messages")
    }

    func testSearchKeepsUpdatedSessionInPlace() async throws {
        let (app, fixture) = try self.openFixtureSearch(appearance: "dark")
        let field = app.textFields["Search.Field"]
        let sessions = app.buttons["Search.Tab.sessions"]
        self.waitForValue("3", of: sessions, timeout: 10)
        sessions.tap()
        let rows = app.scrollViews.containing(.button, identifier: "iOS Release archive").firstMatch.buttons
        let checklist = rows["iOS Release checklist"]
        let notes = rows["iOS Release notes"]
        let notesFirst = notes.frame.midY < checklist.frame.midY
        var request = URLRequest(url: fixture.appendingPathComponent("search-update"))
        request.httpMethod = "POST"
        let (_, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        let updated = rows["iOS Release notes updated"]
        XCTAssertTrue(updated.waitForExistence(timeout: 10))
        XCTAssertEqual(updated.frame.midY < checklist.frame.midY, notesFirst)

        // A fresh query picks up the new recency; switching filters must not do that.
        app.buttons["Search.Tab.all"].tap()
        XCTAssertEqual(updated.frame.midY < checklist.frame.midY, notesFirst)
        field.tap()
        field.typeText(XCUIKeyboardKey.delete.rawValue)
        XCTAssertTrue(updated.waitForExistence(timeout: 5))
        XCTAssertLessThan(updated.frame.midY, checklist.frame.midY)
    }
}
