import AppKit
import Foundation
import WebKit

/// WebKit requires a nonexistent destination. Stage the bytes on the selected
/// volume so a cancelled or failed transfer never truncates an existing file.
struct DashboardBrowserDownloadDestination {
    let destination: URL
    let stagingDirectory: URL
    let stagingFile: URL

    init(destination: URL) throws {
        self.destination = destination
        self.stagingDirectory = try FileManager.default.url(
            for: .itemReplacementDirectory,
            in: .userDomainMask,
            appropriateFor: destination,
            create: true)
        self.stagingFile = self.stagingDirectory.appendingPathComponent("download")
    }

    func commit() throws {
        let files = FileManager.default
        if files.fileExists(atPath: self.destination.path) {
            _ = try files.replaceItemAt(
                self.destination,
                withItemAt: self.stagingFile,
                options: .usingNewMetadataOnly)
        } else {
            try files.moveItem(at: self.stagingFile, to: self.destination)
        }
    }

    func discard() {
        try? FileManager.default.removeItem(at: self.stagingDirectory)
    }
}

/// One user-requested transfer, retained by the window's native browser host.
@MainActor
final class DashboardBrowserDownload: NSObject, WKDownloadDelegate {
    private weak var window: NSWindow?
    private let isCurrent: @MainActor () -> Bool
    private var activeDownload: WKDownload?
    private var panel: NSSavePanel?
    private var destination: DashboardBrowserDownloadDestination?
    private var continuation: CheckedContinuation<Bool, any Error>?

    init(window: NSWindow, isCurrent: @escaping @MainActor () -> Bool) {
        self.window = window
        self.isCurrent = isCurrent
    }

    /// Returns true for cancellation, false only after the completed file is saved.
    func start(using webView: WKWebView, url: URL) async throws -> Bool {
        guard self.isCurrent() else { throw DashboardBrowserError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            // WebKit owns cookies, redirects, authentication, and quarantine metadata.
            // A separate URLSession would not share the reading tab's browser session.
            webView.startDownload(using: URLRequest(url: url)) { [weak self] download in
                guard let self, self.continuation != nil, self.isCurrent() else {
                    download.cancel { _ in }
                    self?.finish(.failure(DashboardBrowserError.unavailable))
                    return
                }
                self.activeDownload = download
                download.delegate = self
            }
        }
    }

    func cancel() {
        self.finish(.success(true))
    }

    func download(
        _: WKDownload,
        decideDestinationUsing response: URLResponse,
        suggestedFilename: String,
        completionHandler: @escaping @MainActor @Sendable (URL?) -> Void)
    {
        guard self.continuation != nil, self.isCurrent(), let window else {
            completionHandler(nil)
            self.finish(.failure(DashboardBrowserError.unavailable))
            return
        }
        if let response = response as? HTTPURLResponse, !(200..<300).contains(response.statusCode) {
            completionHandler(nil)
            self.finish(.failure(URLError(.badServerResponse)))
            return
        }
        let panel = NSSavePanel()
        panel.canCreateDirectories = true
        panel.isExtensionHidden = false
        let filename = (suggestedFilename as NSString).lastPathComponent
        panel.nameFieldStringValue = filename.isEmpty ? "download" : filename
        self.panel = panel
        panel.beginSheetModal(for: window) { [weak self] result in
            guard let self, self.continuation != nil else {
                completionHandler(nil)
                return
            }
            self.panel = nil
            guard self.isCurrent() else {
                completionHandler(nil)
                self.finish(.failure(DashboardBrowserError.unavailable))
                return
            }
            guard result == .OK, let url = panel.url else {
                completionHandler(nil)
                self.finish(.success(true))
                return
            }
            do {
                let destination = try DashboardBrowserDownloadDestination(destination: url)
                self.destination = destination
                completionHandler(destination.stagingFile)
            } catch {
                completionHandler(nil)
                self.finish(.failure(error))
            }
        }
    }

    func downloadDidFinish(_: WKDownload) {
        do {
            guard self.continuation != nil, self.isCurrent(), let destination else {
                throw DashboardBrowserError.unavailable
            }
            try destination.commit()
            self.finish(.success(false))
        } catch {
            self.finish(.failure(error))
        }
    }

    func download(_: WKDownload, didFailWithError error: any Error, resumeData _: Data?) {
        self.finish(.failure(error))
    }

    private func finish(_ result: Result<Bool, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        self.activeDownload?.delegate = nil
        self.activeDownload?.cancel { _ in }
        self.activeDownload = nil
        self.panel?.cancel(nil)
        self.panel = nil
        self.destination?.discard()
        self.destination = nil
        continuation.resume(with: result)
    }
}
