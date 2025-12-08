import AVFoundation
import AppKit
import Darwin
import Foundation
import MenuBarExtraAccess
import OSLog
import Security
import SwiftUI
import Network

@main
struct ClawdisApp: App {
    @NSApplicationDelegateAdaptor(AppDelegate.self) private var delegate
    @StateObject private var state: AppState
    @StateObject private var relayManager = RelayProcessManager.shared
    @State private var statusItem: NSStatusItem?
    @State private var isMenuPresented = false

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
                relayStatus: self.relayManager.status,
                animationsEnabled: self.state.iconAnimationsEnabled)
        }
        .menuBarExtraStyle(.menu)
        .menuBarExtraAccess(isPresented: self.$isMenuPresented) { item in
            self.statusItem = item
            self.applyStatusItemAppearance(paused: self.state.isPaused)
        }
        .onChange(of: self.state.isPaused) { _, paused in
            self.applyStatusItemAppearance(paused: paused)
            self.relayManager.setActive(!paused)
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
}

private struct MenuContent: View {
    @ObservedObject var state: AppState
    let updater: UpdaterProviding?
    @ObservedObject private var relayManager = RelayProcessManager.shared
    @ObservedObject private var healthStore = HealthStore.shared
    @ObservedObject private var heartbeatStore = HeartbeatStore.shared
    @ObservedObject private var controlChannel = ControlChannel.shared
    @Environment(\.openSettings) private var openSettings
    @State private var availableMics: [AudioInputDevice] = []
    @State private var loadingMics = false

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.activeBinding) {
                let label = self.state.connectionMode == .remote ? "Remote Clawdis Active" : "Clawdis Active"
                Text(label)
            }
            self.statusRow
            Toggle(isOn: self.heartbeatsBinding) { Text("Send Heartbeats") }
            self.heartbeatStatusRow
            Toggle(isOn: self.voiceWakeBinding) { Text("Voice Wake") }
                .disabled(!voiceWakeSupported)
                .opacity(voiceWakeSupported ? 1 : 0.5)
            if self.showVoiceWakeMicPicker {
                self.voiceWakeMicMenu
            }
            if AppStateStore.webChatEnabled {
                Button("Open Chat") { WebChatManager.shared.show(sessionKey: self.primarySessionKey()) }
            }
            Divider()
            Button("Settings…") { self.open(tab: .general) }
                .keyboardShortcut(",", modifiers: [.command])
            Button("About Clawdis") { self.open(tab: .about) }
            if let updater, updater.isAvailable {
                Button("Check for Updates…") { updater.checkForUpdates(nil) }
            }
            Divider()
            Button("Quit") { NSApplication.shared.terminate(nil) }
        }
        .task(id: self.state.swabbleEnabled) {
            if self.state.swabbleEnabled {
                await self.loadMicrophones(force: true)
            }
        }
        .task {
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && self.state.voicePushToTalkEnabled)
        }
        .onChange(of: self.state.voicePushToTalkEnabled) { _, enabled in
            VoicePushToTalkHotkey.shared.setEnabled(voiceWakeSupported && enabled)
        }
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var statusRow: some View {
        let health = self.healthStore.state
        let isRefreshing = self.healthStore.isRefreshing
        let lastAge = self.healthStore.lastSuccess.map { age(from: $0) }

        let label: String
        let color: Color

        if isRefreshing {
            // Prefer health while the probe is running.
            label = "Health check running…"
            color = health.tint
        } else {
            // Show last health result + age; relay is implicit when healthy.
            switch health {
            case .ok:
                let ageText = lastAge.map { " · checked \($0)" } ?? ""
                label = "Health ok\(ageText)"
                color = .green
            case .linkingNeeded:
                label = "Health: login required"
                color = .red
            case let .degraded(reason):
                let ageText = lastAge.map { " · checked \($0)" } ?? ""
                label = "Health degraded: \(reason)\(ageText)"
                color = .orange
            case .unknown:
                label = "Health pending"
                color = .secondary
            }
        }

        return HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.vertical, 4)
    }

    private func relayLabel(_ status: RelayProcessManager.Status) -> String {
        switch status {
        case .running: "Running"
        case .starting: "Starting…"
        case .restarting: "Restarting…"
        case let .failed(reason): "Failed: \(reason)"
        case .stopped: "Stopped"
        }
    }

    private func statusColor(_ status: RelayProcessManager.Status) -> Color {
        switch status {
        case .running: .green
        case .starting, .restarting: .orange
        case .failed: .red
        case .stopped: .secondary
        }
    }

    private var heartbeatStatusRow: some View {
        let label: String
        let color: Color

        if case .degraded = self.controlChannel.state {
            label = "Control channel disconnected"
            color = .red
        } else if let evt = self.heartbeatStore.lastEvent {
            let ageText = age(from: Date(timeIntervalSince1970: evt.ts / 1000))
            switch evt.status {
            case "sent":
                label = "Last heartbeat sent · \(ageText)"
                color = .blue
            case "ok-empty", "ok-token":
                label = "Heartbeat ok · \(ageText)"
                color = .green
            case "skipped":
                label = "Heartbeat skipped · \(ageText)"
                color = .secondary
            case "failed":
                label = "Heartbeat failed · \(ageText)"
                color = .red
            default:
                label = "Heartbeat · \(ageText)"
                color = .secondary
            }
        } else {
            label = "No heartbeat yet"
            color = .secondary
        }

        return HStack(spacing: 8) {
            Circle()
                .fill(color)
                .frame(width: 8, height: 8)
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.vertical, 2)
    }

    private var activeBinding: Binding<Bool> {
        Binding(get: { !self.state.isPaused }, set: { self.state.isPaused = !$0 })
    }

    private var heartbeatsBinding: Binding<Bool> {
        Binding(get: { self.state.heartbeatsEnabled }, set: { self.state.heartbeatsEnabled = $0 })
    }

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
    }

    private var showVoiceWakeMicPicker: Bool {
        voiceWakeSupported && self.state.swabbleEnabled
    }

    private var voiceWakeMicMenu: some View {
        Menu {
            self.microphoneMenuItems

            if self.loadingMics {
                Divider()
                Label("Refreshing microphones…", systemImage: "arrow.triangle.2.circlepath")
                    .labelStyle(.titleOnly)
                    .foregroundStyle(.secondary)
                    .disabled(true)
            }
        } label: {
            HStack {
                Text("Microphone")
                Spacer()
                Text(self.selectedMicLabel)
                    .foregroundStyle(.secondary)
            }
        }
        .task { await self.loadMicrophones() }
    }

    private var selectedMicLabel: String {
        if self.state.voiceWakeMicID.isEmpty { return self.defaultMicLabel }
        if let match = self.availableMics.first(where: { $0.uid == self.state.voiceWakeMicID }) {
            return match.name
        }
        return "Unavailable"
    }

    private var microphoneMenuItems: some View {
        Group {
            Button {
                self.state.voiceWakeMicID = ""
            } label: {
                Label(self.defaultMicLabel, systemImage: self.state.voiceWakeMicID.isEmpty ? "checkmark" : "")
                    .labelStyle(.titleAndIcon)
            }
            .buttonStyle(.plain)

            ForEach(self.availableMics) { mic in
                Button {
                    self.state.voiceWakeMicID = mic.uid
                } label: {
                    Label(mic.name, systemImage: self.state.voiceWakeMicID == mic.uid ? "checkmark" : "")
                        .labelStyle(.titleAndIcon)
                }
                .buttonStyle(.plain)
            }
        }
    }

    private var defaultMicLabel: String {
        if let host = Host.current().localizedName, !host.isEmpty {
            return "Auto-detect (\(host))"
        }
        return "System default"
    }

    @MainActor
    private func loadMicrophones(force: Bool = false) async {
        guard self.showVoiceWakeMicPicker else {
            self.availableMics = []
            self.loadingMics = false
            return
        }
        if !force, !self.availableMics.isEmpty { return }
        self.loadingMics = true
        let discovery = AVCaptureDevice.DiscoverySession(
            deviceTypes: [.external, .microphone],
            mediaType: .audio,
            position: .unspecified)
        self.availableMics = discovery.devices
            .sorted { lhs, rhs in
                lhs.localizedName.localizedCaseInsensitiveCompare(rhs.localizedName) == .orderedAscending
            }
            .map { AudioInputDevice(uid: $0.uniqueID, name: $0.localizedName) }
        self.loadingMics = false
    }

    private func primarySessionKey() -> String {
        // Prefer canonical main session; fall back to most recent.
        let storePath = SessionLoader.defaultStorePath
        if let data = try? Data(contentsOf: URL(fileURLWithPath: storePath)),
           let decoded = try? JSONDecoder().decode([String: SessionEntryRecord].self, from: data)
        {
            if decoded.keys.contains("main") { return "main" }

            let sorted = decoded.sorted { a, b -> Bool in
                let lhs = a.value.updatedAt ?? 0
                let rhs = b.value.updatedAt ?? 0
                return lhs > rhs
            }
            if let first = sorted.first { return first.key }
        }
        return "+1003"
    }

    private struct AudioInputDevice: Identifiable, Equatable {
        let uid: String
        let name: String
        var id: String { self.uid }
    }
}

