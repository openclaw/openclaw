import AppKit
import WebKit

extension ControlUIDocumentHost {
    func shouldDownload(_ response: WKNavigationResponse) -> Bool {
        guard response.isForMainFrame, hasCurrentBrowserSession,
              let url = response.response.url,
              Self.shouldAllowNavigation(to: url, dashboardURL: self.currentURL, isMainFrame: true)
        else { return false }
        let http = response.response as? HTTPURLResponse
        if let http, !(200..<300).contains(http.statusCode) {
            return false
        }
        let disposition = http?.value(forHTTPHeaderField: "Content-Disposition")?
            .split(separator: ";", maxSplits: 1).first?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard disposition == "attachment" || !response.canShowMIMEType else { return false }
        expectsDownloadPolicyInterruption = true
        return true
    }

    func consumeDownloadPolicyInterruption(_ error: NSError) -> Bool {
        // WebKit interrupts the provisional load when its response becomes a download.
        // The displayed document survives; only this approved conversion owns the error.
        guard expectsDownloadPolicyInterruption,
              error.domain == "WebKitErrorDomain", error.code == 102 else { return false }
        expectsDownloadPolicyInterruption = false
        return true
    }

    func adoptDownload(_ download: WKDownload) {
        guard AppLaunchRuntimePlan.current.allowsActivation,
              isAvailable(), hasCurrentBrowserSession, let window = webView.window
        else {
            download.cancel { _ in }
            return
        }
        let generation = self.generation
        let id = ObjectIdentifier(download)
        let transfer = DashboardBrowserDownload(
            window: window,
            authenticationHandler: { [weak self] challenge, reply in
                guard let self else { reply(.cancelAuthenticationChallenge, nil)
                    return
                }
                self.authenticationChallenge(challenge, completionHandler: reply)
            },
            isCurrent: { [weak self, weak window] in
                guard let self, let window else { return false }
                return self.generation == generation && self.isAvailable() && self.hasCurrentBrowserSession &&
                    self.webView.window === window
            })
        downloads[id] = transfer
        transfer.start(download) { [weak self, weak window] result in
            self?.downloads.removeValue(forKey: id)
            if case let .failure(error) = result, let window, self?.isAvailable() == true {
                NSAlert(error: error).beginSheetModal(for: window)
            }
        }
    }

    func cancelDownloads() {
        expectsDownloadPolicyInterruption = false
        let transfers = downloads.values
        downloads.removeAll()
        for transfer in transfers {
            transfer.cancel()
        }
    }
}
