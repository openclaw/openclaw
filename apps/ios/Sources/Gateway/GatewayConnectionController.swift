import AVFoundation
import Contacts
import CoreLocation
import CoreMotion
import EventKit
import Foundation
import OpenClawKit
import Network
import Observation
import Photos
import ReplayKit
import Speech
import SwiftUI
import UIKit

@MainActor
@Observable
final class GatewayConnectionController {
    private(set) var gateways: [GatewayDiscoveryModel.DiscoveredGateway] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [GatewayDiscoveryModel.DebugLogEntry] = []

    private let discovery = GatewayDiscoveryModel()
    private weak var appModel: NodeAppModel?
    private var didAutoConnect = false

    init(appModel: NodeAppModel, startDiscovery: Bool = true) {
        self.appModel = appModel

        GatewaySettingsStore.bootstrapPersistence()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "gateway.discovery.debugLogs"))

        self.updateFromDiscovery()
        self.observeDiscovery()

        if startDiscovery {
            self.discovery.start()
        }
    }

    func setDiscoveryDebugLoggingEnabled(_ enabled: Bool) {
        self.discovery.setDebugLoggingEnabled(enabled)
    }

    func setScenePhase(_ phase: ScenePhase) {
        switch phase {
        case .background:
            self.discovery.stop()
        case .active, .inactive:
            self.discovery.start()
        @unknown default:
            self.discovery.start()
        }
    }

    func connect(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) async {
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        guard let host = self.resolveGatewayHost(gateway) else { return }
        let port = gateway.gatewayPort ?? 18789
        let tlsParams = self.resolveDiscoveredTLSParams(gateway: gateway)
        guard let url = self.buildGatewayURL(
            host: host,
            port: port,
            useTLS: tlsParams?.required == true)
        else { return }
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: gateway.stableID,
            tls: tlsParams,
            token: token,
            password: password)
    }

    func connectManual(host: String, port: Int, useTLS: Bool) async {
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        let stableID = self.manualStableID(host: host, port: port)
        let tlsParams = self.resolveManualTLSParams(stableID: stableID, tlsEnabled: useTLS)
        guard let url = self.buildGatewayURL(
            host: host,
            port: port,
            useTLS: tlsParams?.required == true)
        else { return }
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            password: password)
    }

    private func updateFromDiscovery() {
        let newGateways = self.discovery.gateways
        self.gateways = newGateways
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredGateway(from: newGateways)
        self.maybeAutoConnect()
    }

    private func observeDiscovery() {
        withObservationTracking {
            _ = self.discovery.gateways
            _ = self.discovery.statusText
            _ = self.discovery.debugLog
        } onChange: { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                self.updateFromDiscovery()
                self.observeDiscovery()
            }
        }
    }

    private func maybeAutoConnect() {
        guard !self.didAutoConnect else { return }
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayServerName == nil else { return }

        let defaults = UserDefaults.standard
        let manualEnabled = defaults.bool(forKey: "gateway.manual.enabled")

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)

        if manualEnabled {
            let manualHost = defaults.string(forKey: "gateway.manual.host")?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !manualHost.isEmpty else { return }

            let manualPort = defaults.integer(forKey: "gateway.manual.port")
            let resolvedPort = manualPort > 0 ? manualPort : 18789
            let manualTLS = defaults.bool(forKey: "gateway.manual.tls")

            let stableID = self.manualStableID(host: manualHost, port: resolvedPort)
            let tlsParams = self.resolveManualTLSParams(stableID: stableID, tlsEnabled: manualTLS)

            guard let url = self.buildGatewayURL(
                host: manualHost,
                port: resolvedPort,
                useTLS: tlsParams?.required == true)
            else { return }

            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: stableID,
                tls: tlsParams,
                token: token,
                password: password)
            return
        }

        let preferredStableID = defaults.string(forKey: "gateway.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let lastDiscoveredStableID = defaults.string(forKey: "gateway.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        let candidates = [preferredStableID, lastDiscoveredStableID].filter { !$0.isEmpty }
        guard let targetStableID = candidates.first(where: { id in
            self.gateways.contains(where: { $0.stableID == id })
        }) else { return }

        guard let target = self.gateways.first(where: { $0.stableID == targetStableID }) else { return }
        guard let host = self.resolveGatewayHost(target) else { return }
        let port = target.gatewayPort ?? 18789
        let tlsParams = self.resolveDiscoveredTLSParams(gateway: target)
        guard let url = self.buildGatewayURL(host: host, port: port, useTLS: tlsParams?.required == true)
        else { return }

        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: target.stableID,
            tls: tlsParams,
            token: token,
            password: password)
    }

    private func updateLastDiscoveredGateway(from gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        let defaults = UserDefaults.standard
        let preferred = defaults.string(forKey: "gateway.preferredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let existingLast = defaults.string(forKey: "gateway.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""

        // Avoid overriding user intent (preferred/lastDiscovered are also set on manual Connect).
        guard preferred.isEmpty, existingLast.isEmpty else { return }
        guard let first = gateways.first else { return }

        defaults.set(first.stableID, forKey: "gateway.lastDiscoveredStableID")
        GatewaySettingsStore.saveLastDiscoveredGatewayStableID(first.stableID)
    }

    private func startAutoConnect(
        url: URL,
        gatewayStableID: String,
        tls: GatewayTLSParams?,
        token: String?,
        password: String?)
    {
        guard let appModel else { return }
        let connectOptions = self.makeConnectOptions()

        Task { [weak self] in
            guard let self else { return }
            await MainActor.run {
                appModel.gatewayStatusText = "Connecting…"
            }
            appModel.connectToGateway(
                url: url,
                gatewayStableID: gatewayStableID,
                tls: tls,
                token: token,
                password: password,
                connectOptions: connectOptions)
        }
    }

    private func resolveDiscoveredTLSParams(gateway: GatewayDiscoveryModel.DiscoveredGateway) -> GatewayTLSParams? {
        let stableID = gateway.stableID
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)

        if gateway.tlsEnabled || gateway.tlsFingerprintSha256 != nil || stored != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: gateway.tlsFingerprintSha256 ?? stored,
                allowTOFU: stored == nil,
                storeKey: stableID)
        }

        return nil
    }

    private func resolveManualTLSParams(stableID: String, tlsEnabled: Bool) -> GatewayTLSParams? {
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if tlsEnabled || stored != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: stored == nil,
                storeKey: stableID)
        }

        return nil
    }

    private func resolveGatewayHost(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        if let lanHost = gateway.lanHost?.trimmingCharacters(in: .whitespacesAndNewlines), !lanHost.isEmpty {
            return lanHost
        }
        if let tailnet = gateway.tailnetDns?.trimmingCharacters(in: .whitespacesAndNewlines), !tailnet.isEmpty {
            return tailnet
        }
        return nil
    }

    private func buildGatewayURL(host: String, port: Int, useTLS: Bool) -> URL? {
        let scheme = useTLS ? "wss" : "ws"
        var components = URLComponents()
        components.scheme = scheme
        components.host = host
        components.port = port
        return components.url
    }

    private func manualStableID(host: String, port: Int) -> String {
        "manual|\(host.lowercased())|\(port)"
    }

    private func makeConnectOptions() -> GatewayConnectOptions {
        let defaults = UserDefaults.standard
        let displayName = self.resolvedDisplayName(defaults: defaults)
        let manualClientId = defaults.string(forKey: "gateway.manual.clientId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedClientId = manualClientId?.isEmpty == false ? manualClientId! : "openclaw-ios"

        return GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: self.currentCaps(),
            commands: self.currentCommands(),
            permissions: self.currentPermissions(),
            clientId: resolvedClientId,
            clientMode: "node",
            clientDisplayName: displayName)
    }

    private func resolvedDisplayName(defaults: UserDefaults) -> String {
        let key = "node.displayName"
        let existingRaw = defaults.string(forKey: key)
        let resolved = NodeDisplayName.resolve(
            existing: existingRaw,
            deviceName: UIDevice.current.name,
            interfaceIdiom: UIDevice.current.userInterfaceIdiom)
        let existing = existingRaw?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if existing.isEmpty || NodeDisplayName.isGeneric(existing) {
            defaults.set(resolved, forKey: key)
        }
        return resolved
    }

    private func currentCaps() -> [String] {
        var caps = [OpenClawCapability.canvas.rawValue, OpenClawCapability.screen.rawValue]

        // Default-on: if the key doesn't exist yet, treat it as enabled.
        let cameraEnabled =
            UserDefaults.standard.object(forKey: "camera.enabled") == nil
                ? true
                : UserDefaults.standard.bool(forKey: "camera.enabled")
        if cameraEnabled { caps.append(OpenClawCapability.camera.rawValue) }

        let voiceWakeEnabled = UserDefaults.standard.bool(forKey: VoiceWakePreferences.enabledKey)
        if voiceWakeEnabled { caps.append(OpenClawCapability.voiceWake.rawValue) }

        let locationModeRaw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        let locationMode = OpenClawLocationMode(rawValue: locationModeRaw) ?? .off
        if locationMode != .off { caps.append(OpenClawCapability.location.rawValue) }

        caps.append(OpenClawCapability.device.rawValue)
        caps.append(OpenClawCapability.photos.rawValue)
        caps.append(OpenClawCapability.contacts.rawValue)
        caps.append(OpenClawCapability.calendar.rawValue)
        caps.append(OpenClawCapability.reminders.rawValue)
        if Self.motionAvailable() {
            caps.append(OpenClawCapability.motion.rawValue)
        }

        return caps
    }

    private func currentCommands() -> [String] {
        var commands: [String] = [
            OpenClawCanvasCommand.present.rawValue,
            OpenClawCanvasCommand.hide.rawValue,
            OpenClawCanvasCommand.navigate.rawValue,
            OpenClawCanvasCommand.evalJS.rawValue,
            OpenClawCanvasCommand.snapshot.rawValue,
            OpenClawCanvasA2UICommand.push.rawValue,
            OpenClawCanvasA2UICommand.pushJSONL.rawValue,
            OpenClawCanvasA2UICommand.reset.rawValue,
            OpenClawScreenCommand.record.rawValue,
            OpenClawSystemCommand.notify.rawValue,
            OpenClawTalkCommand.pttStart.rawValue,
            OpenClawTalkCommand.pttStop.rawValue,
            OpenClawTalkCommand.pttCancel.rawValue,
            OpenClawTalkCommand.pttOnce.rawValue,
        ]

        let caps = Set(self.currentCaps())
        if caps.contains(OpenClawCapability.camera.rawValue) {
            commands.append(OpenClawCameraCommand.list.rawValue)
            commands.append(OpenClawCameraCommand.snap.rawValue)
            commands.append(OpenClawCameraCommand.clip.rawValue)
        }
        if caps.contains(OpenClawCapability.location.rawValue) {
            commands.append(OpenClawLocationCommand.get.rawValue)
        }
        if caps.contains(OpenClawCapability.device.rawValue) {
            commands.append(OpenClawDeviceCommand.status.rawValue)
            commands.append(OpenClawDeviceCommand.info.rawValue)
        }
        if caps.contains(OpenClawCapability.photos.rawValue) {
            commands.append(OpenClawPhotosCommand.latest.rawValue)
        }
        if caps.contains(OpenClawCapability.contacts.rawValue) {
            commands.append(OpenClawContactsCommand.search.rawValue)
            commands.append(OpenClawContactsCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.calendar.rawValue) {
            commands.append(OpenClawCalendarCommand.events.rawValue)
            commands.append(OpenClawCalendarCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.reminders.rawValue) {
            commands.append(OpenClawRemindersCommand.list.rawValue)
            commands.append(OpenClawRemindersCommand.add.rawValue)
        }
        if caps.contains(OpenClawCapability.motion.rawValue) {
            commands.append(OpenClawMotionCommand.activity.rawValue)
            commands.append(OpenClawMotionCommand.pedometer.rawValue)
        }

        return commands
    }

    private func currentPermissions() -> [String: Bool] {
        var permissions: [String: Bool] = [:]
        permissions["camera"] = AVCaptureDevice.authorizationStatus(for: .video) == .authorized
        permissions["microphone"] = AVCaptureDevice.authorizationStatus(for: .audio) == .authorized
        permissions["speechRecognition"] = SFSpeechRecognizer.authorizationStatus() == .authorized
        permissions["location"] = Self.isLocationAuthorized(
            status: CLLocationManager().authorizationStatus)
            && CLLocationManager.locationServicesEnabled()
        permissions["screenRecording"] = RPScreenRecorder.shared().isAvailable

        let photoStatus = PHPhotoLibrary.authorizationStatus(for: .readWrite)
        permissions["photos"] = photoStatus == .authorized || photoStatus == .limited
        let contactsStatus = CNContactStore.authorizationStatus(for: .contacts)
        permissions["contacts"] = contactsStatus == .authorized || contactsStatus == .limited

        let calendarStatus = EKEventStore.authorizationStatus(for: .event)
        permissions["calendar"] =
            calendarStatus == .authorized || calendarStatus == .fullAccess || calendarStatus == .writeOnly
        let remindersStatus = EKEventStore.authorizationStatus(for: .reminder)
        permissions["reminders"] =
            remindersStatus == .authorized || remindersStatus == .fullAccess || remindersStatus == .writeOnly

        let motionStatus = CMMotionActivityManager.authorizationStatus()
        let pedometerStatus = CMPedometer.authorizationStatus()
        permissions["motion"] =
            motionStatus == .authorized || pedometerStatus == .authorized

        return permissions
    }

    private static func isLocationAuthorized(status: CLAuthorizationStatus) -> Bool {
        switch status {
        case .authorizedAlways, .authorizedWhenInUse, .authorized:
            return true
        default:
            return false
        }
    }

    private static func motionAvailable() -> Bool {
        CMMotionActivityManager.isActivityAvailable() || CMPedometer.isStepCountingAvailable()
    }

    private func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        let name = switch UIDevice.current.userInterfaceIdiom {
        case .pad:
            "iPadOS"
        case .phone:
            "iOS"
        default:
            "iOS"
        }
        return "\(name) \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private func deviceFamily() -> String {
        switch UIDevice.current.userInterfaceIdiom {
        case .pad:
            "iPad"
        case .phone:
            "iPhone"
        default:
            "iOS"
        }
    }

    private func modelIdentifier() -> String {
        var systemInfo = utsname()
        uname(&systemInfo)
        let machine = withUnsafeBytes(of: &systemInfo.machine) { ptr in
            String(bytes: ptr.prefix { $0 != 0 }, encoding: .utf8)
        }
        let trimmed = machine?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? "unknown" : trimmed
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}

#if DEBUG
extension GatewayConnectionController {
    func _test_resolvedDisplayName(defaults: UserDefaults) -> String {
        self.resolvedDisplayName(defaults: defaults)
    }

    func _test_currentCaps() -> [String] {
        self.currentCaps()
    }

    func _test_currentCommands() -> [String] {
        self.currentCommands()
    }

    func _test_currentPermissions() -> [String: Bool] {
        self.currentPermissions()
    }

    func _test_platformString() -> String {
        self.platformString()
    }

    func _test_deviceFamily() -> String {
        self.deviceFamily()
    }

    func _test_modelIdentifier() -> String {
        self.modelIdentifier()
    }

    func _test_appVersion() -> String {
        self.appVersion()
    }

    func _test_setGateways(_ gateways: [GatewayDiscoveryModel.DiscoveredGateway]) {
        self.gateways = gateways
    }

    func _test_triggerAutoConnect() {
        self.maybeAutoConnect()
    }
}
#endif
