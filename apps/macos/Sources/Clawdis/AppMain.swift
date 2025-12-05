import AppKit
import ApplicationServices
import AsyncXPCConnection
import ClawdisIPC
import Foundation
import class Foundation.Bundle
import OSLog
import CoreGraphics
@preconcurrency import ScreenCaptureKit
import VideoToolbox
import ServiceManagement
import SwiftUI
import UserNotifications

private let serviceName = "com.steipete.clawdis.xpc"
private let launchdLabel = "com.steipete.clawdis"
private let onboardingVersionKey = "clawdis.onboardingVersion"
private let currentOnboardingVersion = 1
private let pauseDefaultsKey = "clawdis.pauseEnabled"

// MARK: - App model

@MainActor
final class AppState: ObservableObject {
    @Published var isPaused: Bool {
        didSet { UserDefaults.standard.set(isPaused, forKey: pauseDefaultsKey) }
    }
    @Published var defaultSound: String {
        didSet { UserDefaults.standard.set(defaultSound, forKey: "clawdis.defaultSound") }
    }
    @Published var launchAtLogin: Bool {
        didSet { Task { AppStateStore.updateLaunchAtLogin(enabled: launchAtLogin) } }
    }
    @Published var onboardingSeen: Bool {
        didSet { UserDefaults.standard.set(onboardingSeen, forKey: "clawdis.onboardingSeen") }
    }
    @Published var debugPaneEnabled: Bool {
        didSet { UserDefaults.standard.set(debugPaneEnabled, forKey: "clawdis.debugPaneEnabled") }
    }

    init() {
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.defaultSound = UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? ""
        self.launchAtLogin = SMAppService.mainApp.status == .enabled
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdis.debugPaneEnabled")
    }
}

@MainActor
enum AppStateStore {
    static let shared = AppState()
    static var isPausedFlag: Bool { UserDefaults.standard.bool(forKey: pauseDefaultsKey) }
    static var defaultSound: String { UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? "" }

    static func updateLaunchAtLogin(enabled: Bool) {
        if enabled {
            try? SMAppService.mainApp.register()
        } else {
            try? SMAppService.mainApp.unregister()
        }
    }
}

// MARK: - XPC service protocol

@objc protocol ClawdisXPCProtocol {
    func handle(_ data: Data, withReply reply: @escaping @Sendable (Data?, Error?) -> Void)
}

// MARK: - XPC service implementation

final class ClawdisXPCService: NSObject, ClawdisXPCProtocol {
    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "xpc")

    func handle(_ data: Data, withReply reply: @escaping @Sendable (Data?, Error?) -> Void) {
        let logger = logger
        Task.detached(priority: nil) { @Sendable in
            do {
                let request = try JSONDecoder().decode(Request.self, from: data)
                let response = try await Self.process(request: request, notifier: NotificationManager(), logger: logger)
                let encoded = try JSONEncoder().encode(response)
                reply(encoded, nil)
            } catch {
                logger.error("Failed to handle XPC request: \(error.localizedDescription, privacy: .public)")
                let resp = Response(ok: false, message: "decode/handle error: \(error.localizedDescription)")
                reply(try? JSONEncoder().encode(resp), error)
            }
        }
    }

    private static func process(request: Request, notifier: NotificationManager, logger: Logger) async throws -> Response {
        let paused = await MainActor.run { AppStateStore.isPausedFlag }
        if paused {
            return Response(ok: false, message: "clawdis paused")
        }

        switch request {
        case let .notify(title, body, sound):
            let chosenSound: String
            if let sound { chosenSound = sound } else { chosenSound = await MainActor.run { AppStateStore.defaultSound } }
            let ok = await notifier.send(title: title, body: body, sound: chosenSound)
            return ok ? Response(ok: true) : Response(ok: false, message: "notification not authorized")
        case let .ensurePermissions(caps, interactive):
            let statuses = await PermissionManager.ensure(caps, interactive: interactive)
            let missing = statuses.filter { !$0.value }.map { $0.key.rawValue }
            let ok = missing.isEmpty
            let msg = ok ? "all granted" : "missing: \(missing.joined(separator: ","))"
            return Response(ok: ok, message: msg)
        case .status:
            return Response(ok: true, message: "ready")
        case let .screenshot(displayID, windowID, _):
            let authorized = await PermissionManager.ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
            guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
            if let data = await Screenshotter.capture(displayID: displayID, windowID: windowID) {
                return Response(ok: true, payload: data)
            }
            return Response(ok: false, message: "screenshot failed")
        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            if needsSR {
                let authorized = await PermissionManager.ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
                guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
            }
            return await ShellRunner.run(command: command, cwd: cwd, env: env, timeout: timeoutSec)
        }
    }
}

// MARK: - Notification manager

