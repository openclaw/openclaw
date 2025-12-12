import AppKit
import Darwin
import Foundation
import MenuBarExtraAccess
import OSLog
import Security
import SwiftUI

@main
struct ClawdisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state: AppState
    @StateObject private var gatewayManager = GatewayProcessManager.shared
    @StateObject private var activityStore = WorkActivityStore.shared
    @State private var statusItem: NSStatusItem?
    @State private var isMenuPresented = false
    @State private var isPanelVisible = false

    @MainActor
    private func updateStatusHighlight() {
        self.statusItem?.button?.highlight(self.isPanelVisible)
    }

    init() {
        _state = StateObject(wrappedValue: AppStateStore.shared)
    }

    var body: some Scene {
        MenuBarExtra { MenuContent(state: self.state, updater: self.delegate.updaterController) } label: {
            CritterStatusLabel(
                isPaused: self.state.isPaused,
                isWorking: self.state.isWorking,
                earBoostActive: self.state.earBoostActive,
                blinkTick: self.state.blinkTick,
                sendCelebrationTick: self.state.sendCelebrationTick,
                gatewayStatus: self.gatewayManager.status,
                animationsEnabled: self.state.iconAnimationsEnabled,
                iconState: self.effectiveIconState)
        }
        .menuBarExtraStyle(.menu)
        .menuBarExtraAccess(isPresented: self.$isMenuPresented) { item in
            self.statusItem = item
            self.applyStatusItemAppearance(paused: self.state.isPaused)
            self.installStatusItemMouseHandler(for: item)
        }
        .onChange(of: self.state.isPaused) { _, paused in
            self.applyStatusItemAppearance(paused: paused)
            if self.state.connectionMode == .local {
                self.gatewayManager.setActive(!paused)
            } else {
                self.gatewayManager.stop()
            }
        }
        .onChange(of: self.state.connectionMode) { _, mode in
            Task { await ConnectionModeCoordinator.shared.apply(mode: mode, paused: self.state.isPaused) }
        }

        Settings {
            SettingsRootView(state: self.state, updater: self.delegate.updaterController)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        }
        .defaultSize(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        .windowResizability(.contentSize)
        .onChange(of: self.isMenuPresented) { _, _ in
            self.updateStatusHighlight()
        }
    }

    private func applyStatusItemAppearance(paused: Bool) {
        self.statusItem?.button?.appearsDisabled = paused
    }

    @MainActor
    private func installStatusItemMouseHandler(for item: NSStatusItem) {
        guard let button = item.button else { return }
        if button.subviews.contains(where: { $0 is StatusItemMouseHandlerView }) { return }

        WebChatManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.isPanelVisible = visible
            self.updateStatusHighlight()
        }
        CanvasManager.shared.defaultAnchorProvider = { [self] in self.statusButtonScreenFrame() }

        let handler = StatusItemMouseHandlerView()
        handler.translatesAutoresizingMaskIntoConstraints = false
        handler.onLeftClick = { [self] in self.toggleWebChatPanel() }
        handler.onRightClick = { [self] in
            WebChatManager.shared.closePanel()
            self.isMenuPresented = true
            self.updateStatusHighlight()
        }

        button.addSubview(handler)
        NSLayoutConstraint.activate([
            handler.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            handler.trailingAnchor.constraint(equalTo: button.trailingAnchor),
            handler.topAnchor.constraint(equalTo: button.topAnchor),
            handler.bottomAnchor.constraint(equalTo: button.bottomAnchor),
        ])
    }

    @MainActor
    private func toggleWebChatPanel() {
        guard AppStateStore.webChatEnabled else {
            self.isMenuPresented = true
            return
        }
        self.isMenuPresented = false
        WebChatManager.shared.togglePanel(
            sessionKey: WebChatManager.shared.preferredSessionKey(),
            anchorProvider: { [self] in self.statusButtonScreenFrame() })
    }

    @MainActor
    private func statusButtonScreenFrame() -> NSRect? {
        guard let button = self.statusItem?.button, let window = button.window else { return nil }
        return window.convertToScreen(button.frame)
    }

    private var effectiveIconState: IconState {
        let selection = self.state.iconOverride
        if selection == .system {
            return self.activityStore.iconState
        }
        let overrideState = selection.toIconState()
        switch overrideState {
        case let .workingMain(kind): return .overridden(kind)
        case let .workingOther(kind): return .overridden(kind)
        case .idle: return .idle
        case let .overridden(kind): return .overridden(kind)
        }
    }
}

/// Transparent overlay that intercepts clicks without stealing MenuBarExtra ownership.
private final class StatusItemMouseHandlerView: NSView {
    var onLeftClick: (() -> Void)?
    var onRightClick: (() -> Void)?

    override func mouseDown(with event: NSEvent) {
        if let onLeftClick {
            onLeftClick()
        } else {
            super.mouseDown(with: event)
        }
    }

