import AppKit
import Foundation
import WebKit

/// WebKit requires a nonexistent destination. Stage the bytes on the selected
/// volume so a cancelled or failed transfer never truncates an existing file.
struct DashboardBrowserDownloadDestination {
    let destination: URL
    let stagingDirectory: URL
    let stagingFile: URL
    private let replacesExistingFile: Bool

    init(destination: URL) throws {
        self.destination = destination
        self.replacesExistingFile = FileManager.default.fileExists(atPath: destination.path)
        self.stagingDirectory = try FileManager.default.url(
            for: .itemReplacementDirectory,
            in: .userDomainMask,
            appropriateFor: destination,
            create: true)
        self.stagingFile = self.stagingDirectory.appendingPathComponent("download")
    }

    func commit() throws {
        let files = FileManager.default
        if self.replacesExistingFile {
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
    private let authenticate: (@MainActor (
        URLAuthenticationChallenge,
        @escaping @MainActor @Sendable
        (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) -> Void)?
    private var activeDownload: WKDownload?
    private var panel: NSSavePanel?
    private var destination: DashboardBrowserDownloadDestination?
    private var continuation: CheckedContinuation<Bool, any Error>?

    init(
        window: NSWindow,
        authenticate: (@MainActor (
            URLAuthenticationChallenge,
            @escaping @MainActor @Sendable
            (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) -> Void)? = nil,
        isCurrent: @escaping @MainActor () -> Bool)
    {
        self.window = window
        self.authenticate = authenticate
        self.isCurrent = isCurrent
    }

    /// Adopt WebKit's original attachment request rather than fetching a second ticket.
    func start(adopting download: WKDownload) async throws -> Bool {
        guard AppLaunchRuntimePlan.current.allowsActivation, self.isCurrent() else {
            download.cancel { _ in }
            throw DashboardBrowserError.unavailable
        }
        return try await withCheckedThrowingContinuation { continuation in
            self.continuation = continuation
            self.activeDownload = download
            download.delegate = self
        }
    }

    /// Returns true for cancellation, false only after the completed file is saved.
    func start(using webView: WKWebView, url: URL) async throws -> Bool {
        guard AppLaunchRuntimePlan.current.allowsActivation else { throw DashboardBrowserError.dialogDeferred }
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

    func download(
        _: WKDownload,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable
        (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard self.continuation != nil, self.isCurrent() else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        if let authenticate {
            authenticate(challenge, completionHandler)
        } else {
            completionHandler(.performDefaultHandling, nil)
        }
    }

    private func finish(_ result: Result<Bool, any Error>) {
        guard let continuation else { return }
        self.continuation = nil
        let download = self.activeDownload
        download?.delegate = nil
        self.activeDownload = nil
        self.panel?.cancel(nil)
        self.panel = nil
        let destination = self.destination
        self.destination = nil
        // WebKit can still be writing after cancellation. Release staging only
        // after it has stopped, including when the originating document retires.
        if let download {
            download.cancel { _ in destination?.discard() }
        } else {
            destination?.discard()
        }
        continuation.resume(with: result)
    }
}