@MainActor
struct NotificationManager {
    func send(title: String, body: String, sound: String?) async -> Bool {
        let center = UNUserNotificationCenter.current()
        let status = await center.notificationSettings()
        if status.authorizationStatus == .notDetermined {
            let granted = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            if granted != true { return false }
        } else if status.authorizationStatus != .authorized {
            return false
        }

        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        if let soundName = sound, !soundName.isEmpty {
            content.sound = UNNotificationSound(named: UNNotificationSoundName(soundName))
        }

        let req = UNNotificationRequest(identifier: UUID().uuidString, content: content, trigger: nil)
        do {
            try await center.add(req)
            return true
        } catch {
            return false
        }
    }
}

// MARK: - Permission manager (minimal stub)

enum PermissionManager {
    @MainActor
    static func ensure(_ caps: [Capability], interactive: Bool) async -> [Capability: Bool] {
        var results: [Capability: Bool] = [:]
        for cap in caps {
            switch cap {
            case .notifications:
                let center = UNUserNotificationCenter.current()
                let status = await center.notificationSettings()
                if status.authorizationStatus == .notDetermined && interactive {
                    _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
                    let post = await center.notificationSettings()
                    results[cap] = post.authorizationStatus == .authorized
                } else {
                    results[cap] = status.authorizationStatus == .authorized
                }
            case .accessibility:
                // Accessing AX APIs must be on main thread.
                let trusted = AXIsProcessTrusted()
                results[cap] = trusted
                if interactive && !trusted {
                    _ = AXIsProcessTrustedWithOptions(nil)
                }
            case .screenRecording:
                let granted = ScreenRecordingProbe.isAuthorized()
                if interactive && !granted {
                    await ScreenRecordingProbe.requestAuthorization()
                }
                results[cap] = ScreenRecordingProbe.isAuthorized()
            }
        }
        return results
    }

    @MainActor
    static func status(_ caps: [Capability] = Capability.allCases) async -> [Capability: Bool] {
        var results: [Capability: Bool] = [:]
        for cap in caps {
            switch cap {
            case .notifications:
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                results[cap] = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
            case .accessibility:
                results[cap] = AXIsProcessTrusted()
            case .screenRecording:
                if #available(macOS 10.15, *) {
                    results[cap] = CGPreflightScreenCaptureAccess()
                } else {
                    results[cap] = true
                }
            }
        }
        return results
    }
}

enum ScreenRecordingProbe {
    static func isAuthorized() -> Bool {
        if #available(macOS 10.15, *) {
            return CGPreflightScreenCaptureAccess()
        }
        return true
    }

    @MainActor
    static func requestAuthorization() async {
        if #available(macOS 10.15, *) {
            _ = CGRequestScreenCaptureAccess()
        }
    }
}

// MARK: - Screenshot

enum Screenshotter {
    @MainActor
    static func capture(displayID: UInt32?, windowID: UInt32?) async -> Data? {
        guard let content = try? await SCShareableContent.current else { return nil }

        let targetDisplay: SCDisplay?
        if let displayID {
            targetDisplay = content.displays.first(where: { $0.displayID == displayID })
        } else {
            targetDisplay = content.displays.first
        }

        let filter: SCContentFilter
        if let windowID, let win = content.windows.first(where: { $0.windowID == windowID }) {
            filter = SCContentFilter(desktopIndependentWindow: win)
        } else if let display = targetDisplay {
            filter = SCContentFilter(display: display, excludingWindows: [])
        } else {
            return nil
        }

        let config = SCStreamConfiguration()
        if let display = targetDisplay {
            config.width = display.width
            config.height = display.height
        }
        config.scalesToFit = true
        config.colorSpaceName = CGColorSpace.displayP3

        let stream = SCStream(filter: filter, configuration: config, delegate: nil)
        let grabber = FrameGrabber()
        try? stream.addStreamOutput(grabber, type: .screen, sampleHandlerQueue: DispatchQueue(label: "com.steipete.clawdis.sshot"))
        do {
            try await stream.startCapture()
            let data = await grabber.awaitPNG()
            try? await stream.stopCapture()
            return data
        } catch {
            return nil
        }
    }
}

final class FrameGrabber: NSObject, SCStreamOutput {
    private var continuation: CheckedContinuation<Data?, Never>?
    private var delivered = false

    func awaitPNG() async -> Data? {
        await withCheckedContinuation { cont in
            self.continuation = cont
        }
    }

    nonisolated func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of outputType: SCStreamOutputType) {
        guard outputType == .screen else { return }
        if delivered { return }
        guard let imageBuffer = sampleBuffer.imageBuffer else { return }
        var cgImage: CGImage?
        let result = VTCreateCGImageFromCVPixelBuffer(imageBuffer, options: nil, imageOut: &cgImage)
        guard result == noErr, let cgImage else { return }
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }

        delivered = true
        continuation?.resume(returning: data)
        continuation = nil
    }
}

