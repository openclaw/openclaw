import Foundation
import Testing
import WebKit
@testable import OpenClaw

/// Dashboard waits have no deadline of their own. Their suites declare `.timeLimit`,
/// whose clock starts when a test case runs rather than while it queues behind
/// parallel tests, so a saturated runner delays these waits instead of failing them.
@MainActor
enum DashboardTestWait {
    /// Waits until the controller's main document has settled and `condition` holds.
    /// Readiness is re-read on each WKWebView `isLoading` or `url` change. WebKit
    /// publishes those before calling the navigation delegate, and this task resumes
    /// only after that callback returns, so `canDeliverNativeCommands` already
    /// reflects `didFinish`. `condition` must be a fact of the settled document;
    /// page-script effects that land later belong in `state(_:_:)`.
    static func document(
        _ controller: DashboardWindowController,
        _ stage: String = "dashboard document",
        until condition: @MainActor () async throws -> Bool = { true }) async throws
    {
        let webView = controller.webView
        let changes = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let observations = [
            webView.observe(\.isLoading, options: [.initial]) { _, _ in changes.continuation.yield() },
            webView.observe(\.url) { _, _ in changes.continuation.yield() },
        ]
        defer {
            observations.forEach { $0.invalidate() }
            changes.continuation.finish()
        }
        for await _ in changes.stream {
            if !webView.isLoading, controller.canDeliverNativeCommands, try await condition() { return }
        }
        Issue.record("""
        Still waiting for \(stage): loading=\(webView.isLoading), \
        url=\(webView.url?.absoluteString ?? "nil"), currentURL=\(controller.currentURL.absoluteString), \
        deliverable=\(controller.canDeliverNativeCommands), failurePage=\(controller.isShowingFailurePage)
        """)
        throw CancellationError()
    }

    /// Waits for page-script, AppKit, or fixture state that publishes no change signal,
    /// re-reading it every 10 ms until it holds.
    static func state(_ stage: String, _ condition: @MainActor () async throws -> Bool) async throws {
        while try await !condition() {
            do {
                try await Task.sleep(for: .milliseconds(10))
            } catch {
                Issue.record("Still waiting for \(stage)")
                throw error
            }
        }
    }
}
