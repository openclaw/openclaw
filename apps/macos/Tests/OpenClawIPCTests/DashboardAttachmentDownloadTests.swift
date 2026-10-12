import AppKit
import ApplicationServices
import Darwin
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.testWaitLimit)
@MainActor
struct DashboardAttachmentDownloadTests {
    @Test func `adopted WebKit downloads reject HTTP error bodies before offering Save`() async throws {
        try await AppKitTestSupport.startApplication()
        var requestedStatuses: [Int] = []
        let server = try await DashboardHTTPFixture.start(requestHandler: { request in
            guard let path = request.split(separator: " ").dropFirst().first,
                  path.hasPrefix("/attachment/"), let status = Int(path.split(separator: "/").last ?? "")
            else { return nil }
            requestedStatuses.append(status)
            return Self.response(status: status)
        })
        defer { server.stop() }
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: .zero, configuration: configuration)
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 640, height: 480),
            styleMask: [.titled], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isRestorable = false
        window.contentView = webView
        defer { window.close() }
        let sheets = AttachmentDownloadSheetObserver(window: window)
        defer { sheets.stop() }

        for status in [403, 404, 500] {
            let transfer = DashboardBrowserDownload(window: window, isCurrent: { true })
            defer { transfer.cancel() }
            do {
                _ = try await withCheckedThrowingContinuation { (completion: CheckedContinuation<Bool, any Error>) in
                    // Keep WebKit's real response and transfer. Only its public
                    // start callback is used to reach the adopted-download owner.
                    webView.startDownload(using: URLRequest(url: server.url("/attachment/\(status)"))) { download in
                        Task { @MainActor in
                            do {
                                try await completion.resume(returning: transfer.start(adopting: download))
                            } catch {
                                completion.resume(throwing: error)
                            }
                        }
                    }
                }
                Issue.record("HTTP \(status) must fail before a save destination can be selected")
            } catch {
                let failure = error as NSError
                #expect(failure.domain == NSURLErrorDomain)
                #expect(failure.code == URLError.badServerResponse.rawValue)
            }
            #expect(sheets.savePanelsPresented == 0)
            #expect(window.sheets.isEmpty)
        }
        #expect(requestedStatuses == [403, 404, 500])
    }

    @Test func `Dashboard attachment anchor saves original bytes without replacing its document`() async throws {
        try await AppKitTestSupport.startApplication()
        try #require(AXIsProcessTrusted())
        let filename = "openclaw-attachment-test-\(UUID().uuidString).txt"
        let body = "The original Dashboard attachment bytes."
        let server = try await DashboardHTTPFixture.start(
            html: """
            <!doctype html><body>
            <a id="attachment" href="/attachment/200" download="\(filename)"
               target="_blank" rel="noreferrer">Download</a>
            </body>
            """,
            requestHandler: { request in
                request.hasPrefix("GET /attachment/200 ") ? Self
                    .response(status: 200, body: body, filename: filename) : nil
            })
        defer { server.stop() }
        let auth = DashboardWindowAuth.unauthenticated
        let url = server.url()
        let controller = DashboardWindowController(
            url: url, auth: auth, websiteDataStore: .nonPersistent(),
            windowAutosaveName: "", requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let navigation = AttachmentDownloadNavigationObserver(controller: controller)
        controller.webView.navigationDelegate = navigation
        controller.show(url: url, auth: auth)
        try await DashboardTestWait.document(controller, "attachment source document")
        #expect(controller.canDownloadAttachments)
        let window = try #require(controller.window)
        window.title = filename
        var destination: URL?
        var publication: AttachmentDownloadPublicationObserver?
        let sheets = AttachmentDownloadSheetObserver(window: window) { panel in
            do {
                // Keep the real Save panel and its runner-owned current directory.
                // directoryURL is configuration-only, so do not change it here.
                let directory = try #require(panel.directoryURL)
                let target = directory.appendingPathComponent(filename)
                try #require(!FileManager.default.fileExists(atPath: target.path))
                destination = target
                publication = try AttachmentDownloadPublicationObserver(directory: directory)

            } catch {
                Issue.record(error)
                panel.cancel(nil)
            }
        }
        defer { sheets.stop() }
        defer {
            publication?.stop()
            if let destination { try? FileManager.default.removeItem(at: destination) }
        }
        _ = try await controller.webView.evaluateJavaScript("document.getElementById('attachment').click(); null")
        try await navigation.changed.wait("Dashboard WebKit download conversion") { navigation.downloads == 1 }
        try await sheets.changed.wait("Dashboard Save panel") { sheets.savePanelsPresented == 1 }
        // The remote Save panel does not implement NSSavePanel.ok on macOS 27.
        // Read the self-owned AX tree on the main actor and press the real control.
        try await TestWait.state("native Save control") { Self.pressNativeSave(windowTitle: filename) }
        let saved = try #require(destination)
        let published = try #require(publication)
        try await published.changed.wait("Dashboard attachment publication") {
            FileManager.default.fileExists(atPath: saved.path)
        }
        #expect(try Data(contentsOf: saved) == Data(body.utf8))
        #expect(controller.webView.url == url)
        #expect(!controller.isShowingFailurePage)
        #expect(try await controller.webView.evaluateJavaScript(
            "document.getElementById('attachment') !== null") as? Bool == true)
        controller.closeDashboard()
        #expect(sheets.savePanelsPresented == 1)
    }

    @Test func `attachment admission requires a trusted main-frame source and a supported destination`() throws {
        let dashboard = try #require(URL(string: "https://gateway.example/control/"))
        let trusted = try #require(URL(string: "https://gateway.example/control/chat"))
        for destination in [
            "https://gateway.example/api/chat/media/file", "https://cdn.example/file", "http://cdn.example/file",
            "blob:https://gateway.example/fixture", "data:text/plain,fixture",
        ] {
            let url = try #require(URL(string: destination))
            #expect(ControlUIDocumentHost.shouldAllowAttachmentDownload(
                to: url, sourceURL: trusted, sourceIsMainFrame: true, dashboardURL: dashboard))
            #expect(!ControlUIDocumentHost.shouldAllowAttachmentDownload(
                to: url, sourceURL: trusted, sourceIsMainFrame: false, dashboardURL: dashboard))
        }
        for destination in [
            "file:///tmp/attachment",
            "javascript:void(0)",
            "mailto:someone@example.com",
            "https://user:password@gateway.example/file",
        ] {
            #expect(!ControlUIDocumentHost.shouldAllowAttachmentDownload(
                to: URL(string: destination), sourceURL: trusted, sourceIsMainFrame: true, dashboardURL: dashboard))
        }
        for source in [
            nil,
            URL(string: "https://other.example/control/chat"),
            URL(string: "https://gateway.example/outside/chat"),
        ] {
            #expect(!ControlUIDocumentHost.shouldAllowAttachmentDownload(
                to: URL(string: "https://gateway.example/file"), sourceURL: source,
                sourceIsMainFrame: true, dashboardURL: dashboard))
        }
    }

    @Test func `response conversion recognizes attachment disposition without downloading ordinary pages`() throws {
        let url = try #require(URL(string: "https://gateway.example/attachment"))
        for disposition in ["attachment", "Attachment; filename=fixture.txt", " attachment ; filename=fixture.txt"] {
            let response = try #require(HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Disposition": disposition]))
            #expect(ControlUIDocumentHost.shouldDownloadAttachmentResponse(response, canShowMIMEType: true))
        }
        for disposition in ["inline; filename=fixture.txt", "not-attachment", ""] {
            let response = try #require(HTTPURLResponse(
                url: url, statusCode: 200, httpVersion: "HTTP/1.1", headerFields: ["Content-Disposition": disposition]))
            #expect(!ControlUIDocumentHost.shouldDownloadAttachmentResponse(response, canShowMIMEType: true))
            #expect(ControlUIDocumentHost.shouldDownloadAttachmentResponse(response, canShowMIMEType: false))
        }
        for address in ["blob:https://gateway.example/fixture", "data:text/plain,fixture"] {
            let response = try URLResponse(
                url: #require(URL(string: address)), mimeType: nil, expectedContentLength: 0, textEncodingName: nil)
            #expect(ControlUIDocumentHost.shouldDownloadAttachmentResponse(response, canShowMIMEType: false))
        }
        let file = try URLResponse(
            url: #require(URL(string: "file:///tmp/attachment")), mimeType: nil,
            expectedContentLength: 0, textEncodingName: nil)
        #expect(!ControlUIDocumentHost.shouldDownloadAttachmentResponse(file, canShowMIMEType: false))
    }

    private static func response(
        status: Int,
        body: String = "This is an HTTP error, not the attachment.",
        filename: String = "attachment.txt") -> String
    {
        [
            "HTTP/1.1 \(status) \(status == 200 ? "OK" : "Error")", "Content-Type: application/octet-stream",
            "Content-Disposition: attachment; filename=\(filename)",
            "Content-Length: \(body.utf8.count)", "Connection: close", "", body,
        ].joined(separator: "\r\n")
    }

    private static func pressNativeSave(windowTitle: String) -> Bool {
        func value(_ element: AXUIElement, _ key: String) -> CFTypeRef? {
            var result: CFTypeRef?
            guard AXUIElementCopyAttributeValue(element, key as CFString, &result) == .success else { return nil }
            return result
        }
        func press(_ element: AXUIElement, depth: Int) -> Bool {
            guard depth < 20 else { return false }
            if value(element, kAXRoleAttribute) as? String == kAXButtonRole,
               value(element, kAXTitleAttribute) as? String == "Save",
               value(element, kAXEnabledAttribute) as? Bool == true
            {
                return AXUIElementPerformAction(element, kAXPressAction as CFString) == .success
            }
            return (value(element, kAXChildrenAttribute) as? [AXUIElement] ?? [])
                .contains { press($0, depth: depth + 1) }
        }
        let app = AXUIElementCreateApplication(ProcessInfo.processInfo.processIdentifier)
        guard let windows = value(app, kAXWindowsAttribute) as? [AXUIElement],
              let window = windows.first(where: { value($0, kAXTitleAttribute) as? String == windowTitle })
        else { return false }
        return press(window, depth: 0)
    }
}