// MARK: - Shell runner

enum ShellRunner {
    static func run(command: [String], cwd: String?, env: [String: String]?, timeout: Double?) async -> Response {
        guard !command.isEmpty else { return Response(ok: false, message: "empty command") }

        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/env")
        process.arguments = command
        if let cwd { process.currentDirectoryURL = URL(fileURLWithPath: cwd) }
        if let env { process.environment = env }

        let stdoutPipe = Pipe()
        let stderrPipe = Pipe()
        process.standardOutput = stdoutPipe
        process.standardError = stderrPipe

        do {
            try process.run()
        } catch {
            return Response(ok: false, message: "failed to start: \(error.localizedDescription)")
        }

        let waitTask = Task.detached { () -> (Int32, Data, Data) in
            process.waitUntilExit()
            let out = stdoutPipe.fileHandleForReading.readDataToEndOfFile()
            let err = stderrPipe.fileHandleForReading.readDataToEndOfFile()
            return (process.terminationStatus, out, err)
        }

        if let timeout, timeout > 0 {
            let nanos = UInt64(timeout * 1_000_000_000)
            try? await Task.sleep(nanoseconds: nanos)
            if process.isRunning {
                process.terminate()
                return Response(ok: false, message: "timeout")
            }
        }

        let (status, out, err) = await waitTask.value
        let combined = out.isEmpty ? err : out
        return Response(ok: status == 0, message: status == 0 ? nil : "exit \(status)", payload: combined)
    }
}

// MARK: - App + menu UI

@main
struct ClawdisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state: AppState

    init() {
        _state = StateObject(wrappedValue: AppStateStore.shared)
    }

    var body: some Scene {
        MenuBarExtra { MenuContent(state: state) } label: { CritterStatusLabel(isPaused: state.isPaused) }
            .menuBarExtraStyle(.menu)

        Settings {
            SettingsRootView(state: state)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        }
    }
}

private struct MenuContent: View {
    @ObservedObject var state: AppState
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Toggle(isOn: $state.isPaused) {
            Text(state.isPaused ? "Clawdis Paused" : "Pause Clawdis")
        }
        Button("Settings…") { open(tab: .general) }
            .keyboardShortcut(",", modifiers: [.command])
        Button("About Clawdis") { open(tab: .about) }
        Divider()
        Button("Test Notification") {
            Task { _ = await NotificationManager().send(title: "Clawdis", body: "Test notification", sound: nil) }
        }
        Button("Quit") { NSApplication.shared.terminate(nil) }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }
}

private struct CritterStatusLabel: View {
    var isPaused: Bool

    @State private var blinkAmount: CGFloat = 0
    @State private var nextBlink = Date().addingTimeInterval(Double.random(in: 3.5 ... 8.5))
    @State private var wiggleAngle: Double = 0
    @State private var wiggleOffset: CGFloat = 0
    @State private var nextWiggle = Date().addingTimeInterval(Double.random(in: 6.5 ... 14))
    private let ticker = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    var body: some View {
        Image(nsImage: CritterIconRenderer.makeIcon(blink: blinkAmount))
            .renderingMode(.template)
            .frame(width: 18, height: 16)
            .rotationEffect(.degrees(wiggleAngle), anchor: .center)
            .offset(x: wiggleOffset)
            .foregroundStyle(isPaused ? .secondary : .primary)
            .opacity(isPaused ? 0.45 : 1.0)
            .onReceive(ticker) { now in
                guard !isPaused else {
                    resetMotion()
                    return
                }

                if now >= nextBlink {
                    blink()
                    nextBlink = now.addingTimeInterval(Double.random(in: 3.5 ... 8.5))
                }

                if now >= nextWiggle {
                    wiggle()
                    nextWiggle = now.addingTimeInterval(Double.random(in: 6.5 ... 14))
                }
            }
            .onChange(of: isPaused) { _, paused in
                if paused {
                    resetMotion()
                } else {
                    nextBlink = Date().addingTimeInterval(Double.random(in: 1.5 ... 3.5))
                    nextWiggle = Date().addingTimeInterval(Double.random(in: 4.5 ... 9.5))
                }
            }
    }

    private func resetMotion() {
        blinkAmount = 0
        wiggleAngle = 0
        wiggleOffset = 0
    }

    private func blink() {
        withAnimation(.easeInOut(duration: 0.08)) { blinkAmount = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
            withAnimation(.easeOut(duration: 0.12)) { blinkAmount = 0 }
        }
    }

