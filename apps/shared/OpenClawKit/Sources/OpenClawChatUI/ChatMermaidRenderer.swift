#if canImport(WebKit) && (os(iOS) || os(macOS))
import Foundation
import WebKit
#if os(macOS)
import AppKit
#else
import UIKit
#endif

struct ChatMermaidRenderedImage {
    let image: OpenClawPlatformImage
    let svg: String
    let size: CGSize
    let byteCount: Int
}

@MainActor
final class ChatMermaidRenderer: NSObject, WKNavigationDelegate {
    typealias Completion = @MainActor (Result<ChatMermaidRenderedImage, ChatMermaidFailure>) -> Void

    static let shared = ChatMermaidRenderer()

    private final class Job {
        enum Phase { case loading, rendering, snapshot }

        let id = UUID()
        let startedAt = ProcessInfo.processInfo.systemUptime
        let request: ChatMermaidRequest
        var completions: [UUID: Completion]
        var phase = Phase.loading

        init(request: ChatMermaidRequest, token: UUID, completion: @escaping Completion) {
            self.request = request
            self.completions = [token: completion]
        }
    }

    private static let bridgeName = "ChatMermaidBridge"
    private static let maximumQueued = 32
    private static let maximumSubscribers = 128
    private static let maximumCacheEntries = 32
    private static let maximumCacheBytes = 12 * 1024 * 1024

    private var cache: [ChatMermaidRequest: ChatMermaidRenderedImage] = [:]
    private var cacheBytes = 0
    private var queued: [Job] = []
    private var active: Job?
    private var timeout: Task<Void, Never>?
    private var webView: WKWebView?
    private var documentReady = false
    #if DEBUG
    private var traceDocumentID: UUID?
    #endif

    override init() {
        super.init()
        #if os(iOS)
        NotificationCenter.default.addObserver(
            self,
            selector: #selector(self.removeCachedImages),
            name: UIApplication.didReceiveMemoryWarningNotification,
            object: nil)
        #endif
    }

    @discardableResult
    func render(_ request: ChatMermaidRequest, completion: @escaping Completion) -> UUID? {
        guard request.isValid else {
            completion(.failure(.invalidRequest))
            return nil
        }
        if let cached = self.cache[request] {
            completion(.success(cached))
            return nil
        }
        let subscribers = (self.active?.completions.count ?? 0) +
            self.queued.reduce(0) { $0 + $1.completions.count }
        guard subscribers < Self.maximumSubscribers else {
            completion(.failure(.busy))
            return nil
        }
        let token = UUID()
        if let job = self.active?.request == request ? self.active : self.queued
            .first(where: { $0.request == request })
        {
            job.completions[token] = completion
            self.trace("coalesced", job: job)
        } else {
            guard self.queued.count < Self.maximumQueued else {
                completion(.failure(.busy))
                return nil
            }
            let job = Job(request: request, token: token, completion: completion)
            self.queued.append(job)
            self.trace("queued", job: job)
            self.pump()
        }
        return token
    }

    func cancel(_ token: UUID) {
        self.queued.forEach { $0.completions.removeValue(forKey: token) }
        self.queued.removeAll { $0.completions.isEmpty }
        guard let active = self.active else { return }
        if active.completions.removeValue(forKey: token) != nil {
            self.trace("subscriber-canceled", job: active)
        }
        guard active.completions.isEmpty else { return }
        self.trace("canceled", job: active)
        // Loading has not injected request-specific JavaScript. Let the next job
        // reuse initialization; retire running scripts so they cannot repaint it.
        if active.phase != .loading { self.retireDocument() }
        self.finish(active, result: .failure(.unavailable))
    }

    @objc private func removeCachedImages() {
        self.cache.removeAll(keepingCapacity: true)
        self.cacheBytes = 0
        if self.active == nil { self.retireDocument() }
    }

