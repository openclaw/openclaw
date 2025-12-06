import AppKit
import ApplicationServices
import AsyncXPCConnection
import AVFoundation
import ClawdisIPC
import CoreGraphics
import Foundation
import JavaScriptCore
import MenuBarExtraAccess
import OSLog
@preconcurrency import ScreenCaptureKit
import ServiceManagement
import Speech
import SwiftUI
import UserNotifications
import VideoToolbox
import UniformTypeIdentifiers

private let serviceName = "com.steipete.clawdis.xpc"
private let launchdLabel = "com.steipete.clawdis"
private let onboardingVersionKey = "clawdis.onboardingVersion"
private let currentOnboardingVersion = 2
private let pauseDefaultsKey = "clawdis.pauseEnabled"
private let swabbleEnabledKey = "clawdis.swabbleEnabled"
private let swabbleTriggersKey = "clawdis.swabbleTriggers"
private let showDockIconKey = "clawdis.showDockIcon"
private let defaultVoiceWakeTriggers = ["clawd", "claude"]
private let voiceWakeMicKey = "clawdis.voiceWakeMicID"
private let voiceWakeLocaleKey = "clawdis.voiceWakeLocaleID"
private let voiceWakeAdditionalLocalesKey = "clawdis.voiceWakeAdditionalLocaleIDs"
private let modelCatalogPathKey = "clawdis.modelCatalogPath"
private let modelCatalogReloadKey = "clawdis.modelCatalogReload"
private let voiceWakeSupported: Bool = ProcessInfo.processInfo.operatingSystemVersion.majorVersion >= 26

// MARK: - App model

@MainActor
final class AppState: ObservableObject {
    @Published var isPaused: Bool {
        didSet { UserDefaults.standard.set(self.isPaused, forKey: pauseDefaultsKey) }
    }

    @Published var defaultSound: String {
        didSet { UserDefaults.standard.set(self.defaultSound, forKey: "clawdis.defaultSound") }
    }

    @Published var launchAtLogin: Bool {
        didSet { Task { AppStateStore.updateLaunchAtLogin(enabled: self.launchAtLogin) } }
    }

    @Published var onboardingSeen: Bool {
        didSet { UserDefaults.standard.set(self.onboardingSeen, forKey: "clawdis.onboardingSeen") }
    }

    @Published var debugPaneEnabled: Bool {
        didSet { UserDefaults.standard.set(self.debugPaneEnabled, forKey: "clawdis.debugPaneEnabled") }
    }

    @Published var swabbleEnabled: Bool {
        didSet { UserDefaults.standard.set(self.swabbleEnabled, forKey: swabbleEnabledKey) }
    }

    @Published var swabbleTriggerWords: [String] {
        didSet {
            let cleaned = self.swabbleTriggerWords.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            UserDefaults.standard.set(cleaned, forKey: swabbleTriggersKey)
            if cleaned.count != self.swabbleTriggerWords.count {
                self.swabbleTriggerWords = cleaned
            }
        }
    }

    @Published var showDockIcon: Bool {
        didSet {
            UserDefaults.standard.set(self.showDockIcon, forKey: showDockIconKey)
            AppActivationPolicy.apply(showDockIcon: self.showDockIcon)
        }
    }

    @Published var voiceWakeMicID: String {
        didSet { UserDefaults.standard.set(self.voiceWakeMicID, forKey: voiceWakeMicKey) }
    }

    @Published var voiceWakeLocaleID: String {
        didSet { UserDefaults.standard.set(self.voiceWakeLocaleID, forKey: voiceWakeLocaleKey) }
    }

    @Published var voiceWakeAdditionalLocaleIDs: [String] {
        didSet { UserDefaults.standard.set(self.voiceWakeAdditionalLocaleIDs, forKey: voiceWakeAdditionalLocalesKey) }
    }

    init() {
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.defaultSound = UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? ""
        self.launchAtLogin = SMAppService.mainApp.status == .enabled
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdis.debugPaneEnabled")
        let savedVoiceWake = UserDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleEnabled = voiceWakeSupported ? savedVoiceWake : false
        self.swabbleTriggerWords = UserDefaults.standard
            .stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
        self.showDockIcon = UserDefaults.standard.bool(forKey: showDockIconKey)
        self.voiceWakeMicID = UserDefaults.standard.string(forKey: voiceWakeMicKey) ?? ""
        self.voiceWakeLocaleID = UserDefaults.standard.string(forKey: voiceWakeLocaleKey) ?? Locale.current.identifier
        self.voiceWakeAdditionalLocaleIDs = UserDefaults.standard
            .stringArray(forKey: voiceWakeAdditionalLocalesKey) ?? []
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

@MainActor
enum AppActivationPolicy {
    static func apply(showDockIcon: Bool) {
        NSApp.setActivationPolicy(showDockIcon ? .regular : .accessory)
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

    private static func process(
        request: Request,
        notifier: NotificationManager,
        logger: Logger) async throws -> Response
    {
        let paused = await MainActor.run { AppStateStore.isPausedFlag }
        if paused {
            return Response(ok: false, message: "clawdis paused")
        }

        switch request {
        case let .notify(title, body, sound):
            let chosenSound: String = if let sound { sound } else { await MainActor.run { AppStateStore.defaultSound } }
            let ok = await notifier.send(title: title, body: body, sound: chosenSound)
            return ok ? Response(ok: true) : Response(ok: false, message: "notification not authorized")

        case let .ensurePermissions(caps, interactive):
            let statuses = await PermissionManager.ensure(caps, interactive: interactive)
            let missing = statuses.filter { !$0.value }.map(\.key.rawValue)
            let ok = missing.isEmpty
            let msg = ok ? "all granted" : "missing: \(missing.joined(separator: ","))"
            return Response(ok: ok, message: msg)

        case .status:
            return Response(ok: true, message: "ready")

        case let .screenshot(displayID, windowID, _):
            let authorized = await PermissionManager
                .ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
            guard authorized else { return Response(ok: false, message: "screen recording permission missing") }
            if let data = await Screenshotter.capture(displayID: displayID, windowID: windowID) {
                return Response(ok: true, payload: data)
            }
            return Response(ok: false, message: "screenshot failed")

        case let .runShell(command, cwd, env, timeoutSec, needsSR):
            if needsSR {
                let authorized = await PermissionManager
                    .ensure([.screenRecording], interactive: false)[.screenRecording] ?? false
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
                let settings = await center.notificationSettings()

                switch settings.authorizationStatus {
                case .authorized, .provisional, .ephemeral:
                    results[cap] = true

                case .notDetermined:
                    if interactive {
                        let granted = (try? await center.requestAuthorization(options: [.alert, .sound, .badge])) ?? false
                        let updated = await center.notificationSettings()
                        results[cap] = granted && (updated.authorizationStatus == .authorized || updated
                            .authorizationStatus == .provisional)
                    } else {
                        results[cap] = false
                    }

                case .denied:
                    results[cap] = false
                    if interactive {
                        NotificationPermissionHelper.openSettings()
                    }

                @unknown default:
                    results[cap] = false
                }

            case .accessibility:
                // Accessing AX APIs must be on main thread.
                let trusted = AXIsProcessTrusted()
                results[cap] = trusted
                if interactive, !trusted {
                    _ = AXIsProcessTrustedWithOptions(nil)
                }

            case .screenRecording:
                let granted = ScreenRecordingProbe.isAuthorized()
                if interactive, !granted {
                    await ScreenRecordingProbe.requestAuthorization()
                }
                results[cap] = ScreenRecordingProbe.isAuthorized()

            case .microphone:
                let granted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
                if interactive, !granted {
                    let ok = await AVCaptureDevice.requestAccess(for: .audio)
                    results[cap] = ok
                } else {
                    results[cap] = granted
                }

            case .speechRecognition:
                let status = SFSpeechRecognizer.authorizationStatus()
                if status == .notDetermined, interactive {
                    let ok = await withCheckedContinuation { cont in
                        SFSpeechRecognizer.requestAuthorization { auth in cont.resume(returning: auth == .authorized) }
                    }
                    results[cap] = ok
                } else {
                    results[cap] = status == .authorized
                }
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
                results[cap] = settings.authorizationStatus == .authorized || settings
                    .authorizationStatus == .provisional

            case .accessibility:
                results[cap] = AXIsProcessTrusted()

            case .screenRecording:
                if #available(macOS 10.15, *) {
                    results[cap] = CGPreflightScreenCaptureAccess()
                } else {
                    results[cap] = true
                }

            case .microphone:
                results[cap] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized

            case .speechRecognition:
                results[cap] = SFSpeechRecognizer.authorizationStatus() == .authorized
            }
        }
        return results
    }
}

enum NotificationPermissionHelper {
    static func openSettings() {
        let candidates = [
            "x-apple.systempreferences:com.apple.Notifications-Settings.extension",
            "x-apple.systempreferences:com.apple.preference.notifications",
        ]

        for candidate in candidates {
            if let url = URL(string: candidate), NSWorkspace.shared.open(url) {
                return
            }
        }
    }
}

// MARK: - Permission monitoring

@MainActor
final class PermissionMonitor: ObservableObject {
    static let shared = PermissionMonitor()

    @Published private(set) var status: [Capability: Bool] = [:]

    private var monitorTimer: Timer?
    private var isChecking = false
    private var registrations = 0
    private var lastCheck: Date?
    private let minimumCheckInterval: TimeInterval = 0.5

    func register() {
        self.registrations += 1
        if self.registrations == 1 {
            self.startMonitoring()
        }
    }

    func unregister() {
        guard self.registrations > 0 else { return }
        self.registrations -= 1
        if self.registrations == 0 {
            self.stopMonitoring()
        }
    }

    func refreshNow() async {
        await self.checkStatus(force: true)
    }

    private func startMonitoring() {
        Task { await self.checkStatus(force: true) }

        self.monitorTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self else { return }
            Task { @MainActor in
                await self.checkStatus(force: false)
            }
        }
    }

    private func stopMonitoring() {
        self.monitorTimer?.invalidate()
        self.monitorTimer = nil
        self.lastCheck = nil
    }

    private func checkStatus(force: Bool) async {
        if self.isChecking { return }
        let now = Date()
        if !force, let lastCheck, now.timeIntervalSince(lastCheck) < self.minimumCheckInterval {
            return
        }

        self.isChecking = true
        self.lastCheck = now

        let latest = await PermissionManager.status()
        if latest != self.status {
            self.status = latest
        }

        self.isChecking = false
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

        let targetDisplay: SCDisplay? = if let displayID {
            content.displays.first(where: { $0.displayID == displayID })
        } else {
            content.displays.first
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
        try? stream.addStreamOutput(
            grabber,
            type: .screen,
            sampleHandlerQueue: DispatchQueue(label: "com.steipete.clawdis.sshot"))
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

    nonisolated func stream(
        _ stream: SCStream,
        didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
        of outputType: SCStreamOutputType)
    {
        guard outputType == .screen else { return }
        if self.delivered { return }
        guard let imageBuffer = sampleBuffer.imageBuffer else { return }
        var cgImage: CGImage?
        let result = VTCreateCGImageFromCVPixelBuffer(imageBuffer, options: nil, imageOut: &cgImage)
        guard result == noErr, let cgImage else { return }
        let rep = NSBitmapImageRep(cgImage: cgImage)
        guard let data = rep.representation(using: .png, properties: [:]) else { return }

        self.delivered = true
        self.continuation?.resume(returning: data)
        self.continuation = nil
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
    @State private var statusItem: NSStatusItem?
    @State private var isMenuPresented = false

    init() {
        _state = StateObject(wrappedValue: AppStateStore.shared)
    }

    var body: some Scene {
        MenuBarExtra { MenuContent(state: self.state) } label: { CritterStatusLabel(isPaused: self.state.isPaused) }
            .menuBarExtraStyle(.menu)
            .menuBarExtraAccess(isPresented: self.$isMenuPresented) { item in
                self.statusItem = item
                self.applyStatusItemAppearance(paused: self.state.isPaused)
            }
            .onChange(of: self.state.isPaused) { _, paused in
                self.applyStatusItemAppearance(paused: paused)
            }

        Settings {
            SettingsRootView(state: self.state)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        }
        .defaultSize(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        .windowResizability(.contentSize)
    }

    private func applyStatusItemAppearance(paused: Bool) {
        self.statusItem?.button?.appearsDisabled = paused
    }
}

private struct MenuContent: View {
    @ObservedObject var state: AppState
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Toggle(isOn: self.activeBinding) { Text("Clawdis Active") }
        Toggle(isOn: self.$state.swabbleEnabled) { Text("Voice Wake") }
            .disabled(!voiceWakeSupported)
            .opacity(voiceWakeSupported ? 1 : 0.5)
        Button("Open Chat") { WebChatManager.shared.show(sessionKey: self.primarySessionKey()) }
        Divider()
        Button("Settings…") { self.open(tab: .general) }
            .keyboardShortcut(",", modifiers: [.command])
        Button("About Clawdis") { self.open(tab: .about) }
        Divider()
        Button("Quit") { NSApplication.shared.terminate(nil) }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var activeBinding: Binding<Bool> {
        Binding(get: { !self.state.isPaused }, set: { self.state.isPaused = !$0 })
    }

    private func primarySessionKey() -> String {
        // Prefer the most recently updated session from the store; fall back to default
        let storePath = SessionLoader.defaultStorePath
        if let data = try? Data(contentsOf: URL(fileURLWithPath: storePath)),
           let decoded = try? JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
        {
            let sorted = decoded.sorted { a, b -> Bool in
                let lhs = a.value.updatedAt ?? 0
                let rhs = b.value.updatedAt ?? 0
                return lhs > rhs
            }
            if let first = sorted.first {
                return first.key
            }
        }
        return "+1003"
    }
}

private struct CritterStatusLabel: View {
    var isPaused: Bool

    @State private var blinkAmount: CGFloat = 0
    @State private var nextBlink = Date().addingTimeInterval(Double.random(in: 3.5...8.5))
    @State private var wiggleAngle: Double = 0
    @State private var wiggleOffset: CGFloat = 0
    @State private var nextWiggle = Date().addingTimeInterval(Double.random(in: 6.5...14))
    @State private var legWiggle: CGFloat = 0
    @State private var nextLegWiggle = Date().addingTimeInterval(Double.random(in: 5.0...11.0))
    @State private var earWiggle: CGFloat = 0
    @State private var nextEarWiggle = Date().addingTimeInterval(Double.random(in: 7.0...14.0))
    private let ticker = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if self.isPaused {
                Image(nsImage: CritterIconRenderer.makeIcon(blink: 0))
                    .frame(width: 18, height: 16)
            } else {
                Image(nsImage: CritterIconRenderer.makeIcon(
                    blink: self.blinkAmount,
                    legWiggle: self.legWiggle,
                    earWiggle: self.earWiggle))
                    .frame(width: 18, height: 16)
                    .rotationEffect(.degrees(self.wiggleAngle), anchor: .center)
                    .offset(x: self.wiggleOffset)
                    .onReceive(self.ticker) { now in
                        if now >= self.nextBlink {
                            self.blink()
                            self.nextBlink = now.addingTimeInterval(Double.random(in: 3.5...8.5))
                        }

                        if now >= self.nextWiggle {
                            self.wiggle()
                            self.nextWiggle = now.addingTimeInterval(Double.random(in: 6.5...14))
                        }

                        if now >= self.nextLegWiggle {
                            self.wiggleLegs()
                            self.nextLegWiggle = now.addingTimeInterval(Double.random(in: 5.0...11.0))
                        }

                        if now >= self.nextEarWiggle {
                            self.wiggleEars()
                            self.nextEarWiggle = now.addingTimeInterval(Double.random(in: 7.0...14.0))
                        }
                    }
                    .onChange(of: self.isPaused) { _, _ in self.resetMotion() }
            }
        }
    }

    private func resetMotion() {
        self.blinkAmount = 0
        self.wiggleAngle = 0
        self.wiggleOffset = 0
        self.legWiggle = 0
        self.earWiggle = 0
    }

    private func blink() {
        withAnimation(.easeInOut(duration: 0.08)) { self.blinkAmount = 1 }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.16) {
            withAnimation(.easeOut(duration: 0.12)) { self.blinkAmount = 0 }
        }
    }

    private func wiggle() {
        let targetAngle = Double.random(in: -4.5...4.5)
        let targetOffset = CGFloat.random(in: -0.5...0.5)
        withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
            self.wiggleAngle = targetAngle
            self.wiggleOffset = targetOffset
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.36) {
            withAnimation(.interpolatingSpring(stiffness: 220, damping: 18)) {
                self.wiggleAngle = 0
                self.wiggleOffset = 0
            }
        }
    }

    private func wiggleLegs() {
        let target = CGFloat.random(in: 0.35...0.9)
        withAnimation(.easeInOut(duration: 0.14)) {
            self.legWiggle = target
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
            withAnimation(.easeOut(duration: 0.18)) { self.legWiggle = 0 }
        }
    }

    private func wiggleEars() {
        let target = CGFloat.random(in: -1.2...1.2)
        withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) {
            self.earWiggle = target
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
            withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) { self.earWiggle = 0 }
        }
    }
}

