import ClawdisKit
import Combine
import Foundation
import Network
import SwiftUI

@MainActor
final class BridgeConnectionController: ObservableObject {
    @Published private(set) var bridges: [BridgeDiscoveryModel.DiscoveredBridge] = []
    @Published private(set) var discoveryStatusText: String = "Idle"

    private let discovery = BridgeDiscoveryModel()
    private weak var appModel: NodeAppModel?
    private var cancellables = Set<AnyCancellable>()
    private var didAutoConnect = false
    private var seenStableIDs = Set<String>()

    init(appModel: NodeAppModel) {
        self.appModel = appModel

        BridgeSettingsStore.bootstrapPersistence()

        self.discovery.$bridges
            .sink { [weak self] newValue in
                guard let self else { return }
                self.bridges = newValue
                self.updateLastDiscoveredBridge(from: newValue)
                self.maybeAutoConnect()
            }
            .store(in: &self.cancellables)

        self.discovery.$statusText
            .assign(to: &self.$discoveryStatusText)

        self.discovery.start()
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
        let displayName = defaults.string(forKey: "node.displayName") ?? "iOS Node"

        return BridgeHello(
            nodeId: nodeId,
            displayName: displayName,
            token: token,
            platform: self.platformString(),
            version: self.appVersion())
    }

    private func platformString() -> String {
        let v = ProcessInfo.processInfo.operatingSystemVersion
        return "iOS \(v.majorVersion).\(v.minorVersion).\(v.patchVersion)"
    }

    private func appVersion() -> String {
        Bundle.main.infoDictionary?["CFBundleShortVersionString"] as? String ?? "dev"
    }
}
