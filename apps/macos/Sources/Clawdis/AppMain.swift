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

    init() {
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.defaultSound = UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? ""
        self.launchAtLogin = SMAppService.mainApp.status == .enabled
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
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
        MenuBarExtra { menuContent } label: { CritterStatusLabel(isPaused: state.isPaused) }
            .menuBarExtraStyle(.menu)

        Settings {
            SettingsRootView(state: state)
                .frame(minWidth: 520, minHeight: 420)
        }
    }

    @ViewBuilder
    private var menuContent: some View {
        Toggle(isOn: $state.isPaused) {
            Text(state.isPaused ? "Clawdis Paused" : "Pause Clawdis")
        }
        Divider()
        Button("Test Notification") {
            Task { _ = await NotificationManager().send(title: "Clawdis", body: "Test notification", sound: nil) }
        }
        Divider()
        Button("Permissions…") { PermissionsSheetController.shared.show(state: state) }
        Button("Quit") { NSApplication.shared.terminate(nil) }
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
        CritterGlyph(blinkAmount: blinkAmount)
            .frame(width: 16, height: 16)
            .rotationEffect(.degrees(wiggleAngle), anchor: .center)
            .offset(x: wiggleOffset)
            .foregroundStyle(isPaused ? .secondary : .primary)
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

struct CritterGlyph: View {
    var blinkAmount: CGFloat

    var body: some View {
        GeometryReader { geo in
            let w = geo.size.width
            let h = geo.size.height

            let bodyWidth = w * 0.78
            let bodyHeight = h * 0.58
            let bodyRect = CGRect(x: (w - bodyWidth) / 2, y: h * 0.18, width: bodyWidth, height: bodyHeight)

            let armWidth = w * 0.2
            let armHeight = bodyHeight * 0.6
            let armCorner = armWidth * 0.24

            let legWidth = w * 0.11
            let legHeight = h * 0.26
            let legSpacing = w * 0.08
            let legStartX = bodyRect.minX + w * 0.05
            let legY = bodyRect.maxY - legHeight * 0.2

            let eyeOpen = max(0.02, 1 - blinkAmount)
            let eyeWidth = bodyWidth * 0.18
            let eyeHeight = bodyHeight * 0.22 * eyeOpen
            let eyeY = bodyRect.midY - bodyHeight * 0.08
            let eyeOffset = bodyWidth * 0.2

            Path { path in
                path.addRoundedRect(in: bodyRect, cornerSize: CGSize(width: w * 0.08, height: w * 0.08))

                path.addRoundedRect(
                    in: CGRect(x: bodyRect.minX - armWidth * 0.65, y: bodyRect.midY - armHeight / 2, width: armWidth, height: armHeight),
                    cornerSize: CGSize(width: armCorner, height: armCorner)
                )

                path.addRoundedRect(
                    in: CGRect(x: bodyRect.maxX - armWidth * 0.35, y: bodyRect.midY - armHeight / 2, width: armWidth, height: armHeight),
                    cornerSize: CGSize(width: armCorner, height: armCorner)
                )

                for i in 0 ..< 4 {
                    let x = legStartX + CGFloat(i) * (legWidth + legSpacing)
                    path.addRoundedRect(
                        in: CGRect(x: x, y: legY, width: legWidth, height: legHeight),
                        cornerSize: CGSize(width: legWidth * 0.35, height: legWidth * 0.35)
                    )
                }

                let leftEyeX = bodyRect.midX - eyeOffset
                path.move(to: CGPoint(x: leftEyeX - eyeWidth / 2, y: eyeY - eyeHeight))
                path.addLine(to: CGPoint(x: leftEyeX + eyeWidth / 2, y: eyeY))
                path.addLine(to: CGPoint(x: leftEyeX - eyeWidth / 2, y: eyeY + eyeHeight))
                path.closeSubpath()

                let rightEyeX = bodyRect.midX + eyeOffset
                path.move(to: CGPoint(x: rightEyeX + eyeWidth / 2, y: eyeY - eyeHeight))
                path.addLine(to: CGPoint(x: rightEyeX - eyeWidth / 2, y: eyeY))
                path.addLine(to: CGPoint(x: rightEyeX + eyeWidth / 2, y: eyeY + eyeHeight))
                path.closeSubpath()
            }
            .fill(style: FillStyle(eoFill: true, antialiased: true))
        }
    }
}

final class AppDelegate: NSObject, NSApplicationDelegate, NSXPCListenerDelegate {
    private var listener: NSXPCListener?
    private var state: AppState?

    @MainActor
    func applicationDidFinishLaunching(_ notification: Notification) {
        NSApp.setActivationPolicy(.accessory)
        state = AppStateStore.shared
        startListener()
    }

    @MainActor
    private func startListener() {
        guard state != nil else { return }
        let listener = NSXPCListener(machServiceName: serviceName)
        listener.delegate = self
        listener.resume()
        self.listener = listener
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
        VStack(alignment: .leading, spacing: 0) {
            Picker("", selection: $selectedTab) {
                ForEach(SettingsTab.allCases, id: \.self) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .padding([.top, .horizontal])

            Divider()

            Group {
                switch selectedTab {
                case .general:
                    GeneralSettings(state: state)
                case .permissions:
                    PermissionsSettings(status: permStatus, refresh: refreshPerms, showOnboarding: { OnboardingController.shared.show() })
                case .debug:
                    DebugSettings()
                case .about:
                    AboutSettings()
                }
            }
            .padding(16)
        }
        .task { await refreshPerms() }
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
    var title: String {
        switch self {
        case .general: return "General"
        case .permissions: return "Permissions"
        case .debug: return "Debug"
        case .about: return "About"
        }
    }
}

struct GeneralSettings: View {
    @ObservedObject var state: AppState

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            if !state.onboardingSeen {
                Label("Complete onboarding to finish setup", systemImage: "sparkles")
                    .foregroundColor(.accentColor)
            }
            Toggle(isOn: $state.isPaused) { Text("Pause Clawdis (disables notifications & privileged actions)") }
            Toggle(isOn: $state.launchAtLogin) { Text("Launch at login") }
            HStack {
                Text("Default sound")
                Spacer()
                Picker("Sound", selection: $state.defaultSound) {
                    Text("None").tag("")
                    Text("Glass").tag("Glass")
                    Text("Basso").tag("Basso")
                    Text("Ping").tag("Ping")
                }
                .labelsHidden()
                .frame(width: 140)
            }
            Spacer()
        }
    }
}

struct PermissionsSettings: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void
    let showOnboarding: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Allow these so Clawdis can notify and capture when needed.")
            PermissionStatusList(status: status, refresh: refresh)
            Button("Show onboarding") { showOnboarding() }
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
    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Clawdis Companion")
                .font(.title2.bold())
            let version = Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
            Text("Version \(version)")
            Text("Menu bar helper for notifications, screenshots, and privileged actions.")
                .foregroundColor(.secondary)
            Divider()
            Link("View repository", destination: URL(string: "https://github.com/steipete/warelay")!)
            Spacer()
        }
    }
}