enum CritterIconRenderer {
    private static let size = NSSize(width: 18, height: 16)

    static func makeIcon(blink: CGFloat, legWiggle: CGFloat = 0, earWiggle: CGFloat = 0) -> NSImage {
        let image = NSImage(size: size)
        image.lockFocus()
        defer { image.unlockFocus() }

        guard let ctx = NSGraphicsContext.current?.cgContext else { return image }

        let w = self.size.width
        let h = self.size.height

        let bodyW = w * 0.78
        let bodyH = h * 0.58
        let bodyX = (w - bodyW) / 2
        let bodyY = h * 0.36
        let bodyCorner = w * 0.09

        let earW = w * 0.22
        let earH = bodyH * 0.66 * (1 - 0.08 * abs(earWiggle))
        let earCorner = earW * 0.24

        let legW = w * 0.11
        let legH = h * 0.26
        let legSpacing = w * 0.085
        let legsWidth = 4 * legW + 3 * legSpacing
        let legStartX = (w - legsWidth) / 2
        let legLift = legH * 0.35 * legWiggle
        let legYBase = bodyY - legH + h * 0.05

        let eyeOpen = max(0.05, 1 - blink)
        let eyeW = bodyW * 0.2
        let eyeH = bodyH * 0.26 * eyeOpen
        let eyeY = bodyY + bodyH * 0.56
        let eyeOffset = bodyW * 0.24

        ctx.setFillColor(NSColor.labelColor.cgColor)

        // Body
        ctx.addPath(CGPath(
            roundedRect: CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH),
            cornerWidth: bodyCorner,
            cornerHeight: bodyCorner,
            transform: nil))
        // Ears (tiny wiggle)
        ctx.addPath(CGPath(
            roundedRect: CGRect(
                x: bodyX - earW * 0.55 + earWiggle,
                y: bodyY + bodyH * 0.08 + earWiggle * 0.4,
                width: earW,
                height: earH),
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        ctx.addPath(CGPath(
            roundedRect: CGRect(
                x: bodyX + bodyW - earW * 0.45 - earWiggle,
                y: bodyY + bodyH * 0.08 - earWiggle * 0.4,
                width: earW,
                height: earH),
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        // Legs
        for i in 0..<4 {
            let x = legStartX + CGFloat(i) * (legW + legSpacing)
            let lift = (i % 2 == 0 ? legLift : -legLift)
            let rect = CGRect(x: x, y: legYBase + lift, width: legW, height: legH * (1 - 0.12 * legWiggle))
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
        self.state = AppStateStore.shared
        AppActivationPolicy.apply(showDockIcon: self.state?.showDockIcon ?? false)
        LaunchdManager.startClawdis()
        self.startListener()
        self.scheduleFirstRunOnboardingIfNeeded()
    }

    func applicationWillTerminate(_ notification: Notification) {
        LaunchdManager.stopClawdis()
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
        let interface = NSXPCInterface(with: ClawdisXPCProtocol.self)
        connection.exportedInterface = interface
        connection.exportedObject = ClawdisXPCService()
        connection.resume()
        return true
    }
}

// MARK: - Settings UI

private struct SessionEntryRecord: Decodable {
    let sessionId: String?
    let updatedAt: Double?
    let systemSent: Bool?
    let abortedLastRun: Bool?
    let thinkingLevel: String?
    let verboseLevel: String?
    let inputTokens: Int?
    let outputTokens: Int?
    let totalTokens: Int?
    let model: String?
    let contextTokens: Int?
}

private struct SessionTokenStats {
    let input: Int
    let output: Int
    let total: Int
    let contextTokens: Int

    var percentUsed: Int? {
        guard self.contextTokens > 0, self.total > 0 else { return nil }
        return min(100, Int(round((Double(self.total) / Double(self.contextTokens)) * 100)))
    }

    var summary: String {
        let parts = ["in \(input)", "out \(output)", "total \(total)"]
        var text = parts.joined(separator: " | ")
        if let percentUsed {
            text += " (\(percentUsed)% of \(self.contextTokens))"
        }
        return text
    }
}

private struct SessionRow: Identifiable {
    let id: String
    let key: String
    let kind: SessionKind
    let updatedAt: Date?
    let sessionId: String?
    let thinkingLevel: String?
    let verboseLevel: String?
    let systemSent: Bool
    let abortedLastRun: Bool
    let tokens: SessionTokenStats
    let model: String?

    var ageText: String { relativeAge(from: self.updatedAt) }

    var flagLabels: [String] {
        var flags: [String] = []
        if let thinkingLevel { flags.append("think \(thinkingLevel)") }
        if let verboseLevel { flags.append("verbose \(verboseLevel)") }
        if self.systemSent { flags.append("system sent") }
        if self.abortedLastRun { flags.append("aborted") }
        return flags
    }
}

private enum SessionKind {
    case direct, group, global, unknown

    static func from(key: String) -> SessionKind {
        if key == "global" { return .global }
        if key.hasPrefix("group:") { return .group }
        if key == "unknown" { return .unknown }
        return .direct
    }

    var label: String {
        switch self {
        case .direct: "Direct"
        case .group: "Group"
        case .global: "Global"
        case .unknown: "Unknown"
        }
    }

    var tint: Color {
        switch self {
        case .direct: .accentColor
        case .group: .orange
        case .global: .purple
        case .unknown: .gray
        }
    }
}

private struct SessionDefaults {
    let model: String
    let contextTokens: Int
}

struct ModelChoice: Identifiable, Hashable {
    let id: String
    let name: String
    let provider: String
    let contextWindow: Int?
}

extension String? {
    var isNilOrEmpty: Bool {
        switch self {
        case .none: true
        case let .some(value): value.isEmpty
        }
    }
}

extension [String] {
    fileprivate func dedupedPreserveOrder() -> [String] {
        var seen = Set<String>()
        var result: [String] = []
        for item in self {
            if !seen.contains(item) {
                seen.insert(item)
                result.append(item)
            }
        }
        return result
    }
}

private struct SessionConfigHints {
    let storePath: String?
    let model: String?
    let contextTokens: Int?
}

private enum SessionLoadError: LocalizedError {
    case missingStore(String)
    case decodeFailed(String)

    var errorDescription: String? {
        switch self {
        case let .missingStore(path):
            "No session store found at \(path) yet. Send or receive a message to create it."

        case let .decodeFailed(reason):
            "Could not read the session store: \(reason)"
        }
    }
}

private enum SessionLoader {
    static let fallbackModel = "claude-opus-4-5"
    static let fallbackContextTokens = 200_000

    static let defaultStorePath = standardize(
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis/sessions/sessions.json").path)

    private static let legacyStorePaths: [String] = [
        standardize(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clawdis/sessions.json")
            .path),
        standardize(FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".warelay/sessions/sessions.json").path),
        standardize(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".warelay/sessions.json")
            .path),
    ]

    static func configHints() -> SessionConfigHints {
        let configURL = FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis/clawdis.json")
        guard let data = try? Data(contentsOf: configURL) else {
            return SessionConfigHints(storePath: nil, model: nil, contextTokens: nil)
        }
        guard let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return SessionConfigHints(storePath: nil, model: nil, contextTokens: nil)
        }

        let inbound = parsed["inbound"] as? [String: Any]
        let reply = inbound?["reply"] as? [String: Any]
        let session = reply?["session"] as? [String: Any]
        let agent = reply?["agent"] as? [String: Any]

        let store = session?["store"] as? String
        let model = agent?["model"] as? String
        let contextTokens = (agent?["contextTokens"] as? NSNumber)?.intValue

        return SessionConfigHints(
            storePath: store.map { self.standardize($0) },
            model: model,
            contextTokens: contextTokens)
    }

    static func resolveStorePath(override: String?) -> String {
        let preferred = self.standardize(override ?? self.defaultStorePath)
        let candidates = [preferred] + self.legacyStorePaths
        if let existing = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            return existing
        }
        return preferred
    }

    static func availableModels(storeOverride: String?) -> [String] {
        let path = self.resolveStorePath(override: storeOverride)
        guard let data = try? Data(contentsOf: URL(fileURLWithPath: path)),
              let decoded = try? JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
        else {
            return [self.fallbackModel]
        }
        let models = decoded.values.compactMap(\.model)
        return ([self.fallbackModel] + models).dedupedPreserveOrder()
    }

    static func loadRows(at path: String, defaults: SessionDefaults) async throws -> [SessionRow] {
        try await Task.detached(priority: .utility) {
            guard FileManager.default.fileExists(atPath: path) else {
                throw SessionLoadError.missingStore(path)
            }

            let data = try Data(contentsOf: URL(fileURLWithPath: path))
            let decoded: [String: SessionEntryRecord]
            do {
                decoded = try JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
            } catch {
                throw SessionLoadError.decodeFailed(error.localizedDescription)
            }

            return decoded.map { key, entry in
                let updated = entry.updatedAt.map { Date(timeIntervalSince1970: $0 / 1000) }
                let input = entry.inputTokens ?? 0
                let output = entry.outputTokens ?? 0
                let total = entry.totalTokens ?? input + output
                let context = entry.contextTokens ?? defaults.contextTokens
                let model = entry.model ?? defaults.model

                return SessionRow(
                    id: key,
                    key: key,
                    kind: SessionKind.from(key: key),
                    updatedAt: updated,
                    sessionId: entry.sessionId,
                    thinkingLevel: entry.thinkingLevel,
                    verboseLevel: entry.verboseLevel,
                    systemSent: entry.systemSent ?? false,
                    abortedLastRun: entry.abortedLastRun ?? false,
                    tokens: SessionTokenStats(
                        input: input,
                        output: output,
                        total: total,
                        contextTokens: context),
                    model: model)
            }
            .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        }.value
    }

    private static func standardize(_ path: String) -> String {
        (path as NSString).expandingTildeInPath.replacingOccurrences(of: "//", with: "/")
    }
}

enum ModelCatalogLoader {
    static let defaultPath: String = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Projects/pi-mono/packages/ai/src/models.generated.ts").path