    private func pump() {
        guard self.active == nil, !self.queued.isEmpty else { return }
        let job = self.queued.removeFirst()
        self.active = job
        self.trace("started", job: job)
        do {
            try self.prepareDocument(width: job.request.width)
        } catch {
            self.trace("prepare-failed", job: job, error: error)
            self.finish(job, result: .failure(.unavailable))
            return
        }
        // Native cancellation can replace WebKit even if synchronous diagram
        // layout prevents the JavaScript watchdog from running.
        self.timeout = Task { [weak self, weak job] in
            do { try await Task.sleep(for: .seconds(20)) } catch { return }
            guard let self, let job, self.active === job else { return }
            self.trace("watchdog-expired", job: job)
            self.retireDocument()
            self.finish(job, result: .failure(.timedOut))
        }
        self.start(job)
    }

    private func prepareDocument(width: Int) throws {
        guard self.webView == nil else { return }
        guard let directory = ChatMermaidResources.directory() else { throw ChatMermaidFailure.unavailable }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.defaultWebpagePreferences.allowsContentJavaScript = true
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        let handler = try ChatMermaidSchemeHandler(directory: directory)
        configuration.setURLSchemeHandler(handler, forURLScheme: ChatMermaidResources.scheme)
        configuration.userContentController.add(Bridge(owner: self), contentWorld: .page, name: Self.bridgeName)
        let webView = WKWebView(frame: CGRect(x: 0, y: 0, width: width, height: 1), configuration: configuration)
        webView.navigationDelegate = self
        webView.allowsLinkPreview = false
        #if os(iOS)
        webView.isOpaque = false
        webView.backgroundColor = .clear
        webView.scrollView.isScrollEnabled = false
        #endif
        self.documentReady = false
        self.webView = webView
        #if DEBUG
        self.traceDocumentID = handler.traceDocumentID
        #endif
        self.trace("document-created")
        webView.load(URLRequest(url: ChatMermaidResources.documentURL))
    }

