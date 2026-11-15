#if os(macOS) && canImport(WebKit)
import AppKit
import Foundation
import Observation
import SwiftUI
import Testing
import WebKit
@testable import OpenClawChatUI

@MainActor
struct ChatInlineWidgetLifecycleTests {
    @Test(arguments: [false, true])
    func `retained widget revalidates without losing state and recovers a failure during resolution`(
        replacementAvailable: Bool) async throws
    {
        let fixture = try await WidgetLifecycleFixture()
        defer { fixture.close() }
        await fixture.resolver.waitForRequests(1)
        fixture.resolver.complete(0, with: fixture.resource)
        await waitForObservedState { fixture.loadedWebView != nil }
        let original = try #require(fixture.loadedWebView)
        _ = try await original.evaluateJavaScript("window.widgetCount = 7")

        // A readiness transition restarts the real view task without destroying the row.
        // Swap the resolver too: a retained coordinator must not keep the old callback.
        let oldResolver = fixture.resolver
        fixture.resolver = WidgetResolverProbe()
        await fixture.revalidate()
        fixture.layout()
        #expect(fixture.webView === original)
        #expect(try await original.evaluateJavaScript("window.widgetCount") as? Int == 7)
        #expect(fixture.documentRequestCount == 1)

        original.navigationDelegate?.webView?(
            original, didFailProvisionalNavigation: nil, withError: URLError(.cannotLoadFromNetwork))
        #expect(fixture.resolver.requests.count == 1)
        let updated = OpenClawChatWidgetResource(
            url: fixture.resource.url,
            tlsFingerprintSHA256: nil,
            surfaceRole: .operatorSurface,
            attemptedSurfaceRoles: [.node])
        fixture.resolver.complete(0, with: updated)
        await fixture.resolver.waitForRequests(2)
        let failed = try #require(fixture.resolver.requests[1].failedResource)
        #expect(failed.surfaceRole == .operatorSurface)
        #expect(failed.attemptedSurfaceRoles == [.node])
        #expect(oldResolver.requests.count == 1)

        // Returning the failed document from recovery must not strand a dead page.
        fixture.resolver.complete(1, with: replacementAvailable ? fixture.replacement : updated)
        if replacementAvailable {
            await waitForObservedState { fixture.loadedWebView?.url == fixture.replacement.url }
            #expect(fixture.webView !== original)
            let replacement = try #require(fixture.loadedWebView)
            #expect(try await replacement.evaluateJavaScript("window.widgetCount") as? Int == 0)

            // No task restart this time: updateUIView/updateNSView must refresh the failure callback.
            let previousResolver = fixture.resolver
            fixture.resolver = WidgetResolverProbe()
            fixture.update()
            replacement.navigationDelegate?.webView?(
                replacement, didFailProvisionalNavigation: nil, withError: URLError(.cannotLoadFromNetwork))
            await fixture.resolver.waitForRequests(1)
            #expect(previousResolver.requests.count == 2)
            fixture.resolver.complete(0, with: nil)
            await waitForObservedState { fixture.webView == nil }
        } else {
            await waitForObservedState { fixture.webView == nil }
        }
    }

    @Test(arguments: [WidgetScopeChange.model, .session, .generation])
    func `retained row retires its browser and suspended resolution when the chat owner changes`(
        change: WidgetScopeChange) async throws
    {
        let fixture = try await WidgetLifecycleFixture()
        defer { fixture.close() }
        await fixture.resolver.waitForRequests(1)
        fixture.resolver.complete(0, with: fixture.resource)
        await waitForObservedState { fixture.loadedWebView != nil }
        let original = try #require(fixture.webView)
        await fixture.revalidate()
        #expect(fixture.resolver.requests.count == 2)

        switch change {
        case .model: fixture.modelOwner = NSObject()
        case .session:
            fixture.target = OpenClawChatSessionTarget(sessionKey: "other", agentID: "other-agent")
        case .generation: fixture.sessionGeneration += 1
        }
        fixture.update()
        await fixture.resolver.waitForRequests(3)
        fixture.layout()
        #expect(fixture.webView == nil)
        #expect(original.navigationDelegate == nil)
        // Complete the canceled old-owner lookup last; it cannot restore the old document.
        fixture.resolver.complete(2, with: fixture.replacement)
        await waitForObservedState { fixture.loadedWebView?.url == fixture.replacement.url }
        fixture.resolver.complete(1, with: fixture.resource)
        await waitForObservedState { fixture.resolver.completedCount == 3 }
        fixture.layout()
        #expect(fixture.webView?.url == fixture.replacement.url)
    }

