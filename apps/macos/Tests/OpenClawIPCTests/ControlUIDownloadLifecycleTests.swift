import AppKit
import CryptoKit
import Foundation
import OpenClawKit
import Security
import Testing
import WebKit
@testable import OpenClaw

/// Run only in the disposable macOS runner: these tests own real WebKit views and Save sheets.
@Suite(.serialized, .testWaitLimit)
@MainActor
struct ControlUIDownloadLifecycleTests {
    @Test(arguments: [false, true])
    func `download links and attachment responses preserve the document`(_ conversation: Bool) async throws {
        try await AppKitTestSupport.startApplication()
        let server = try await Self.server()
        defer { server.stop() }
        let surface = try Self.surface(url: server.url(), conversation: conversation)
        defer { surface.close() }
        try await surface.waitUntilReady()

        for (link, filename) in [
            ("attachment", "attachment.bin"),
            ("unsupported", "unsupported.bin"),
            ("blank", "blank-target.bin"),
        ] {
            let panel = try await surface.download(link)
            #expect(panel.nameFieldStringValue == filename)
            // Acceptance belongs to the external UI proof: Save runs out of process.
            panel.cancel(nil)
            try await TestWait.state("cancelled \(link) download") {
                surface.document.downloads.isEmpty && surface.window.attachedSheet == nil &&
                    surface.document.webView.url == server.url() && !surface.document.webView.isLoading
            }
            #expect(surface.document.webView.url == server.url())
            if let bridge = surface.bridge { #expect(bridge.availability == .ready) }
            #expect(try await surface.document.webView.evaluateJavaScript("document.title") as? String ==
                "Download fixture")
        }
    }

