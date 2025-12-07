import AppKit
import Foundation
import MenuBarExtraAccess
import SwiftUI

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
        MenuBarExtra { MenuContent(state: self.state) } label: {
            CritterStatusLabel(
                isPaused: self.state.isPaused,
                isWorking: self.state.isWorking,
                earBoostActive: self.state.earBoostActive,
                relayStatus: self.relayManager.status)
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
    @ObservedObject private var relayManager = RelayProcessManager.shared
    @Environment(\.openSettings) private var openSettings

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Toggle(isOn: self.activeBinding) { Text("Clawdis Active") }
            self.relayStatusRow
            Toggle(isOn: self.voiceWakeBinding) { Text("Voice Wake") }
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
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        NSApp.activate(ignoringOtherApps: true)
        self.openSettings()
        NotificationCenter.default.post(name: .clawdisSelectSettingsTab, object: tab)
    }

    private var relayStatusRow: some View {
        let status = self.relayManager.status
        return HStack(spacing: 8) {
            Circle()
                .fill(self.statusColor(status))
                .frame(width: 8, height: 8)
            Text(status.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.vertical, 4)
    }

    private func statusColor(_ status: RelayProcessManager.Status) -> Color {
        switch status {
        case .running: .green
        case .starting, .restarting: .orange
        case .failed: .red
        case .stopped: .secondary
        }
    }

    private var activeBinding: Binding<Bool> {
        Binding(get: { !self.state.isPaused }, set: { self.state.isPaused = !$0 })
    }

    private var voiceWakeBinding: Binding<Bool> {
        Binding(
            get: { self.state.swabbleEnabled },
            set: { newValue in
                Task { await self.state.setVoiceWakeEnabled(newValue) }
            })
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
}

private struct CritterStatusLabel: View {
    var isPaused: Bool
    var isWorking: Bool
    var earBoostActive: Bool
    var relayStatus: RelayProcessManager.Status

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
                        earScale: self.earBoostActive ? 1.9 : 1.0))
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

                            if self.isWorking {
                                self.scurry()
                            }
                        }
                        .onChange(of: self.isPaused) { _, _ in self.resetMotion() }
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
        earScale: CGFloat = 1) -> NSImage
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
        if let state {
            RelayProcessManager.shared.setActive(!state.isPaused)
        }
        self.startListener()
        self.scheduleFirstRunOnboardingIfNeeded()
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
        let interface = NSXPCInterface(with: ClawdisXPCProtocol.self)
        connection.exportedInterface = interface
        connection.exportedObject = ClawdisXPCService()
        connection.resume()
        return true
    }
}
