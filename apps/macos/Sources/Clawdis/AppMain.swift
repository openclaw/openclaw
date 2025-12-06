import AppKit
import ApplicationServices
import AsyncXPCConnection
import ClawdisIPC
import Foundation
import class Foundation.Bundle
import OSLog
import CoreGraphics
@preconcurrency import ScreenCaptureKit
import AVFoundation
import Speech
import VideoToolbox
import ServiceManagement
import SwiftUI
import UserNotifications
import MenuBarExtraAccess

private let serviceName = "com.steipete.clawdis.xpc"
private let launchdLabel = "com.steipete.clawdis"
private let onboardingVersionKey = "clawdis.onboardingVersion"
private let currentOnboardingVersion = 2
private let pauseDefaultsKey = "clawdis.pauseEnabled"
private let swabbleEnabledKey = "clawdis.swabbleEnabled"
private let swabbleTriggersKey = "clawdis.swabbleTriggers"
private let defaultVoiceWakeTriggers = ["clawd", "claude"]

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
    @Published var swabbleEnabled: Bool {
        didSet { UserDefaults.standard.set(swabbleEnabled, forKey: swabbleEnabledKey) }
    }
    @Published var swabbleTriggerWords: [String] {
        didSet {
            let cleaned = swabbleTriggerWords.map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty }
            UserDefaults.standard.set(cleaned, forKey: swabbleTriggersKey)
            if cleaned.count != swabbleTriggerWords.count {
                swabbleTriggerWords = cleaned
            }
        }
    }

    init() {
        self.isPaused = UserDefaults.standard.bool(forKey: pauseDefaultsKey)
        self.defaultSound = UserDefaults.standard.string(forKey: "clawdis.defaultSound") ?? ""
        self.launchAtLogin = SMAppService.mainApp.status == .enabled
        self.onboardingSeen = UserDefaults.standard.bool(forKey: "clawdis.onboardingSeen")
        self.debugPaneEnabled = UserDefaults.standard.bool(forKey: "clawdis.debugPaneEnabled")
        self.swabbleEnabled = UserDefaults.standard.bool(forKey: swabbleEnabledKey)
        self.swabbleTriggerWords = UserDefaults.standard.stringArray(forKey: swabbleTriggersKey) ?? defaultVoiceWakeTriggers
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
            case .microphone:
                let granted = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
                if interactive && !granted {
                    let ok = await AVCaptureDevice.requestAccess(for: .audio)
                    results[cap] = ok
                } else {
                    results[cap] = granted
                }
            case .speechRecognition:
                let status = SFSpeechRecognizer.authorizationStatus()
                if status == .notDetermined && interactive {
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
                results[cap] = settings.authorizationStatus == .authorized || settings.authorizationStatus == .provisional
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
    @State private var statusItem: NSStatusItem?
    @State private var isMenuPresented = false

    init() {
        _state = StateObject(wrappedValue: AppStateStore.shared)
    }

    var body: some Scene {
        MenuBarExtra { MenuContent(state: state) } label: { CritterStatusLabel(isPaused: state.isPaused) }
            .menuBarExtraStyle(.menu)
            .menuBarExtraAccess(isPresented: $isMenuPresented) { item in
                statusItem = item
                applyStatusItemAppearance(paused: state.isPaused)
            }
            .onChange(of: state.isPaused) { _, paused in
                applyStatusItemAppearance(paused: paused)
            }

        Settings {
            SettingsRootView(state: state)
                .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        }
        .defaultSize(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
        .windowResizability(.contentSize)
    }

    private func applyStatusItemAppearance(paused: Bool) {
        statusItem?.button?.appearsDisabled = paused
    }
}

private struct MenuContent: View {
    @ObservedObject var state: AppState
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        Toggle(isOn: activeBinding) { Text("Clawdis Active") }
        Toggle(isOn: $state.swabbleEnabled) { Text("Voice Wake") }
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

    private var activeBinding: Binding<Bool> {
        Binding(get: { !state.isPaused }, set: { state.isPaused = !$0 })
    }
}

private struct CritterStatusLabel: View {
    var isPaused: Bool

    @State private var blinkAmount: CGFloat = 0
    @State private var nextBlink = Date().addingTimeInterval(Double.random(in: 3.5 ... 8.5))
    @State private var wiggleAngle: Double = 0
    @State private var wiggleOffset: CGFloat = 0
    @State private var nextWiggle = Date().addingTimeInterval(Double.random(in: 6.5 ... 14))
    @State private var legWiggle: CGFloat = 0
    @State private var nextLegWiggle = Date().addingTimeInterval(Double.random(in: 5.0 ... 11.0))
    @State private var earWiggle: CGFloat = 0
    @State private var nextEarWiggle = Date().addingTimeInterval(Double.random(in: 7.0 ... 14.0))
    private let ticker = Timer.publish(every: 0.35, on: .main, in: .common).autoconnect()

    var body: some View {
        Group {
            if isPaused {
                Image(nsImage: CritterIconRenderer.makeIcon(blink: 0))
                    .frame(width: 18, height: 16)
            } else {
                Image(nsImage: CritterIconRenderer.makeIcon(
                    blink: blinkAmount,
                    legWiggle: legWiggle,
                    earWiggle: earWiggle
                ))
                    .frame(width: 18, height: 16)
                    .rotationEffect(.degrees(wiggleAngle), anchor: .center)
                    .offset(x: wiggleOffset)
                    .onReceive(ticker) { now in
                        if now >= nextBlink {
                            blink()
                            nextBlink = now.addingTimeInterval(Double.random(in: 3.5 ... 8.5))
                        }

                        if now >= nextWiggle {
                            wiggle()
                            nextWiggle = now.addingTimeInterval(Double.random(in: 6.5 ... 14))
                        }

                        if now >= nextLegWiggle {
                            wiggleLegs()
                            nextLegWiggle = now.addingTimeInterval(Double.random(in: 5.0 ... 11.0))
                        }

                        if now >= nextEarWiggle {
                            wiggleEars()
                            nextEarWiggle = now.addingTimeInterval(Double.random(in: 7.0 ... 14.0))
                        }
                    }
                    .onChange(of: isPaused) { _, _ in resetMotion() }
            }
        }
    }

    private func resetMotion() {
        blinkAmount = 0
        wiggleAngle = 0
        wiggleOffset = 0
        legWiggle = 0
        earWiggle = 0
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

    private func wiggleLegs() {
        let target = CGFloat.random(in: 0.35 ... 0.9)
        withAnimation(.easeInOut(duration: 0.14)) {
            legWiggle = target
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) {
            withAnimation(.easeOut(duration: 0.18)) { legWiggle = 0 }
        }
    }

    private func wiggleEars() {
        let target = CGFloat.random(in: -1.2 ... 1.2)
        withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) {
            earWiggle = target
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.32) {
            withAnimation(.interpolatingSpring(stiffness: 260, damping: 19)) { earWiggle = 0 }
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

        let w = size.width
        let h = size.height

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
        ctx.addPath(CGPath(roundedRect: CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH), cornerWidth: bodyCorner, cornerHeight: bodyCorner, transform: nil))
        // Ears (tiny wiggle)
        ctx.addPath(CGPath(roundedRect: CGRect(
            x: bodyX - earW * 0.55 + earWiggle,
            y: bodyY + bodyH * 0.08 + earWiggle * 0.4,
            width: earW,
            height: earH),
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        ctx.addPath(CGPath(roundedRect: CGRect(
            x: bodyX + bodyW - earW * 0.45 - earWiggle,
            y: bodyY + bodyH * 0.08 - earWiggle * 0.4,
            width: earW,
            height: earH),
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        // Legs
        for i in 0 ..< 4 {
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
        guard contextTokens > 0, total > 0 else { return nil }
        return min(100, Int(round((Double(total) / Double(contextTokens)) * 100)))
    }

    var summary: String {
        let parts = ["in \(input)", "out \(output)", "total \(total)"]
        var text = parts.joined(separator: " | ")
        if let percentUsed {
            text += " (\(percentUsed)% of \(contextTokens))"
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

    var ageText: String { relativeAge(from: updatedAt) }

    var flagLabels: [String] {
        var flags: [String] = []
        if let thinkingLevel { flags.append("think \(thinkingLevel)") }
        if let verboseLevel { flags.append("verbose \(verboseLevel)") }
        if systemSent { flags.append("system sent") }
        if abortedLastRun { flags.append("aborted") }
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
        case .direct: return "Direct"
        case .group: return "Group"
        case .global: return "Global"
        case .unknown: return "Unknown"
        }
    }

    var tint: Color {
        switch self {
        case .direct: return .accentColor
        case .group: return .orange
        case .global: return .purple
        case .unknown: return .gray
        }
    }
}

private struct SessionDefaults {
    let model: String
    let contextTokens: Int
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
            return "No session store found at \(path) yet. Send or receive a message to create it."
        case let .decodeFailed(reason):
            return "Could not read the session store: \(reason)"
        }
    }
}

private enum SessionLoader {
    static let fallbackModel = "claude-opus-4-5"
    static let fallbackContextTokens = 200_000

    static let defaultStorePath = standardize(
        FileManager.default.homeDirectoryForCurrentUser
            .appendingPathComponent(".clawdis/sessions/sessions.json").path
    )

    private static let legacyStorePaths: [String] = [
        standardize(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".clawdis/sessions.json").path),
        standardize(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".warelay/sessions/sessions.json").path),
        standardize(FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent(".warelay/sessions.json").path),
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
            storePath: store.map { standardize($0) },
            model: model,
            contextTokens: contextTokens
        )
    }

    static func resolveStorePath(override: String?) -> String {
        let preferred = standardize(override ?? defaultStorePath)
        let candidates = [preferred] + legacyStorePaths
        if let existing = candidates.first(where: { FileManager.default.fileExists(atPath: $0) }) {
            return existing
        }
        return preferred
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
                        contextTokens: context
                    ),
                    model: model
                )
            }
            .sorted { ($0.updatedAt ?? .distantPast) > ($1.updatedAt ?? .distantPast) }
        }.value
    }

    private static func standardize(_ path: String) -> String {
        (path as NSString).expandingTildeInPath.replacingOccurrences(of: "//", with: "/")
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
            header
            storeMetadata
            Divider().padding(.vertical, 4)
            content
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .task {
            guard !hasLoaded else { return }
            hasLoaded = true
            await refresh()
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
                Text(storePath)
                    .font(.caption.monospaced())
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }

            HStack(spacing: 10) {
                Button {
                    Task { await refresh() }
                } label: {
                    Label(loading ? "Refreshing..." : "Refresh", systemImage: "arrow.clockwise")
                        .labelStyle(.titleAndIcon)
                }
                .disabled(loading)

                Button {
                    revealStore()
                } label: {
                    Label("Reveal", systemImage: "folder")
                        .labelStyle(.titleAndIcon)
                }
                .disabled(!FileManager.default.fileExists(atPath: storePath))

                if loading {
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
            if rows.isEmpty && errorMessage == nil {
                Text("No sessions yet. They appear after the first inbound message or heartbeat.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .padding(.top, 6)
            } else {
                Table(rows) {
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
        guard !loading else { return }
        loading = true
        errorMessage = nil

        let hints = SessionLoader.configHints()
        let resolvedStore = SessionLoader.resolveStorePath(override: hints.storePath)
        let defaults = SessionDefaults(
            model: hints.model ?? SessionLoader.fallbackModel,
            contextTokens: hints.contextTokens ?? SessionLoader.fallbackContextTokens
        )

        do {
            let newRows = try await SessionLoader.loadRows(at: resolvedStore, defaults: defaults)
            rows = newRows
            storePath = resolvedStore
            lastLoaded = Date()
        } catch {
            rows = []
            storePath = resolvedStore
            errorMessage = (error as? LocalizedError)?.errorDescription ?? error.localizedDescription
        }

        loading = false
    }

    private func revealStore() {
        let url = URL(fileURLWithPath: storePath)
        if FileManager.default.fileExists(atPath: storePath) {
            NSWorkspace.shared.activateFileViewerSelecting([url])
        } else {
            NSWorkspace.shared.open(url.deletingLastPathComponent())
        }
    }
}

private struct SessionRowView: View {
    let row: SessionRow

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Text(row.key)
                    .font(.body.weight(.semibold))
                SessionKindBadge(kind: row.kind)
                Spacer()
                Text(row.ageText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 12) {
                Label(row.tokens.summary, systemImage: "chart.bar.doc.horizontal")
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

            if !row.flagLabels.isEmpty {
                HStack(spacing: 6) {
                    ForEach(row.flagLabels, id: \.self) { flag in
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
                .fill(Color(NSColor.controlBackgroundColor))
        )
        .overlay(
            RoundedRectangle(cornerRadius: 10, style: .continuous)
                .stroke(Color.secondary.opacity(0.15), lineWidth: 1)
        )
    }
}

private struct SessionKindBadge: View {
    let kind: SessionKind

    var body: some View {
        Text(kind.label)
            .font(.caption2.weight(.bold))
            .padding(.horizontal, 7)
            .padding(.vertical, 4)
            .foregroundStyle(kind.tint)
            .background(kind.tint.opacity(0.15))
            .clipShape(Capsule())
    }
}

private struct Badge: View {
    let text: String

    var body: some View {
        Text(text)
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
    @State private var permStatus: [Capability: Bool] = [:]
    @State private var loadingPerms = false
    @State private var selectedTab: SettingsTab = .general

    var body: some View {
        TabView(selection: $selectedTab) {
            GeneralSettings(state: state)
                .tabItem { Label("General", systemImage: "gearshape") }
                .tag(SettingsTab.general)

            SessionsSettings()
                .tabItem { Label("Sessions", systemImage: "clock.arrow.circlepath") }
                .tag(SettingsTab.sessions)

            VoiceWakeSettings(state: state)
                .tabItem { Label("Voice Wake", systemImage: "waveform.circle") }
                .tag(SettingsTab.voiceWake)

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
        .padding(.horizontal, 18)
        .padding(.vertical, 16)
        .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight, alignment: .topLeading)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
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
    case general, sessions, voiceWake, permissions, debug, about
    static let windowWidth: CGFloat = 520
    static let windowHeight: CGFloat = 520
    var title: String {
        switch self {
        case .general: return "General"
        case .sessions: return "Sessions"
        case .voiceWake: return "Voice Wake"
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

enum VoiceWakeTestState: Equatable {
    case idle
    case requesting
    case listening
    case detected(String)
    case failed(String)
}

actor VoiceWakeTester {
    private let recognizer: SFSpeechRecognizer?
    private let audioEngine = AVAudioEngine()
    private var recognitionRequest: SFSpeechAudioBufferRecognitionRequest?
    private var recognitionTask: SFSpeechRecognitionTask?

    init(locale: Locale = .current) {
        self.recognizer = SFSpeechRecognizer(locale: locale)
    }

    func start(triggers: [String], onUpdate: @MainActor @escaping @Sendable (VoiceWakeTestState) -> Void) async throws {
        guard recognitionTask == nil else { return }
        guard let recognizer, recognizer.isAvailable else {
            throw NSError(domain: "VoiceWakeTester", code: 1, userInfo: [NSLocalizedDescriptionKey: "Speech recognition unavailable"])
        }

        guard Self.hasPrivacyStrings else {
            throw NSError(domain: "VoiceWakeTester", code: 3, userInfo: [NSLocalizedDescriptionKey: "Missing mic/speech privacy strings. Rebuild the mac app (scripts/restart-mac.sh) to include usage descriptions."])
        }

        let granted = try await Self.ensurePermissions()
        guard granted else {
            throw NSError(domain: "VoiceWakeTester", code: 2, userInfo: [NSLocalizedDescriptionKey: "Microphone or speech permission denied"])
        }

        recognitionRequest = SFSpeechAudioBufferRecognitionRequest()
        recognitionRequest?.shouldReportPartialResults = true

        let inputNode = audioEngine.inputNode
        let format = inputNode.outputFormat(forBus: 0)
        inputNode.removeTap(onBus: 0)
        inputNode.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
            guard let self else { return }
            Task { await self.appendBuffer(buffer) }
        }

        audioEngine.prepare()
        try audioEngine.start()
        await MainActor.run { onUpdate(.listening) }

        guard let request = recognitionRequest else { return }

        recognitionTask = recognizer.recognitionTask(with: request) { [weak self] result, error in
            let text = result?.bestTranscription.formattedString
            let matched = text.map { Self.matches(text: $0, triggers: triggers) } ?? false
            let errorMessage = error?.localizedDescription
            guard let self else { return }
            Task { await self.handleResult(matched: matched, text: text, errorMessage: errorMessage, onUpdate: onUpdate) }
        }
    }

    func stop() {
        audioEngine.stop()
        recognitionRequest?.endAudio()
        recognitionTask?.cancel()
        recognitionTask = nil
        recognitionRequest = nil
        audioEngine.inputNode.removeTap(onBus: 0)
    }

    private func appendBuffer(_ buffer: AVAudioPCMBuffer) {
        recognitionRequest?.append(buffer)
    }

    private func handleResult(
        matched: Bool,
        text: String?,
        errorMessage: String?,
        onUpdate: @MainActor @escaping @Sendable (VoiceWakeTestState) -> Void
    ) async {
        if matched, let text {
            await stop()
            await MainActor.run { onUpdate(.detected(text)) }
            return
        }
        if let errorMessage {
            await stop()
            await MainActor.run { onUpdate(.failed(errorMessage)) }
        }
    }

    private static func matches(text: String, triggers: [String]) -> Bool {
        let lowered = text.lowercased()
        return triggers.contains { lowered.contains($0.lowercased()) }
    }

    nonisolated private static func ensurePermissions() async throws -> Bool {
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
            Toggle(isOn: $binding) {
                Text(title)
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
            if !state.onboardingSeen {
                Text("Complete onboarding to finish setup")
                    .font(.callout.weight(.semibold))
                    .foregroundColor(.accentColor)
                    .padding(.bottom, 2)
            }

            VStack(alignment: .leading, spacing: 12) {
                SettingsToggleRow(
                    title: "Clawdis active",
                    subtitle: "Pause to stop Clawdis background helpers and notifications.",
                    binding: activeBinding)

                SettingsToggleRow(
                    title: "Launch at login",
                    subtitle: "Automatically start Clawdis after you sign in.",
                    binding: $state.launchAtLogin)

                SettingsToggleRow(
                    title: "Enable debug tools",
                    subtitle: "Show the Debug tab with development utilities.",
                    binding: $state.debugPaneEnabled)

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

            VStack(alignment: .leading, spacing: 6) {
                Text("CLI helper")
                    .font(.callout.weight(.semibold))
                cliInstaller
            }

            Spacer()
            HStack {
                Spacer()
                Button("Quit Clawdis") { NSApp.terminate(nil) }
                    .buttonStyle(.borderedProminent)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
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

struct VoiceWakeSettings: View {
    @ObservedObject var state: AppState
    @State private var testState: VoiceWakeTestState = .idle
    @State private var tester = VoiceWakeTester()
    @State private var isTesting = false

    private struct IndexedWord: Identifiable {
        let id: Int
        let value: String
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            SettingsToggleRow(
                title: "Enable Voice Wake",
                subtitle: "Listen for a wake phrase (e.g. \"Claude\") before running voice commands.",
                binding: $state.swabbleEnabled
            )

            testCard

            VStack(alignment: .leading, spacing: 8) {
                HStack {
                    Text("Trigger words")
                        .font(.callout.weight(.semibold))
                    Spacer()
                    Button {
                        addWord()
                    } label: {
                        Label("Add word", systemImage: "plus")
                    }
                    .disabled(state.swabbleTriggerWords.contains(where: { $0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }))

                    Button("Reset defaults") { state.swabbleTriggerWords = defaultVoiceWakeTriggers }
                }

                Table(indexedWords) {
                    TableColumn("Word") { row in
                        TextField("Wake word", text: binding(for: row.id))
                            .textFieldStyle(.roundedBorder)
                    }
                    TableColumn("") { row in
                        Button {
                            removeWord(at: row.id)
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
                        .stroke(Color.secondary.opacity(0.25), lineWidth: 1)
                )

                Text("Clawdis reacts when any trigger appears in a transcription. Keep them short to avoid false positives.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
    }

    private var indexedWords: [IndexedWord] {
        state.swabbleTriggerWords.enumerated().map { IndexedWord(id: $0.offset, value: $0.element) }
    }

    private var testCard: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Text("Test Voice Wake")
                    .font(.callout.weight(.semibold))
                Spacer()
                Button(action: toggleTest) {
                    Label(isTesting ? "Stop" : "Start test", systemImage: isTesting ? "stop.circle.fill" : "play.circle")
                }
                .buttonStyle(.borderedProminent)
                .tint(isTesting ? .red : .accentColor)
            }

            HStack(spacing: 8) {
                statusIcon
                VStack(alignment: .leading, spacing: 4) {
                    Text(statusText)
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
        switch testState {
        case .idle:
            AnyView(Image(systemName: "waveform").foregroundStyle(.secondary))
        case .requesting:
            AnyView(ProgressView().controlSize(.small))
        case .listening:
            AnyView(
                Image(systemName: "ear.and.waveform")
                    .symbolEffect(.pulse)
                    .foregroundStyle(Color.accentColor)
            )
        case .detected:
            AnyView(Image(systemName: "checkmark.circle.fill").foregroundStyle(.green))
        case .failed:
            AnyView(Image(systemName: "exclamationmark.triangle.fill").foregroundStyle(.yellow))
        }
    }

    private var statusText: String {
        switch testState {
        case .idle:
            return "Press start, say a trigger word, and wait for detection."
        case .requesting:
            return "Requesting mic & speech permission…"
        case .listening:
            return "Listening… say your trigger word."
        case .detected:
            return "Voice wake detected!"
        case let .failed(reason):
            return reason
        }
    }

    private func addWord() {
        state.swabbleTriggerWords.append("")
    }

    private func removeWord(at index: Int) {
        guard state.swabbleTriggerWords.indices.contains(index) else { return }
        state.swabbleTriggerWords.remove(at: index)
    }

    private func binding(for index: Int) -> Binding<String> {
        Binding(
            get: {
                guard state.swabbleTriggerWords.indices.contains(index) else { return "" }
                return state.swabbleTriggerWords[index]
            },
            set: { newValue in
                guard state.swabbleTriggerWords.indices.contains(index) else { return }
                state.swabbleTriggerWords[index] = newValue
            }
        )
    }

    private func toggleTest() {
        if isTesting {
            Task { await tester.stop() }
            isTesting = false
            testState = .idle
            return
        }

        let triggers = sanitizedTriggers()
        isTesting = true
        testState = .requesting
        Task { @MainActor in
            do {
                try await tester.start(
                    triggers: triggers,
                    onUpdate: { newState in
                        self.testState = newState
                        if case .detected = newState { self.isTesting = false }
                        if case .failed = newState { self.isTesting = false }
                    }
                )
                // timeout after 10s
                try await Task.sleep(nanoseconds: 10 * 1_000_000_000)
                if isTesting {
                    await tester.stop()
                    testState = .failed("Timeout: no trigger heard")
                    isTesting = false
                }
            } catch {
                await tester.stop()
                testState = .failed(error.localizedDescription)
                isTesting = false
            }
        }
    }

    private func sanitizedTriggers() -> [String] {
        let cleaned = state.swabbleTriggerWords
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
        return cleaned.isEmpty ? defaultVoiceWakeTriggers : cleaned
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
                .padding(.horizontal, 2)
                .padding(.vertical, 6)

            Button("Show onboarding") { showOnboarding() }
                .buttonStyle(.bordered)
            Spacer()
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
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
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
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
                    .shadow(color: iconHover ? .accentColor.opacity(0.25) : .clear, radius: 8)
                    .scaleEffect(iconHover ? 1.06 : 1.0)
            }
            .buttonStyle(.plain)
            .onHover { hover in
                withAnimation(.spring(response: 0.3, dampingFraction: 0.72)) { iconHover = hover }
            }

            VStack(spacing: 3) {
                Text("Clawdis")
                    .font(.title3.bold())
                Text("Version \(versionString)")
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
                AboutLinkRow(icon: "chevron.left.slash.chevron.right", title: "GitHub", url: "https://github.com/steipete/clawdis")
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
            case .microphone:
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone")
            case .speechRecognition:
                openSettings("x-apple.systempreferences:com.apple.preference.security?Privacy_SpeechRecognition")
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
        case .microphone: return "Microphone"
        case .speechRecognition: return "Speech Recognition"
        }
    }

    private var subtitle: String {
        switch capability {
        case .notifications: return "Show desktop alerts for agent activity"
        case .accessibility: return "Control UI elements when an action requires it"
        case .screenRecording: return "Capture the screen for context or screenshots"
        case .microphone: return "Allow Voice Wake and audio capture"
        case .speechRecognition: return "Transcribe Voice Wake trigger phrases on-device"
        }
    }

    private var icon: String {
        switch capability {
        case .notifications: return "bell" 
        case .accessibility: return "hand.raised" 
        case .screenRecording: return "display" 
        case .microphone: return "mic" 
        case .speechRecognition: return "waveform" 
        }
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
        window?.close()
        window = nil
    }
}

struct OnboardingView: View {
    @State private var currentPage = 0
    @State private var permStatus: [Capability: Bool] = [:]
    @State private var isRequesting = false
    @State private var installingCLI = false
    @State private var cliStatus: String?
    @State private var copied = false
    @ObservedObject private var state = AppStateStore.shared

    private let pageWidth: CGFloat = 640
    private let contentHeight: CGFloat = 260
    private var pageCount: Int { 6 }
    private var buttonTitle: String { currentPage == pageCount - 1 ? "Finish" : "Next" }
    private let devLinkCommand = "ln -sf $(pwd)/apps/macos/.build/debug/ClawdisCLI /usr/local/bin/clawdis-mac"

    var body: some View {
        VStack(spacing: 0) {
            GlowingClawdisIcon(size: 156)
                .padding(.top, 40)
                .padding(.bottom, 20)
                .frame(height: 240)

            GeometryReader { _ in
                HStack(spacing: 0) {
                    welcomePage().frame(width: pageWidth)
                    focusPage().frame(width: pageWidth)
                    permissionsPage().frame(width: pageWidth)
                    cliPage().frame(width: pageWidth)
                    launchPage().frame(width: pageWidth)
                    readyPage().frame(width: pageWidth)
                }
                .offset(x: CGFloat(-currentPage) * pageWidth)
                .animation(
                    .interactiveSpring(response: 0.5, dampingFraction: 0.86, blendDuration: 0.25),
                    value: currentPage
                )
                .frame(width: pageWidth, height: contentHeight, alignment: .top)
                .clipped()
            }
            .frame(height: 260)

            navigationBar
        }
        .frame(width: pageWidth, height: 560)
        .background(Color(NSColor.windowBackgroundColor))
        .onAppear { currentPage = 0 }
        .task { await refreshPerms() }
    }

    private func welcomePage() -> some View {
        onboardingPage {
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
        onboardingPage {
            Text("What Clawdis handles")
                .font(.largeTitle.weight(.semibold))
            onboardingCard {
                featureRow(
                    title: "Owns the TCC prompts",
                    subtitle: "Requests Notifications, Accessibility, and Screen Recording so your agents stay unblocked.",
                    systemImage: "lock.shield"
                )
                featureRow(
                    title: "Native notifications",
                    subtitle: "Shows desktop toasts for agent events with your preferred sound.",
                    systemImage: "bell.and.waveform"
                )
                featureRow(
                    title: "Privileged helpers",
                    subtitle: "Runs screenshots or shell actions from the `clawdis-mac` CLI with the right permissions.",
                    systemImage: "terminal"
                )
            }
        }
    }

    private func permissionsPage() -> some View {
        onboardingPage {
            Text("Grant permissions")
                .font(.largeTitle.weight(.semibold))
            Text("Approve these once and the helper CLI reuses the same grants.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            onboardingCard {
                ForEach(Capability.allCases, id: \.self) { cap in
                    PermissionRow(capability: cap, status: permStatus[cap] ?? false) {
                        Task { await request(cap) }
                    }
                }

                HStack(spacing: 12) {
                    Button("Refresh status") { Task { await refreshPerms() } }
                        .controlSize(.small)
                    if isRequesting {
                        ProgressView()
                            .controlSize(.small)
                    }
                }
                .padding(.top, 4)
            }
        }
    }

    private func cliPage() -> some View {
        onboardingPage {
            Text("Install the helper CLI")
                .font(.largeTitle.weight(.semibold))
            Text("Link `clawdis-mac` so scripts and the agent can talk to this app.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            onboardingCard {
                HStack(spacing: 12) {
                    Button {
                        Task { await installCLI() }
                    } label: {
                        if installingCLI {
                            ProgressView()
                        } else {
                            Text("Install helper")
                        }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(installingCLI)

                    Button(copied ? "Copied" : "Copy dev link") {
                        copyToPasteboard(devLinkCommand)
                    }
                    .disabled(installingCLI)
                }

                if let cliStatus {
                    Text(cliStatus)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Text("We install into /usr/local/bin and /opt/homebrew/bin. Rerun anytime if you move the build output.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func launchPage() -> some View {
        onboardingPage {
            Text("Keep it running")
                .font(.largeTitle.weight(.semibold))
            Text("Let Clawdis launch with macOS so permissions and notifications are ready when automations start.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: 520)
                .fixedSize(horizontal: false, vertical: true)

            onboardingCard {
                Toggle("Launch at login", isOn: $state.launchAtLogin)
                    .toggleStyle(.switch)
                    .onChange(of: state.launchAtLogin) { _, newValue in
                        AppStateStore.updateLaunchAtLogin(enabled: newValue)
                    }
                Text("You can pause from the menu bar anytime. Settings keeps a \"Show onboarding\" button if you need to revisit.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func readyPage() -> some View {
        onboardingPage {
            Text("All set")
                .font(.largeTitle.weight(.semibold))
            onboardingCard {
                featureRow(
                    title: "Run the dashboard",
                    subtitle: "Use the CLI helper from your scripts, and reopen onboarding from Settings if you add a new user.",
                    systemImage: "checkmark.seal"
                )
                featureRow(
                    title: "Test a notification",
                    subtitle: "Send a quick notify via the menu bar to confirm sounds and permissions.",
                    systemImage: "bell.badge"
                )
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

                if currentPage > 0 {
                    Button(action: { handleBack() }) {
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
                ForEach(0..<pageCount, id: \.self) { index in
                    Button {
                        withAnimation { currentPage = index }
                    } label: {
                        Circle()
                            .fill(index == currentPage ? Color.accentColor : Color.gray.opacity(0.3))
                            .frame(width: 8, height: 8)
                    }
                    .buttonStyle(.plain)
                }
            }

            Spacer()

            Button(action: handleNext) {
                Text(buttonTitle)
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
        .frame(width: pageWidth, alignment: .top)
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
                .shadow(color: .black.opacity(0.06), radius: 8, y: 3)
        )
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
            currentPage = max(0, currentPage - 1)
        }
    }

    private func handleNext() {
        if currentPage < pageCount - 1 {
            withAnimation { currentPage += 1 }
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

    private func installCLI() async {
        guard !installingCLI else { return }
        installingCLI = true
        defer { installingCLI = false }
        await CLIInstaller.install { message in
            await MainActor.run { cliStatus = message }
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
                            Color.accentColor.opacity(glowIntensity),
                            Color.blue.opacity(glowIntensity * 0.6)
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing
                    )
                )
                .blur(radius: 22)
                .scaleEffect(breathe ? 1.12 : 0.95)
                .opacity(0.9)

            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .frame(width: size, height: size)
                .clipShape(RoundedRectangle(cornerRadius: size * 0.22, style: .continuous))
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
                .scaleEffect(breathe ? 1.02 : 1.0)
        }
        .frame(width: size + 60, height: size + 60)
        .onAppear {
            guard enableFloating else { return }
            withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
                breathe.toggle()
            }
        }
    }
}
