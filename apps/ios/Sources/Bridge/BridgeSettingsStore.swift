import Foundation

enum BridgeSettingsStore {
    private static let bridgeService = "com.steipete.clawdis.bridge"
    private static let nodeService = "com.steipete.clawdis.node"

    private static let instanceIdDefaultsKey = "node.instanceId"
    private static let preferredBridgeStableIDDefaultsKey = "bridge.preferredStableID"
    private static let lastDiscoveredBridgeStableIDDefaultsKey = "bridge.lastDiscoveredStableID"

    private static let instanceIdAccount = "instanceId"
    private static let preferredBridgeStableIDAccount = "preferredStableID"
    private static let lastDiscoveredBridgeStableIDAccount = "lastDiscoveredStableID"

    static func bootstrapPersistence() {
        self.ensureStableInstanceID()
        self.ensurePreferredBridgeStableID()
        self.ensureLastDiscoveredBridgeStableID()
    }

    static func loadStableInstanceID() -> String? {
        KeychainStore.loadString(service: self.nodeService, account: self.instanceIdAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func saveStableInstanceID(_ instanceId: String) {
        _ = KeychainStore.saveString(instanceId, service: self.nodeService, account: self.instanceIdAccount)
    }

    static func loadPreferredBridgeStableID() -> String? {
        KeychainStore.loadString(service: self.bridgeService, account: self.preferredBridgeStableIDAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func savePreferredBridgeStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.bridgeService,
            account: self.preferredBridgeStableIDAccount)
    }

    static func loadLastDiscoveredBridgeStableID() -> String? {
        KeychainStore.loadString(service: self.bridgeService, account: self.lastDiscoveredBridgeStableIDAccount)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
    }

    static func saveLastDiscoveredBridgeStableID(_ stableID: String) {
        _ = KeychainStore.saveString(
            stableID,
            service: self.bridgeService,
            account: self.lastDiscoveredBridgeStableIDAccount)
    }

    private static func ensureStableInstanceID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.instanceIdDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadStableInstanceID() == nil {
                self.saveStableInstanceID(existing)
            }
            return
        }

        if let stored = self.loadStableInstanceID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.instanceIdDefaultsKey)
            return
        }

        let fresh = UUID().uuidString
        self.saveStableInstanceID(fresh)
        defaults.set(fresh, forKey: self.instanceIdDefaultsKey)
    }

    private static func ensurePreferredBridgeStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.preferredBridgeStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadPreferredBridgeStableID() == nil {
                self.savePreferredBridgeStableID(existing)
            }
            return
        }

        if let stored = self.loadPreferredBridgeStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.preferredBridgeStableIDDefaultsKey)
        }
    }

    private static func ensureLastDiscoveredBridgeStableID() {
        let defaults = UserDefaults.standard

        if let existing = defaults.string(forKey: self.lastDiscoveredBridgeStableIDDefaultsKey)?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !existing.isEmpty
        {
            if self.loadLastDiscoveredBridgeStableID() == nil {
                self.saveLastDiscoveredBridgeStableID(existing)
            }
            return
        }

        if let stored = self.loadLastDiscoveredBridgeStableID(), !stored.isEmpty {
            defaults.set(stored, forKey: self.lastDiscoveredBridgeStableIDDefaultsKey)
        }
    }
}