struct PermissionStatusList: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            row(label: "Notifications", cap: .notifications, action: requestNotifications)
            row(label: "Accessibility", cap: .accessibility) {
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")
            }
            row(label: "Screen Recording", cap: .screenRecording) {
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording")
            }
            Button("Refresh status") { Task { await refresh() } }
                .font(.footnote)
        }
    }

    private func row(label: String, cap: Capability, action: @escaping () -> Void) -> some View {
        let ok = status[cap] ?? false
        return HStack {
            Circle()
                .fill(ok ? Color.green : Color.red)
                .frame(width: 10, height: 10)
            Text(label)
            Spacer()
            Button(ok ? "Granted" : "Open Settings", action: action)
                .disabled(ok)
        }
    }

    private func requestNotifications() {
        Task {
            let center = UNUserNotificationCenter.current()
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            await refresh()
        }
    }

    private func openSettings(_ path: String) {
        if let url = URL(string: path) {
            NSWorkspace.shared.open(url)
        }
    }
}

// MARK: - Permissions window stub

@MainActor
final class PermissionsSheetController {
    static let shared = PermissionsSheetController()

    private var window: NSWindow?

    func show(state: AppState) {
        if let window {
            window.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            return
        }

        let hosting = NSHostingController(rootView: PermissionsView())
        let window = NSWindow(contentViewController: hosting)
        window.title = "Permissions"
        window.setContentSize(NSSize(width: 360, height: 220))
        window.styleMask = [.titled, .closable, .miniaturizable]
        window.isReleasedWhenClosed = false
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }
}

