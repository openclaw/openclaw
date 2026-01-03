import Foundation
import Testing
@testable import Clawdis

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let bridgeService = "com.clawdis.bridge"
private let nodeService = "com.clawdis.node"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredBridgeEntry = KeychainEntry(service: bridgeService, account: "preferredStableID")
private let lastBridgeEntry = KeychainEntry(service: bridgeService, account: "lastDiscoveredStableID")

private func snapshotDefaults(_ keys: [String]) -> [String: Any?] {
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    return snapshot
}

private func applyDefaults(_ values: [String: Any?]) {
    let defaults = UserDefaults.standard
    for (key, value) in values {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
}

private func restoreDefaults(_ snapshot: [String: Any?]) {
    applyDefaults(snapshot)
}

private func snapshotKeychain(_ entries: [KeychainEntry]) -> [KeychainEntry: String?] {
    var snapshot: [KeychainEntry: String?] = [:]
    for entry in entries {
        snapshot[entry] = KeychainStore.loadString(service: entry.service, account: entry.account)
    }
    return snapshot
}

private func applyKeychain(_ values: [KeychainEntry: String?]) {
    for (entry, value) in values {
        if let value {
            _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
        } else {
            _ = KeychainStore.delete(service: entry.service, account: entry.account)
        }
    }
}

private func restoreKeychain(_ snapshot: [KeychainEntry: String?]) {
    applyKeychain(snapshot)
}

@Suite(.serialized) struct BridgeSettingsStoreTests {
    @Test func bootstrapCopiesDefaultsToKeychainWhenMissing() {
        let defaultsKeys = [
            "node.instanceId",
            "bridge.preferredStableID",
            "bridge.lastDiscoveredStableID",
        ]
        let entries = [instanceIdEntry, preferredBridgeEntry, lastBridgeEntry]
        let defaultsSnapshot = snapshotDefaults(defaultsKeys)
        let keychainSnapshot = snapshotKeychain(entries)
        defer {
            restoreDefaults(defaultsSnapshot)
            restoreKeychain(keychainSnapshot)
        }

        applyDefaults([
            "node.instanceId": "node-test",
            "bridge.preferredStableID": "preferred-test",
            "bridge.lastDiscoveredStableID": "last-test",
        ])
        applyKeychain([
            instanceIdEntry: nil,
            preferredBridgeEntry: nil,
            lastBridgeEntry: nil,
        ])

        BridgeSettingsStore.bootstrapPersistence()

        #expect(KeychainStore.loadString(service: nodeService, account: "instanceId") == "node-test")
        #expect(KeychainStore.loadString(service: bridgeService, account: "preferredStableID") == "preferred-test")
        #expect(KeychainStore.loadString(service: bridgeService, account: "lastDiscoveredStableID") == "last-test")
    }

    @Test func bootstrapCopiesKeychainToDefaultsWhenMissing() {
        let defaultsKeys = [
            "node.instanceId",
            "bridge.preferredStableID",
            "bridge.lastDiscoveredStableID",
        ]
        let entries = [instanceIdEntry, preferredBridgeEntry, lastBridgeEntry]
        let defaultsSnapshot = snapshotDefaults(defaultsKeys)
        let keychainSnapshot = snapshotKeychain(entries)
        defer {
            restoreDefaults(defaultsSnapshot)
            restoreKeychain(keychainSnapshot)
        }

        applyDefaults([
            "node.instanceId": nil,
            "bridge.preferredStableID": nil,
            "bridge.lastDiscoveredStableID": nil,
        ])
        applyKeychain([
            instanceIdEntry: "node-from-keychain",
            preferredBridgeEntry: "preferred-from-keychain",
            lastBridgeEntry: "last-from-keychain",
        ])

        BridgeSettingsStore.bootstrapPersistence()

        let defaults = UserDefaults.standard
        #expect(defaults.string(forKey: "node.instanceId") == "node-from-keychain")
        #expect(defaults.string(forKey: "bridge.preferredStableID") == "preferred-from-keychain")
        #expect(defaults.string(forKey: "bridge.lastDiscoveredStableID") == "last-from-keychain")
    }
}