    static func load(from path: String) async throws -> [ModelChoice] {
        let expanded = (path as NSString).expandingTildeInPath
        let source = try String(contentsOfFile: expanded, encoding: .utf8)
        let sanitized = self.sanitize(source: source)

        let ctx = JSContext()
        ctx?.exceptionHandler = { _, exception in
            if let exception { print("JS exception: \(exception)") }
        }
        ctx?.evaluateScript(sanitized)
        guard let rawModels = ctx?.objectForKeyedSubscript("MODELS")?.toDictionary() as? [String: Any] else {
            throw NSError(
                domain: "ModelCatalogLoader",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Failed to parse models.generated.ts"])
        }

        var choices: [ModelChoice] = []
        for (provider, value) in rawModels {
            guard let models = value as? [String: Any] else { continue }
            for (id, payload) in models {
                guard let dict = payload as? [String: Any] else { continue }
                let name = dict["name"] as? String ?? id
                let ctxWindow = dict["contextWindow"] as? Int
                choices.append(ModelChoice(id: id, name: name, provider: provider, contextWindow: ctxWindow))
            }
        }

        return choices.sorted { lhs, rhs in
            if lhs.provider == rhs.provider {
                return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
            }
            return lhs.provider.localizedCaseInsensitiveCompare(rhs.provider) == .orderedAscending
        }
    }

    private static func sanitize(source: String) -> String {
        guard let exportRange = source.range(of: "export const MODELS"),
              let firstBrace = source[exportRange.upperBound...].firstIndex(of: "{"),
              let lastBrace = source.lastIndex(of: "}")
        else {
            return "var MODELS = {}"
        }
        var body = String(source[firstBrace...lastBrace])
        body = body.replacingOccurrences(
            of: #"(?m)\bsatisfies\s+[^,}\n]+"#,
            with: "",
            options: .regularExpression)
        body = body.replacingOccurrences(
            of: #"(?m)\bas\s+[^;,\n]+"#,
            with: "",
            options: .regularExpression)
        return "var MODELS = \(body);"
    }
}

private func relativeAge(from date: Date?) -> String {
    guard let date else { return "unknown" }
    let delta = Date().timeIntervalSince(date)
    if delta < 60 { return "just now" }
    let minutes = Int(round(delta / 60))
    if minutes < 60 { return "\(minutes)m ago" }
    let hours = Int(round(Double(minutes) / 60))
    if hours < 48 { return "\(hours)h ago" }
    let days = Int(round(Double(hours) / 24))
    return "\(days)d ago"
}

@MainActor
struct SessionsSettings: View {
    @State private var rows: [SessionRow] = []
    @State private var storePath: String = SessionLoader.defaultStorePath
    @State private var lastLoaded: Date?
    @State private var errorMessage: String?
    @State private var loading = false
    @State private var hasLoaded = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            self.header
            self.storeMetadata
            Divider().padding(.vertical, 4)
            self.content
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .task {
            guard !self.hasLoaded else { return }
            self.hasLoaded = true
            await self.refresh()
        }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Sessions")
                .font(.title3.weight(.semibold))
            Text("Peek at the stored conversation buckets the CLI reuses for context and rate limits.")
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var storeMetadata: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 10) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Session store")
                        .font(.callout.weight(.semibold))
                    if let lastLoaded {
                        Text("Updated \(relativeAge(from: lastLoaded))")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer()
                Text(self.storePath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }

            HStack(spacing: 10) {
                Button {
                    Task { await self.refresh() }
                } label: {
                    Label(self.loading ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                        .labelStyle(.titleAndIcon)
                }
                .disabled(self.loading)

                Button {
                    self.revealStore()
                } label: {
                    Label("Reveal", systemImage: "folder")
                        .labelStyle(.titleAndIcon)
                }
                .disabled(!FileManager.default.fileExists(atPath: self.storePath))

                if self.loading {
                    ProgressView().controlSize(.small)
                }
            }

            if let errorMessage {
                Text(errorMessage)
                    .font(.footnote)
                    .foregroundStyle(.red)
            }
        }
    }