/// HTTP-error cases cancel a forbidden Save sheet instead of waiting for a user.
/// The successful source-flow case supplies a test-owned filename and presses Save.
@MainActor
private final class AttachmentDownloadSheetObserver {
    private var observation: NSObjectProtocol?
    let changed = AsyncTestSignal()
    private(set) var savePanelsPresented = 0

    init(window: NSWindow, perform: @escaping @MainActor (NSSavePanel) -> Void = { $0.cancel(nil) }) {
        self.observation = NotificationCenter.default.addObserver(
            forName: NSWindow.willBeginSheetNotification, object: window, queue: .main)
        { [weak self, weak window] _ in
            // AppKit announces the transition before installing attachedSheet.
            Task { @MainActor [weak self, weak window] in
                guard let panel = window?.attachedSheet as? NSSavePanel else { return }
                self?.savePanelsPresented += 1
                perform(panel)
                self?.changed.notify()
            }
        }
    }

    func stop() {
        if let observation { NotificationCenter.default.removeObserver(observation) }
        self.observation = nil
    }
}

/// Publication is a directory change, not a timer or a second transport request.
@MainActor
private final class AttachmentDownloadPublicationObserver {
    let changed = AsyncTestSignal()
    private let source: any DispatchSourceFileSystemObject

    init(directory: URL) throws {
        let descriptor = Darwin.open(directory.path, O_EVTONLY)
        guard descriptor >= 0 else { throw POSIXError(POSIXErrorCode(rawValue: errno) ?? .EIO) }
        self.source = DispatchSource.makeFileSystemObjectSource(
            fileDescriptor: descriptor, eventMask: .write, queue: .main)
        self.source.setEventHandler { [changed = self.changed] in changed.notify() }
        self.source.setCancelHandler { Darwin.close(descriptor) }
        self.source.resume()
    }

