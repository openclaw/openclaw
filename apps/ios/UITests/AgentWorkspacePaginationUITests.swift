import UIKit
import XCTest

@MainActor
final class AgentWorkspacePaginationUITests: XCTestCase {
    func testSuccessfulLoadMoreClearsPreviousPageFailure() async throws {
        continueAfterFailure = false
        let environment = ProcessInfo.processInfo.environment
        try XCTSkipUnless(
            environment["OPENCLAW_IOS_WORKSPACE_PAGINATION_URL"] != nil,
            "Requires test-ios-shell-gateway.mjs --workspace-pagination")
        let fixture = try XCTUnwrap(environment["OPENCLAW_IOS_WORKSPACE_PAGINATION_URL"].flatMap(URL.init(string:)))
        let setupCode = try XCTUnwrap(environment["OPENCLAW_IOS_LIVE_SETUP_CODE"])
        let app = XCUIApplication()
        defer { app.terminate() }
        app.launchArguments = [
            "--openclaw-reset-onboarding", "--openclaw-initial-destination", "chat",
            "--openclaw-ui-test-readiness", "-sidebar.pinnedPages", "files",
            "--openclaw-appearance", "light", "-AppleLanguages", "(en)", "-AppleLocale", "en_US",
        ]
        app.launch()
        XCTAssertTrue(app.buttons["Continue"].waitForExistence(timeout: 15))
        app.buttons["Continue"].tap()
        XCTAssertTrue(app.buttons["Connect Manually"].waitForExistence(timeout: 10))
        app.buttons["Connect Manually"].tap()
        let setup = app.textFields["Enter setup code"]
        XCTAssertTrue(setup.waitForExistence(timeout: 5))
        setup.tap()
        setup.typeText(setupCode)
        app.buttons["Apply"].tap()
        XCTAssertTrue(app.staticTexts["You're connected"].waitForExistence(timeout: 60))
        app.buttons["Go to Chat"].tap()
        app.buttons["RootTabs.Sidebar.Show"].tap()
        let files = app.buttons["RootTabs.Sidebar.Destination.files"]
        XCTAssertTrue(files.waitForExistence(timeout: 10))
        files.tap()
        let readiness = app.descendants(matching: .any)["RootTabs.Ready"].firstMatch
        self.expectation(for: NSPredicate(format: "value == %@", "ready:files"), evaluatedWith: readiness)
        self.waitForExpectations(timeout: 10)

        XCTAssertTrue(app.buttons["File 001.txt"].waitForExistence(timeout: 10))
        let initial = try await self.state(fixture, minimumReads: 1)
        XCTAssertEqual(initial.reads.first?.offset, 0)
        XCTAssertEqual(initial.reads.first?.count, 250)
        XCTAssertNil(initial.reads.first?.limit)
        let paths = try XCTUnwrap(initial.reads.first?.paths)
        XCTAssertEqual(paths.count, 250)
        XCTAssertEqual(Set(paths), Set((1...250).map { String(format: "File %03d.txt", $0) }))
        let failure = app.staticTexts["Could not load this folder."]
        let summary = app.buttons["Summary.md"]

        for attempt in 1...2 {
            let more = self.revealLoadMore(in: app)
            XCTAssertTrue(more.label.contains("250 of 251"))
            XCTAssertTrue(app.buttons["File 250.txt"].isHittable)
            more.tap()
            let failed = try await self.state(fixture, minimumReads: initial.reads.count + attempt)
            self.assertTailReads(failed, failed: Array(repeating: true, count: attempt))
            // Error feedback can move this virtualized footer outside the visible list.
            _ = self.revealLoadMore(in: app)
            self.expectation(for: NSPredicate(format: "enabled == true"), evaluatedWith: more)
            self.waitForExpectations(timeout: 5)
            self.scrollToTop(in: app)
            XCTAssertTrue(failure.waitForExistence(timeout: 5))
            XCTAssertTrue(app.buttons["File 001.txt"].isHittable)
            XCTAssertFalse(summary.exists)
            self.capture("failed-page-attempt-\(attempt)", in: app)
        }

        _ = try await self.state(fixture, rejecting: false)
        let more = self.revealLoadMore(in: app)
        more.tap()
        let recovered = try await self.state(fixture, minimumReads: initial.reads.count + 3)
        self.assertTailReads(recovered, failed: [true, true, false])
        XCTAssertTrue(summary.waitForExistence(timeout: 10))
        XCTAssertTrue(more.waitForNonExistence(timeout: 5))
        XCTAssertEqual(app.buttons.matching(identifier: "Summary.md").count, 1)
        XCTAssertTrue(app.buttons["File 250.txt"].isHittable)
        self.capture("last-file-loaded", in: app)
        self.scrollToTop(in: app)
        self.capture("recovered-directory", in: app)
        XCTAssertFalse(failure.exists, "Successful Load More must retire the earlier page error")
        XCTAssertTrue(app.buttons["File 001.txt"].isHittable)
    }

    private func revealLoadMore(in app: XCUIApplication) -> XCUIElement {
        let more = app.buttons.matching(NSPredicate(format: "label BEGINSWITH %@", "Load More")).firstMatch
        for _ in 0..<40 where !more.exists || !more.isHittable {
            app.swipeUp(velocity: .fast)
        }
        XCTAssertTrue(more.exists && more.isHittable)
        return more
    }

    private func scrollToTop(in app: XCUIApplication) {
        app.coordinate(withNormalizedOffset: .zero).withOffset(CGVector(dx: 20, dy: 30)).tap()
        XCTAssertTrue(app.buttons["File 001.txt"].waitForExistence(timeout: 5))
    }

    private func state(_ fixture: URL, minimumReads: Int = 0, rejecting: Bool? = nil) async throws -> PageState {
        var query = [URLQueryItem(name: "reads", value: String(minimumReads))]
        if let rejecting { query.append(URLQueryItem(name: "reject", value: rejecting ? "1" : "0")) }
        var request = URLRequest(url: fixture.appendingPathComponent("workspace-pagination")
            .appending(queryItems: query))
        request.httpMethod = rejecting == nil ? "GET" : "POST"
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        XCTAssertEqual((response as? HTTPURLResponse)?.statusCode, 200)
        return try JSONDecoder().decode(PageState.self, from: data)
    }

    private func assertTailReads(_ state: PageState, failed: [Bool]) {
        let reads = state.reads.filter { $0.offset > 0 }
        XCTAssertEqual(reads.map(\.offset), Array(repeating: 250, count: failed.count))
        XCTAssertTrue(reads.allSatisfy { $0.limit == nil })
        XCTAssertEqual(reads.map(\.failed), failed)
        XCTAssertEqual(reads.map(\.count), failed.map { $0 ? 0 : 1 })
    }

    private func capture(_ name: String, in app: XCUIApplication) {
        let screenshot = XCTAttachment(screenshot: app.screenshot())
        screenshot.name = name
        screenshot.lifetime = .keepAlways
        add(screenshot)
    }

    private struct PageState: Decodable {
        struct Read: Decodable {
            let offset: Int
            let limit: Int?
            let count: Int
            let paths: [String]
            let failed: Bool
        }

        let reads: [Read]
    }
}