    private var content: some View {
        Group {
            if self.rows.isEmpty, self.errorMessage == nil {
                Text("No sessions yet. They appear after the first inbound message or heartbeat.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            } else {
                Table(self.rows) {
                    TableColumn("Key") { row in
                        VStack(alignment: .leading, spacing: 4) {
                            Text(row.key)
                                .font(.body.weight(.semibold))
                            HStack(spacing: 6) {
                                SessionKindBadge(kind: row.kind)
                                if !row.flagLabels.isEmpty {
                                    ForEach(row.flagLabels, id: \.self) { flag in
                                        Badge(text: flag)
                                    }
                                }
                            }
                        }
                    }
                    .width(170)

                    TableColumn("Updated", value: \.ageText)
                        .width(80)

                    TableColumn("Tokens") { row in
                        Text(row.tokens.summary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(210)

                    TableColumn("Model") { row in
                        Text(row.model ?? "—")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .width(120)

                    TableColumn("Session ID") { row in
                        Text(row.sessionId ?? "—")
                            .font(.caption.monospaced())
                            .foregroundStyle(.secondary)
                            .lineLimit(1)
                            .truncationMode(.middle)
                    }
                }
                .tableStyle(.inset(alternatesRowBackgrounds: true))
                .frame(maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private func refresh() async {
        guard !self.loading else { return }
        self.loading = true
        self.errorMessage = nil

        let hints = SessionLoader.configHints()
        let resolvedStore = SessionLoader.resolveStorePath(override: hints.storePath)
        let defaults = SessionDefaults(
            model: hints.model ?? SessionLoader.fallbackModel,
            contextTokens: hints.contextTokens ?? SessionLoader.fallbackContextTokens)

        do {
            let newRows = try await SessionLoader.loadRows(at: resolvedStore, defaults: defaults)
            self.rows = newRows
            self.storePath = resolvedStore
            self.lastLoaded = Date()
        } catch {
            self.rows = []
            self.storePath = resolvedStore
            self.errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }

        self.loading = false
    }

    private func revealStore() {
        let url = URL(fileURLWithPath: storePath)
        if FileManager.default.fileExists(atPath: self.storePath) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }
}

@MainActor
struct ConfigSettings: View {
    @State private var configModel: String = ""
    @State private var customModel: String = ""
    @State private var configStorePath: String = SessionLoader.defaultStorePath
    @State private var configSaving = false
    @State private var hasLoaded = false
    @State private var models: [ModelChoice] = []
    @State private var modelsLoading = false
    @State private var modelError: String?
    @AppStorage(modelCatalogPathKey) private var modelCatalogPath: String = ModelCatalogLoader.defaultPath
    @AppStorage(modelCatalogReloadKey) private var modelCatalogReloadBump: Int = 0
    @State private var allowAutosave = false

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Clawdis CLI config")
                .font(.title3.weight(.semibold))
            Text("Edit ~/.clawdis/clawdis.json (inbound.reply.agent/session).")
                .font(.callout)
                .foregroundStyle(.secondary)

            LabeledContent("Model") {
                VStack(alignment: .leading, spacing: 6) {
                    Picker("Model", selection: self.$configModel) {
                        ForEach(self.models) { choice in
                            Text(
                                "\(choice.name) — \(choice.provider.uppercased())")
                                .tag(choice.id)
                        }
                        Text("Manual entry…").tag("__custom__")
                    }
                    .labelsHidden()
                    .frame(width: 360)
                    .disabled(self.modelsLoading || (!self.modelError.isNilOrEmpty && self.models.isEmpty))
                    .onChange(of: self.configModel) { _, _ in
                        self.autosaveConfig()
                    }

                    if self.configModel == "__custom__" {
                        TextField("Enter model ID", text: self.$customModel)
                            .textFieldStyle(.roundedBorder)
                            .frame(width: 320)
                            .onChange(of: self.customModel) { _, newValue in
                                self.configModel = newValue
                                self.autosaveConfig()
                            }
                    }

                    if let contextLabel = self.selectedContextLabel {
                        Text(contextLabel)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }

                    HStack(spacing: 10) {
                        Button {
                            Task { await self.loadModels() }
                        } label: {
                            Label(self.modelsLoading ? "Loading…" : "Reload models", systemImage: "arrow.clockwise")
                        }
                        .disabled(self.modelsLoading)

                        if let modelError {
                            Text(modelError)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                        }
                    }
                }
            }

            LabeledContent("Session store") {
                TextField("Path", text: self.$configStorePath)
                    .textFieldStyle(.roundedBorder)
                    .frame(width: 360)
                    .onChange(of: self.configStorePath) { _, _ in
                        self.autosaveConfig()
                    }
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .onChange(of: self.modelCatalogPath) { _, _ in
            Task { await self.loadModels() }
        }
        .onChange(of: self.modelCatalogReloadBump) { _, _ in
            Task { await self.loadModels() }
        }
        .task {
            guard !self.hasLoaded else { return }
            self.hasLoaded = true
            self.loadConfig()
            await self.loadModels()
            self.allowAutosave = true
        }
    }

    private func configURL() -> URL {
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis")
            .appendingPathComponent("clawdis.json")
    }

    private func loadConfig() {
        let url = self.configURL()
        guard let data = try? Data(contentsOf: url) else {
            self.configModel = SessionLoader.fallbackModel
            self.configStorePath = SessionLoader.defaultStorePath
            return
        }
        guard
            let parsed = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
            let inbound = parsed["inbound"] as? [String: Any],
            let reply = inbound["reply"] as? [String: Any]
        else {
            return
        }

        let session = reply["session"] as? [String: Any]
        let agent = reply["agent"] as? [String: Any]
        self.configStorePath = (session?["store"] as? String) ?? SessionLoader.defaultStorePath
        let loadedModel = (agent?["model"] as? String) ?? ""
        if !loadedModel.isEmpty {
            self.configModel = loadedModel
            self.customModel = loadedModel
        } else {
            self.configModel = SessionLoader.fallbackModel
            self.customModel = SessionLoader.fallbackModel
        }
    }

    private func autosaveConfig() {
        guard self.allowAutosave else { return }
        Task { await self.saveConfig() }
    }

    private func saveConfig() async {
        guard !self.configSaving else { return }
        self.configSaving = true
        defer { self.configSaving = false }

        var session: [String: Any] = [:]
        var agent: [String: Any] = [:]

        let trimmedStore = self.configStorePath.trimmingCharacters(in: .whitespacesAndNewlines)
        if !trimmedStore.isEmpty { session["store"] = trimmedStore }

        let chosenModel = (self.configModel == "__custom__" ? self.customModel : self.configModel)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let trimmedModel = chosenModel
        if !trimmedModel.isEmpty { agent["model"] = trimmedModel }

        let reply: [String: Any] = [
            "session": session,
            "agent": agent,
        ]
        let inbound: [String: Any] = ["reply": reply]
        let root: [String: Any] = ["inbound": inbound]

        do {
            let data = try JSONSerialization.data(withJSONObject: root, options: [.prettyPrinted, .sortedKeys])
            let url = self.configURL()
            try FileManager.default.createDirectory(
                at: url.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            try data.write(to: url, options: [.atomic])
        } catch {}
    }

    private func loadModels() async {
        guard !self.modelsLoading else { return }
        self.modelsLoading = true
        self.modelError = nil
        do {
            let loaded = try await ModelCatalogLoader.load(from: self.modelCatalogPath)
            self.models = loaded
            // if current model not in list, switch to custom to keep value visible
            if !self.configModel.isEmpty, !loaded.contains(where: { $0.id == self.configModel }) {
                self.customModel = self.configModel
                self.configModel = "__custom__"
            }
        } catch {
            self.modelError = error.localizedDescription
            self.models = []
        }
        self.modelsLoading = false
    }

    private var selectedContextLabel: String? {
        let chosenId = (self.configModel == "__custom__") ? self.customModel : self.configModel
        guard
            !chosenId.isEmpty,
            let choice = self.models.first(where: { $0.id == chosenId }),
            let context = choice.contextWindow
        else {
            return nil
        }

        let human = context >= 1000 ? "\(context / 1000)k" : "\(context)"
        return "Context window: \(human) tokens"
    }
}

private struct SessionRowView: View {
    let row: SessionRow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(self.row.key)
                    .font(.body.weight(.semibold))
                SessionKindBadge(kind: self.row.kind)
                Spacer()
                Text(self.row.ageText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Label(self.row.tokens.summary, systemImage: "chart.bar.doc.horizontal")
                    .labelStyle(.titleAndIcon)
                    .foregroundStyle(.secondary)

                if let model = row.model {
                    Label(model, systemImage: "brain.head.profile")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(.secondary)
                }

                if let sessionId = row.sessionId {
                    Label(sessionId, systemImage: "number")
                        .labelStyle(.titleAndIcon)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .font(.caption)
            .lineLimit(1)

            if !self.row.flagLabels.isEmpty {
                HStack(spacing: 6) {
                    ForEach(self.row.flagLabels, id: \.self) { flag in
                        Text(flag)
                            .font(.caption2.weight(.semibold))
                            .padding(.horizontal, 6)
                            .padding(.vertical, 4)
                            .background(Color.secondary.opacity(0.12))
                            .clipShape(Capsule())
                    }
                }
            }
        }
        .padding(10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor)))
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.secondary.opacity(0.15), lineWidth: 1))
    }
}

private struct SessionKindBadge: View {
    let kind: SessionKind

    var body: some View {
        Text(self.kind.label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .foregroundStyle(self.kind.tint)
            .background(self.kind.tint.opacity(0.15))
            .clipShape(Capsule())
    }
}

private struct Badge: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .padding(.horizontal, 6)
            .padding(.vertical, 3)
            .foregroundStyle(.secondary)
            .background(Color.secondary.opacity(0.12))
            .clipShape(Capsule())
    }
}

struct SettingsRootView: View {
    @ObservedObject var state: AppState
    @ObservedObject private var permissionMonitor = PermissionMonitor.shared
    @State private var monitoringPermissions = false
    @State private var selectedTab: SettingsTab = .general

    var body: some View {
        TabView(selection: self.$selectedTab) {
            GeneralSettings(state: self.state)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)

            SessionsSettings()
                .tabItem { Label("Sessions", systemImage: "clock.arrow.circlepath") }
                .tag(SettingsTab.sessions)

            ConfigSettings()
                .tabItem { Label("Config", systemImage: "slider.horizontal.3") }
                .tag(SettingsTab.config)

            VoiceWakeSettings(state: self.state)
                .tabItem { Label("Voice Wake", systemImage: "waveform.circle") }
                .tag(SettingsTab.voiceWake)

            PermissionsSettings(
                status: self.permissionMonitor.status,
                refresh: self.refreshPerms,
                showOnboarding: { OnboardingController.shared.show() })
                .tabItem { Label("Permissions", systemImage: "lock.shield") }
                .tag(SettingsTab.permissions)

            if self.state.debugPaneEnabled {
                DebugSettings()
                    .tabItem { Label("Debug", systemImage: "ant") }
                    .tag(SettingsTab.debug)
            }

            AboutSettings()
                .tabItem { Label("About", systemImage: "info.circle") }
                .tag(SettingsTab.about)
        }
        .padding(.horizontal, 28)
        .padding(.vertical, 22)
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
        .onReceive(NotificationCenter.default.publisher(for: .clawdisSelectSettingsTab)) { note in
            if let tab = note.object as? SettingsTab {
                withAnimation(.spring(response: 0.32, dampingFraction: 0.85)) {
                    self.selectedTab = tab
                }
            }
        }
        .onAppear {
            if let pending = SettingsTabRouter.consumePending() {
                self.selectedTab = self.validTab(for: pending)
            }
            self.updatePermissionMonitoring(for: self.selectedTab)
        }
        .onChange(of: self.state.debugPaneEnabled) { _, enabled in
            if !enabled, self.selectedTab == .debug {
                self.selectedTab = .general
            }
        }
        .onChange(of: self.selectedTab) { _, newValue in
            self.updatePermissionMonitoring(for: newValue)
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task { await self.refreshPerms() }
    }

    private func validTab(for requested: SettingsTab) -> SettingsTab {
        if requested == .debug, !self.state.debugPaneEnabled { return .general }
        return requested
    }

    @MainActor
    private func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    private func updatePermissionMonitoring(for tab: SettingsTab) {
        let shouldMonitor = tab == .permissions
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }
}

enum SettingsTab: CaseIterable {
    case general, sessions, config, voiceWake, permissions, debug, about
    static let windowWidth: CGFloat = 520
    static let windowHeight: CGFloat = 624
    var title: String {
        switch self {
        case .general: "General"
        case .sessions: "Sessions"
        case .config: "Config"
        case .voiceWake: "Voice Wake"
        case .permissions: "Permissions"
        case .debug: "Debug"
        case .about: "About"
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

enum VoiceWakeTestState: Equatable {
    case idle
    case requesting
    case listening
    case hearing(String)
    case detected(String)
    case failed(String)
}

private struct AudioInputDevice: Identifiable, Equatable {
    let uid: String
    let name: String
    var id: String { self.uid }
}

actor MicLevelMonitor {
    private let engine = AVAudioEngine()
    private var update: (@Sendable (Double) -> Void)?
    private var running = false
    private var smoothedLevel: Double = 0

    func start(onLevel: @Sendable @escaping (Double) -> Void) async throws {
        self.update = onLevel
        if self.running { return }
        let input = self.engine.inputNode
        let format = input.outputFormat(forBus: 0)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 512, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            let level = Self.normalizedLevel(from: buffer)
            Task { await self.push(level: level) }
        }
        self.engine.prepare()
        try self.engine.start()
        self.running = true
    }

    func stop() {
        guard self.running else { return }
        self.engine.inputNode.removeTap(onBus: 0)
        self.engine.stop()
        self.running = false
    }

    private func push(level: Double) {
        self.smoothedLevel = (self.smoothedLevel * 0.45) + (level * 0.55)
        guard let update else { return }
        let value = self.smoothedLevel
        Task { @MainActor in update(value) }
    }

    private static func normalizedLevel(from buffer: AVAudioPCMBuffer) -> Double {
        guard let channel = buffer.floatChannelData?[0] else { return 0 }
        let frameCount = Int(buffer.frameLength)
        guard frameCount > 0 else { return 0 }
        var sum: Float = 0
        for i in 0..<frameCount {
            let s = channel[i]
            sum += s * s
        }
        let rms = sqrt(sum / Float(frameCount) + 1e-12)
        let db = 20 * log10(Double(rms))
        let normalized = max(0, min(1, (db + 50) / 50)) // -50dB -> 0, 0dB -> 1
        return normalized
    }
}

@MainActor
final class VoiceWakeTester {
    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?
    private var isStopping = false

    init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    func start(
        triggers: [String],
        micID: String?,
        localeID: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void) async throws
    {
        guard self.recognitionTask == nil else { return }
        self.isStopping = false
        let chosenLocale = localeID.flatMap { Locale(identifier: $0) } ?? Locale.current
        let recognizer = SFSpeechRecognizer(locale: chosenLocale)
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 1,
                userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable"])
        }

        guard Self.hasPrivacyStrings else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 3,
                userInfo: [
                    NSLocalizedDescriptionKey: "Missing mic/speech privacy strings. Rebuild the mac app (scripts/restart-mac.sh) to include usage descriptions.",
                ])
        }

        let granted = try await Self.ensurePermissions()
        guard granted else {
            throw NSError(
                domain: "VoiceWakeTester",
                code: 2,
                userInfo: [NSLocalizedDescriptionKey: "Microphone or speech permission denied"])
        }

        self.configureSession(preferredMicID: micID)

        self.recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        self.recognitionRequest?.shouldReportPartialResults = true
        let request = self.recognitionRequest

        let inputNode = self.audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak request] buffer, _ in
            request?.append(buffer)
        }

        self.audioEngine.prepare()
        try self.audioEngine.start()
        DispatchQueue.main.async {
            onUpdate(.listening)
        }

        guard let request = recognitionRequest else { return }

        self.recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            guard let self, !self.isStopping else { return }
            let text = result?.bestTranscription.formattedString ?? ""
            let matched = Self.matches(text: text, triggers: triggers)
            let isFinal = result?.isFinal ?? false
            let errorMessage = error?.localizedDescription
            Task { @MainActor [weak self] in
                guard let self else { return }
                self.handleResult(
                    matched: matched,
                    text: text,
                    isFinal: isFinal,
                    errorMessage: errorMessage,
                    onUpdate: onUpdate)
            }
        }
    }

