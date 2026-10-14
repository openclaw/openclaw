import Foundation
import Testing
import WebKit
@testable import OpenClaw

/// Dashboard document waits follow `TestWait`'s deadline-free contract.
@MainActor
enum DashboardTestWait {
    /// Waits until the controller's main document has settled and `condition` holds.
    /// Readiness is re-read on each WKWebView `isLoading` or `url` change. WebKit
    /// publishes those before calling the navigation delegate, and this task resumes
    /// only after that callback returns, so `canDeliverNativeCommands` already
    /// reflects `didFinish`. `condition` must be a fact of the settled document;
    /// page-script effects that land later belong in `TestWait.state(_:_:)`.
    static func document(
        _ controller: DashboardWindowController,
        _ stage: String = "dashboard document",
        sourceLocation: SourceLocation = #_sourceLocation,
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
        """, sourceLocation: sourceLocation)
        throw CancellationError()
    }
}