    private func wiggle() {
        let targetAngle = Double.random(in: -4.5 ... 4.5)
        let targetOffset = CGFloat.random(in: -0.5 ... 0.5)
        withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
            wiggleAngle = targetAngle
            wiggleOffset = targetOffset
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.36) {
            withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
                wiggleAngle = 0
                wiggleOffset = 0
            }
        }
    }
}

enum CritterIconRenderer {
    private static let size = NSSize(width: 18, height: 16)

    static func makeIcon(blink: CGFloat) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        defer { image.unlockFocus() }

        guard let ctx = NSGraphicsContext.current?.cgContext else { return image }

        let w = size.width
        let h = size.height

        let bodyW = w * 0.78
        let bodyH = h * 0.58
        let bodyX = (w - bodyW) / 2
        let bodyY = h * 0.36
        let bodyCorner = w * 0.09

        let earW = w * 0.22
        let earH = bodyH * 0.66
        let earCorner = earW * 0.24

        let legW = w * 0.11
        let legH = h * 0.26
        let legSpacing = w * 0.085
        let legsWidth = 4 * legW + 3 * legSpacing
        let legStartX = (w - legsWidth) / 2
        let legY = bodyY - legH + h * 0.05

        let eyeOpen = max(0.05, 1 - blink)
        let eyeW = bodyW * 0.2
        let eyeH = bodyH * 0.26 * eyeOpen
        let eyeY = bodyY + bodyH * 0.56
        let eyeOffset = bodyW * 0.24

        ctx.setFillColor(NSColor.labelColor.cgColor)

        // Body
        ctx.addPath(CGPath(roundedRect: CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH), cornerWidth: bodyCorner, cornerHeight: bodyCorner, transform: nil))
        // Ears
        ctx.addPath(CGPath(roundedRect: CGRect(x: bodyX - earW * 0.55, y: bodyY + bodyH * 0.08, width: earW, height: earH), cornerWidth: earCorner, cornerHeight: earCorner, transform: nil))
        ctx.addPath(CGPath(roundedRect: CGRect(x: bodyX + bodyW - earW * 0.45, y: bodyY + bodyH * 0.08, width: earW, height: earH), cornerWidth: earCorner, cornerHeight: earCorner, transform: nil))
        // Legs
        for i in 0 ..< 4 {
            let x = legStartX + CGFloat(i) * (legW + legSpacing)
            let rect = CGRect(x: x, y: legY, width: legW, height: legH)
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: legW * 0.34, cornerHeight: legW * 0.34, transform: nil))
        }
        ctx.fillPath()

        // Eyes punched out
        ctx.saveGState()
        ctx.setBlendMode(.clear)

        let leftCenter = CGPoint(x: w / 2 - eyeOffset, y: eyeY)
        let rightCenter = CGPoint(x: w / 2 + eyeOffset, y: eyeY)

        let left = CGMutablePath()
        left.move(to: CGPoint(x: leftCenter.x - eyeW / 2, y: leftCenter.y - eyeH))
        left.addLine(to: CGPoint(x: leftCenter.x + eyeW / 2, y: leftCenter.y))
        left.addLine(to: CGPoint(x: leftCenter.x - eyeW / 2, y: leftCenter.y + eyeH))
        left.closeSubpath()

        let right = CGMutablePath()
        right.move(to: CGPoint(x: rightCenter.x + eyeW / 2, y: rightCenter.y - eyeH))
        right.addLine(to: CGPoint(x: rightCenter.x - eyeW / 2, y: rightCenter.y))
        right.addLine(to: CGPoint(x: rightCenter.x + eyeW / 2, y: rightCenter.y + eyeH))
        right.closeSubpath()

        ctx.addPath(left)
        ctx.addPath(right)
        ctx.fillPath()
        ctx.restoreGState()

        image.isTemplate = true
        return image
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSXPCListenerDelegate {
    private var listener: NSXPCListener?
    private var state: AppState?

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        state = AppStateStore.shared
        LaunchdManager.startClawdis()
        startListener()
        scheduleFirstRunOnboardingIfNeeded()
    }

    func applicationWillTerminate(_ notification: Notification) {
        LaunchdManager.stopClawdis()
    }

    @MainActor
    private func startListener() {
        guard state != nil else { return }
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
        let interface = NSXPCInterface(with: ClawdisXPCProtocol.self)
        connection.exportedInterface = interface
        connection.exportedObject = ClawdisXPCService()
        connection.resume()
        return true
    }
}

// MARK: - Settings UI

struct SettingsRootView: View {
    @ObservedObject var state: AppState
    @State private var permStatus: [Capability: Bool] = [:]
    @State private var loadingPerms = false
    @State private var selectedTab: SettingsTab = .general