    func stop() {
        self.isStopping = true
        self.audioEngine.stop()
        self.recognitionRequest?.endAudio()
        self.recognitionTask?.cancel()
        self.recognitionTask = nil
        self.recognitionRequest = nil
        self.audioEngine.inputNode.removeTap(onBus: 0)
    }

    @MainActor
    private func handleResult(
        matched: Bool,
        text: String,
        isFinal: Bool,
        errorMessage: String?,
        onUpdate: @escaping @Sendable (VoiceWakeTestState) -> Void)
    {
        if matched, !text.isEmpty {
            self.stop()
            onUpdate(.detected(text))
            return
        }
        if let errorMessage {
            self.stop()
            onUpdate(.failed(errorMessage))
            return
        }
        if isFinal {
            self.stop()
            onUpdate(text.isEmpty ? .failed("No speech detected") : .failed("No trigger heard: “\(text)”"))
        } else {
            onUpdate(text.isEmpty ? .listening : .hearing(text))
        }
    }

    private func configureSession(preferredMicID: String?) {
        // macOS uses the system default input for AVAudioEngine. Selection is stored for future
        // pipeline wiring; test currently relies on the system default device.
        _ = preferredMicID
    }

    private static func matches(text: String, triggers: [String]) -> Bool {
        let lowered = text.lowercased()
        return triggers.contains { lowered.contains($0.lowercased()) }
    }

    private nonisolated static func ensurePermissions() async throws -> Bool {
        let speechStatus = SFSpeechRecognizer.authorizationStatus()
        if speechStatus == .notDetermined {
            let granted = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { status in
                    continuation.resume(returning: status == .authorized)
                }
            }
            guard granted else { return false }
        } else if speechStatus != .authorized {
            return false
        }

        let micStatus = AVCaptureDevice.authorizationStatus(for: .audio)
        switch micStatus {
        case .authorized: return true

        case .notDetermined:
            return await withCheckedContinuation { continuation in
                AVCaptureDevice.requestAccess(for: .audio) { granted in
                    continuation.resume(returning: granted)
                }
            }

        default:
            return false
        }
    }

    private static var hasPrivacyStrings: Bool {
        let speech = Bundle.main.object(forInfoDictionaryKey: "NSSpeechRecognitionUsageDescription") as? String
        let mic = Bundle.main.object(forInfoDictionaryKey: "NSMicrophoneUsageDescription") as? String
        return speech?.isEmpty == false && mic?.isEmpty == false
    }
}

@MainActor
struct SettingsToggleRow: View {
    let title: String
    let subtitle: String?
    @Binding var binding: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Toggle(isOn: self.$binding) {
                Text(self.title)
                    .font(.body)
            }
            .toggleStyle(.checkbox)

            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(.footnote)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

struct GeneralSettings: View {
    @ObservedObject var state: AppState
    @State private var isInstallingCLI = false
    @State private var cliStatus: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            if !self.state.onboardingSeen {
                Text("Complete onboarding to finish setup")
                    .font(.callout.weight(.semibold))
                    .foregroundColor(.accentColor)
                    .padding(.bottom, 2)
            }

            VStack(alignment: .leading, spacing: 12) {
                SettingsToggleRow(
                    title: "Clawdis active",
                    subtitle: "Pause to stop Clawdis background helpers and notifications.",
                    binding: self.activeBinding)

                SettingsToggleRow(
                    title: "Launch at login",
                    subtitle: "Automatically start Clawdis after you sign in.",
                    binding: self.$state.launchAtLogin)

                SettingsToggleRow(
                    title: "Show Dock icon",
                    subtitle: "Keep Clawdis visible in the Dock instead of menu-bar-only mode.",
                    binding: self.$state.showDockIcon)

                SettingsToggleRow(
                    title: "Enable debug tools",
                    subtitle: "Show the Debug tab with development utilities.",
                    binding: self.$state.debugPaneEnabled)

                LabeledContent("Default sound") {
                    Picker("Sound", selection: self.$state.defaultSound) {
                        Text("None").tag("")
                        Text("Glass").tag("Glass")
                        Text("Basso").tag("Basso")
                        Text("Ping").tag("Ping")
                    }
                    .labelsHidden()
                    .frame(width: 140)
                }
            }

            VStack(alignment: .leading, spacing: 6) {
                Text("CLI helper")
                    .font(.callout.weight(.semibold))
                self.cliInstaller
            }

            Spacer()
            HStack {
                Spacer()
                Button("Quit Clawdis") { NSApp.terminate(nil) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 22)
    }

    private var activeBinding: Binding<Bool> {
        Binding(
            get: { !self.state.isPaused },
            set: { self.state.isPaused = !$0 })
    }

    private var cliInstaller: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                Button {
                    Task { await self.installCLI() }
                } label: {
                    if self.isInstallingCLI {
                        ProgressView().controlSize(.small)
                    } else {
                        Text("Install CLI helper")
                    }
                }
                .disabled(self.isInstallingCLI)

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
        guard !self.isInstallingCLI else { return }
        self.isInstallingCLI = true
        defer { isInstallingCLI = false }
        await CLIInstaller.install { status in
            await MainActor.run { self.cliStatus = status }
        }
    }
}

struct VoiceWakeSettings: View {
    @ObservedObject var state: AppState
    @State private var testState: VoiceWakeTestState = .idle
    @State private var tester = VoiceWakeTester()
    @State private var isTesting = false
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false
    @State private var meterLevel: Double = 0
    @State private var meterError: String?
    private let meter = MicLevelMonitor()
    @State private var availableLocales: [Locale] = []

