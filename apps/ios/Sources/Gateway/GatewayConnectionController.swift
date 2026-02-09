import AVFoundation
import Contacts
import CoreLocation
import CoreMotion
import EventKit
import Foundation
import EasyHubKit
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
            self.attemptAutoReconnectIfNeeded()
        @unknown default:
            self.discovery.start()
            self.attemptAutoReconnectIfNeeded()
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
        GatewaySettingsStore.saveLastGatewayConnection(
            host: host,
            port: port,
            useTLS: tlsParams?.required == true,
            stableID: gateway.stableID)
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
        let resolvedUseTLS = useTLS
        guard let resolvedPort = self.resolveManualPort(host: host, port: port, useTLS: resolvedUseTLS)
        else { return }
        let stableID = self.manualStableID(host: host, port: resolvedPort)
        let tlsParams = self.resolveManualTLSParams(
            stableID: stableID,
            tlsEnabled: resolvedUseTLS,
            allowTOFUReset: self.shouldForceTLS(host: host))
        guard let url = self.buildGatewayURL(
            host: host,
            port: resolvedPort,
            useTLS: tlsParams?.required == true)
        else { return }
        GatewaySettingsStore.saveLastGatewayConnection(
            host: host,
            port: resolvedPort,
            useTLS: tlsParams?.required == true,
            stableID: stableID)
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: stableID,
            tls: tlsParams,
            token: token,
            password: password)
    }

    func connectLastKnown() async {
        guard let last = GatewaySettingsStore.loadLastGatewayConnection() else { return }
        let instanceId = UserDefaults.standard.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let token = GatewaySettingsStore.loadGatewayToken(instanceId: instanceId)
        let password = GatewaySettingsStore.loadGatewayPassword(instanceId: instanceId)
        let resolvedUseTLS = last.useTLS
        let tlsParams = self.resolveManualTLSParams(
            stableID: last.stableID,
            tlsEnabled: resolvedUseTLS,
            allowTOFUReset: self.shouldForceTLS(host: last.host))
        guard let url = self.buildGatewayURL(
            host: last.host,
            port: last.port,
            useTLS: tlsParams?.required == true)
        else { return }
        if resolvedUseTLS != last.useTLS {
            GatewaySettingsStore.saveLastGatewayConnection(
                host: last.host,
                port: last.port,
                useTLS: resolvedUseTLS,
                stableID: last.stableID)
        }
        self.didAutoConnect = true
        self.startAutoConnect(
            url: url,
            gatewayStableID: last.stableID,
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
        guard defaults.bool(forKey: "gateway.autoconnect") else { return }
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
            let manualTLS = defaults.bool(forKey: "gateway.manual.tls")
            let resolvedUseTLS = manualTLS || self.shouldForceTLS(host: manualHost)
            guard let resolvedPort = self.resolveManualPort(
                host: manualHost,
                port: manualPort,
                useTLS: resolvedUseTLS)
            else { return }

            let stableID = self.manualStableID(host: manualHost, port: resolvedPort)
            let tlsParams = self.resolveManualTLSParams(
                stableID: stableID,
                tlsEnabled: resolvedUseTLS,
                allowTOFUReset: self.shouldForceTLS(host: manualHost))

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

        if let lastKnown = GatewaySettingsStore.loadLastGatewayConnection() {
            let resolvedUseTLS = lastKnown.useTLS || self.shouldForceTLS(host: lastKnown.host)
            let tlsParams = self.resolveManualTLSParams(
                stableID: lastKnown.stableID,
                tlsEnabled: resolvedUseTLS,
                allowTOFUReset: self.shouldForceTLS(host: lastKnown.host))
            guard let url = self.buildGatewayURL(
                host: lastKnown.host,
                port: lastKnown.port,
                useTLS: tlsParams?.required == true)
            else { return }

            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: lastKnown.stableID,
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
        if let targetStableID = candidates.first(where: { id in
            self.gateways.contains(where: { $0.stableID == id })
        }) {
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
            return
        }

        if self.gateways.count == 1, let gateway = self.gateways.first {
            guard let host = self.resolveGatewayHost(gateway) else { return }
            let port = gateway.gatewayPort ?? 18789
            let tlsParams = self.resolveDiscoveredTLSParams(gateway: gateway)
            guard let url = self.buildGatewayURL(host: host, port: port, useTLS: tlsParams?.required == true)
            else { return }

            self.didAutoConnect = true
            self.startAutoConnect(
                url: url,
                gatewayStableID: gateway.stableID,
                tls: tlsParams,
                token: token,
                password: password)
            return
        }
    }

    private func attemptAutoReconnectIfNeeded() {
        guard let appModel = self.appModel else { return }
        guard appModel.gatewayAutoReconnectEnabled else { return }
        // Avoid starting duplicate connect loops while a prior config is active.
        guard appModel.activeGatewayConnectConfig == nil else { return }
        guard UserDefaults.standard.bool(forKey: "gateway.autoconnect") else { return }
        self.didAutoConnect = false
        self.maybeAutoConnect()
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
        let connectOptions = self.makeConnectOptions(stableID: gatewayStableID)

        Task { [weak appModel] in
            guard let appModel else { return }
            await MainActor.run {
                appModel.gatewayStatusText = "Connecting…"
            }
            let cfg = GatewayConnectConfig(
                url: url,
                stableID: gatewayStableID,
                tls: tls,
                token: token,
                password: password,
                nodeOptions: connectOptions)
            appModel.applyGatewayConnectConfig(cfg)
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

    private func resolveManualTLSParams(
        stableID: String,
        tlsEnabled: Bool,
        allowTOFUReset: Bool = false) -> GatewayTLSParams?
    {
        let stored = GatewayTLSStore.loadFingerprint(stableID: stableID)
        if tlsEnabled || stored != nil {
            return GatewayTLSParams(
                required: true,
                expectedFingerprint: stored,
                allowTOFU: stored == nil || allowTOFUReset,
                storeKey: stableID)
        }

        return nil
    }

    private func resolveGatewayHost(_ gateway: GatewayDiscoveryModel.DiscoveredGateway) -> String? {
        if let tailnet = gateway.tailnetDns?.trimmingCharacters(in: .whitespacesAndNewlines), !tailnet.isEmpty {
            return tailnet
        }
        if let lanHost = gateway.lanHost?.trimmingCharacters(in: .whitespacesAndNewlines), !lanHost.isEmpty {
            return lanHost
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

    private func shouldForceTLS(host: String) -> Bool {
        let trimmed = host.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if trimmed.isEmpty { return false }
        return trimmed.hasSuffix(".ts.net") || trimmed.hasSuffix(".ts.net.")
    }

    private func manualStableID(host: String, port: Int) -> String {
        "manual|\(host.lowercased())|\(port)"
    }

    private func makeConnectOptions(stableID: String?) -> GatewayConnectOptions {
        let defaults = UserDefaults.standard
        let displayName = self.resolvedDisplayName(defaults: defaults)
        let resolvedClientId = self.resolvedClientId(defaults: defaults, stableID: stableID)

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

    private func resolvedClientId(defaults: UserDefaults, stableID: String?) -> String {
        if let stableID,
           let override = GatewaySettingsStore.loadGatewayClientIdOverride(stableID: stableID) {
            return override
        }
        let manualClientId = defaults.string(forKey: "gateway.manual.clientId")?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        if manualClientId?.isEmpty == false {
            return manualClientId!
        }
        return "EasyHub-ios"
    }

    private func resolveManualPort(host: String, port: Int, useTLS: Bool) -> Int? {
        if port > 0 {
            return port <= 65535 ? port : nil
        }
        let trimmedHost = host.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmedHost.isEmpty else { return nil }
        if useTLS && self.shouldForceTLS(host: trimmedHost) {
            return 443
        }
        return 18789
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
        var caps = [EasyHubCapability.canvas.rawValue, EasyHubCapability.screen.rawValue]

        // Default-on: if the key doesn't exist yet, treat it as enabled.
        let cameraEnabled =
            UserDefaults.standard.object(forKey: "camera.enabled") == nil
                ? true
                : UserDefaults.standard.bool(forKey: "camera.enabled")
        if cameraEnabled { caps.append(EasyHubCapability.camera.rawValue) }

        let voiceWakeEnabled = UserDefaults.standard.bool(forKey: VoiceWakePreferences.enabledKey)
        if voiceWakeEnabled { caps.append(EasyHubCapability.voiceWake.rawValue) }

        let locationModeRaw = UserDefaults.standard.string(forKey: "location.enabledMode") ?? "off"
        let locationMode = EasyHubLocationMode(rawValue: locationModeRaw) ?? .off
        if locationMode != .off { caps.append(EasyHubCapability.location.rawValue) }

        caps.append(EasyHubCapability.device.rawValue)
        caps.append(EasyHubCapability.photos.rawValue)
        caps.append(EasyHubCapability.contacts.rawValue)
        caps.append(EasyHubCapability.calendar.rawValue)
        caps.append(EasyHubCapability.reminders.rawValue)
        if Self.motionAvailable() {
            caps.append(EasyHubCapability.motion.rawValue)
        }

        return caps
    }

    private func currentCommands() -> [String] {
        var commands: [String] = [
            EasyHubCanvasCommand.present.rawValue,
            EasyHubCanvasCommand.hide.rawValue,
            EasyHubCanvasCommand.navigate.rawValue,
            EasyHubCanvasCommand.evalJS.rawValue,
            EasyHubCanvasCommand.snapshot.rawValue,
            EasyHubCanvasA2UICommand.push.rawValue,
            EasyHubCanvasA2UICommand.pushJSONL.rawValue,
            EasyHubCanvasA2UICommand.reset.rawValue,
            EasyHubScreenCommand.record.rawValue,
            EasyHubSystemCommand.notify.rawValue,
            EasyHubChatCommand.push.rawValue,
            EasyHubTalkCommand.pttStart.rawValue,
            EasyHubTalkCommand.pttStop.rawValue,
            EasyHubTalkCommand.pttCancel.rawValue,
            EasyHubTalkCommand.pttOnce.rawValue,
        ]

        let caps = Set(self.currentCaps())
        if caps.contains(EasyHubCapability.camera.rawValue) {
            commands.append(EasyHubCameraCommand.list.rawValue)
            commands.append(EasyHubCameraCommand.snap.rawValue)
            commands.append(EasyHubCameraCommand.clip.rawValue)
        }
        if caps.contains(EasyHubCapability.location.rawValue) {
            commands.append(EasyHubLocationCommand.get.rawValue)
        }
        if caps.contains(EasyHubCapability.device.rawValue) {
            commands.append(EasyHubDeviceCommand.status.rawValue)
            commands.append(EasyHubDeviceCommand.info.rawValue)
        }
        if caps.contains(EasyHubCapability.photos.rawValue) {
            commands.append(EasyHubPhotosCommand.latest.rawValue)
        }
        if caps.contains(EasyHubCapability.contacts.rawValue) {
            commands.append(EasyHubContactsCommand.search.rawValue)
            commands.append(EasyHubContactsCommand.add.rawValue)
        }
        if caps.contains(EasyHubCapability.calendar.rawValue) {
            commands.append(EasyHubCalendarCommand.events.rawValue)
            commands.append(EasyHubCalendarCommand.add.rawValue)
        }
        if caps.contains(EasyHubCapability.reminders.rawValue) {
            commands.append(EasyHubRemindersCommand.list.rawValue)
            commands.append(EasyHubRemindersCommand.add.rawValue)
        }
        if caps.contains(EasyHubCapability.motion.rawValue) {
            commands.append(EasyHubMotionCommand.activity.rawValue)
            commands.append(EasyHubMotionCommand.pedometer.rawValue)
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
