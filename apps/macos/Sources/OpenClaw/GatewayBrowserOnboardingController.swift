import AppKit
import OpenClawKit
import SwiftUI

@MainActor
final class GatewayBrowserOnboardingController: NSWindowController, NSWindowDelegate {
    static let shared = GatewayBrowserOnboardingController()
    private var onClose: (() -> Void)?

    private init() {
        super.init(window: nil)
    }

    @available(*, unavailable)
    required init?(coder: NSCoder) {
        fatalError("init(coder:) has not been implemented")
    }

    func present(_ link: GatewayAddDeepLink) {
        // A new external intent replaces the editor, cancelling any pending sign-in.
        self.close()
        self.present(title: "Add Gateway", content: GatewayProfileEditor(
            name: link.name ?? "",
            address: link.url.absoluteString,
            onCancel: { [weak self] in self?.close() },
            onSaved: { [weak self] _ in self?.close() }))
    }

    /// CLI calls retain their terminal RPC result; browser recovery stays in an invocation-owned native window.
    static func withSignInProgress<Result: Sendable>(
        operation: @escaping @MainActor (GatewayBrowserSignInProgress) async throws -> Result) async throws -> Result
    {
        let controller = GatewayBrowserOnboardingController()
        let progress = GatewayBrowserSignInProgress()
        let task = Task { try await operation(progress) }
        controller.onClose = { task.cancel() }
        progress.onChange = { [weak controller] in
            guard let controller, controller.window == nil, progress.canOpenBrowser else { return }
            controller.present(
                title: String(localized: "Gateway sign-in"),
                content:
                VStack(alignment: .leading, spacing: 18) {
                    Text(verbatim: progress.gatewayHost).font(.headline)
                    GatewayBrowserSignInProgressView(progress: progress)
                    Button("Cancel", role: .cancel) { task.cancel() }
                }.padding(24).frame(width: 440))
        }
        defer {
            progress.onChange = nil
            controller.onClose = nil
            controller.close()
        }
        return try await withTaskCancellationHandler {
            try await task.value
        } onCancel: {
            task.cancel()
        }
    }

    private func present(title: String, content: some View) {
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 540, height: 360),
            styleMask: [.titled, .closable],
            backing: .buffered,
            defer: false)
        window.title = title
        window.isReleasedWhenClosed = false
        window.delegate = self
        window.contentViewController = NSHostingController(rootView: content)
        self.window = window
        window.center()
        self.showWindow(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
    }

    func windowWillClose(_ notification: Notification) {
        guard let closingWindow = notification.object as? NSWindow else { return }
        self.onClose?()
        closingWindow.contentViewController = nil
    }
}