    private struct IndexedWord: Identifiable {
        let id: Int
        let value: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsToggleRow(
                title: "Enable Voice Wake",
                subtitle: "Listen for a wake phrase (e.g. \"Claude\") before running voice commands. Voice recognition runs fully on-device.",
                binding: self.$state.swabbleEnabled)
                .disabled(!voiceWakeSupported)

            if !voiceWakeSupported {
                Label("Voice Wake requires macOS 26 or newer.", systemImage: "exclamationmark.triangle.fill")
                    .font(.callout)
                    .foregroundStyle(.yellow)
                    .padding(8)
                    .background(Color.secondary.opacity(0.15))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
            }

            self.localePicker
            self.micPicker
            self.levelMeter

            self.testCard

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Trigger words")
                        .font(.callout.weight(.semibold))
                    Spacer()
                    Button {
                        self.addWord()
                    } label: {
                        Label("Add word", systemImage: "plus")
                    }
                    .disabled(self.state.swabbleTriggerWords
                        .contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))

                    Button("Reset defaults") { self.state.swabbleTriggerWords = defaultVoiceWakeTriggers }
                }

                Table(self.indexedWords) {
                    TableColumn("Word") { row in
                        TextField("Wake word", text: self.binding(for: row.id))
                            .textFieldStyle(.roundedBorder)
                    }
                    TableColumn("") { row in
                        Button {
                            self.removeWord(at: row.id)
                        } label: {
                            Image(systemName: "trash")
                        }
                        .buttonStyle(.borderless)
                        .help("Remove trigger word")
                    }
                    .width(36)
                }
                .frame(minHeight: 180)
                .clipShape(RoundedRectangle(cornerRadius: 6))
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.25), lineWidth: 1))

                Text(
                    "Clawdis reacts when any trigger appears in a transcription. Keep them short to avoid false positives.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .task { await self.loadMicsIfNeeded() }
        .task { await self.loadLocalesIfNeeded() }
        .task { await self.restartMeter() }
        .onChange(of: self.state.voiceWakeMicID) { _, _ in
            Task { await self.restartMeter() }
        }
        .onDisappear {
            Task { await self.meter.stop() }
        }
    }

    private var indexedWords: [IndexedWord] {
        self.state.swabbleTriggerWords.enumerated().map { IndexedWord(id: $0.offset, value: $0.element) }
    }

    private var testCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Test Voice Wake")
                    .font(.callout.weight(.semibold))
                Spacer()
                Button(action: self.toggleTest) {
                    Label(
                        self.isTesting ? "Stop" : "Start test",
                        systemImage: self.isTesting ? "stop.circle.fill" : "play.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(self.isTesting ? .red : .accentColor)
            }

            HStack(spacing: 8) {
                self.statusIcon
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.statusText)
                        .font(.subheadline)
                    if case let .detected(text) = testState {
                        Text("Heard: \(text)")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }
                Spacer()
            }
            .padding(10)
            .background(.quaternary.opacity(0.2))
            .clipShape(RoundedRectangle(cornerRadius: 8))
        }
        .padding(.vertical, 2)
    }

    private var statusIcon: some View {
        switch self.testState {
        case .idle:
            AnyView(Image(systemName: "waveform").foregroundStyle(.secondary))

        case .requesting:
            AnyView(ProgressView().controlSize(.small))

        case .listening, .hearing:
            AnyView(
                Image(systemName: "ear.and.waveform")
                    .symbolEffect(.pulse)
                    .foregroundStyle(Color.accentColor))

        case .detected:
            AnyView(Image(systemName: "checkmark.circle.fill").foregroundStyle(.green))

        case .failed:
            AnyView(Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow))
        }
    }

    private var statusText: String {
        switch self.testState {
        case .idle:
            "Press start, say a trigger word, and wait for detection."

        case .requesting:
            "Requesting mic & speech permission…"

        case .listening:
            "Listening… say your trigger word."

        case let .hearing(text):
            "Heard: \(text)"

        case .detected:
            "Voice wake detected!"

        case let .failed(reason):
            reason
        }
    }

    private func addWord() {
        self.state.swabbleTriggerWords.append("")
    }

    private func removeWord(at index: Int) {
        guard self.state.swabbleTriggerWords.indices.contains(index) else { return }
        self.state.swabbleTriggerWords.remove(at: index)
    }

    private func binding(for index: Int) -> Binding<String> {
        Binding(
            get: {
                guard self.state.swabbleTriggerWords.indices.contains(index) else { return "" }
                return self.state.swabbleTriggerWords[index]
            },
            set: { newValue in
                guard self.state.swabbleTriggerWords.indices.contains(index) else { return }
                self.state.swabbleTriggerWords[index] = newValue
            })
    }

    private func toggleTest() {
        guard voiceWakeSupported else {
            self.testState = .failed("Voice Wake requires macOS 26 or newer.")
            return
        }
        if self.isTesting {
            self.tester.stop()
            self.isTesting = false
            self.testState = .idle
            return
        }

        let triggers = self.sanitizedTriggers()
        self.isTesting = true
        self.testState = .requesting
        Task { @MainActor in
            do {
                try await self.tester.start(
                    triggers: triggers,
                    micID: self.state.voiceWakeMicID.isEmpty ? nil : self.state.voiceWakeMicID,
                    localeID: self.state.voiceWakeLocaleID,
                    onUpdate: { newState in
                        DispatchQueue.main.async { [self] in
                            self.testState = newState
                            if case .detected = newState { self.isTesting = false }
                            if case .failed = newState { self.isTesting = false }
                        }
                    })
                // timeout after 10s
                try await Task.sleep(nanoseconds: 10 * 1_000_000_000)
                if self.isTesting {
                    self.tester.stop()
                    self.testState = .failed("Timeout: no trigger heard")
                    self.isTesting = false
                }
            } catch {
                self.tester.stop()
                self.testState = .failed(error.localizedDescription)
                self.isTesting = false
            }
        }
    }

    private func sanitizedTriggers() -> [String] {
        let cleaned = self.state.swabbleTriggerWords
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return cleaned.isEmpty ? defaultVoiceWakeTriggers : cleaned
    }

    private var micPicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("Microphone") {
                Picker("Microphone", selection: self.$state.voiceWakeMicID) {
                    Text("System default").tag("")
                    ForEach(self.availableMics) { mic in
                        Text(mic.name).tag(mic.uid)
                    }
                }
                .labelsHidden()
                .frame(width: 260)
            }
            if self.loadingMics {
                ProgressView().controlSize(.small)
            }
        }
    }

    private var localePicker: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent("Recognition language") {
                Picker("Language", selection: self.$state.voiceWakeLocaleID) {
                    let current = Locale(identifier: Locale.current.identifier)
                    Text("\(self.friendlyName(for: current)) (System)").tag(Locale.current.identifier)
                    ForEach(self.availableLocales.map(\.identifier), id: \.self) { id in
                        if id != Locale.current.identifier {
                            Text(self.friendlyName(for: Locale(identifier: id))).tag(id)
                        }
                    }
                }
                .labelsHidden()
                .frame(width: 260)
            }

            if !self.state.voiceWakeAdditionalLocaleIDs.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text("Additional languages")
                        .font(.footnote.weight(.semibold))
                    ForEach(
                        Array(self.state.voiceWakeAdditionalLocaleIDs.enumerated()),
                        id: \.offset)
                    { idx, localeID in
                        HStack(spacing: 8) {
                            Picker("Extra \(idx + 1)", selection: Binding(
                                get: { localeID },
                                set: { newValue in
                                    guard self.state
                                        .voiceWakeAdditionalLocaleIDs.indices
                                        .contains(idx) else { return }
                                    self.state
                                        .voiceWakeAdditionalLocaleIDs[idx] =
                                        newValue
                                })) {
                                    ForEach(self.availableLocales.map(\.identifier), id: \.self) { id in
                                        Text(self.friendlyName(for: Locale(identifier: id))).tag(id)
                                    }
                                }
                                .labelsHidden()
                                    .frame(width: 220)

                            Button {
                                guard self.state.voiceWakeAdditionalLocaleIDs.indices.contains(idx) else { return }
                                self.state.voiceWakeAdditionalLocaleIDs.remove(at: idx)
                            } label: {
                                Image(systemName: "trash")
                            }
                            .buttonStyle(.borderless)
                            .help("Remove language")
                        }
                    }

                    Button {
                        if let first = availableLocales.first {
                            self.state.voiceWakeAdditionalLocaleIDs.append(first.identifier)
                        }
                    } label: {
                        Label("Add language", systemImage: "plus")
                    }
                    .disabled(self.availableLocales.isEmpty)
                }
                .padding(.top, 4)
            } else {
                Button {
                    if let first = availableLocales.first {
                        self.state.voiceWakeAdditionalLocaleIDs.append(first.identifier)
                    }
                } label: {
                    Label("Add additional language", systemImage: "plus")
                }
                .buttonStyle(.link)
                .disabled(self.availableLocales.isEmpty)
                .padding(.top, 4)
            }

            Text("Languages are tried in order. Models may need a first-use download on macOS 26.")
                .font(.caption)
                .foregroundStyle(.secondary)
        }
    }

    @MainActor
    private func loadMicsIfNeeded() async {
        guard self.availableMics.isEmpty, !self.loadingMics else { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        self.availableMics = discovery.devices.map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.loadingMics = false
    }

    @MainActor
    private func loadLocalesIfNeeded() async {
        guard self.availableLocales.isEmpty else { return }
        self.availableLocales = Array(SFSpeechRecognizer.supportedLocales()).sorted { lhs, rhs in
            self.friendlyName(for: lhs)
                .localizedCaseInsensitiveCompare(self.friendlyName(for: rhs)) == .orderedAscending
        }
    }

    /// Produce a human-friendly label without odd BCP-47 variants (rg=zzzz, calendar, collation, numbering).
    private func friendlyName(for locale: Locale) -> String {
        let cleanedID = self.normalizedLocaleIdentifier(locale.identifier)
        let cleanLocale = Locale(identifier: cleanedID)

        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode),
           let regionCode = cleanLocale.region?.identifier,
           let region = cleanLocale.localizedString(forRegionCode: regionCode)
        {
            return "\(lang) (\(region))"
        }
        if let langCode = cleanLocale.language.languageCode?.identifier,
           let lang = cleanLocale.localizedString(forLanguageCode: langCode)
        {
            return lang
        }
        return cleanLocale.localizedString(forIdentifier: cleanedID) ?? cleanedID
    }

    /// Strip uncommon BCP-47 subtags so labels stay readable (e.g. remove @rg=zzzz, -u- extensions).
    private func normalizedLocaleIdentifier(_ raw: String) -> String {
        var trimmed = raw
        if let at = trimmed.firstIndex(of: "@") {
            trimmed = String(trimmed[..<at])
        }
        if let u = trimmed.range(of: "-u-") {
            trimmed = String(trimmed[..<u.lowerBound])
        }
        if let t = trimmed.range(of: "-t-") { // transform extension
            trimmed = String(trimmed[..<t.lowerBound])
        }
        return trimmed
    }

    private var levelMeter: some View {
        VStack(alignment: .leading, spacing: 6) {
            LabeledContent {
                HStack(spacing: 10) {
                    MicLevelBar(level: self.meterLevel)
                    Text(self.levelLabel)
                        .font(.callout.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            } label: {
                Text("Live level")
                    .font(.callout.weight(.semibold))
            }
            if let meterError {
                Text(meterError)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private var levelLabel: String {
        let db = (meterLevel * 50) - 50
        return String(format: "%.0f dB", db)
    }

    @MainActor
    private func restartMeter() async {
        self.meterError = nil
        await self.meter.stop()
        do {
            try await self.meter.start { [weak state] level in
                Task { @MainActor in
                    guard state != nil else { return }
                    self.meterLevel = level
                }
            }
        } catch {
            self.meterError = error.localizedDescription
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

            PermissionStatusList(status: self.status, refresh: self.refresh)
                .padding(.horizontal, 2)
                .padding(.vertical, 6)

            Button("Show onboarding") { self.showOnboarding() }
                .buttonStyle(.bordered)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
    }
}

struct DebugSettings: View {
    @AppStorage(modelCatalogPathKey) private var modelCatalogPath: String = ModelCatalogLoader.defaultPath
    @AppStorage(modelCatalogReloadKey) private var modelCatalogReloadBump: Int = 0
    @State private var modelsCount: Int?
    @State private var modelsLoading = false
    @State private var modelsError: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            LabeledContent("PID") { Text("\(ProcessInfo.processInfo.processIdentifier)") }
            LabeledContent("Log file") {
                Button("Open /tmp/clawdis.log") { NSWorkspace.shared.open(URL(fileURLWithPath: "/tmp/clawdis.log")) }
            }
            LabeledContent("Binary path") { Text(Bundle.main.bundlePath).font(.footnote) }
            LabeledContent("Model catalog") {
                VStack(alignment: .leading, spacing: 6) {
                    Text(self.modelCatalogPath)
                        .font(.caption.monospaced())
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    HStack(spacing: 8) {
                        Button {
                            self.chooseCatalogFile()
                        } label: {
                            Label("Choose models.generated.ts…", systemImage: "folder")
                        }
                        .buttonStyle(.bordered)

                        Button {
                            Task { await self.reloadModels() }
                        } label: {
                            Label(self.modelsLoading ? "Reloading…" : "Reload models", systemImage: "arrow.clockwise")
                        }
                        .buttonStyle(.bordered)
                        .disabled(self.modelsLoading)
                    }
                    if let modelsError {
                        Text(modelsError)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    } else if let modelsCount {
                        Text("Loaded \(modelsCount) models")
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    Text("Used by the Config tab model picker; point at a different build when debugging.")
                        .font(.footnote)
                        .foregroundStyle(.tertiary)
                }
            }
            Button("Send Test Notification") {
                Task { _ = await NotificationManager().send(title: "Clawdis", body: "Test notification", sound: nil) }
            }
            .buttonStyle(.bordered)
            HStack {
                Button("Restart app") { self.relaunch() }
                Button("Reveal app in Finder") { self.revealApp() }
            }
            .buttonStyle(.bordered)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .task { await self.reloadModels() }
    }

    private func chooseCatalogFile() {
        let panel = NSOpenPanel()
        panel.title = "Select models.generated.ts"
        if let tsType = UTType(filenameExtension: "ts") {
            panel.allowedContentTypes = [tsType]
        } else {
            panel.allowedFileTypes = ["ts"] // fallback
        }
        panel.allowsMultipleSelection = false
        panel.directoryURL = URL(fileURLWithPath: self.modelCatalogPath).deletingLastPathComponent()
        if panel.runModal() == .OK, let url = panel.url {
            self.modelCatalogPath = url.path
            self.modelCatalogReloadBump += 1
            Task { await self.reloadModels() }
        }
    }

    private func reloadModels() async {
        guard !self.modelsLoading else { return }
        self.modelsLoading = true
        self.modelsError = nil
        self.modelCatalogReloadBump += 1
        defer { self.modelsLoading = false }
        do {
            let loaded = try await ModelCatalogLoader.load(from: self.modelCatalogPath)
            self.modelsCount = loaded.count
        } catch {
            self.modelsCount = nil
            self.modelsError = error.localizedDescription
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
        VStack(spacing: 8) {
            let appIcon = NSApplication.shared.applicationIconImage ?? CritterIconRenderer.makeIcon(blink: 0)
            Button {
                if let url = URL(string: "https://github.com/steipete/clawdis") {
                    NSWorkspace.shared.open(url)
                }
            } label: {
                Image(nsImage: appIcon)
                    .resizable()
                    .frame(width: 88, height: 88)
                    .cornerRadius(16)
                    .shadow(color: self.iconHover ? .accentColor.opacity(0.25) : .clear, radius: 8)
                    .scaleEffect(self.iconHover ? 1.06 : 1.0)
            }
            .buttonStyle(.plain)
            .onHover { hover in
                withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) { self.iconHover = hover }
            }

            VStack(spacing: 3) {
                Text("Clawdis")
                    .font(.title3.bold())
                Text("Version \(self.versionString)")
                    .foregroundStyle(.secondary)
                if let buildTimestamp {
                    Text("Built \(buildTimestamp)")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                Text("Menu bar companion for notifications, screenshots, and privileged agent actions.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)
                    .padding(.horizontal, 18)
            }

            VStack(alignment: .center, spacing: 6) {
                AboutLinkRow(
                    icon: "chevron.left.slash.chevron.right",
                    title: "GitHub",
                    url: "https://github.com/steipete/clawdis")
                AboutLinkRow(icon: "globe", title: "Website", url: "https://steipete.me")
                AboutLinkRow(icon: "bird", title: "Twitter", url: "https://twitter.com/steipete")
                AboutLinkRow(icon: "envelope", title: "Email", url: "mailto:[redacted-email]")
            }
            .frame(maxWidth: .infinity)
            .multilineTextAlignment(.center)
            .padding(.vertical, 10)

            Text("© 2025 Peter Steinberger — MIT License.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .padding(.top, 4)

            Spacer()
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .padding(.top, 4)
        .padding(.horizontal, 24)
        .padding(.bottom, 24)
    }

    private var versionString: String {
        let version = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "dev"
        let build = Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String
        return build.map { "\(version) (\($0))" } ?? version
    }

    private var buildTimestamp: String? {
        guard let raw = Bundle.main.object(forInfoDictionaryKey: "ClawdisBuildTimestamp") as? String else { return nil }
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime]
        guard let date = parser.date(from: raw) else { return raw }

        let formatter = DateFormatter()
        formatter.dateStyle = .medium
        formatter.timeStyle = .short
        formatter.locale = .current
        return formatter.string(from: date)
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
                Image(systemName: self.icon)
                Text(self.title)
                    .underline(self.hovering, color: .accentColor)
            }
            .foregroundColor(.accentColor)
        }
        .buttonStyle(.plain)
        .onHover { self.hovering = $0 }
    }
}

struct PermissionStatusList: View {
    let status: [Capability: Bool]
    let refresh: () async -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            ForEach(Capability.allCases, id: \.self) { cap in
                PermissionRow(capability: cap, status: self.status[cap] ?? false) {
                    Task { await self.handle(cap) }
                }
            }
            Button("Refresh status") { Task { await self.refresh() } }
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
                self.openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility")

            case .screenRecording:
                self.openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenRecording")

            case .microphone:
                self.openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")

            case .speechRecognition:
                self.openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
            }
            await self.refresh()
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
        self.runLaunchctl(["kickstart", "-k", userTarget])
    }

    static func stopClawdis() {
        let userTarget = "gui/\(getuid())/\(launchdLabel)"
        self.runLaunchctl(["stop", userTarget])
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
                try FileManager.default.createDirectory(
                    atPath: (target as NSString).deletingLastPathComponent,
                    withIntermediateDirectories: true)
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
                Circle().fill(self.status ? Color.green.opacity(0.2) : Color.gray.opacity(0.15))
                    .frame(width: 32, height: 32)
                Image(systemName: self.icon)
                    .foregroundStyle(self.status ? Color.green : Color.secondary)
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title).font(.body.weight(.semibold))
                Text(self.subtitle).font(.caption).foregroundStyle(.secondary)
            }
            Spacer()
            if self.status {
                Label("Granted", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Button("Grant") { self.action() }
                    .buttonStyle(.bordered)
            }
        }
        .padding(.vertical, 6)
    }

    private var title: String {
        switch self.capability {
        case .notifications: "Notifications"
        case .accessibility: "Accessibility"
        case .screenRecording: "Screen Recording"
        case .microphone: "Microphone"
        case .speechRecognition: "Speech Recognition"
        }
    }

    private var subtitle: String {
        switch self.capability {
        case .notifications: "Show desktop alerts for agent activity"
        case .accessibility: "Control UI elements when an action requires it"
        case .screenRecording: "Capture the screen for context or screenshots"
        case .microphone: "Allow Voice Wake and audio capture"
        case .speechRecognition: "Transcribe Voice Wake trigger phrases on-device"
        }
    }

    private var icon: String {
        switch self.capability {
        case .notifications: "bell"
        case .accessibility: "hand.raised"
        case .screenRecording: "display"
        case .microphone: "mic"
        case .speechRecognition: "waveform"
        }
    }
}

struct MicLevelBar: View {
    let level: Double
    let segments: Int = 12

    var body: some View {
        HStack(spacing: 3) {
            ForEach(0..<self.segments, id: \.self) { idx in
                let fill = self.level * Double(self.segments) > Double(idx)
                RoundedRectangle(cornerRadius: 2)
                    .fill(fill ? self.segmentColor(for: idx) : Color.gray.opacity(0.35))
                    .frame(width: 14, height: 10)
            }
        }
        .padding(4)
        .background(
            RoundedRectangle(cornerRadius: 6)
                .stroke(Color.gray.opacity(0.25), lineWidth: 1))
    }

    private func segmentColor(for idx: Int) -> Color {
        let fraction = Double(idx + 1) / Double(self.segments)
        if fraction < 0.65 { return .green }
        if fraction < 0.85 { return .yellow }
        return .red
    }
}

// MARK: - Onboarding

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
        window.setContentSize(NSSize(width: 640, height: 560))
        window.styleMask = [.titled, .closable]
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        self.window = window
    }

    func close() {
        self.window?.close()
        self.window = nil
    }
}