    var body: some View {
        TabView(selection: $selectedTab) {
            GeneralSettings(state: state)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)

            PermissionsSettings(status: permStatus, refresh: refreshPerms, showOnboarding: { OnboardingController.shared.show() })
                .tabItem { Label("Permissions", systemImage: "lock.shield") }
                .tag(SettingsTab.permissions)

            if state.debugPaneEnabled {
                DebugSettings()
                    .tabItem { Label("Debug", systemImage: "ant") }
                    .tag(SettingsTab.debug)
            }

            AboutSettings()
                .tabItem { Label("About", systemImage: "info.circle") }
                .tag(SettingsTab.about)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 14)
        .onReceive(NotificationCenter.default.publisher(for: .clawdisSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    selectedTab = tab
                }
            }
        }
        .onAppear {
            if let pending = SettingsTabRouter.consumePending() {
                selectedTab = validTab(for: pending)
            }
        }
        .onChange(of: state.debugPaneEnabled) { _, enabled in
            if !enabled && selectedTab == .debug {
                selectedTab = .general
            }
        }
        .task { await refreshPerms() }
    }

    private func validTab(for requested: SettingsTab) -> SettingsTab {
        if requested == .debug && !state.debugPaneEnabled { return .general }
        return requested
    }

    @MainActor
    private func refreshPerms() async {
        guard !loadingPerms else { return }
        loadingPerms = true
        permStatus = await PermissionManager.status()
        loadingPerms = false
    }
}

enum SettingsTab: CaseIterable {
    case general, permissions, debug, about
    static let windowWidth: CGFloat = 460
    static let windowHeight: CGFloat = 500
    var title: String {
        switch self {
        case .general: return "General"
        case .permissions: return "Permissions"
        case .debug: return "Debug"
        case .about: return "About"
        }
    }
}

@MainActor
enum SettingsTabRouter {
    private static var pending: SettingsTab?

    static func request(_ tab: SettingsTab) {
        self.pending = tab
    }

    static func consumePending() -> SettingsTab? {
        defer { self.pending = nil }
        return self.pending
    }
}

extension Notification.Name {
    static let clawdisSelectSettingsTab = Notification.Name("clawdisSelectSettingsTab")
}

struct GeneralSettings: View {
    @ObservedObject var state: AppState
    @State private var isInstallingCLI = false
    @State private var cliStatus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            if !state.onboardingSeen {
                Label("Complete onboarding to finish setup", systemImage: "sparkles")
                    .foregroundColor(.accentColor)
                    .padding(.bottom, 4)
            }

            VStack(alignment: .leading, spacing: 10) {
                Toggle(isOn: activeBinding) { Text(activeBinding.wrappedValue ? "Clawdis Active" : "Clawdis Paused") }
                    .help("Disable to stop Clawdis background helpers and notifications")
                Toggle(isOn: $state.launchAtLogin) { Text("Launch at login") }
                #if DEBUG
                Toggle(isOn: $state.debugPaneEnabled) { Text("Enable debug tools") }
                    .help("Show the Debug tab with development utilities")
                #endif

                LabeledContent("Default sound") {
                    Picker("Sound", selection: $state.defaultSound) {
                        Text("None").tag("")
                        Text("Glass").tag("Glass")
                        Text("Basso").tag("Basso")
                        Text("Ping").tag("Ping")
                    }
                    .labelsHidden()
                    .frame(width: 140)
                }
            }
            .padding(14)
            .background(RoundedRectangle(cornerRadius: 12).fill(Color(NSColor.controlBackgroundColor)))

            GroupBox("CLI helper") {
                cliInstaller
            }
            .groupBoxStyle(.automatic)

            Spacer()
            HStack {
                Spacer()
                Button("Quit Clawdis") { NSApp.terminate(nil) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { !state.isPaused },
            set: { state.isPaused = !$0 }
        )
    }

    private var cliInstaller: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    Task { await installCLI() }
                } label: {
                    if isInstallingCLI {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Install CLI helper")
                    }
                }
                .disabled(isInstallingCLI)

                if let status = cliStatus {
                    Text(status)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
            Text("Symlink \"clawdis-mac\" into /usr/local/bin and /opt/homebrew/bin for scripts.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .padding(.leading, 2)
        }
    }

    private func installCLI() async {
        guard !isInstallingCLI else { return }
        isInstallingCLI = true
        defer { isInstallingCLI = false }
        await CLIInstaller.install { status in
            await MainActor.run { cliStatus = status }
        }
    }
}

struct PermissionsSettings: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void
    let showOnboarding: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Allow these so Clawdis can notify and capture when needed.")
                .padding(.top, 4)

            PermissionStatusList(status: status, refresh: refresh)
                .padding(14)
                .background(RoundedRectangle(cornerRadius: 12).fill(Color(NSColor.controlBackgroundColor)))

            Button("Show onboarding") { showOnboarding() }
                .buttonStyle(.bordered)
            Spacer()
        }
    }
}

