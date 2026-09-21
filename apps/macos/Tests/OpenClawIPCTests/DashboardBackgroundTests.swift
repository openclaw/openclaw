import AppKit
import Testing
import WebKit
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct DashboardBackgroundTests {
    @Test(arguments: [NSAppearance.Name.aqua, .darkAqua])
    func `unstyled dashboard reveals native canvas and preserves page backgrounds`(
        appearance: NSAppearance.Name) async throws
    {
        let server = try await DashboardHTTPFixture.start(
            html: "<!doctype html><html><head></head><body></body></html>",
            contentSecurityPolicy: "default-src 'none'; style-src 'unsafe-inline'")
        defer { server.stop() }
        let auth = DashboardWindowAuth(gatewayUrl: nil, token: nil, password: nil)
        let controller = DashboardWindowController(
            url: server.url(),
            auth: auth,
            websiteDataStore: .nonPersistent(),
            windowAutosaveName: "",
            requestBrowserProfileImportOffer: { _ in false })
        defer { controller.closeDashboard() }
        let window = try #require(controller.window)
        window.appearance = NSAppearance(named: appearance)
        controller.show(url: server.url(), auth: auth)
        let deadline = ContinuousClock.now + .seconds(5)
        while controller.webView.isLoading || !controller.canDeliverNativeCommands {
            guard ContinuousClock.now < deadline else { throw URLError(.timedOut) }
            try await Task.sleep(for: .milliseconds(10))
        }

        // Freeze the unstyled stage: an opaque white pixel here flashes before
        // the Control UI's inline theme can paint, even in a dark native window.
        let unstyled = try await Self.centerPixel(controller.webView)
        #expect(unstyled.alphaComponent < 0.01)

        // Preloaded dashboards can be hidden; snapshots must not wait for animation frames.
        window.orderOut(nil)
        // Black and white are invariant under the snapshot's display color profile.
        for (css, expected) in [("black", 0.0), ("white", 1.0)] {
            _ = try await controller.webView.callAsyncJavaScript(
                "document.documentElement.style.background = color;",
                arguments: ["color": css],
                in: nil,
                contentWorld: .page)
            let painted = try await Self.centerPixel(controller.webView)
            #expect(painted.alphaComponent > 0.99)
            #expect(abs(painted.redComponent - expected) < 0.01)
            #expect(abs(painted.greenComponent - expected) < 0.01)
            #expect(abs(painted.blueComponent - expected) < 0.01)
        }
    }

    private static func centerPixel(_ webView: WKWebView) async throws -> NSColor {
        let image = try await webView.takeSnapshot(configuration: nil)
        let data = try #require(image.tiffRepresentation)
        let bitmap = try #require(NSBitmapImageRep(data: data))
        return try #require(bitmap.colorAt(x: bitmap.pixelsWide / 2, y: bitmap.pixelsHigh / 2)?
            .usingColorSpace(.sRGB))
    }
}
