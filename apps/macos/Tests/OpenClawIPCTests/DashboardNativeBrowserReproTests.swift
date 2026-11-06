import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized, .timeLimit(.minutes(1)))
@MainActor
struct DashboardNativeBrowserReproTests {
    @Test(arguments: [false, true])
    func `dashboard publishes current tab title after showing`(hiddenDuringChange: Bool) async throws {
        _ = AppKitTestSupport.application
        let favicon = "data:image/png;base64," +
            "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4z8DwHwAFAAH/iZk9HQAAAABJRU5ErkJggg=="
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><html><head><title>Article</title>
            <link rel="icon" href="\(favicon)"></head><body>Article fixture</body></html>
            """,
            contentSecurityPolicy: "default-src 'none'; img-src data:; connect-src data:")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url(),
            auth: DashboardWindowAuth.unauthenticated,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: server.url(), auth: .unauthenticated)
        try await DashboardTestWait.document(controller, "repro dashboard fixture loaded") {
            try await controller.webView.evaluateJavaScript("document.body.textContent") as? String == "Article fixture"
        }
        try controller.nativeBrowser.open(tabId: "mac-article", url: server.url("/article"), sessionKey: "")
        let article = try #require(controller.nativeBrowser.webView(for: "mac-article"))
        try #require(!article.configuration.websiteDataStore.isPersistent)
        try await TestWait.state("repro native article fixture loaded") {
            !article.isLoading && controller.nativeBrowser.state.tabs.first?.title == "Article"
        }
        try await self.expectPublishedTitle("Article", in: controller)
        // Favicon completion schedules a push too; finish it before hiding so it cannot rescue a dropped title.
        try await TestWait.state("repro initial favicon completed and published") {
            guard controller.nativeBrowser.state.tabs.first?.favicon == favicon else { return false }
            return try await controller.webView.evaluateJavaScript(
                "window.__OPENCLAW_NATIVE_BROWSER__?.tabs?.[0]?.favicon ?? null") as? String == favicon
        }
        let publishedRevision = try #require(try await controller.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_BROWSER__.revision") as? Int)
        print("[183926] setup passed: real article, title and completed favicon published; " +
            "hidden=\(hiddenDuringChange)")

        if hiddenDuringChange {
            controller.hideForExperience()
            try #require(controller.isHiddenForExperience)
        }
        _ = try await article.evaluateJavaScript("document.title = 'Changed while hidden'; true")
        try await TestWait.state("repro native host observes changed title and emits state") {
            let state = controller.nativeBrowser.state
            return state.tabs.first?.title == "Changed while hidden" && state.revision > publishedRevision
        }
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
        if hiddenDuringChange {
            try #require(try await self.publishedTitle(in: controller) == "Article")
        }
        print("[183926] native host title=\(controller.nativeBrowser.state.tabs.first?.title ?? "nil")")

        controller.show()
        try #require(!controller.isHiddenForExperience)
        try #require(controller.window?.isVisible == true)
        try await self.expectPublishedTitle("Changed while hidden", in: controller)
    }

    private func publishedTitle(in controller: DashboardWindowController) async throws -> String? {
        try await controller.webView.evaluateJavaScript(
            "window.__OPENCLAW_NATIVE_BROWSER__?.tabs?.find(tab => tab.id === 'mac-article')?.title ?? null") as? String
    }

    private func expectPublishedTitle(_ expected: String, in controller: DashboardWindowController) async throws {
        // A bounded document-state wait distinguishes a dropped push from slow WebKit delivery.
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .seconds(5))
        var published = try await self.publishedTitle(in: controller)
        while published != expected, clock.now < deadline {
            try await Task.sleep(for: .milliseconds(10))
            published = try await self.publishedTitle(in: controller)
        }
        let nativeTitle = controller.nativeBrowser.state.tabs.first?.title
        print("[183926] expected=\(expected); dashboard=\(published ?? "nil"); native=\(nativeTitle ?? "nil")")
        try #require(published == expected)
    }
}