struct DebugSettings: View {
    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("PID") { Text("\(ProcessInfo.processInfo.processIdentifier)") }
            LabeledContent("Log file") {
                Button("Open /tmp/clawdis.log") { NSWorkspace.shared.open(URL(fileURLWithPath: "/tmp/clawdis.log")) }
            }
            LabeledContent("Binary path") { Text(Bundle.main.bundlePath).font(.footnote) }
            HStack {
                Button("Restart app") { relaunch() }
                Button("Reveal app in Finder") { revealApp() }
            }
            .buttonStyle(.bordered)
            Spacer()
        }
    }

    private func relaunch() {
        let url = Bundle.main.bundleURL
        let task = Process()
        task.launchPath = "/usr/bin/open"
        task.arguments = [url.path]
        try? task.run()
        task.waitUntilExit()
        NSApp.terminate(nil)
    }

    private func revealApp() {
        let url = Bundle.main.bundleURL
        NSWorkspace.shared.activateFileViewerSelecting([url])
    }
}

struct AboutSettings: View {
    @State private var iconHover = false

    var body: some View {
        VStack(spacing: 14) {
            let appIcon = NSApplication.shared.applicationIconImage ?? CritterIconRenderer.makeIcon(blink: 0)
            Button {
                if let url = URL(string: "https://github.com/steipete/warelay") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Image(nsImage: appIcon)
                    .resizable()
                    .frame(width: 88, height: 88)
                    .cornerRadius(18)
                    .shadow(color: iconHover ? .accentColor.opacity(0.25) : .clear, radius: 8)
                    .scaleEffect(iconHover ? 1.06 : 1.0)
            }
            .buttonStyle(.plain)
            .onHover { hover in
                withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) { iconHover = hover }
            }

            VStack(spacing: 4) {
                Text("Clawdis")
                    .font(.title3.bold())
                Text("Version \(versionString)")
                    .foregroundStyle(.secondary)
                Text("Menu bar companion for notifications, screenshots, and privileged agent actions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 24)
            }

            VStack(alignment: .center, spacing: 8) {
                AboutLinkRow(icon: "chevron.left.slash.chevron.right", title: "GitHub", url: "https://github.com/steipete/warelay")
                AboutLinkRow(icon: "globe", title: "Website", url: "https://steipete.me")
                AboutLinkRow(icon: "bird", title: "Twitter", url: "https://twitter.com/steipete")
                AboutLinkRow(icon: "envelope", title: "Email", url: "mailto:[redacted-email]")
            }
            .padding(.vertical, 10)

            Text("© 2025 Peter Steinberger — MIT License.")
                .font(.footnote)
                .foregroundStyle(.secondary)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .padding(.top, 18)
        .padding(.horizontal, 18)
        .padding(.bottom, 22)
    }

    private var versionString: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return build.map { "\(version) (\($0))" } ?? version
    }
}

@MainActor
private struct AboutLinkRow: View {
    let icon: String
    let title: String
    let url: String

    @State private var hovering = false

    var body: some View {
        Button {
            if let url = URL(string: url) { NSWorkspace.shared.open(url) }
        } label: {
            HStack(spacing: 6) {
                Image(systemName: icon)
                Text(title)
                    .underline(hovering, color: .accentColor)
            }
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
        .onHover { hovering = $0 }
    }
}

struct PermissionStatusList: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Capability.allCases, id: \.self) { cap in
                PermissionRow(capability: cap, status: status[cap] ?? false) {
                    Task { await handle(cap) }
                }
            }
            Button("Refresh status") { Task { await refresh() } }
                .font(.footnote)
                .padding(.top, 2)
        }
    }

    @MainActor
    private func handle(_ cap: Capability) async {
        Task {
            switch cap {
            case .notifications:
                let center = UNUserNotificationCenter.current()
                _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            case .accessibility:
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            case .screenRecording:
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording")
            }
            await refresh()
        }
    }

    private func openSettings(_ path: String) {
        if let url = URL(string: path) {
            NSWorkspace.shared.open(url)
        }
    }
}

enum LaunchdManager {
    private static func runLaunchctl(_ args: [String]) {
        let process = Process()
        process.launchPath = "/bin/launchctl"
        process.arguments = args
        try? process.run()
    }

    static func startClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        runLaunchctl(["kickstart", "-k", userTarget])
    }

    static func stopClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        runLaunchctl(["stop", userTarget])
    }
}

