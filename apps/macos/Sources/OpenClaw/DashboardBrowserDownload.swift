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

/// One user-requested transfer, retained by its document or native browser host.
@MainActor
final class DashboardBrowserDownload: NSObject, WKDownloadDelegate {
    typealias AuthenticationHandler = @MainActor (
        URLAuthenticationChallenge,
        @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void) -> Void

    private let authenticationHandler: AuthenticationHandler?
    private weak var window: NSWindow?
    private let isCurrent: @MainActor () -> Bool
    private var activeDownload: WKDownload?
    private var panel: NSSavePanel?
    private var destination: DashboardBrowserDownloadDestination?
    private var completion: ((Result<Bool, any Error>) -> Void)?

    init(
        window: NSWindow,
        authenticationHandler: AuthenticationHandler? = nil,
        isCurrent: @escaping @MainActor () -> Bool)
    {
        self.authenticationHandler = authenticationHandler
        self.window = window
        self.isCurrent = isCurrent
    }

    /// Returns true for cancellation, false only after the completed file is saved.
    func start(using webView: WKWebView, url: URL) async throws -> Bool {
        guard AppLaunchRuntimePlan.current.allowsActivation else { throw DashboardBrowserError.dialogDeferred }
        guard self.isCurrent() else { throw DashboardBrowserError.unavailable }
        return try await withCheckedThrowingContinuation { continuation in
            self.completion = { continuation.resume(with: $0) }
            // WebKit owns cookies, redirects, authentication, and quarantine metadata.
            // A separate URLSession would not share the reading tab's browser session.
            webView.startDownload(using: URLRequest(url: url)) { [weak self] download in
                guard let self else { download.cancel { _ in }
                    return
                }
                self.attach(download)
            }
        }
    }

    /// Converted navigations must receive their delegate before WebKit's callback returns.
    func start(_ download: WKDownload, completion: @escaping (Result<Bool, any Error>) -> Void) {
        self.completion = completion
        self.attach(download)
    }

    private func attach(_ download: WKDownload) {
        guard self.completion != nil, self.isCurrent(), AppLaunchRuntimePlan.current.allowsActivation else {
            download.cancel { _ in }
            self.finish(.failure(DashboardBrowserError.unavailable))
            return
        }
        self.activeDownload = download
        download.delegate = self
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
        guard self.completion != nil, self.isCurrent(), let window else {
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
            guard let self, self.completion != nil else {
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

    func download(
        _: WKDownload,
        didReceive challenge: URLAuthenticationChallenge,
        completionHandler: @escaping @MainActor @Sendable (URLSession.AuthChallengeDisposition, URLCredential?) -> Void)
    {
        guard self.completion != nil, self.isCurrent() else {
            completionHandler(.cancelAuthenticationChallenge, nil)
            return
        }
        guard let authenticationHandler else {
            // Preserve WebKit's default for reading-tab transfers without Gateway authority.
            completionHandler(.rejectProtectionSpace, nil)
            return
        }
        authenticationHandler(challenge, completionHandler)
    }

    func downloadDidFinish(_: WKDownload) {
        do {
            guard self.completion != nil, self.isCurrent(), let destination else {
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
        guard let completion else { return }
        self.completion = nil
        self.activeDownload?.delegate = nil
        self.activeDownload?.cancel { _ in }
        self.activeDownload = nil
        self.panel?.cancel(nil)
        self.panel = nil
        self.destination?.discard()
        self.destination = nil
        completion(result)
    }
}
