import AppKit
import ConcurrencyExtras
import Foundation
import Testing
import WebKit
@testable import OpenClaw
@testable import OpenClawKit

@Suite(.serialized, .testWaitLimit)
@MainActor
struct DashboardSameEndpointHTTPRecoveryTests {
    @Test func `successful same endpoint reconnect clears failed HTTP document`() async throws {
        _ = AppKitTestSupport.application
        let httpRecovered = LockIsolated(false)
        let html = """
        <!doctype html><html><head><title>Recovered fixture</title>
        <style>html,body{margin:0;background:#f5f6f7;color:#202124;font:18px -apple-system}
        main{margin:100px 70px;padding:36px;background:white;border-radius:16px}
        h1{font-size:28px}p{line-height:1.6}</style></head><body><main>
        <h1 id="recovered">Synthetic dashboard restored</h1>
        <p>The same loopback endpoint now returns HTTP 200.</p>
        <p>The native connection recovered without a manual reload.</p>
        <p>Parallels native boundary fixture · no production Gateway or account</p>
        </main></body></html>
        """
        let server = try await DashboardHTTPFixture.start(requestHandler: { _ in
            let recovered = httpRecovered.value
            let body = recovered ? html : "Synthetic Gateway unavailable"
            return [
                recovered ? "HTTP/1.1 200 OK" : "HTTP/1.1 503 Service Unavailable",
                "Content-Type: \(recovered ? "text/html" : "text/plain"); charset=utf-8",
                "Content-Length: \(body.utf8.count)",
                "Cache-Control: no-store", "Connection: close",
                "Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'",
            ].joined(separator: "\r\n") + "\r\n\r\n" + body
        })
        defer { server.stop() }
        let endpoint = GatewayConnection.EndpointSnapshot(
            config: (server.websocketURL(), "synthetic-owner-token", nil),
            routeAuthority: nil,
            revision: 0)
        let source = GatewayConnectionEndpointSource(endpoint: endpoint)
        let fixture = try DashboardIdentityFixture(announcement: nil, source: source)
        let control = ControlChannel(gateway: fixture.connection, endpointRevision: { 0 })
        let endpointState = GatewayEndpointState.ready(
            mode: .remote,
            url: endpoint.config.url,
            token: endpoint.config.token,
            password: nil,
            routeRevision: 0)
        let manager = DashboardManager._testMake(
            connectionProvider: { _ in fixture.connection },
            browserIdentityURLProvider: nil,
            endpointStateProvider: { endpointState },
            automaticGatewayProfileRefreshEnabled: false,
            primaryEndpointProvider: { _ in endpoint })
        let controller = DashboardWindowController(
            url: server.url(),
            auth: .nativeDevice(
                gatewayUrl: server.websocketURL().absoluteString,
                token: endpoint.config.token,
                password: nil,
                legacyCredentials: [:]),
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        manager._testSetController(controller)
        let result: Result<Void, Error>
        do {
            _ = try await fixture.connection.request(method: "health", params: nil)
            try await TestWait.observed("initial native authenticated connection") { control.state == .connected }
            controller.show(url: server.url(), auth: controller.auth)
            try await TestWait.state("actual WebKit HTTP 503 failure document") {
                guard controller.isShowingFailurePage, !controller.webView.isLoading else { return false }
                let text = try? await controller.webView.evaluateJavaScript("document.body.innerText") as? String
                return text?.contains("HTTP 503") == true
            }
            try await Self.capture(controller.webView, name: "dashboard-reconnect-before")
            httpRecovered.setValue(true)
            // Verify the exact same HTTP endpoint now serves usable content before reconnecting.
            let session = URLSession(configuration: .ephemeral)
            let (data, response) = try await session.data(from: server.url())
            session.invalidateAndCancel()
            try #require((response as? HTTPURLResponse)?.statusCode == 200)
            try #require(String(bytes: data, encoding: .utf8) == html)
            let previousLease = try #require(await fixture.connection.captureServerLease())
            try await fixture.reconnect(announcement: nil)
            try await TestWait.observed("native authenticated reconnect") { control.state == .connected }
            let nextLease = try #require(await fixture.connection.captureServerLease())
            try #require(previousLease.socketGeneration != nextLease.socketGeneration)
            await manager._testHandleControlChannelStateChange(control.state)
            let current = try #require(manager._testController())
            #expect(current.currentURL == server.url())
            #expect(
                !current.isShowingFailurePage,
                "Native reconnect succeeded and HTTP is 200, but failure page remains")
            if !current.isShowingFailurePage {
                try await DashboardTestWait.document(current, "recovered document")
                #expect(try await current.webView
                    .evaluateJavaScript("document.getElementById('recovered')?.textContent")
                    as? String == "Synthetic dashboard restored")
            }
            try await Self.capture(current.webView, name: "dashboard-reconnect-after")
            // Repeated readiness must preserve a recovered document and its unsent draft.
            if !current.isShowingFailurePage {
                _ = try await current.webView.evaluateJavaScript("window.unsentDraft = 'Keep my draft'")
                await manager._testHandleControlChannelStateChange(.connected)
                try await DashboardTestWait.document(current, "preserved recovered document")
                #expect(try await current.webView
                    .evaluateJavaScript("window.unsentDraft") as? String == "Keep my draft")
            }
            result = .success(())
        } catch { result = .failure(error) }
        manager.close()
        await control.disconnect()
        await fixture.connection.shutdown()
        NSWindow.removeFrame(usingName: manager.mainWindowAutosaveName)
        try result.get()
    }

    private static func capture(_ webView: WKWebView, name: String) async throws {
        guard let directory = ProcessInfo.processInfo.environment["OPENCLAW_TEST_MENU_CAPTURE_DIR"] else { return }
        let configuration = WKSnapshotConfiguration()
        configuration.afterScreenUpdates = true
        let image = try await webView.takeSnapshot(configuration: configuration)
        let tiff = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: tiff))
        let png = try #require(bitmap.representation(using: .png, properties: [:]))
        try png.write(to: URL(fileURLWithPath: directory).appendingPathComponent("\(name)-window.png"))
    }
}