    @Test(arguments: [false, true])
    func `same owner replaces or retires the document after fresh source resolution`(available: Bool) async throws {
        let fixture = try await WidgetLifecycleFixture()
        defer { fixture.close() }
        await fixture.resolver.waitForRequests(1)
        fixture.resolver.complete(0, with: fixture.resource)
        await waitForObservedState { fixture.loadedWebView != nil }
        let original = try #require(fixture.webView)
        await fixture.revalidate()
        fixture.resolver.complete(1, with: available ? fixture.replacement : nil)
        if available {
            await waitForObservedState { fixture.loadedWebView?.url == fixture.replacement.url }
            #expect(fixture.webView !== original)
            #expect(fixture.documentRequestCount == 2)
        } else {
            await waitForObservedState { fixture.webView == nil }
        }
        #expect(original.navigationDelegate == nil)
    }
}

enum WidgetScopeChange: Sendable {
    case model
    case session
    case generation
}

@MainActor
@Observable
private final class WidgetResolverProbe {
    struct Request {
        let path: String
        let failedResource: OpenClawChatWidgetResource?
        var continuation: CheckedContinuation<OpenClawChatWidgetResource?, Never>?
    }

    private(set) var requests: [Request] = []
    private(set) var completedCount = 0

    func resolve(path: String, failedResource: OpenClawChatWidgetResource?) async -> OpenClawChatWidgetResource? {
        let resource = await withCheckedContinuation { continuation in
            self.requests.append(Request(path: path, failedResource: failedResource, continuation: continuation))
        }
        self.completedCount += 1
        return resource
    }

    func waitForRequests(_ count: Int) async {
        await waitForObservedState { self.requests.count >= count }
    }

    func complete(_ index: Int, with resource: OpenClawChatWidgetResource?) {
        let continuation = self.requests[index].continuation
        self.requests[index].continuation = nil
        continuation?.resume(returning: resource)
    }

    func finish() {
        for index in self.requests.indices {
            self.complete(index, with: nil)
        }
    }
}

@MainActor
@Observable
private final class WidgetLifecycleFixture {
    var resolver = WidgetResolverProbe()
    var modelOwner = NSObject()
    var target = OpenClawChatSessionTarget(sessionKey: "main", agentID: nil)
    var sessionGeneration: UInt64 = 0
    private(set) var webView: WKWebView?
    private(set) var loadedWebView: WKWebView?
    private var renderedReady: Bool?
    private var ready = true
    private let server: GatewayHTTPFixture
    let resource: OpenClawChatWidgetResource
    let replacement: OpenClawChatWidgetResource
    private let message: OpenClawChatMessage
    private let host = WidgetLifecycleHost(rootView: AnyView(EmptyView()))
    private let window: NSWindow
    @ObservationIgnored private var titleObservation: NSKeyValueObservation?

    var documentRequestCount: Int {
        self.server.requests.filter { $0.hasPrefix("GET /first") || $0.hasPrefix("GET /second") }.count
    }