    func stop() {
        self.source.cancel()
    }
}

/// Observe actual WebKit conversion while forwarding every relevant event to
/// the production controller, including its document readiness and admission.
@MainActor
private final class AttachmentDownloadNavigationObserver: NSObject, WKNavigationDelegate {
    let controller: DashboardWindowController
    let changed = AsyncTestSignal()
    private(set) var downloads = 0

    init(controller: DashboardWindowController) {
        self.controller = controller
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationActionPolicy) -> Void)
    {
        self.controller.webView(webView, decidePolicyFor: navigationAction, decisionHandler: decisionHandler)
    }

    func webView(
        _ webView: WKWebView, decidePolicyFor navigationResponse: WKNavigationResponse,
        decisionHandler: @escaping @MainActor @Sendable (WKNavigationResponsePolicy) -> Void)
    {
        self.controller.webView(webView, decidePolicyFor: navigationResponse, decisionHandler: decisionHandler)
    }

    func webView(_ webView: WKWebView, didCommit navigation: WKNavigation!) {
        self.controller.webView(webView, didCommit: navigation)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        self.controller.webView(webView, didFinish: navigation)
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        self.controller.webView(webView, didFailProvisionalNavigation: navigation, withError: error)
        self.changed.notify()
    }

    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        self.controller.webView(webView, navigationAction: navigationAction, didBecome: download)
        self.downloads += 1
        self.changed.notify()
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        self.controller.webView(webView, navigationResponse: navigationResponse, didBecome: download)
        self.downloads += 1
        self.changed.notify()
    }
}