    @Test(arguments: [false, true])
    func `cancel and document replacement discard pending downloads`(_ conversation: Bool) async throws {
        try await AppKitTestSupport.startApplication()
        let server = try await Self.server()
        defer { server.stop() }
        let surface = try Self.surface(url: server.url(), conversation: conversation)
        defer { surface.close() }
        try await surface.waitUntilReady()

        let cancelled = try await surface.download("blank")
        cancelled.cancel(nil)
        try await TestWait.state("cancelled Save sheet and transfer") {
            surface.window.attachedSheet == nil && surface.document.downloads.isEmpty
        }
        #expect(surface.document.webView.url == server.url())

        _ = try await surface.download("attachment")
        let replacement = server.url("/replacement")
        // A WebKit commit, rather than a direct call to the cleanup helper, retires the document.
        surface.document.webView.load(URLRequest(url: replacement))
        try await TestWait.state("replacement document and retired Save sheet") {
            surface.document.webView.url == replacement && !surface.document.webView.isLoading &&
                surface.window.attachedSheet == nil && surface.document.downloads.isEmpty
        }
        #expect(try await surface.document.webView.evaluateJavaScript("document.title") as? String ==
            "Download fixture")
    }

    @Test(arguments: [false, true])
    func `pinned HTTPS downloads use the gateway certificate policy`(_ conversation: Bool) async throws {
        try await AppKitTestSupport.startApplication()
        let tls = try await DashboardTLSFixture()
        let server = try await Self.server(tlsIdentity: tls.identity)
        defer { server.stop() }
        let surface = try Self.surface(url: server.url(), conversation: conversation, tlsParams: GatewayTLSParams(
            required: true,
            expectedFingerprint: SHA256.hash(data: tls.certificate).map { String(format: "%02x", $0) }.joined(),
            allowTOFU: false, storeKey: nil))
        defer { surface.close() }
        try await surface.waitUntilReady()
        let panel = try await surface.download("blank")
        #expect(panel.nameFieldStringValue == "blank-target.bin")
        panel.cancel(nil)
        try await TestWait.state("cancelled HTTPS download") { surface.document.downloads.isEmpty }
        #expect(surface.document.webView.url == server.url())
    }

    @MainActor
    private struct Surface {
        let document: ControlUIDocumentHost
        let window: NSWindow
        let bridge: NativeConversationBridge?
        let close: () -> Void

        func waitUntilReady() async throws {
            try await TestWait.state("download fixture document") {
                guard !self.document.webView.isLoading else { return false }
                return try await self.document.webView
                    .evaluateJavaScript("window.fixtureReady === true") as? Bool == true
            }
            if let bridge {
                try await TestWait.observed("ready native conversation") { bridge.currentDocumentId != nil }
            }
        }

        func download(_ link: String) async throws -> NSSavePanel {
            _ = try await self.document.webView.evaluateJavaScript("document.getElementById('\(link)').click()")
            try await TestWait.state("\(link) Save sheet") { self.window.attachedSheet != nil }
            return try #require(self.window.attachedSheet as? NSSavePanel)
        }
    }

    private static func surface(url: URL, conversation: Bool, tlsParams: GatewayTLSParams? = nil) throws -> Surface {
        if !conversation {
            let controller = DashboardWindowController(
                url: url, auth: .unauthenticated, websiteDataStore: .nonPersistent(), tlsParams: tlsParams,
                windowAutosaveName: "", requestBrowserProfileImportOffer: { _ in false })
            // Keep loopback fixtures independent of the VM's external Safe Browsing service.
            controller.webView.configuration.preferences.isFraudulentWebsiteWarningEnabled = false
            controller.show(url: url, auth: .unauthenticated)
            return try Surface(
                document: controller.documentHost, window: #require(controller.window), bridge: nil,
                close: { controller.closeDashboard() })
        }
        let handler = NativeConversationMessageHandler()
        let document = ControlUIDocumentHost(
            url: url,
            auth: .unauthenticated,
            websiteDataStore: .nonPersistent(),
            tlsParams: tlsParams)
        {
            $0.addScriptMessageHandler(handler, contentWorld: .page, name: NativeConversationContract.handlerName)
        }
        document.webView.configuration.preferences.isFraudulentWebsiteWarningEnabled = false
        let bridge = NativeConversationBridge(document: document)
        handler.owner = bridge
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 800, height: 600),
            styleMask: [.titled, .closable], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = document.webView
        window.makeKeyAndOrderFront(nil)
        bridge.load(url)
        return Surface(document: document, window: window, bridge: bridge, close: {
            bridge.close()
            window.close()
        })
    }

    private static let bytes = Data([0x50, 0x4B, 0x03, 0x04, 0x00, 0xFF, 0x80, 0x0A, 0x00, 0xFE])

    private static func server(tlsIdentity: sec_identity_t? = nil) async throws -> DashboardHTTPFixture {
        try await DashboardHTTPFixture.start(
            html: self.html,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'",
            tlsIdentity: tlsIdentity,
            rawResponseHandler: { request in
                let mime: String
                let disposition: String
                if request.hasPrefix("GET /payload/attachment.bin ") {
                    mime = "text/plain"
                    disposition = "Content-Disposition: attachment; filename=\"attachment.bin\"\r\n"
                } else if request.hasPrefix("GET /payload/unsupported.bin ") {
                    mime = "application/x-openclaw-download-fixture"
                    disposition = ""
                } else if request.hasPrefix("GET /payload/blank.bin ") {
                    mime = "text/plain"
                    disposition = ""
                } else {
                    return nil
                }
                var response = Data((
                    "HTTP/1.1 200 OK\r\nContent-Type: \(mime)\r\n" + disposition +
                        "Content-Length: \(Self.bytes.count)\r\nConnection: close\r\n\r\n").utf8)
                response.append(Self.bytes)
                return DashboardHTTPFixture.RawResponse(data: response)
            })
    }

    private static let html = """
    <!doctype html><html><head><title>Download fixture</title></head><body>
    <a id="blank" href="/payload/blank.bin" download="blank-target.bin" target="_blank">Download file</a>
    <a id="attachment" href="/payload/attachment.bin">Server attachment</a>
    <a id="unsupported" href="/payload/unsupported.bin">Binary file</a>
    <script>
    const conversation = window.webkit?.messageHandlers?.openclawConversation;
    if (conversation) {
      const documentId = crypto.randomUUID();
      Object.defineProperty(window, '__OPENCLAW_NATIVE_CONVERSATION_DOCUMENT__', {
        value: {contract:1, documentId}
      });
      conversation.postMessage({contract:1, documentId, type:'ready', surface:'conversation', capabilities:[]});
    }
    window.fixtureReady = true;
    </script></body></html>
    """
}
