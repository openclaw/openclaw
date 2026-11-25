import AppKit
import Foundation
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardDownloadNavigationTests {
    @Test func `blob download opens Save without replacing document`() async throws {
        try await AppKitTestSupport.startApplication()
        // A complete ZIP containing one theme JSON file; opaque bytes must never become document text.
        let bytes = try #require(Data(base64Encoded:
            "UEsDBBQAAAAAAAAAIVyoybtfLQAAAC0AAAAnAAAAZ2hvc3QtY2xhdy10aGVtZS90aGVtZXMvZ2hvc3QtY2xhdy5qc29ueyJuYW1lIjoiR2hvc3QgQ2xhdyIsImJhY2tncm91bmQiOiIjMjAyNDI3In0KUEsBAhQDFAAAAAAAAAAhXKjJu18tAAAALQAAACcAAAAAAAAAAAAAAIABAAAAAGdob3N0LWNsYXctdGhlbWUvdGhlbWVzL2dob3N0LWNsYXcuanNvblBLBQYAAAAAAQABAFUAAAByAAAAAAA="))
        let html = """
        <!doctype html><html><head><title>File download</title>
        <style>body{font:18px system-ui;background:#202427;color:#eee;padding:80px 50px}
        button{font:inherit;padding:12px 24px}p{color:#bbc0c6}</style></head>
        <body><h1>ghost-claw-theme.zip</h1><p>Download the theme archive.</p>
        <button id="download">Download</button><script>
        document.querySelector('button').onclick = () => {
          const bytes = Uint8Array.from(atob('\(bytes.base64EncodedString())'), c => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], {type:'text/plain'}));
          const link = document.createElement('a');
          link.href = url; link.download = 'ghost-claw-theme.zip'; link.click();
          setTimeout(() => URL.revokeObjectURL(url), 0);
        };
        </script></body></html>
        """
        let server = try await DashboardHTTPFixture.start(
            html: html,
            contentSecurityPolicy: "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
        defer { server.stop() }
        let controller = DashboardWindowController(
            url: server.url(), auth: .unauthenticated, websiteDataStore: .nonPersistent(),
            windowAutosaveName: "", requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        controller.show(url: controller.currentURL, auth: controller.auth)
        try await waitForNativeDashboardDocument(controller)
        let proof = ProcessInfo.processInfo.environment["OPENCLAW_DOWNLOAD_PROOF"] == "1"
        if proof { try await Task.sleep(for: .seconds(3)) }
        _ = try await controller.webView.evaluateJavaScript("document.querySelector('button').click()")
        let deadline = ContinuousClock.now.advanced(by: .seconds(5))
        while controller.window?.attachedSheet == nil, ContinuousClock.now < deadline {
            try await Task.sleep(for: .milliseconds(50))
        }
        if proof { try await Task.sleep(for: .seconds(4)) }
        let panel = try #require(
            controller.window?.attachedSheet as? NSSavePanel,
            "Download must present Save instead of navigating to ZIP bytes")
        #expect(panel.nameFieldStringValue == "ghost-claw-theme.zip")
        if proof {
            // The OS hosts Save out of process. A VM UI driver must confirm the real dialog.
            FileHandle.standardOutput.write(Data("DOWNLOAD_PROOF_READY_FOR_SAVE\n".utf8))
            try await TestWait.state("external Save confirmation") {
                controller.window?.attachedSheet == nil && controller.documentHost.downloads.isEmpty
            }
            let destination = try #require(panel.url)
            #expect(try Data(contentsOf: destination) == bytes)
            FileHandle.standardOutput.write(Data("DOWNLOAD_PROOF_BYTES_VERIFIED\n".utf8))
            try? FileManager.default.removeItem(at: destination)
        } else {
            panel.cancel(nil)
            try await TestWait.state("cancelled download") { controller.documentHost.downloads.isEmpty }
        }
        #expect(controller.webView.url == server.url())
        #expect(try await controller.webView
            .evaluateJavaScript("document.querySelector('h1')?.textContent") as? String ==
            "ghost-claw-theme.zip")
        if proof { try await Task.sleep(for: .seconds(4)) }
    }
}