@MainActor
enum CLIInstaller {
    static func install(statusHandler: @escaping @Sendable (String) async -> Void) async {
        let helper = Bundle.main.bundleURL.appendingPathComponent("Contents/MacOS/ClawdisCLI")
        guard FileManager.default.isExecutableFile(atPath: helper.path) else {
            await statusHandler("Helper missing in bundle; rebuild via scripts/package-mac-app.sh")
            return
        }

        let targets = ["/usr/local/bin/clawdis-mac", "/opt/homebrew/bin/clawdis-mac"]
        var messages: [String] = []
        for target in targets {
            do {
                try FileManager.default.createDirectory(atPath: (target as NSString).deletingLastPathComponent, withIntermediateDirectories: true)
                try? FileManager.default.removeItem(atPath: target)
                try FileManager.default.createSymbolicLink(atPath: target, withDestinationPath: helper.path)
                messages.append("Linked \(target)")
            } catch {
                messages.append("Failed \(target): \(error.localizedDescription)")
            }
        }
        await statusHandler(messages.joined(separator: "; "))
    }
}

private struct PermissionRow: View {
    let capability: Capability
    let status: Bool
    let action: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            ZStack {
                Circle().fill(status ? Color.green.opacity(0.2) : Color.gray.opacity(0.15))
                    .frame(width: 32, height: 32)
                Image(systemName: icon)
                    .foregroundStyle(status ? Color.green : Color.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.body.weight(.semibold))
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if status {
                Label("Granted", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Button("Grant") { action() }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 6)
    }

    private var title: String {
        switch capability {
        case .notifications: return "Notifications"
        case .accessibility: return "Accessibility"
        case .screenRecording: return "Screen Recording"
        }
    }

    private var subtitle: String {
        switch capability {
        case .notifications: return "Show desktop alerts for agent activity"
        case .accessibility: return "Control UI elements when an action requires it"
        case .screenRecording: return "Capture the screen for context or screenshots"
        }
    }

    private var icon: String {
        switch capability {
        case .notifications: return "bell" 
        case .accessibility: return "hand.raised" 
        case .screenRecording: return "display" 
        }
    }
}

// MARK: - Onboarding (VibeTunnel-style, multi-step)

@MainActor
final class OnboardingController {
    static let shared = OnboardingController()
    private var window: NSWindow?

    func show() {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let hosting = NSHostingController(rootView: OnboardingView())
        let window = NSWindow(contentViewController: hosting)
        window.title = "Welcome to Clawdis"
        window.setContentSize(NSSize(width: 640, height: 520))
        window.styleMask = [.titled, .closable]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        window?.close()
        window = nil
    }
}

struct OnboardingView: View {
    @State private var stepIndex = 0
    @State private var permStatus: [Capability: Bool] = [:]
    @State private var copied = false
    @State private var isRequesting = false
    @ObservedObject private var state = AppStateStore.shared

    private var steps: [OnboardingStep] {
        [
            .init(title: "Meet Clawdis", detail: "A focused menu bar companion for notifications, screenshots, and privileged agent actions.", systemImage: "sparkles"),
            .init(title: "Permissions", detail: "Grant Notifications, Accessibility, and Screen Recording so tasks don't get blocked.", systemImage: "lock.shield", showsPermissions: true),
            .init(title: "CLI helper", detail: "Install the `clawdis-mac` helper so scripts can talk to the app.", systemImage: "terminal", showsCLI: true),
            .init(title: "Stay running", detail: "Enable launch at login so Clawdis is ready before the agent asks.", systemImage: "arrow.triangle.2.circlepath", showsLogin: true),
            .init(title: "You're set", detail: "Keep Clawdis running, pause from the menu anytime, and re-run onboarding later if needed.", systemImage: "checkmark.seal")
        ]
    }

    var body: some View {
        let step = steps[stepIndex]
        VStack(spacing: 18) {
            heroHeader(step: step)
            contentCard(step: step)
            progressDots
            footerButtons
        }
        .padding(22)
        .background(Color(NSColor.windowBackgroundColor))
        .task { await refreshPerms() }
    }

