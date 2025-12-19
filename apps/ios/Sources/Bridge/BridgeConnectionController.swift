import ClawdisKit
import Darwin
import Foundation
import Network
import Observation
import SwiftUI
import UIKit

@MainActor
@Observable
final class BridgeConnectionController {
    private(set) var bridges: [BridgeDiscoveryModel.DiscoveredBridge] = []
    private(set) var discoveryStatusText: String = "Idle"
    private(set) var discoveryDebugLog: [BridgeDiscoveryModel.DebugLogEntry] = []

    private let discovery = BridgeDiscoveryModel()
    private weak var appModel: NodeAppModel?
    private var didAutoConnect = false
    private var seenStableIDs = Set<String>()

    init(appModel: NodeAppModel, startDiscovery: Bool = true) {
        self.appModel = appModel

        BridgeSettingsStore.bootstrapPersistence()
        let defaults = UserDefaults.standard
        self.discovery.setDebugLoggingEnabled(defaults.bool(forKey: "bridge.discovery.debugLogs"))

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

    private func updateFromDiscovery() {
        let newBridges = self.discovery.bridges
        self.bridges = newBridges
        self.discoveryStatusText = self.discovery.statusText
        self.discoveryDebugLog = self.discovery.debugLog
        self.updateLastDiscoveredBridge(from: newBridges)
        self.maybeAutoConnect()
    }

    private func observeDiscovery() {
        withObservationTracking {
            _ = self.discovery.bridges
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
        guard appModel.bridgeServerName == nil else { return }

        let defaults = UserDefaults.standard
        let manualEnabled = defaults.bool(forKey: "bridge.manual.enabled")

        let instanceId = defaults.string(forKey: "node.instanceId")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !instanceId.isEmpty else { return }

        let token = KeychainStore.loadString(
            service: "com.steipete.clawdis.bridge",
            account: "bridge-token.\(instanceId)")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !token.isEmpty else { return }

        if manualEnabled {
            let manualHost = defaults.string(forKey: "bridge.manual.host")?
                .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            guard !manualHost.isEmpty else { return }

            let manualPort = defaults.integer(forKey: "bridge.manual.port")
            let resolvedPort = manualPort > 0 ? manualPort : 18790
            guard let port = NWEndpoint.Port(rawValue: UInt16(resolvedPort)) else { return }

            self.didAutoConnect = true
            appModel.connectToBridge(
                endpoint: .hostPort(host: NWEndpoint.Host(manualHost), port: port),
                hello: self.makeHello(token: token))
            return
        }

        let targetStableID = defaults.string(forKey: "bridge.lastDiscoveredStableID")?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        guard !targetStableID.isEmpty else { return }

        guard let target = self.bridges.first(where: { $0.stableID == targetStableID }) else { return }

        self.didAutoConnect = true
        appModel.connectToBridge(endpoint: target.endpoint, hello: self.makeHello(token: token))
    }

    private func updateLastDiscoveredBridge(from bridges: [BridgeDiscoveryModel.DiscoveredBridge]) {
        let newlyDiscovered = bridges.filter { self.seenStableIDs.insert($0.stableID).inserted }
        guard let last = newlyDiscovered.last else { return }

        UserDefaults.standard.set(last.stableID, forKey: "bridge.lastDiscoveredStableID")
        BridgeSettingsStore.saveLastDiscoveredBridgeStableID(last.stableID)
    }

    private func makeHello(token: String) -> BridgeHello {
        let defaults = UserDefaults.standard
        let nodeId = defaults.string(forKey: "node.instanceId") ?? "ios-node"
        let displayName = self.resolvedDisplayName(defaults: defaults)

        return BridgeHello(
            nodeId: nodeId,
            displayName: displayName,
            token: token,
            platform: self.platformString(),
            version: self.appVersion(),
            deviceFamily: self.deviceFamily(),
            modelIdentifier: self.modelIdentifier(),
            caps: self.currentCaps(),
            commands: self.currentCommands())
    }

    private func resolvedDisplayName(defaults: UserDefaults) -> String {
        let key = "node.displayName"
        let existing = defaults.string(forKey: key)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        if !existing.isEmpty, existing != "iOS Node" { return existing }

        let deviceName = UIDevice.current.name.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = deviceName.isEmpty ? "iOS Node" : deviceName

        if existing.isEmpty || existing == "iOS Node" {
            defaults.set(candidate, forKey: key)
        }

        return candidate
    }

    private func currentCaps() -> [String] {
        var caps = [ClawdisCapability.canvas.rawValue, ClawdisCapability.screen.rawValue]

        // Default-on: if the key doesn't exist yet, treat it as enabled.
        let cameraEnabled =
            UserDefaults.standard.object(forKey: "camera.enabled") == nil
                ? true
                : UserDefaults.standard.bool(forKey: "camera.enabled")
        if cameraEnabled { caps.append(ClawdisCapability.camera.rawValue) }

        let voiceWakeEnabled = UserDefaults.standard.bool(forKey: VoiceWakePreferences.enabledKey)
        if voiceWakeEnabled { caps.append(ClawdisCapability.voiceWake.rawValue) }

        return caps
    }

    private func currentCommands() -> [String] {
        var commands: [String] = [
            ClawdisCanvasCommand.show.rawValue,
            ClawdisCanvasCommand.hide.rawValue,
            ClawdisCanvasCommand.navigate.rawValue,
            ClawdisCanvasCommand.evalJS.rawValue,
            ClawdisCanvasCommand.snapshot.rawValue,
            ClawdisCanvasA2UICommand.push.rawValue,
            ClawdisCanvasA2UICommand.pushJSONL.rawValue,
            ClawdisCanvasA2UICommand.reset.rawValue,
            ClawdisScreenCommand.record.rawValue,
        ]

        let caps = Set(self.currentCaps())
        if caps.contains(ClawdisCapability.camera.rawValue) {
            commands.append(ClawdisCameraCommand.snap.rawValue)
            commands.append(ClawdisCameraCommand.clip.rawValue)
        }

        return commands
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
            String(decoding: ptr.prefix { $0 != 0 }, as: UTF8.self)
        }
        return machine.isEmpty ? "unknown" : machine
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}
