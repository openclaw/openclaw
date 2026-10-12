import AppKit
import Foundation
import WebKit

/// Admission and retirement belong to the Dashboard document; the existing
/// browser download owner retains WebKit authentication and staged publication.
@MainActor
final class DashboardAttachmentDownloads {
    private weak var controller: DashboardWindowController?
    private var generation: UInt64 = 0
    private var pendingActions: [ObjectIdentifier: WKNavigationAction] = [:]
    private var pendingResponses: [ObjectIdentifier: WKNavigationResponse] = [:]
    private var responseDownloadAllowed = false
    private var active: [ObjectIdentifier: (transfer: DashboardBrowserDownload, task: Task<Void, Never>)] = [:]
    private let alerts = DashboardAlertPresenter()

    init(controller: DashboardWindowController) {
        self.controller = controller
    }

    private func admits(_ action: WKNavigationAction) -> Bool {
        guard let controller, controller.canDownloadAttachments else { return false }
        return ControlUIDocumentHost.shouldAllowAttachmentDownload(
            to: action.request.url,
            sourceURL: action.sourceFrame.request.url,
            sourceIsMainFrame: action.sourceFrame.isMainFrame,
            dashboardURL: controller.currentURL)
    }

    func prepare(_ action: WKNavigationAction) {
        if action.targetFrame?.isMainFrame == true {
            self.responseDownloadAllowed = self.admits(action) && action.navigationType == .linkActivated
        }
    }

    func admit(_ action: WKNavigationAction) -> Bool {
        guard self.admits(action) else { return false }
        self.pendingActions[ObjectIdentifier(action)] = action
        return true
    }

    func admit(_ response: WKNavigationResponse) -> Bool {
        guard response.isForMainFrame else { return false }
        let allowed = self.responseDownloadAllowed
        self.responseDownloadAllowed = false
        guard allowed, self.controller?.canDownloadAttachments == true,
              ControlUIDocumentHost.shouldDownloadAttachmentResponse(
                  response.response, canShowMIMEType: response.canShowMIMEType)
        else { return false }
        self.pendingResponses[ObjectIdentifier(response)] = response
        return true
    }

    func start(_ download: WKDownload, for action: WKNavigationAction) {
        guard self.pendingActions.removeValue(forKey: ObjectIdentifier(action)) != nil else {
            download.cancel { _ in }
            return
        }
        self.start(download)
    }

    func start(_ download: WKDownload, for response: WKNavigationResponse) {
        guard self.pendingResponses.removeValue(forKey: ObjectIdentifier(response)) != nil else {
            download.cancel { _ in }
            return
        }
        self.start(download)
    }

    private func start(_ download: WKDownload) {
        guard let controller, controller.canDownloadAttachments,
              download.webView === controller.webView, let window = controller.window
        else {
            download.cancel { _ in }
            return
        }
        let generation = self.generation
        let document = controller.documentHost.generation
        let isCurrent: @MainActor () -> Bool = { [weak self, weak controller, weak window] in
            guard let self, let controller, let window else { return false }
            return self.generation == generation && controller.documentHost.generation == document &&
                controller.window === window && controller.canDownloadAttachments
        }
        let transfer = DashboardBrowserDownload(
            window: window,
            authenticate: { [weak controller] challenge, completion in
                guard let controller, isCurrent() else {
                    completion(.cancelAuthenticationChallenge, nil)
                    return
                }
                controller.documentHost.authenticationChallenge(challenge, completionHandler: completion)
            },
            isCurrent: isCurrent)
        let id = ObjectIdentifier(download)
        let task = Task { @MainActor [weak self] in
            defer { self?.active.removeValue(forKey: id) }
            do {
                _ = try await transfer.start(adopting: download)
            } catch {
                guard !Task.isCancelled, isCurrent() else { return }
                // Keep transport URLs and signed tickets out of user-facing errors.
                let alert = NSAlert()
                alert.messageText = String(localized: "Attachment download failed")
                alert.informativeText = String(localized: "Try downloading the attachment again.")
                self?.alerts.present(alert, over: window)
            }
        }
        self.active[id] = (transfer, task)
    }

    func retire() {
        self.generation &+= 1
        self.pendingActions.removeAll()
        self.pendingResponses.removeAll()
        self.responseDownloadAllowed = false
        let transfers = self.active.values
        self.active.removeAll()
        for item in transfers {
            item.task.cancel()
            item.transfer.cancel()
        }
        self.alerts.dismissAll()
    }
}

extension DashboardWindowController {
    func webView(_ webView: WKWebView, navigationAction: WKNavigationAction, didBecome download: WKDownload) {
        guard webView === self.webView else {
            download.cancel { _ in }
            return
        }
        self.attachmentDownloads.start(download, for: navigationAction)
    }

    func webView(_ webView: WKWebView, navigationResponse: WKNavigationResponse, didBecome download: WKDownload) {
        guard webView === self.webView else {
            download.cancel { _ in }
            return
        }
        self.attachmentDownloads.start(download, for: navigationResponse)
    }
}