    @ViewBuilder
    private func heroHeader(step: OnboardingStep) -> some View {
        HStack(spacing: 16) {
            ZStack {
                LinearGradient(colors: [.accentColor.opacity(0.75), .purple.opacity(0.65)], startPoint: .topLeading, endPoint: .bottomTrailing)
                    .frame(width: 96, height: 96)
                    .clipShape(RoundedRectangle(cornerRadius: 22, style: .continuous))
                    .shadow(color: .accentColor.opacity(0.35), radius: 12, y: 6)
                Image(nsImage: CritterIconRenderer.makeIcon(blink: 0))
                    .resizable()
                    .renderingMode(.template)
                    .foregroundStyle(.white)
                    .frame(width: 54, height: 48)
            }

            VStack(alignment: .leading, spacing: 6) {
                Label(step.title, systemImage: step.systemImage)
                    .font(.title3.bold())
                Text(step.detail)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    @ViewBuilder
    private func contentCard(step: OnboardingStep) -> some View {
        VStack(alignment: .leading, spacing: 14) {
            if step.showsPermissions {
                permissionsCard
            }
            if step.showsCLI {
                CLIInstallCard(copied: $copied)
            }
            if step.showsLoginToggle {
                loginCard
            }
            if !step.showsPermissions && !step.showsCLI {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Keep Clawdis running in your menu bar. Pause from the menu if you need silence, or open Settings to adjust permissions later.")
                    Button("Open Settings") {
                        NSApp.activate(ignoringOtherApps: true)
                        SettingsTabRouter.request(.general)
                        NSApplication.shared.sendAction(Selector(("showPreferencesWindow:")), to: nil, from: nil)
                    }
                }
            }
        }
        .padding(16)
        .background(RoundedRectangle(cornerRadius: 16, style: .continuous).fill(Color(NSColor.controlBackgroundColor)))
    }

    private var loginCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            Text("Launch at login")
                .font(.headline)
            Text("Keep the companion ready before automations start. You can change this anytime in Settings.")
                .font(.subheadline)
                .foregroundStyle(.secondary)
            Toggle("Enable launch at login", isOn: $state.launchAtLogin)
                .toggleStyle(.switch)
                .onChange(of: state.launchAtLogin) { _, newValue in
                    AppStateStore.updateLaunchAtLogin(enabled: newValue)
                }
        }
    }

    private var permissionsCard: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Give Clawdis the access it needs")
                .font(.headline)
            Text("Grant these once; the CLI will reuse the same approvals.")
                .font(.subheadline)
                .foregroundStyle(.secondary)

            ForEach(Capability.allCases, id: \.self) { cap in
                PermissionRow(capability: cap, status: permStatus[cap] ?? false) {
                    Task { await request(cap) }
                }
            }

            Button("Refresh status") { Task { await refreshPerms() } }
                .font(.footnote)
                .padding(.top, 4)
        }
    }

    private var progressDots: some View {
        HStack(spacing: 8) {
            ForEach(Array(steps.indices), id: \.self) { idx in
                Circle()
                    .fill(idx == stepIndex ? Color.accentColor : Color.gray.opacity(0.4))
                    .frame(width: 8, height: 8)
                    .scaleEffect(idx == stepIndex ? 1.25 : 1.0)
                    .animation(.spring(response: 0.35, dampingFraction: 0.7), value: stepIndex)
            }
            Spacer()
        }
        .padding(.horizontal, 4)
    }

    private var footerButtons: some View {
        HStack {
            Button("Skip") { finish() }
                .buttonStyle(.plain)
            Spacer()
            if stepIndex > 0 {
                Button("Back") { stepIndex = max(0, stepIndex - 1) }
            }
            Button(stepIndex == steps.count - 1 ? "Finish" : "Next") { advance() }
                .buttonStyle(.borderedProminent)
        }
        .padding(.top, 4)
    }

    private func advance() {
        if stepIndex + 1 < steps.count {
            stepIndex += 1
        } else {
            finish()
        }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "clawdis.onboardingSeen")
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        OnboardingController.shared.close()
    }

    @MainActor
    private func refreshPerms() async {
        permStatus = await PermissionManager.status()
    }

    @MainActor
    private func request(_ cap: Capability) async {
        guard !isRequesting else { return }
        isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await refreshPerms()
    }
}

struct OnboardingStep {
    let title: String
    let detail: String
    let systemImage: String
    var showsPermissions: Bool = false
    var showsCLI: Bool = false
    var showsLogin: Bool = false

    var showsLoginToggle: Bool { showsLogin }
}

struct CLIInstallCard: View {
    @Binding var copied: Bool
    @State private var installing = false
    @State private var status: String?
    private let command = "ln -sf $(pwd)/apps/macos/.build/debug/ClawdisCLI /usr/local/bin/clawdis-mac"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Install the helper CLI")
                .font(.headline)
            Text("Link `clawdis-mac` so scripts and the agent can call the companion.")

            HStack(spacing: 10) {
                Button {
                    Task {
                        guard !installing else { return }
                        installing = true
                        defer { installing = false }
                        await CLIInstaller.install { msg in await MainActor.run { status = msg } }
                    }
                } label: {
                    if installing { ProgressView() } else { Text("Install helper") }
                }
                .buttonStyle(.borderedProminent)

                Button(copied ? "Copied" : "Copy command") {
                    copyToPasteboard(command)
                }
                .disabled(installing)
            }

            if let status {
                Text(status)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            Text("You can rerun this anytime; we install into /usr/local/bin and /opt/homebrew/bin.")
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    private func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { copied = false }
    }
}
