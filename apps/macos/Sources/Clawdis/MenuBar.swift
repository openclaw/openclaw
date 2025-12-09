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
    private let menuDelegate = StatusMenuDelegate()

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
            self.attachMenuDelegate(to: item)
        }
        .onChange(of: self.state.isPaused) { _, paused in
            self.applyStatusItemAppearance(paused: paused)
            self.gatewayManager.setActive(!paused)
        }

        Settings {
            SettingsRootView(state: self.state, updater: self.delegate.updaterController)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        }
        .defaultSize(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        .windowResizability(.contentSize)
    }

    private func applyStatusItemAppearance(paused: Bool) {
        self.statusItem?.button?.appearsDisabled = paused
    }

    @MainActor
    private func installStatusItemMouseHandler(for item: NSStatusItem) {
        guard let button = item.button else { return }
        if button.subviews.contains(where: { $0 is StatusItemMouseHandlerView }) { return }

        WebChatManager.shared.onPanelVisibilityChanged = { [self] visible in
            self.statusItem?.button?.highlight(visible)
        }

        self.menuDelegate.button = button

        let handler = StatusItemMouseHandlerView()
        handler.translatesAutoresizingMaskIntoConstraints = false
        handler.onLeftClick = { [self] in self.toggleWebChatPanel() }
        handler.onRightClick = { WebChatManager.shared.closePanel() }

        button.addSubview(handler)
        NSLayoutConstraint.activate([
            handler.leadingAnchor.constraint(equalTo: button.leadingAnchor),
            handler.trailingAnchor.constraint(equalTo: button.trailingAnchor),
            handler.topAnchor.constraint(equalTo: button.topAnchor),
            handler.bottomAnchor.constraint(equalTo: button.bottomAnchor)
        ])
    }

    @MainActor
    private func attachMenuDelegate(to item: NSStatusItem) {
        guard let menu = item.menu else { return }
        self.menuDelegate.button = item.button
        menu.delegate = self.menuDelegate
    }

    @MainActor
    private func toggleWebChatPanel() {
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
        super.rightMouseDown(with: event) // forward to MenuBarExtra so the menu still opens
    }
}

private final class StatusMenuDelegate: NSObject, NSMenuDelegate {
    weak var button: NSStatusBarButton?

    func menuWillOpen(_ menu: NSMenu) {
        self.button?.highlight(true)
    }

    func menuDidClose(_ menu: NSMenu) {
        self.button?.highlight(false)
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSXPCListenerDelegate {
    private var listener: NSXPCListener?
    private var state: AppState?
    private let xpcLogger = Logger(subsystem: "com.steipete.clawdis", category: "xpc")
    private let webChatAutoLogger = Logger(subsystem: "com.steipete.clawdis", category: "WebChat")
    // Only clients signed with this team ID may talk to the XPC service (hard-fails if mismatched).
    private let allowedTeamIDs: Set<String> = ["Y5PE65HELJ"]
    let updaterController: UpdaterProviding = makeUpdaterController()

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        if self.isDuplicateInstance() {
            NSApp.terminate(nil)
            return
        }
        self.state = AppStateStore.shared
        AppActivationPolicy.apply(showDockIcon: self.state?.showDockIcon ?? false)
        if let state {
            GatewayProcessManager.shared.setActive(!state.isPaused)
        }
        Task {
            await ControlChannel.shared.configure()
            PresenceReporter.shared.start()
        }
        Task { await HealthStore.shared.refresh(onDemand: true) }
        self.startListener()
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
        Task { await AgentRPC.shared.shutdown() }
    }

    @MainActor
    private func startListener() {
        guard self.state != nil else { return }
        let listener = NSXPCListener(machServiceName: serviceName)
        listener.delegate = self
        listener.resume()
        self.listener = listener
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

    func listener(_ listener: NSXPCListener, shouldAcceptNewConnection connection: NSXPCConnection) -> Bool {
        guard self.isAllowed(connection: connection) else {
            self.xpcLogger.error("Rejecting XPC connection: team ID mismatch or invalid audit token")
            connection.invalidate()
            return false
        }
        let interface = NSXPCInterface(with: ClawdisXPCProtocol.self)
        connection.exportedInterface = interface
        connection.exportedObject = ClawdisXPCService()
        connection.resume()
        return true
    }

    private func isDuplicateInstance() -> Bool {
        guard let bundleID = Bundle.main.bundleIdentifier else { return false }
        let running = NSWorkspace.shared.runningApplications.filter { $0.bundleIdentifier == bundleID }
        return running.count > 1
    }

    private func isAllowed(connection: NSXPCConnection) -> Bool {
        let pid = connection.processIdentifier
        guard pid > 0 else { return false }

        // Same-user shortcut: allow quickly when caller uid == ours.
        if let callerUID = self.uid(for: pid), callerUID == getuid() {
            return true
        }

        let attrs: NSDictionary = [kSecGuestAttributePid: pid]
        if self.teamIDMatches(attrs: attrs) { return true }

        return false
    }

    private func uid(for pid: pid_t) -> uid_t? {
        var info = kinfo_proc()
        var size = MemoryLayout.size(ofValue: info)
        var mib: [Int32] = [CTL_KERN, KERN_PROC, KERN_PROC_PID, pid]
        let ok = mib.withUnsafeMutableBufferPointer { mibPtr -> Bool in
            return sysctl(mibPtr.baseAddress, u_int(mibPtr.count), &info, &size, nil, 0) == 0
        }
        return ok ? info.kp_eproc.e_ucred.cr_uid : nil
    }

    private func teamIDMatches(attrs: NSDictionary) -> Bool {
        var secCode: SecCode?
        guard SecCodeCopyGuestWithAttributes(nil, attrs, SecCSFlags(), &secCode) == errSecSuccess,
              let code = secCode else { return false }

        var staticCode: SecStaticCode?
        guard SecCodeCopyStaticCode(code, SecCSFlags(), &staticCode) == errSecSuccess,
              let sCode = staticCode else { return false }

        var infoCF: CFDictionary?
        guard SecCodeCopySigningInformation(sCode, SecCSFlags(), &infoCF) == errSecSuccess,
              let info = infoCF as? [String: Any],
              let teamID = info[kSecCodeInfoTeamIdentifier as String] as? String
        else {
            return false
        }

        return self.allowedTeamIDs.contains(teamID)
    }

    @MainActor
    private func writeEndpoint(_ endpoint: NSXPCListenerEndpoint) {}
    @MainActor private func writeEndpointIfAvailable() {}
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