struct PermissionsView: View {
    @State private var notificationStatus: String = "Unknown"

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text("Grant the permissions below so Clawdis can help.")
            if AppStateStore.isPausedFlag {
                Text("Clawdis is paused. Unpause to enable actions.")
                    .foregroundColor(.orange)
            }
            Divider()
            HStack {
                Text("Notifications")
                Spacer()
                Text(notificationStatus).foregroundColor(.secondary)
                Button("Request") { requestNotifications() }
            }
            HStack {
                Text("Accessibility")
                Spacer()
                Button("Open Settings") { openSettings(path: "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility") }
            }
            HStack {
                Text("Screen Recording")
                Spacer()
                Button("Open Settings") { openSettings(path: "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording") }
            }
            Spacer()
            Text("Tip: run 'clawdis-mac ensure-permissions --interactive' from terminal to trigger prompts.")
                .font(.footnote)
                .foregroundColor(.secondary)
        }
        .padding()
        .task { await refreshNotificationStatus() }
    }

    private func requestNotifications() {
        Task {
            let center = UNUserNotificationCenter.current()
            _ = try? await center.requestAuthorization(options: [.alert, .sound, .badge])
            await refreshNotificationStatus()
        }
    }

    @MainActor
    private func refreshNotificationStatus() async {
        let settings = await UNUserNotificationCenter.current().notificationSettings()
        switch settings.authorizationStatus {
        case .notDetermined: notificationStatus = "Not determined"
        case .denied: notificationStatus = "Denied"
        case .authorized, .provisional, .ephemeral: notificationStatus = "Authorized"
        @unknown default: notificationStatus = "Unknown"
        }
    }

    private func openSettings(path: String) {
        if let url = URL(string: path) {
            NSWorkspace.shared.open(url)
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
        window.setContentSize(NSSize(width: 520, height: 420))
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

    private var steps: [OnboardingStep] {
        [
            .init(title: "Welcome aboard", detail: "Clawdis is your macOS companion for notifications and privileged agent actions.", accent: "sparkles"),
            .init(title: "Grant permissions", detail: "Enable Notifications, Accessibility, and Screen Recording so actions succeed.", accent: "lock.shield", showsPermissions: true),
            .init(title: "Install the CLI", detail: "Make the helper available to scripts via a quick symlink.", accent: "terminal", showsCLI: true),
            .init(title: "Done", detail: "You can pause Clawdis anytime from the menu. Happy automating!", accent: "hand.thumbsup")
        ]
    }

    var body: some View {
        let step = steps[stepIndex]
        VStack(spacing: 16) {
            header(step: step)
            contentCard(step: step)
            progressDots
            footerButtons
        }
        .padding(20)
        .task { await refreshPerms() }
    }

    @ViewBuilder
    private func header(step: OnboardingStep) -> some View {
        ZStack(alignment: .leading) {
            RoundedRectangle(cornerRadius: 14)
                .fill(LinearGradient(colors: [Color.blue.opacity(0.9), Color.purple.opacity(0.85)], startPoint: .topLeading, endPoint: .bottomTrailing))
                .frame(height: 100)
            VStack(alignment: .leading, spacing: 6) {
                Label(step.title, systemImage: step.accent)
                    .font(.title3.bold())
                    .foregroundColor(.white)
                Text(step.detail)
                    .foregroundColor(Color.white.opacity(0.92))
                    .font(.subheadline)
            }
            .padding(.horizontal, 16)
        }
    }

    @ViewBuilder
    private func contentCard(step: OnboardingStep) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            if step.showsPermissions {
                PermissionStatusList(status: permStatus, refresh: refreshPerms)
                    .padding(10)
                    .background(RoundedRectangle(cornerRadius: 10).fill(Color(NSColor.controlBackgroundColor)))
            }
            if step.showsCLI {
                CLIInstallCard(copied: $copied)
            }
            if !step.showsPermissions && !step.showsCLI {
                Text("Keep Clawdis running in your menu bar. Use the Pause toggle anytime if you need to mute actions.")
            }
        }
        .padding(14)
        .background(RoundedRectangle(cornerRadius: 14).stroke(Color.gray.opacity(0.2)))
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
            Button(stepIndex == steps.count - 1 ? "Finish" : "Next") {
                advance()
            }
            .buttonStyle(.borderedProminent)
        }
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
        OnboardingController.shared.close()
    }

    @MainActor
    private func refreshPerms() async {
        permStatus = await PermissionManager.status()
    }
}

struct OnboardingStep {
    let title: String
    let detail: String
    let accent: String
    var showsPermissions: Bool = false
    var showsCLI: Bool = false
}

struct CLIInstallCard: View {
    @Binding var copied: Bool
    private let command = "ln -sf $(pwd)/apps/macos/.build/debug/ClawdisCLI /usr/local/bin/clawdis-mac"

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("Install the helper CLI")
                .font(.headline)
            Text("Run this once to expose the helper to your shell:")
            HStack {
                Text(command)
                    .font(.system(.footnote, design: .monospaced))
                    .lineLimit(2)
                Spacer()
                Button(copied ? "Copied" : "Copy") {
                    copyToPasteboard(command)
                }
            }
            .padding(8)
            .background(RoundedRectangle(cornerRadius: 8).fill(Color(NSColor.controlBackgroundColor)))
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
