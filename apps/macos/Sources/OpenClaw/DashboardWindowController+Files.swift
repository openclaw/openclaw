import AppKit
import Foundation
import OSLog
import UniformTypeIdentifiers
import WebKit

/// Replies with a `DefaultAppOpenOutcome` raw value so the Control UI can explain refusals.
@MainActor
final class DashboardFilesMessageHandler: NSObject, WKScriptMessageHandlerWithReply {
    /// Handler presence is the Control UI feature probe for "Open in > Default App".
    static let name = "openclawFiles"

    weak var owner: DashboardWindowController?

    func userContentController(
        _: WKUserContentController,
        didReceive message: WKScriptMessage,
        replyHandler: @escaping @MainActor (Any?, String?) -> Void)
    {
        guard let owner = self.owner else {
            replyHandler(nil, "The dashboard window is no longer available.")
            return
        }
        owner.receiveFilesMessage(message, replyHandler: replyHandler)
    }
}

enum DefaultAppOpenOutcome: String {
    case opened
    case remote
    case missing
    case unsupportedType = "unsupported-type"
    case noApp = "no-app"
}

extension DashboardWindowController {
    private static let filesLogger = Logger(subsystem: "ai.openclaw", category: "dashboard-files")

    static func defaultAppFileRequest(from body: Any) -> URL? {
        guard let payload = body as? [String: Any],
              payload["type"] as? String == "open-default-app",
              let path = payload["path"] as? String,
              path.hasPrefix("/"), path.count <= 4096
        else {
            return nil
        }
        return URL(fileURLWithPath: path).standardizedFileURL
    }

    /// Gateway paths name files on the Gateway host; only a local Gateway shares this filesystem.
    static func isLocalGatewayTarget(_ target: DashboardGatewayTarget?, mode: AppState.ConnectionMode) -> Bool {
        switch target {
        case .local: true
        case .primary: mode == .local
        case .profile, nil: false
        }
    }

    /// Hands only document-like regular files to Launch Services. The default
    /// handler for scripts, executables, bundles, and Terminal or location files
    /// would run or follow them, which a file-preview action must never do.
    static func defaultAppRefusal(for url: URL) -> DefaultAppOpenOutcome? {
        guard let values = try? url.resourceValues(forKeys: [
            .isRegularFileKey, .isPackageKey, .isExecutableKey, .contentTypeKey,
        ]) else {
            return .missing
        }
        guard values.isRegularFile == true,
              values.isPackage != true,
              values.isExecutable != true,
              let type = values.contentType,
              type.conforms(to: .content), !type.conforms(to: .script), !type.conforms(to: .executable)
        else {
            return .unsupportedType
        }
        return nil
    }

    func receiveFilesMessage(_ message: WKScriptMessage, replyHandler: @MainActor (Any?, String?) -> Void) {
        // Page-world handlers are privileged: accept only the current Control UI document's main frame.
        guard message.webView === self.webView, message.frameInfo.isMainFrame, !self.isShowingFailurePage,
              ControlUIDocumentHost.isTrustedLinkSource(message.frameInfo.request.url, dashboardURL: self.currentURL),
              let requested = Self.defaultAppFileRequest(from: message.body)
        else {
            replyHandler(nil, "Invalid default app request.")
            return
        }
        // Read the window's live target, not the published snapshot, so a Gateway switch
        // or connection-mode change revokes the capability before the page learns of it.
        let target = DashboardManager.shared.target(for: self)
        let outcome: DefaultAppOpenOutcome
        if !Self.isLocalGatewayTarget(target, mode: AppStateStore.shared.connectionMode) {
            outcome = .remote
        } else {
            let url = requested.resolvingSymlinksInPath()
            if let refusal = Self.defaultAppRefusal(for: url) {
                outcome = refusal
            } else {
                outcome = AppActivation.shared.open(url) ? .opened : .noApp
            }
        }
        if outcome != .opened {
            Self.filesLogger.warning("Default app open not performed: \(outcome.rawValue, privacy: .public)")
        }
        replyHandler(outcome.rawValue, nil)
    }
}
