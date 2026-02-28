import OpenClawKit
import Observation
import UIKit
import WebKit

@MainActor
@Observable
final class ScreenController {
    private weak var activeWebView: WKWebView?

    var urlString: String = ""
    var errorText: String?

    /// Callback invoked when an openclaw:// deep link is tapped in the canvas
    var onDeepLink: ((URL) -> Void)?

    /// Callback invoked when the user clicks an A2UI action (e.g. button) inside the canvas web UI.
    var onA2UIAction: (([String: Any]) -> Void)?

    private var debugStatusEnabled: Bool = false
    private var debugStatusTitle: String?
    private var debugStatusSubtitle: String?

    init() {
        self.reload()
    }

    func navigate(to urlString: String) {
        let trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            self.urlString = ""
            self.reload()
            return
        }
        if let url = URL(string: trimmed),
           !url.isFileURL,
           let host = url.host,
           Self.isLoopbackHost(host)
        {
            // Never try to load loopback URLs from a remote gateway.
            self.showDefaultCanvas()
            return
        }
        self.urlString = (trimmed == "/" ? "" : trimmed)
        self.reload()
    }

    func reload() {
        self.applyScrollBehavior()
        guard let webView = self.activeWebView else { return }

        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            guard let url = Self.canvasScaffoldURL else { return }
            self.errorText = nil
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
            return
        }

        guard let url = URL(string: trimmed) else {
            self.errorText = "Invalid URL: \(trimmed)"
            return
        }
        self.errorText = nil
        if url.isFileURL {
            webView.loadFileURL(url, allowingReadAccessTo: url.deletingLastPathComponent())
        } else {
            webView.load(URLRequest(url: url))
        }
    }

    func showDefaultCanvas() {
        self.urlString = ""
        self.reload()
    }

    func setDebugStatusEnabled(_ enabled: Bool) {
        self.debugStatusEnabled = enabled
        self.applyDebugStatusIfNeeded()
    }

    func updateDebugStatus(title: String?, subtitle: String?) {
        self.debugStatusTitle = title
        self.debugStatusSubtitle = subtitle
        self.applyDebugStatusIfNeeded()
    }

    func applyDebugStatusIfNeeded() {
        guard let webView = self.activeWebView else { return }
        let enabled = self.debugStatusEnabled
        let title = self.debugStatusTitle
        let subtitle = self.debugStatusSubtitle
        let js = """
        (() => {
          try {
            const api = globalThis.__openclaw;
            if (!api) return;
            if (typeof api.setDebugStatusEnabled === 'function') {
              api.setDebugStatusEnabled(\(enabled ? "true" : "false"));
            }
            if (!\(enabled ? "true" : "false")) return;
            if (typeof api.setStatus === 'function') {
              api.setStatus(\(Self.jsValue(title)), \(Self.jsValue(subtitle)));
            }
          } catch (_) {}
        })()
        """
        webView.evaluateJavaScript(js) { _, _ in }
    }

    func waitForA2UIReady(timeoutMs: Int) async -> Bool {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: .milliseconds(timeoutMs))
        while clock.now < deadline {
            do {
                let res = try await self.eval(javaScript: """
                (() => {
                  try {
                    const host = globalThis.openclawA2UI;
                    return !!host && typeof host.applyMessages === 'function';
                  } catch (_) { return false; }
                })()
                """)
                let trimmed = res.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
                if trimmed == "true" || trimmed == "1" { return true }
            } catch {
                // ignore; page likely still loading
            }
            try? await Task.sleep(nanoseconds: 120_000_000)
        }
        return false
    }

    func eval(javaScript: String) async throws -> String {
        guard let webView = self.activeWebView else {
            throw NSError(domain: "Screen", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "web view unavailable",
            ])
        }
        return try await withCheckedThrowingContinuation { cont in
            webView.evaluateJavaScript(javaScript) { result, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                if let result {
                    cont.resume(returning: String(describing: result))
                } else {
                    cont.resume(returning: "")
                }
            }
        }
    }

    func snapshotPNGBase64(maxWidth: CGFloat? = nil) async throws -> String {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        guard let webView = self.activeWebView else {
            throw NSError(domain: "Screen", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "web view unavailable",
            ])
        }
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            webView.takeSnapshot(with: config) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Screen", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot failed",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }
        guard let data = image.pngData() else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    func snapshotBase64(
        maxWidth: CGFloat? = nil,
        format: OpenClawCanvasSnapshotFormat,
        quality: Double? = nil) async throws -> String
    {
        let config = WKSnapshotConfiguration()
        if let maxWidth {
            config.snapshotWidth = NSNumber(value: Double(maxWidth))
        }
        guard let webView = self.activeWebView else {
            throw NSError(domain: "Screen", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "web view unavailable",
            ])
        }
        let image: UIImage = try await withCheckedThrowingContinuation { cont in
            webView.takeSnapshot(with: config) { image, error in
                if let error {
                    cont.resume(throwing: error)
                    return
                }
                guard let image else {
                    cont.resume(throwing: NSError(domain: "Screen", code: 2, userInfo: [
                        NSLocalizedDescriptionKey: "snapshot failed",
                    ]))
                    return
                }
                cont.resume(returning: image)
            }
        }

        let data: Data?
        switch format {
        case .png:
            data = image.pngData()
        case .jpeg:
            let q = (quality ?? 0.82).clamped(to: 0.1...1.0)
            data = image.jpegData(compressionQuality: q)
        }
        guard let data else {
            throw NSError(domain: "Screen", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "snapshot encode failed",
            ])
        }
        return data.base64EncodedString()
    }

    func attachWebView(_ webView: WKWebView) {
        self.activeWebView = webView
        self.reload()
        self.applyDebugStatusIfNeeded()
    }

    func detachWebView(_ webView: WKWebView) {
        guard self.activeWebView === webView else { return }
        self.activeWebView = nil
    }

    private static func bundledResourceURL(
        name: String,
        ext: String,
        subdirectory: String)
        -> URL?
    {
        let bundle = OpenClawKitResources.bundle
        return bundle.url(forResource: name, withExtension: ext, subdirectory: subdirectory)
            ?? bundle.url(forResource: name, withExtension: ext)
    }

    private static let canvasScaffoldURL: URL? = ScreenController.bundledResourceURL(
        name: "scaffold",
        ext: "html",
        subdirectory: "CanvasScaffold")

    private static func isLoopbackHost(_ host: String) -> Bool {
        let normalized = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if normalized.isEmpty { return true }
        if normalized == "localhost" || normalized == "::1" || normalized == "0.0.0.0" {
            return true
        }
        if normalized == "127.0.0.1" || normalized.hasPrefix("127.") {
            return true
        }
        return false
    }
    func isTrustedCanvasUIURL(_ url: URL) -> Bool {
        guard url.isFileURL else { return false }
        let std = url.standardizedFileURL
        if let expected = Self.canvasScaffoldURL,
           std == expected.standardizedFileURL
        {
            return true
        }
        return false
    }

    private func applyScrollBehavior() {
        guard let webView = self.activeWebView else { return }
        let trimmed = self.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        let allowScroll = !trimmed.isEmpty
        let scrollView = webView.scrollView
        // Default canvas needs raw touch events; external pages should scroll.
        scrollView.isScrollEnabled = allowScroll
        scrollView.bounces = allowScroll
    }

    private static func jsValue(_ value: String?) -> String {
        guard let value else { return "null" }
        if let data = try? JSONSerialization.data(withJSONObject: [value]),
           let encoded = String(data: data, encoding: .utf8),
           encoded.count >= 2
        {
            return String(encoded.dropFirst().dropLast())
        }
        return "null"
    }

    func isLocalNetworkCanvasURL(_ url: URL) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard let host = url.host?.trimmingCharacters(in: .whitespacesAndNewlines), !host.isEmpty else {
            return false
        }
        if host == "localhost" { return true }
        if host.hasSuffix(".local") { return true }
        if host.hasSuffix(".ts.net") { return true }
        if host.hasSuffix(".tailscale.net") { return true }
        // Allow MagicDNS / LAN hostnames like "peters-mac-studio-1".
        if !host.contains("."), !host.contains(":") { return true }
        if let ipv4 = Self.parseIPv4(host) {
            return Self.isLocalNetworkIPv4(ipv4)
        }
        return false
    }

    private static func parseIPv4(_ host: String) -> (UInt8, UInt8, UInt8, UInt8)? {
        let parts = host.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        let bytes: [UInt8] = parts.compactMap { UInt8($0) }
        guard bytes.count == 4 else { return nil }
        return (bytes[0], bytes[1], bytes[2], bytes[3])
    }

    private static func isLocalNetworkIPv4(_ ip: (UInt8, UInt8, UInt8, UInt8)) -> Bool {
        let (a, b, _, _) = ip
        // 10.0.0.0/8
        if a == 10 { return true }
        // 172.16.0.0/12
        if a == 172, (16...31).contains(Int(b)) { return true }
        // 192.168.0.0/16
        if a == 192, b == 168 { return true }
        // 127.0.0.0/8
        if a == 127 { return true }
        // 169.254.0.0/16 (link-local)
        if a == 169, b == 254 { return true }
        // Tailscale: 100.64.0.0/10
        if a == 100, (64...127).contains(Int(b)) { return true }
        return false
    }

    nonisolated static func parseA2UIActionBody(_ body: Any) -> [String: Any]? {
        if let dict = body as? [String: Any] { return dict.isEmpty ? nil : dict }
        if let str = body as? String,
           let data = str.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any]
        {
            return json.isEmpty ? nil : json
        }
        if let dict = body as? [AnyHashable: Any] {
            let mapped = dict.reduce(into: [String: Any]()) { acc, pair in
                guard let key = pair.key as? String else { return }
                acc[key] = pair.value
            }
            return mapped.isEmpty ? nil : mapped
        }
        return nil
    }
}

extension Double {
    fileprivate func clamped(to range: ClosedRange<Double>) -> Double {
        if self < range.lowerBound { return range.lowerBound }
        if self > range.upperBound { return range.upperBound }
        return self
    }
}