    init() async throws {
        _ = NSApplication.shared
        let html = """
        <html><head><script>window.widgetCount = 0</script><title>Widget fixture</title></head>
        <body>Widget</body></html>
        """
        let server = try GatewayHTTPFixture(reply:
            "HTTP/1.1 200 OK\r\nContent-Type: text/html\r\nContent-Length: \(html.utf8.count)\r\n" +
                "Cache-Control: no-store\r\nConnection: close\r\n\r\n" + html)
        let origin: URL
        do {
            origin = try await server.readyURL().deletingLastPathComponent()
        } catch {
            server.stop()
            throw error
        }
        self.server = server
        let firstURL = origin.appendingPathComponent("first.html")
        let secondURL = origin.appendingPathComponent("second.html")
        self.resource = OpenClawChatWidgetResource(url: firstURL)
        self.replacement = OpenClawChatWidgetResource(url: secondURL)
        let preview = OpenClawChatCanvasPreview(
            kind: "canvas", surface: "assistant_message", render: "url", title: "Synthetic widget",
            preferredHeight: 180, url: "/__openclaw__/canvas/documents/fixture/index.html", viewId: nil,
            sandbox: "scripts")
        self.message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "canvas", text: nil, mimeType: nil, fileName: nil, content: nil, preview: preview)],
            timestamp: nil)
        self.window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 400),
            styleMask: [.borderless], backing: .buffered, defer: false)
        self.window.isReleasedWhenClosed = false
        self.host.didLayout = { [weak self] in self?.observeWebView() }
        self.window.contentView = self.host
        self.window.orderFront(nil)
        self.update()
    }

    func update() {
        let resolver = self.resolver
        let ready = self.ready
        self.host.rootView = AnyView(ChatMessageBubble(
            message: self.message,
            style: .standard,
            markdownVariant: .standard,
            userAccent: nil,
            displayOptions: [],
            assistantName: nil,
            assistantAvatarText: nil,
            assistantAvatarTint: nil,
            showsAssistantAvatar: false,
            isClean: false,
            contextWindowTokens: nil,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetScope: ChatInlineWidgetScope(
                modelID: ObjectIdentifier(self.modelOwner),
                sessionTarget: self.target,
                sessionGeneration: self.sessionGeneration),
            inlineWidgetResolverReady: ready,
            inlineWidgetResourceResolver: { path, failed in
                await resolver.resolve(path: path, failedResource: failed)
            },
            mediaArtifactResolverReady: false,
            mediaPlaybackAllowed: { false },
            loadMediaArtifact: { _, _, _ in nil })
            .onChange(of: ready, initial: true) { [weak self] _, value in
                self?.renderedReady = value
            })
        self.layout()
    }

    func revalidate() async {
        self.ready = false
        self.update()
        await waitForObservedState { self.renderedReady == false }
        let requestCount = self.resolver.requests.count
        self.ready = true
        self.update()
        await self.resolver.waitForRequests(requestCount + 1)
    }

    func layout() {
        self.host.layoutSubtreeIfNeeded()
        self.observeWebView()
    }

    func close() {
        self.host.didLayout = nil
        self.host.rootView = AnyView(EmptyView())
        self.window.contentView = nil
        self.window.close()
        self.titleObservation = nil
        self.resolver.finish()
        self.server.stop()
    }

    private func observeWebView() {
        let current = Self.findWebView(in: self.host)
        guard current !== self.webView else { return }
        self.titleObservation = nil
        self.webView = current
        self.loadedWebView = nil
        self.titleObservation = current?.observe(\.title, options: [.initial, .new]) { @Sendable [weak self, weak current] _, _ in
            Task { @MainActor in
                guard let self, let current, self.webView === current else { return }
                if current.title == "Widget fixture" { self.loadedWebView = current }
            }
        }
    }

    private static func findWebView(in view: NSView) -> WKWebView? {
        if let webView = view as? WKWebView { return webView }
        return view.subviews.lazy.compactMap { Self.findWebView(in: $0) }.first
    }
}

@MainActor
private final class WidgetLifecycleHost: NSHostingView<AnyView> {
    var didLayout: (() -> Void)?

    override func layout() {
        super.layout()
        self.didLayout?()
    }
}
#endif