    override func rightMouseDown(with event: NSEvent) {
        self.onRightClick?()
        // Do not call super; menu will be driven by isMenuPresented binding.
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate {
    private var state: AppState?
    private let webChatAutoLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")
    private let socketServer = ControlSocketServer()
    let updaterController: UpdaterProviding = makeUpdaterController()

    func application(_: NSApplication, open urls: [URL]) {
        Task { @MainActor in
            for url in urls {
                await DeepLinkHandler.shared.handle(url: url)
            }
        }
    }

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        if self.isDuplicateInstance() {
            NSApp.terminate(nil)
            return
        }
        self.state = AppStateStore.shared
        AppActivationPolicy.apply(showDockIcon: self.state?.showDockIcon ?? false)
        if let state {
            Task { await ConnectionModeCoordinator.shared.apply(mode: state.connectionMode, paused: state.isPaused) }
        }
        Task { PresenceReporter.shared.start() }
        Task { await HealthStore.shared.refresh(onDemand: true) }
        Task { await PortGuardian.shared.sweep(mode: AppStateStore.shared.connectionMode) }
        Task { await self.socketServer.start() }
        Task { await BridgeServer.shared.start() }
        self.scheduleFirstRunOnboardingIfNeeded()

        // Developer/testing helper: auto-open WebChat when launched with --webchat
        if CommandLine.arguments.contains("--webchat") {
            self.webChatAutoLogger.debug("Auto-opening web chat via --webchat flag")
            WebChatManager.shared.show(sessionKey: "main")
        }
    }

    func applicationWillTerminate(_ notification: Notification) {
        GatewayProcessManager.shared.stop()
        PresenceReporter.shared.stop()
        WebChatManager.shared.close()
        WebChatManager.shared.resetTunnels()
        Task { await RemoteTunnelManager.shared.stopAll() }
        Task { await AgentRPC.shared.shutdown() }
        Task { await GatewayConnection.shared.shutdown() }
        Task { await self.socketServer.stop() }
        Task { await BridgeServer.shared.stop() }
    }

    @MainActor
    private func scheduleFirstRunOnboardingIfNeeded() {
        let seenVersion = UserDefaults.standard.integer(forKey: onboardingVersionKey)
        let shouldShow = seenVersion < currentOnboardingVersion || !AppStateStore.shared.onboardingSeen
        guard shouldShow else { return }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.6) {
            OnboardingController.shared.show()
        }
    }

    private func isDuplicateInstance() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
        return running.count > 1
    }
}

// MARK: - Sparkle updater (disabled for unsigned/dev builds)

@MainActor
protocol UpdaterProviding: AnyObject {
    var automaticallyChecksForUpdates: Bool { get set }
    var isAvailable: Bool { get }
    func checkForUpdates(_ sender: Any?)
}

// No-op updater used for debug/dev runs to suppress Sparkle dialogs.
final class DisabledUpdaterController: UpdaterProviding {
    var automaticallyChecksForUpdates: Bool = false
    let isAvailable: Bool = false
    func checkForUpdates(_: Any?) {}
}

#if canImport(Sparkle)
import Sparkle

extension SPUStandardUpdaterController: UpdaterProviding {
    var automaticallyChecksForUpdates: Bool {
        get { self.updater.automaticallyChecksForUpdates }
        set { self.updater.automaticallyChecksForUpdates = newValue }
    }

    var isAvailable: Bool { true }
}

private func isDeveloperIDSigned(bundleURL: URL) -> Bool {
    var staticCode: SecStaticCode?
    guard SecStaticCodeCreateWithPath(bundleURL as CFURL, SecCSFlags(), &staticCode) == errSecSuccess,
          let code = staticCode
    else { return false }

    var infoCF: CFDictionary?
    guard SecCodeCopySigningInformation(code, SecCSFlags(rawValue: kSecCSSigningInformation), &infoCF) == errSecSuccess,
          let info = infoCF as? [String: Any],
          let certs = info[kSecCodeInfoCertificates as String] as? [SecCertificate],
          let leaf = certs.first
    else {
        return false
    }

    if let summary = SecCertificateCopySubjectSummary(leaf) as String? {
        return summary.hasPrefix("Developer ID Application:")
    }
    return false
}

private func makeUpdaterController() -> UpdaterProviding {
    let bundleURL = Bundle.main.bundleURL
    let isBundledApp = bundleURL.pathExtension == "app"
    guard isBundledApp, isDeveloperIDSigned(bundleURL: bundleURL) else { return DisabledUpdaterController() }

    let defaults = UserDefaults.standard
    let autoUpdateKey = "autoUpdateEnabled"
    // Default to true; honor the user's last choice otherwise.
    let savedAutoUpdate = (defaults.object(forKey: autoUpdateKey) as? Bool) ?? true

    let controller = SPUStandardUpdaterController(
        startingUpdater: false,
        updaterDelegate: nil,
        userDriverDelegate: nil)
    controller.updater.automaticallyChecksForUpdates = savedAutoUpdate
    controller.startUpdater()
    return controller
}
#else
private func makeUpdaterController() -> UpdaterProviding {
    DisabledUpdaterController()
}
#endif