    private func start(_ job: Job) {
        guard self.active === job, self.documentReady, job.phase == .loading,
              let webView = self.webView
        else { return }
        self.layout(webView, size: CGSize(width: job.request.width, height: 1))
        job.phase = .rendering
        self.trace("javascript-started", job: job)
        #if DEBUG
        // Return only an entry timestamp; keep the render promise's existing lifetime.
        let functionBody = if ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode") {
            "const enteredAtMs = Date.now(); void window.renderMermaid(job); return enteredAtMs;"
        } else {
            "void window.renderMermaid(job);"
        }
        #else
        let functionBody = "void window.renderMermaid(job);"
        #endif
        webView.callAsyncJavaScript(
            functionBody,
            arguments: ["job": job.request.arguments(id: job.id)],
            in: nil,
            in: .page)
        { [weak self, weak webView, weak job] result in
            guard let self, let webView, let job, self.isCurrent(job, webView: webView)
            else { return }
            switch result {
            case let .success(value):
                self.trace("javascript-returned", job: job, javascriptEnteredAtMs: value as? Double)
            case let .failure(error):
                self.trace("javascript-failed", job: job, error: error)
                self.retireDocument()
                self.finish(job, result: .failure(.unavailable))
            }
        }
    }

    private func receive(_ message: WKScriptMessage) {
        if message.webView === self.webView { self.trace("bridge-received") }
        // WebKit exposes handlers to all frames. Accept results only from the
        // exact current top-level document; the opaque diagram frame has no authority.
        guard message.name == Self.bridgeName, message.world == .page,
              message.frameInfo.isMainFrame,
              message.frameInfo.request.url == ChatMermaidResources.documentURL,
              let webView = self.webView, message.webView === webView,
              let job = self.active, job.phase == .rendering,
              self.isCurrent(job, webView: webView), let body = message.body as? String
        else {
            if message.webView === self.webView { self.trace("bridge-context-rejected") }
            return
        }
        do {
            guard let response = try ChatMermaidResponse(body: body, expectedID: job.id, request: job.request) else {
                self.trace("bridge-job-rejected", job: job)
                return
            }
            job.phase = .snapshot
            self.trace("bridge-succeeded", job: job)
            self.capture(response, for: job, webView: webView)
        } catch let error as ChatMermaidFailure {
            self.trace("bridge-failed", job: job)
            self.finish(job, result: .failure(error))
        } catch {
            self.finish(job, result: .failure(.invalidResult))
        }
    }

    private func capture(_ response: ChatMermaidResponse, for job: Job, webView: WKWebView) {
        self.layout(webView, size: response.size)
        self.trace("snapshot-started", job: job)
        // Snapshot widths are points and WebKit multiplies them by its own
        // device scale. Read that producer fact instead of assuming UIScreen's scale.
        webView.evaluateJavaScript("window.devicePixelRatio") { [weak self, weak webView, weak job] value, error in
            guard let self, let webView, let job, self.isCurrent(job, webView: webView) else { return }
            guard error == nil, let scale = value as? Double, scale.isFinite, scale > 0 else {
                self.trace("scale-failed", job: job, error: error)
                self.retireDocument()
                self.finish(job, result: .failure(.invalidResult))
                return
            }
            let configuration = WKSnapshotConfiguration()
            configuration.rect = CGRect(origin: .zero, size: response.size)
            configuration.snapshotWidth = NSNumber(value: response.size.width * job.request.displayScale / scale)
            configuration.afterScreenUpdates = true
            webView.takeSnapshot(with: configuration) { [weak self, weak webView, weak job] image, error in
                guard let self, let webView, let job, self.isCurrent(job, webView: webView) else { return }
                guard let image, let byteCount = self.bitmapByteCount(image) else {
                    self.trace("snapshot-failed", job: job, error: error)
                    self.finish(job, result: .failure(.unavailable))
                    return
                }
                self.finish(job, result: .success(ChatMermaidRenderedImage(
                    image: image,
                    svg: response.svg,
                    size: response.size,
                    byteCount: byteCount + response.svg.utf8.count + job.request.source.utf8.count)))
            }
        }
    }

    private func bitmapByteCount(_ image: OpenClawPlatformImage) -> Int? {
        #if os(macOS)
        var proposed = CGRect(origin: .zero, size: image.size)
        guard let bitmap = image.cgImage(forProposedRect: &proposed, context: nil, hints: nil) else { return nil }
        #else
        guard let bitmap = image.cgImage else { return nil }
        #endif
        guard ChatMermaidResponse.isSafeBitmap(
            size: CGSize(width: bitmap.width, height: bitmap.height), scale: 1)
        else { return nil }
        return bitmap.bytesPerRow * bitmap.height
    }

    private func layout(_ webView: WKWebView, size: CGSize) {
        webView.frame = CGRect(origin: .zero, size: size)
        #if os(macOS)
        webView.layoutSubtreeIfNeeded()
        #else
        webView.layoutIfNeeded()
        webView.scrollView.contentOffset = .zero
        #endif
    }

    private func isCurrent(_ job: Job, webView: WKWebView) -> Bool {
        self.active === job && self.webView === webView && webView.url == ChatMermaidResources.documentURL
    }

    private func finish(_ job: Job, result: Result<ChatMermaidRenderedImage, ChatMermaidFailure>) {
        guard self.active === job else { return }
        switch result {
        case .success: self.trace("finished-success", job: job)
        case let .failure(failure):
            let reason: String = switch failure {
            case .invalidRequest: "invalid-request"
            case .busy: "busy"
            case .unavailable: "unavailable"
            case .timedOut: "timed-out"
            case .invalidResult: "invalid-result"
            case .tooLarge: "too-large"
            case let .rendering(message, retryable):
                switch message {
                case "Mermaid renderer could not be loaded.": "frame-load-timed-out"
                case "Mermaid diagram rendering timed out.": "frame-render-timed-out"
                case "Diagram image timed out.": "image-decode-timed-out"
                default: retryable ? "rendering-transient" : "rendering-invalid"
                }
            }
            self.trace("finished-\(reason)", job: job)
        }
        self.timeout?.cancel()
        self.timeout = nil
        self.active = nil
        if case let .success(image) = result, image.byteCount <= Self.maximumCacheBytes {
            if self.cache.count >= Self.maximumCacheEntries || self.cacheBytes + image.byteCount > Self
                .maximumCacheBytes
            {
                self.cache.removeAll(keepingCapacity: true)
                self.cacheBytes = 0
            }
            self.cache[job.request] = image
            self.cacheBytes += image.byteCount
        }
        let completions = Array(job.completions.values)
        job.completions.removeAll()
        completions.forEach { $0(result) }
        self.pump()
    }

    private func retireDocument() {
        self.documentReady = false
        guard let webView = self.webView else { return }
        self.webView = nil
        #if DEBUG
        self.traceDocumentID = nil
        #endif
        webView.navigationDelegate = nil
        webView.configuration.userContentController.removeScriptMessageHandler(
            forName: Self.bridgeName,
            contentWorld: .page)
        webView.stopLoading()
    }

    func webView(_ webView: WKWebView, didFinish _: WKNavigation!) {
        guard self.webView === webView, webView.url == ChatMermaidResources.documentURL else { return }
        self.documentReady = true
        self.trace("document-finished")
        if let active = self.active { self.start(active) }
    }

    func webView(
        _ webView: WKWebView,
        decidePolicyFor action: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        let isMainDocument = action.targetFrame?.isMainFrame == true &&
            action.request.url == ChatMermaidResources.documentURL && !self.documentReady
        let isOpaqueFrame = action.targetFrame?.isMainFrame == false &&
            action.request.url?.absoluteString == "about:srcdoc"
        let allowed = self.webView === webView && (isMainDocument || isOpaqueFrame)
        if !allowed { self.trace("navigation-rejected") }
        decisionHandler(allowed ? .allow : .cancel)
    }

    func webView(_ webView: WKWebView, didStartProvisionalNavigation _: WKNavigation!) {
        if self.webView === webView { self.trace("document-started") }
    }

    func webView(_ webView: WKWebView, didCommit _: WKNavigation!) {
        if self.webView === webView { self.trace("document-committed") }
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: any Error) {
        if self.webView === webView { self.trace("provisional-navigation-failed", error: error) }
        self.documentFailed(webView)
    }

    func webView(_ webView: WKWebView, didFail _: WKNavigation!, withError error: any Error) {
        if self.webView === webView { self.trace("navigation-failed", error: error) }
        self.documentFailed(webView)
    }

    func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
        if self.webView === webView { self.trace("web-content-terminated") }
        self.documentFailed(webView)
    }

    private func documentFailed(_ webView: WKWebView) {
        guard self.webView === webView else { return }
        let active = self.active
        self.retireDocument()
        if let active { self.finish(active, result: .failure(.unavailable)) }
    }

    /// Temporary incident trace for Debug screenshot fixtures; never retain diagram content or error descriptions.
    private func trace(
        _ event: String,
        job: Job? = nil,
        error: (any Error)? = nil,
        javascriptEnteredAtMs: Double? = nil)
    {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode"),
              let job = job ?? self.active
        else { return }
        var record: [String: Any] = [
            "event": event, "job": job.id.uuidString,
            "elapsedMs": Int((ProcessInfo.processInfo.systemUptime - job.startedAt) * 1000),
            "phase": String(describing: job.phase), "width": job.request.width,
            "displayScale": job.request.displayScale,
            "queued": self.queued.count, "subscribers": job.completions.count,
            "documentReady": self.documentReady,
        ]
        if let traceDocumentID { record["document"] = traceDocumentID.uuidString }
        if let javascriptEnteredAtMs { record["javascriptEnteredAtMs"] = javascriptEnteredAtMs }
        if let error = error as NSError? {
            record["errorCode"] = error.code
            switch error.domain {
            case WKError.errorDomain: record["errorDomain"] = "webkit"
            case NSURLErrorDomain: record["errorDomain"] = "url"
            case NSCocoaErrorDomain: record["errorDomain"] = "cocoa"
            default: record["errorDomain"] = "other"
            }
        }
        ChatMermaidTrace.write(record)
        #endif
    }

    @MainActor
    private final class Bridge: NSObject, WKScriptMessageHandler {
        private weak var owner: ChatMermaidRenderer?

        init(owner: ChatMermaidRenderer) {
            self.owner = owner
        }

        func userContentController(_: WKUserContentController, didReceive message: WKScriptMessage) {
            self.owner?.receive(message)
        }
    }
}
#endif
