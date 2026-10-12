import AppKit
import SwiftUI

@MainActor
protocol AppActivationApplication {
    func activate(ignoringOtherApps: Bool)
}

extension NSApplication: AppActivationApplication {}

@MainActor
protocol AppActivationWindow: AnyObject {
    var level: NSWindow.Level { get set }
    func makeKeyAndOrderFront(_ sender: Any?)
    func orderFrontRegardless()
    func orderBack(_ sender: Any?)
}

extension NSWindow: AppActivationWindow {}

/// Owns app-initiated focus and ordering, including presentations requested after launch.
@MainActor
final class AppActivation {
    static let shared = AppActivation(launchPlan: .current)

    let allowsActivation: Bool
    private lazy var alerts = DashboardAlertPresenter()
    private let logger = Logger(subsystem: "ai.openclaw", category: "app")

    init(launchPlan: AppLaunchRuntimePlan) {
        self.allowsActivation = launchPlan.allowsActivation
    }

    func configureLaunch() {
        // Set before SwiftUI constructs the application, so launch itself cannot request focus.
        if !self.allowsActivation { NSApplication.shared.setActivationPolicy(.accessory) }
    }

    func activate(application: any AppActivationApplication = NSApplication.shared) {
        guard self.allowsActivation else { return }
        application.activate(ignoringOtherApps: true)
    }

    func activate(application: NSRunningApplication) -> Bool {
        guard self.allowsActivation else { return false }
        return application.activate(options: [])
    }

    func requestExternalNavigation() -> Bool {
        guard self.allowsActivation else {
            self.logger.warning("External navigation deferred by --no-activate; relaunch without the flag and retry.")
            return false
        }
        return true
    }

    var openURLAction: OpenURLAction {
        OpenURLAction { _ in self.requestExternalNavigation() ? .systemAction : .discarded }
    }

    @discardableResult
    func open(_ url: URL) -> Bool {
        guard self.requestExternalNavigation() else { return false }
        return NSWorkspace.shared.open(url)
    }

    func revealFiles(_ urls: [URL]) {
        guard self.requestExternalNavigation() else { return }
        NSWorkspace.shared.activateFileViewerSelecting(urls)
    }

    func open(
        _ url: URL,
        configuration: NSWorkspace.OpenConfiguration,
        completionHandler: @escaping @Sendable (NSRunningApplication?, (any Error)?) -> Void)
    {
        guard self.requestExternalNavigation() else {
            completionHandler(nil, NSError(domain: "AppActivation", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "External navigation deferred by --no-activate; relaunch without the flag.",
            ]))
            return
        }
        NSWorkspace.shared.open(url, configuration: configuration, completionHandler: completionHandler)
    }

    func open(_ urls: [URL], withApplicationAt applicationURL: URL) {
        guard self.requestExternalNavigation() else { return }
        NSWorkspace.shared.open(
            urls,
            withApplicationAt: applicationURL,
            configuration: NSWorkspace.OpenConfiguration(),
            completionHandler: nil)
    }

    func makeKeyAndOrderFront(window: (any AppActivationWindow)?) {
        guard let window else { return }
        if self.allowsActivation {
            window.makeKeyAndOrderFront(nil)
        } else {
            self.orderBack(window: window)
        }
    }

    func orderFrontRegardless(window: (any AppActivationWindow)?, level: NSWindow.Level? = nil) {
        guard let window else { return }
        if self.allowsActivation {
            if let level { window.level = level }
            window.orderFrontRegardless()
        } else {
            self.orderBack(window: window)
        }
    }

    func showWindow(controller: NSWindowController) {
        if self.allowsActivation {
            controller.showWindow(nil)
        } else if let window = controller.window {
            self.orderBack(window: window)
        }
    }

    func deminiaturize(window: NSWindow) {
        // Respect operator minimization during automation; restoring can raise the window.
        if self.allowsActivation {
            window.deminiaturize(nil)
        }
    }

    private func orderBack(window: any AppActivationWindow) {
        // Ordering is relative to a level: a floating/modal panel would still cover other apps.
        if let panel = window as? NSPanel {
            panel.isFloatingPanel = false
            panel.hidesOnDeactivate = false
        }
        window.level = .normal
        window.orderBack(nil)
    }

    func presentAlert(
        _ alert: NSAlert,
        completion: @escaping (NSApplication.ModalResponse) -> Void = { _ in })
    {
        if self.allowsActivation {
            completion(alert.runModal())
        } else {
            let parent = NSApp.windows.first { $0.isVisible && $0.canBecomeMain && !$0.isSheet }
            self.alerts.present(alert, over: parent, completion: completion)
        }
    }

    func response(to alert: NSAlert) async -> NSApplication.ModalResponse {
        await withCheckedContinuation { continuation in
            self.presentAlert(alert) { continuation.resume(returning: $0) }
        }
    }
}
