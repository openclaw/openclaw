import AppKit
import Foundation
import Observation
import OSLog
import SwiftUI

private let gatewayBrowserSignInLogger = Logger(subsystem: "ai.openclaw", category: "gateway.browser-sign-in")

/// A native-only action, never a URL payload for a dashboard or IPC client.
struct GatewayBrowserHandoff: Sendable {
    let id = UUID()
    private let url: URL
    private let isCurrent: @Sendable () -> Bool

    init(url: URL, isCurrent: @escaping @Sendable () -> Bool) {
        self.url = url
        self.isCurrent = isCurrent
    }

    var isAvailable: Bool {
        self.isCurrent()
    }

    func perform<Result>(_ action: (URL) throws -> Result) throws -> Result {
        guard self.isCurrent() else { throw CancellationError() }
        return try action(self.url)
    }
}

@MainActor
@Observable
final class GatewayBrowserSignInProgress {
    private(set) var handoff: GatewayBrowserHandoff?
    var gatewayHost = ""
    private(set) var error: String?
    private(set) var isOpeningBrowser = false
    var onChange: (() -> Void)?

    var canOpenBrowser: Bool {
        self.handoff?.isAvailable == true && !self.isOpeningBrowser
    }

    func update(_ handoff: GatewayBrowserHandoff?) {
        self.handoff = handoff
        self.error = nil
        self.isOpeningBrowser = false
        self.onChange?()
    }

    func openBrowser(_ action: GatewayBrowserHandoff) {
        guard self.handoff?.id == action.id, !self.isOpeningBrowser else { return }
        do {
            try action.perform { url in
                let configuration = NSWorkspace.OpenConfiguration()
                // A reused browser process can be headless. Let the browser's normal startup
                // choose its profile owner instead of delivering to an arbitrary running instance.
                configuration.createsNewApplicationInstance = true
                self.isOpeningBrowser = true
                self.error = nil
                gatewayBrowserSignInLogger.info("browser launch requested action=\(action.id, privacy: .public)")
                NSWorkspace.shared.open(url, configuration: configuration) { [weak self] application, error in
                    // Never log the URL or localized error: both can contain the sign-in transfer key.
                    if let error = error as NSError? {
                        gatewayBrowserSignInLogger.error(
                            """
                            browser launch failed action=\(action.id, privacy: .public) \
                            domain=\(error.domain, privacy: .public) code=\(error.code)
                            """)
                    } else {
                        gatewayBrowserSignInLogger.info(
                            """
                            browser launch delivered action=\(action.id, privacy: .public) \
                            pid=\(application?.processIdentifier ?? 0) \
                            bundle=\(application?.bundleIdentifier ?? "unknown", privacy: .public)
                            """)
                    }
                    Task { @MainActor in self?.browserDidOpen(action, error: error) }
                }
            }
        } catch {
            self.handoff = nil
            self.error = String(localized: "This sign-in is no longer active. Start sign-in again.")
        }
        self.onChange?()
    }

    func browserDidOpen(_ action: GatewayBrowserHandoff, error: Error?) {
        // LaunchServices may complete after cancellation, helper exit, or a replacement sign-in.
        guard self.handoff?.id == action.id, action.isAvailable else { return }
        self.isOpeningBrowser = false
        self.error = error == nil ? nil : String(localized:
            "Could not open your browser. Check your default browser and try again.")
        self.onChange?()
    }
}

struct GatewayBrowserSignInProgressView: View {
    let progress: GatewayBrowserSignInProgress

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                ProgressView().controlSize(.small)
                Text(self.progress.handoff?.isAvailable == true
                    ? String(localized: "Complete sign-in in your browser…") : String(localized: "Connecting…"))
                    .font(.callout)
            }
            if let action = self.progress.handoff, action.isAvailable {
                Button("Open browser") { self.progress.openBrowser(action) }
                    .disabled(self.progress.isOpeningBrowser)
            }
            if let error = self.progress.error {
                Text(error).font(.footnote).foregroundStyle(.red)
            }
        }
    }
}