private struct CritterStatusLabel: View {
    var isPaused: Bool
    var isWorking: Bool
    var earBoostActive: Bool
    var blinkTick: Int
    var sendCelebrationTick: Int
    var relayStatus: RelayProcessManager.Status
    var animationsEnabled: Bool

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
        ZStack(alignment: .bottomTrailing) {
            Group {
                if self.isPaused {
                    Image(nsImage: CritterIconRenderer.makeIcon(blink: 0))
                        .frame(width: 18, height: 16)
                } else {
                    Image(nsImage: CritterIconRenderer.makeIcon(
                        blink: self.blinkAmount,
                        legWiggle: max(self.legWiggle, self.isWorking ? 0.6 : 0),
                        earWiggle: self.earWiggle,
                        earScale: self.earBoostActive ? 1.9 : 1.0,
                        earHoles: self.earBoostActive))
                        .frame(width: 18, height: 16)
                        .rotationEffect(.degrees(self.wiggleAngle), anchor: .center)
                        .offset(x: self.wiggleOffset)
                        .onReceive(self.ticker) { now in
                            guard self.animationsEnabled, !self.earBoostActive else {
                                self.resetMotion()
                                return
                            }

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

                            if self.isWorking {
                                self.scurry()
                            }
                        }
                        .onChange(of: self.isPaused) { _, _ in self.resetMotion() }
                        .onChange(of: self.blinkTick) { _, _ in
                            guard !self.earBoostActive else { return }
                            self.blink()
                        }
                        .onChange(of: self.sendCelebrationTick) { _, _ in
                            guard !self.earBoostActive else { return }
                            self.wiggleLegs()
                        }
                        .onChange(of: self.animationsEnabled) { _, enabled in
                            if enabled {
                                self.scheduleRandomTimers(from: Date())
                            } else {
                                self.resetMotion()
                            }
                        }
                        .onChange(of: self.earBoostActive) { _, active in
                            if active {
                                self.resetMotion()
                            } else if self.animationsEnabled {
                                self.scheduleRandomTimers(from: Date())
                            }
                        }
                }
            }

            if self.relayNeedsAttention {
                Circle()
                    .fill(self.relayBadgeColor)
                    .frame(width: 8, height: 8)
                    .offset(x: 4, y: 4)
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

    private func scurry() {
        let target = CGFloat.random(in: 0.7...1.0)
        withAnimation(.easeInOut(duration: 0.12)) {
            self.legWiggle = target
            self.wiggleOffset = CGFloat.random(in: -0.6...0.6)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            withAnimation(.easeOut(duration: 0.16)) {
                self.legWiggle = 0.25
                self.wiggleOffset = 0
            }
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

    private func scheduleRandomTimers(from date: Date) {
        self.nextBlink = date.addingTimeInterval(Double.random(in: 3.5...8.5))
        self.nextWiggle = date.addingTimeInterval(Double.random(in: 6.5...14))
        self.nextLegWiggle = date.addingTimeInterval(Double.random(in: 5.0...11.0))
        self.nextEarWiggle = date.addingTimeInterval(Double.random(in: 7.0...14.0))
    }

    private var relayNeedsAttention: Bool {
        switch self.relayStatus {
        case .failed, .stopped:
            !self.isPaused
        case .starting, .restarting, .running:
            false
        }
    }

    private var relayBadgeColor: Color {
        switch self.relayStatus {
        case .failed: .red
        case .stopped: .orange
        default: .clear
        }
    }
}

enum CritterIconRenderer {
    private static let size = NSSize(width: 18, height: 16)

    static func makeIcon(
        blink: CGFloat,
        legWiggle: CGFloat = 0,
        earWiggle: CGFloat = 0,
        earScale: CGFloat = 1,
        earHoles: Bool = false) -> NSImage
    {
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
        let earH = bodyH * 0.66 * earScale * (1 - 0.08 * abs(earWiggle))
        let earCorner = earW * 0.24
        let leftEarRect = CGRect(
            x: bodyX - earW * 0.55 + earWiggle,
            y: bodyY + bodyH * 0.08 + earWiggle * 0.4,
            width: earW,
            height: earH)
        let rightEarRect = CGRect(
            x: bodyX + bodyW - earW * 0.45 - earWiggle,
            y: bodyY + bodyH * 0.08 - earWiggle * 0.4,
            width: earW,
            height: earH)

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

        ctx.addPath(CGPath(
            roundedRect: CGRect(x: bodyX, y: bodyY, width: bodyW, height: bodyH),
            cornerWidth: bodyCorner,
            cornerHeight: bodyCorner,
            transform: nil))
        ctx.addPath(CGPath(
            roundedRect: leftEarRect,
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        ctx.addPath(CGPath(
            roundedRect: rightEarRect,
            cornerWidth: earCorner,
            cornerHeight: earCorner,
            transform: nil))
        for i in 0..<4 {
            let x = legStartX + CGFloat(i) * (legW + legSpacing)
            let lift = (i % 2 == 0 ? legLift : -legLift)
            let rect = CGRect(x: x, y: legYBase + lift, width: legW, height: legH * (1 - 0.12 * legWiggle))
            ctx.addPath(CGPath(roundedRect: rect, cornerWidth: legW * 0.34, cornerHeight: legW * 0.34, transform: nil))
        }
        ctx.fillPath()

        ctx.saveGState()
        ctx.setBlendMode(.clear)

        let leftCenter = CGPoint(x: w / 2 - eyeOffset, y: eyeY)
        let rightCenter = CGPoint(x: w / 2 + eyeOffset, y: eyeY)

        if earHoles || earScale > 1.05 {
            let holeW = earW * 0.6
            let holeH = earH * 0.46
            let holeCorner = holeW * 0.34
            let leftHoleRect = CGRect(
                x: leftEarRect.midX - holeW / 2,
                y: leftEarRect.midY - holeH / 2 + earH * 0.04,
                width: holeW,
                height: holeH)
            let rightHoleRect = CGRect(
                x: rightEarRect.midX - holeW / 2,
                y: rightEarRect.midY - holeH / 2 + earH * 0.04,
                width: holeW,
                height: holeH)

            ctx.addPath(CGPath(
                roundedRect: leftHoleRect,
                cornerWidth: holeCorner,
                cornerHeight: holeCorner,
                transform: nil))
            ctx.addPath(CGPath(
                roundedRect: rightHoleRect,
                cornerWidth: holeCorner,
                cornerHeight: holeCorner,
                transform: nil))
        }

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
            RelayProcessManager.shared.setActive(!state.isPaused)
        }
        Task {
            let controlMode: ControlChannel.Mode = AppStateStore.shared.connectionMode == .remote
                ? .remote(target: AppStateStore.shared.remoteTarget, identity: AppStateStore.shared.remoteIdentity)
                : .local
            try? await ControlChannel.shared.configure(mode: controlMode)
            try? await AgentRPC.shared.start()
            _ = await AgentRPC.shared.setHeartbeatsEnabled(AppStateStore.shared.heartbeatsEnabled)
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
        RelayProcessManager.shared.stop()
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
