import AppKit
import SwiftUI
import Testing
import WebKit
@testable import OpenClaw

/// Opt-in real SwiftUI/WebKit renders with synthetic removal data, never a live enrollment.
@MainActor
struct OpenClawIDRemovalRenderTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_ONBOARDING_RENDER_DIR"] != nil))
    func `removal recovery screens render`() async throws {
        let output = try OnboardingRenderTests.outputDirectory()
        let suite = "ocid-removal-render-\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        defer { defaults.removePersistentDomain(forName: suite) }
        let model = OpenClawIDSettingsModel(store: MacOpenClawIDDeviceStore(
            defaults: defaults, databaseURL: output.appendingPathComponent("unused.sqlite")))
        let removal = MacOpenClawIDRemoval(hostname: "studio.example.test", origin: .here)
        for (name, note) in [("3-settings-removed", Optional(removal)), ("4-settings-sign-in", nil)] {
            try OnboardingRenderTests.capture(
                Form {
                    Section("Status") { LabeledContent("Gateway", value: "Not connected") }
                    OpenClawIDSettingsSection(presentation: .signIn(removal: note), model: model)
                    Section("Gateway") { LabeledContent("Mode", value: "Not configured") }
                }.formStyle(.grouped),
                name: name,
                label: "Real SwiftUI · fixture data · not live",
                output: output,
                width: 720,
                dark: false)
        }
        for (name, origin) in [
            ("1-dashboard-removed-here", MacOpenClawIDRemoval.Origin.here),
            ("2-dashboard-removed-elsewhere", .elsewhere),
        ] {
            let configuration = WKWebViewConfiguration()
            configuration.websiteDataStore = .nonPersistent()
            let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 1000, height: 700), configuration: configuration)
            webView.appearance = NSAppearance(named: .aqua)
            let loaded = LoadedPage()
            webView.navigationDelegate = loaded
            let window = NSWindow(contentRect: webView.frame, styleMask: [], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            window.contentView = webView
            defer {
                webView.stopLoading()
                webView.navigationDelegate = nil
                window.contentView = nil
                window.close()
            }
            let removal = MacOpenClawIDRemoval(hostname: "studio.example.test", origin: origin)
            try await loaded.load(DashboardFailurePage.html(removal: removal), into: webView)
            let image = try await webView.takeSnapshot(configuration: nil)
            let bitmap = try #require(image.tiffRepresentation.flatMap(NSBitmapImageRep.init(data:)))
            try #require(bitmap.representation(using: .png, properties: [:]))
                .write(to: output.appendingPathComponent("\(name).png"))
        }
    }
}

@MainActor
private final class LoadedPage: NSObject, WKNavigationDelegate {
    private var continuation: CheckedContinuation<Void, Error>?

    func load(_ html: String, into webView: WKWebView) async throws {
        try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            webView.loadHTMLString(html, baseURL: nil)
        }
    }

    func webView(_: WKWebView, didFinish _: WKNavigation!) {
        self.continuation?.resume()
        self.continuation = nil
    }

    func webView(_: WKWebView, didFailProvisionalNavigation _: WKNavigation!, withError error: Error) {
        self.continuation?.resume(throwing: error)
        self.continuation = nil
    }
}
