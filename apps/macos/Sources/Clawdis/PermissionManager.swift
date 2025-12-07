import AppKit
import ApplicationServices
import AVFoundation
import ClawdisIPC
import CoreGraphics
import Foundation
import Speech
import UserNotifications

enum PermissionManager {
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
                        let granted = await (try? center.requestAuthorization(options: [.alert, .sound, .badge])) ??
                            false
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
                let trusted = await MainActor.run { AXIsProcessTrusted() }
                results[cap] = trusted
                if interactive, !trusted {
                    await MainActor.run {
                        let opts: NSDictionary = ["AXTrustedCheckOptionPrompt": true]
                        _ = AXIsProcessTrustedWithOptions(opts)
                    }
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

    static func voiceWakePermissionsGranted() -> Bool {
        let mic = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        let speech = SFSpeechRecognizer.authorizationStatus() == .authorized
        return mic && speech
    }

    static func ensureVoiceWakePermissions(interactive: Bool) async -> Bool {
        let results = await self.ensure([.microphone, .speechRecognition], interactive: interactive)
        return results[.microphone] == true && results[.speechRecognition] == true
    }

    static func status(_ caps: [Capability] = Capability.allCases) async -> [Capability: Bool] {
        var results: [Capability: Bool] = [:]
        for cap in caps {
            switch cap {
            case .notifications:
                let center = UNUserNotificationCenter.current()
                let settings = await center.notificationSettings()
                results[cap] = settings.authorizationStatus == .authorized
                    || settings.authorizationStatus == .provisional

            case .accessibility:
                results[cap] = await MainActor.run { AXIsProcessTrusted() }

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

        let latest = await PermissionManager.status()
        if latest != self.status {
            self.status = latest
        }
        self.lastCheck = Date()

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
