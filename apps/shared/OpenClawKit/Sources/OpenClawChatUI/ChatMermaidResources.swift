#if canImport(WebKit) && (os(iOS) || os(macOS))
import Foundation
import WebKit

@MainActor
enum ChatMermaidResources {
    static let scheme = "openclaw-mermaid"
    static let documentURL = URL(string: "openclaw-mermaid://renderer/index.html")!

    static func directory() -> URL? {
        #if os(macOS)
        if Bundle.main.bundleURL.pathExtension == "app" {
            // The signed macOS package keeps SwiftPM sidecars in Contents/Resources.
            // Bundle.module may trap when searching beside the app executable.
            guard let url = Bundle.main.url(forResource: "OpenClawKit_OpenClawChatUI", withExtension: "bundle"),
                  let bundle = Bundle(url: url)
            else { return nil }
            return bundle.url(forResource: "Mermaid", withExtension: nil)
        }
        #endif
        return Bundle.module.url(forResource: "Mermaid", withExtension: nil)
    }
}

@MainActor
final class ChatMermaidSchemeHandler: NSObject, WKURLSchemeHandler {
    private struct Resource {
        let data: Data
        let mime: String
        let category: String
    }

    private let resources: [String: Resource]
    #if DEBUG
    let traceDocumentID = UUID()
    private let traceStartedAt = ProcessInfo.processInfo.systemUptime
    #endif

    init(directory: URL) throws {
        var resources: [String: Resource] = [:]
        let assets = try FileManager.default.contentsOfDirectory(
            atPath: directory.appendingPathComponent("assets", isDirectory: true).path)
            .filter { $0.hasPrefix("pele.min-") && $0.hasSuffix(".js") }
            .sorted()
        guard !assets.isEmpty else { throw ChatMermaidFailure.unavailable }
        let filenames = ["index.html", "native.js", "frame.js"] + assets.map { "assets/\($0)" }
        for filename in filenames {
            let url = directory.appendingPathComponent(filename, isDirectory: false)
            resources["openclaw-mermaid://renderer/\(filename)"] = try Resource(
                data: Data(contentsOf: url, options: .mappedIfSafe),
                mime: filename == "index.html" ? "text/html" : "application/javascript",
                category: filename.hasPrefix("assets/") ? "compiler" : filename)
        }
        self.resources = resources
        super.init()
    }

    func webView(_: WKWebView, start task: WKURLSchemeTask) {
        guard task.request.httpMethod == "GET",
              let url = task.request.url,
              let resource = self.resources[url.absoluteString]
        else {
            self.trace("resource-rejected")
            task.didFailWithError(URLError(.unsupportedURL))
            return
        }
        self.trace("resource-started", resource: resource)
        task.didReceive(URLResponse(
            url: url,
            mimeType: resource.mime,
            expectedContentLength: resource.data.count,
            textEncodingName: "utf-8"))
        self.trace("resource-response", resource: resource)
        task.didReceive(resource.data)
        self.trace("resource-data", resource: resource)
        task.didFinish()
        self.trace("resource-finished", resource: resource)
    }

    func webView(_: WKWebView, stop _: WKURLSchemeTask) {
        // Bundled resources complete synchronously on the main actor.
        self.trace("resource-stopped")
    }

    private func trace(_ event: String, resource: Resource? = nil) {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode") else { return }
        var record: [String: Any] = [
            "event": event, "document": self.traceDocumentID.uuidString,
            "documentElapsedMs": Int((ProcessInfo.processInfo.systemUptime - self.traceStartedAt) * 1000),
        ]
        if let resource {
            record["resource"] = resource.category
            record["bytes"] = resource.data.count
        }
        ChatMermaidTrace.write(record)
        #endif
    }
}

/// Temporary, content-free evidence for the screenshot renderer incident.
@MainActor
enum ChatMermaidTrace {
    static func write(_ record: [String: Any]) {
        #if DEBUG
        guard ProcessInfo.processInfo.arguments.contains("--openclaw-screenshot-mode") else { return }
        var record = record
        record["pid"] = ProcessInfo.processInfo.processIdentifier
        record["at"] = Date().timeIntervalSince1970
        let url = FileManager.default.temporaryDirectory.appendingPathComponent("mermaid-renderer.log")
        do {
            let data = try JSONSerialization.data(withJSONObject: record, options: [.sortedKeys]) + Data([0x0A])
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            let file = try FileHandle(forWritingTo: url)
            defer { try? file.close() }
            try file.seekToEnd()
            try file.write(contentsOf: data)
        } catch {
            // Optional incident evidence must not change rendering or screenshot results.
        }
        #endif
    }
}
#endif