struct OnboardingView: View {
    @State private var currentPage = 0
    @State private var isRequesting = false
    @State private var installingCLI = false
    @State private var cliStatus: String?
    @State private var copied = false
    @State private var monitoringPermissions = false
    @ObservedObject private var state = AppStateStore.shared
    @ObservedObject private var permissionMonitor = PermissionMonitor.shared

    private let pageWidth: CGFloat = 640
    private let contentHeight: CGFloat = 260
    private let permissionsPageIndex = 2
    private var pageCount: Int { 6 }
    private var buttonTitle: String { self.currentPage == self.pageCount - 1 ? "Finish" : "Next" }
    private let devLinkCommand = "ln -sf $(pwd)/apps/macos/.build/debug/ClawdisCLI /usr/local/bin/clawdis-mac"

    var body: some View {
        VStack(spacing: 0) {
            GlowingClawdisIcon(size: 156)
                .padding(.top, 40)
                .padding(.bottom, 20)
                .frame(height: 240)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    self.welcomePage().frame(width: self.pageWidth)
                    self.focusPage().frame(width: self.pageWidth)
                    self.permissionsPage().frame(width: self.pageWidth)
                    self.cliPage().frame(width: self.pageWidth)
                    self.launchPage().frame(width: self.pageWidth)
                    self.readyPage().frame(width: self.pageWidth)
                }
                .offset(x: CGFloat(-self.currentPage) * self.pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: self.currentPage)
                .frame(height: self.contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: 260)

            self.navigationBar
        }
        .frame(width: self.pageWidth, height: 560)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear {
            self.currentPage = 0
            self.updatePermissionMonitoring(for: 0)
        }
        .onChange(of: self.currentPage) { _, newValue in
            self.updatePermissionMonitoring(for: newValue)
        }
        .onDisappear { self.stopPermissionMonitoring() }
        .task { await self.refreshPerms() }
    }

    private func welcomePage() -> some View {
        self.onboardingPage {
            Text("Welcome to Clawdis")
                .font(.largeTitle.weight(.semibold))
            Text("Your macOS menu bar companion for notifications, screenshots, and privileged agent actions.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)
            Text("Quick steps with live permission checks and the helper CLI so you can finish setup in minutes.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func focusPage() -> some View {
        self.onboardingPage {
            Text("What Clawdis handles")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                self.featureRow(
                    title: "Owns the TCC prompts",
                    subtitle: "Requests Notifications, Accessibility, and Screen Recording so your agents stay unblocked.",
                    systemImage: "lock.shield")
                self.featureRow(
                    title: "Native notifications",
                    subtitle: "Shows desktop toasts for agent events with your preferred sound.",
                    systemImage: "bell.and.waveform")
                self.featureRow(
                    title: "Privileged helpers",
                    subtitle: "Runs screenshots or shell actions from the `clawdis-mac` CLI with the right permissions.",
                    systemImage: "terminal")
            }
        }
    }

    private func permissionsPage() -> some View {
        self.onboardingPage {
            Text("Grant permissions")
                .font(.largeTitle.weight(.semibold))
            Text("Approve these once and the helper CLI reuses the same grants.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard {
                ForEach(Capability.allCases, id: \.self) { cap in
                    PermissionRow(capability: cap, status: self.permissionMonitor.status[cap] ?? false) {
                        Task { await self.request(cap) }
                    }
                }

                HStack(spacing: 12) {
                    Button("Refresh status") { Task { await self.refreshPerms() } }
                        .controlSize(.small)
                    if self.isRequesting {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private func cliPage() -> some View {
        self.onboardingPage {
            Text("Install the helper CLI")
                .font(.largeTitle.weight(.semibold))
            Text("Link `clawdis-mac` so scripts and the agent can talk to this app.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard {
                HStack(spacing: 12) {
                    Button {
                        Task { await self.installCLI() }
                    } label: {
                        if self.installingCLI {
                            ProgressView()
                        } else {
                            Text("Install helper")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.installingCLI)

                    Button(self.copied ? "Copied" : "Copy dev link") {
                        self.copyToPasteboard(self.devLinkCommand)
                    }
                    .disabled(self.installingCLI)
                }

                if let cliStatus {
                    Text(cliStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text(
                    "We install into /usr/local/bin and /opt/homebrew/bin. Rerun anytime if you move the build output.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func launchPage() -> some View {
        self.onboardingPage {
            Text("Keep it running")
                .font(.largeTitle.weight(.semibold))
            Text("Let Clawdis launch with macOS so permissions and notifications are ready when automations start.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            self.onboardingCard {
                HStack {
                    Spacer()
                    Toggle("Launch at login", isOn: self.$state.launchAtLogin)
                        .toggleStyle(.switch)
                        .onChange(of: self.state.launchAtLogin) { _, newValue in
                            AppStateStore.updateLaunchAtLogin(enabled: newValue)
                        }
                    Spacer()
                }
                Text(
                    "You can pause from the menu bar anytime. Settings keeps a \"Show onboarding\" button if you need to revisit.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .frame(maxWidth: .infinity, alignment: .center)
            }
        }
    }

    private func readyPage() -> some View {
        self.onboardingPage {
            Text("All set")
                .font(.largeTitle.weight(.semibold))
            self.onboardingCard {
                self.featureRow(
                    title: "Run the dashboard",
                    subtitle: "Use the CLI helper from your scripts, and reopen onboarding from Settings if you add a new user.",
                    systemImage: "checkmark.seal")
                self.featureRow(
                    title: "Test a notification",
                    subtitle: "Send a quick notify via the menu bar to confirm sounds and permissions.",
                    systemImage: "bell.badge")
            }
            Text("Finish to save this version of onboarding. We'll reshow automatically when steps change.")
                .font(.footnote)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
        }
    }

    private var navigationBar: some View {
        HStack(spacing: 20) {
            ZStack(alignment: .leading) {
                Button(action: {}, label: {
                    Label("Back", systemImage: "chevron.left").labelStyle(.iconOnly)
                })
                .buttonStyle(.plain)
                .opacity(0)
                .disabled(true)

                if self.currentPage > 0 {
                    Button(action: { self.handleBack() }) {
                        Label("Back", systemImage: "chevron.left")
                            .labelStyle(.iconOnly)
                    }
                    .buttonStyle(.plain)
                    .foregroundColor(.secondary)
                    .opacity(0.8)
                    .transition(.opacity.combined(with: .scale(scale: 0.9)))
                }
            }
            .frame(minWidth: 80, alignment: .leading)

            Spacer()

            HStack(spacing: 8) {
                ForEach(0..<self.pageCount, id: \.self) { index in
                    Button {
                        withAnimation { self.currentPage = index }
                    } label: {
                        Circle()
                            .fill(index == self.currentPage ? Color.accentColor : Color.gray.opacity(0.3))
                            .frame(width: 8, height: 8)
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()

            Button(action: self.handleNext) {
                Text(self.buttonTitle)
                    .frame(minWidth: 88)
            }
            .keyboardShortcut(.return)
            .buttonStyle(.borderedProminent)
        }
        .padding(.horizontal, 20)
        .frame(height: 60)
    }

    private func onboardingPage(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(spacing: 22) {
            content()
            Spacer()
        }
        .frame(width: self.pageWidth, alignment: .top)
    }

    private func onboardingCard(@ViewBuilder _ content: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 12) {
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(Color(NSColor.controlBackgroundColor))
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3))
    }

    private func featureRow(title: String, subtitle: String, systemImage: String) -> some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: systemImage)
                .font(.title3.weight(.semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 26)
            VStack(alignment: .leading, spacing: 4) {
                Text(title).font(.headline)
                Text(subtitle)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func handleBack() {
        withAnimation {
            self.currentPage = max(0, self.currentPage - 1)
        }
    }

    private func handleNext() {
        if self.currentPage < self.pageCount - 1 {
            withAnimation { self.currentPage += 1 }
        } else {
            self.finish()
        }
    }

    private func finish() {
        UserDefaults.standard.set(true, forKey: "clawdis.onboardingSeen")
        UserDefaults.standard.set(currentOnboardingVersion, forKey: onboardingVersionKey)
        OnboardingController.shared.close()
    }

    @MainActor
    private func refreshPerms() async {
        await self.permissionMonitor.refreshNow()
    }

    @MainActor
    private func request(_ cap: Capability) async {
        guard !self.isRequesting else { return }
        self.isRequesting = true
        defer { isRequesting = false }
        _ = await PermissionManager.ensure([cap], interactive: true)
        await self.refreshPerms()
    }

    private func updatePermissionMonitoring(for pageIndex: Int) {
        let shouldMonitor = pageIndex == self.permissionsPageIndex
        if shouldMonitor, !self.monitoringPermissions {
            self.monitoringPermissions = true
            PermissionMonitor.shared.register()
        } else if !shouldMonitor, self.monitoringPermissions {
            self.monitoringPermissions = false
            PermissionMonitor.shared.unregister()
        }
    }

    private func stopPermissionMonitoring() {
        guard self.monitoringPermissions else { return }
        self.monitoringPermissions = false
        PermissionMonitor.shared.unregister()
    }

    private func installCLI() async {
        guard !self.installingCLI else { return }
        self.installingCLI = true
        defer { installingCLI = false }
        await CLIInstaller.install { message in
            await MainActor.run { self.cliStatus = message }
        }
    }

    private func copyToPasteboard(_ text: String) {
        let pb = NSPasteboard.general
        pb.clearContents()
        pb.setString(text, forType: .string)
        self.copied = true
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { self.copied = false }
    }
}

private struct GlowingClawdisIcon: View {
    let size: CGFloat
    let glowIntensity: Double
    let enableFloating: Bool

    @State private var breathe = false

    init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
        self.size = size
        self.glowIntensity = glowIntensity
        self.enableFloating = enableFloating
    }

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(self.glowIntensity),
                            Color.blue.opacity(self.glowIntensity * 0.6),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .blur(radius: 22)
                .scaleEffect(self.breathe ? 1.12 : 0.95)
                .opacity(0.9)

            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: self.size, height: self.size)
                .clipShape(RoundedRectangle(cornerRadius: self.size * 0.22, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                .scaleEffect(self.breathe ? 1.02 : 1.0)
        }
        .frame(width: self.size + 60, height: self.size + 60)
        .onAppear {
            guard self.enableFloating else { return }
            withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
                self.breathe.toggle()
            }
        }
    }
}

extension VoiceWakeTester: @unchecked Sendable {}
