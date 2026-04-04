import Foundation
import Testing
@testable import OpenClaw

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let gatewayService = "ai.vericlaw.gateway"
private let legacyGatewayService = "ai.openclaw.gateway"
private let nodeService = "ai.vericlaw.node"
private let legacyNodeService = "ai.openclaw.node"
private let talkService = "ai.vericlaw.talk"
private let legacyTalkService = "ai.openclaw.talk"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredGatewayEntry = KeychainEntry(service: gatewayService, account: "preferredStableID")
private let lastGatewayEntry = KeychainEntry(service: gatewayService, account: "lastDiscoveredStableID")
private let talkAcmeProviderEntry = KeychainEntry(service: talkService, account: "provider.apiKey.acme")
private let legacyInstanceIdEntry = KeychainEntry(service: legacyNodeService, account: "instanceId")
private let legacyPreferredGatewayEntry = KeychainEntry(service: legacyGatewayService, account: "preferredStableID")
private let legacyLastGatewayEntry = KeychainEntry(service: legacyGatewayService, account: "lastDiscoveredStableID")
private let legacyTalkAcmeProviderEntry = KeychainEntry(service: legacyTalkService, account: "provider.apiKey.acme")
private let bootstrapDefaultsKeys = [
    "node.instanceId",
    "gateway.preferredStableID",
    "gateway.lastDiscoveredStableID",
]
private let bootstrapKeychainEntries = [
    instanceIdEntry,
    preferredGatewayEntry,
    lastGatewayEntry,
    legacyInstanceIdEntry,
    legacyPreferredGatewayEntry,
    legacyLastGatewayEntry,
]
private let lastGatewayDefaultsKeys = [
    "gateway.last.kind",
    "gateway.last.host",
    "gateway.last.port",
    "gateway.last.tls",
    "gateway.last.stableID",
]
private let lastGatewayKeychainEntry = KeychainEntry(service: gatewayService, account: "lastConnection")
private let legacyLastGatewayKeychainEntry = KeychainEntry(service: legacyGatewayService, account: "lastConnection")

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

private func withBootstrapSnapshots(_ body: () -> Void) {
    let defaultsSnapshot = snapshotDefaults(bootstrapDefaultsKeys)
    let keychainSnapshot = snapshotKeychain(bootstrapKeychainEntries)
    defer {
        restoreDefaults(defaultsSnapshot)
        restoreKeychain(keychainSnapshot)
    }
    body()
}

private func withLastGatewaySnapshot(_ body: () -> Void) {
    let defaultsSnapshot = snapshotDefaults(lastGatewayDefaultsKeys)
    let keychainSnapshot = snapshotKeychain([lastGatewayKeychainEntry, legacyLastGatewayKeychainEntry])
    defer {
        restoreDefaults(defaultsSnapshot)
        restoreKeychain(keychainSnapshot)
    }
    body()
}

@Suite(.serialized) struct GatewaySettingsStoreTests {
    @Test func bootstrapCopiesDefaultsToKeychainWhenMissing() {
        withBootstrapSnapshots {
            applyDefaults([
                "node.instanceId": "node-test",
                "gateway.preferredStableID": "preferred-test",
                "gateway.lastDiscoveredStableID": "last-test",
            ])
            applyKeychain([
                instanceIdEntry: nil,
                preferredGatewayEntry: nil,
                lastGatewayEntry: nil,
            ])

            GatewaySettingsStore.bootstrapPersistence()

            #expect(KeychainStore.loadString(service: nodeService, account: "instanceId") == "node-test")
            #expect(KeychainStore.loadString(service: gatewayService, account: "preferredStableID") == "preferred-test")
            #expect(KeychainStore.loadString(service: gatewayService, account: "lastDiscoveredStableID") == "last-test")
        }
    }

    @Test func bootstrapCopiesKeychainToDefaultsWhenMissing() {
        withBootstrapSnapshots {
            applyDefaults([
                "node.instanceId": nil,
                "gateway.preferredStableID": nil,
                "gateway.lastDiscoveredStableID": nil,
            ])
            applyKeychain([
                instanceIdEntry: "node-from-keychain",
                preferredGatewayEntry: "preferred-from-keychain",
                lastGatewayEntry: "last-from-keychain",
            ])

            GatewaySettingsStore.bootstrapPersistence()

            let defaults = UserDefaults.standard
            #expect(defaults.string(forKey: "node.instanceId") == "node-from-keychain")
            #expect(defaults.string(forKey: "gateway.preferredStableID") == "preferred-from-keychain")
            #expect(defaults.string(forKey: "gateway.lastDiscoveredStableID") == "last-from-keychain")
        }
    }

    @Test func lastGateway_manualRoundTrip() {
        withLastGatewaySnapshot {
            GatewaySettingsStore.saveLastGatewayConnectionManual(
                host: "example.com",
                port: 443,
                useTLS: true,
                stableID: "manual|example.com|443")

            let loaded = GatewaySettingsStore.loadLastGatewayConnection()
            #expect(loaded == .manual(host: "example.com", port: 443, useTLS: true, stableID: "manual|example.com|443"))
        }
    }

    @Test func lastGateway_discoveredOverwritesManual() {
        withLastGatewaySnapshot {
            GatewaySettingsStore.saveLastGatewayConnectionManual(
                host: "10.0.0.99",
                port: 18789,
                useTLS: true,
                stableID: "manual|10.0.0.99|18789")

            GatewaySettingsStore.saveLastGatewayConnectionDiscovered(stableID: "gw|abc", useTLS: true)

            #expect(GatewaySettingsStore.loadLastGatewayConnection() == .discovered(stableID: "gw|abc", useTLS: true))
        }
    }

    @Test func lastGateway_migratesFromUserDefaults() {
        withLastGatewaySnapshot {
            // Clear Keychain entry and plant legacy UserDefaults values.
            applyKeychain([lastGatewayKeychainEntry: nil])
            applyDefaults([
                "gateway.last.kind": nil,
                "gateway.last.host": "example.org",
                "gateway.last.port": 18789,
                "gateway.last.tls": false,
                "gateway.last.stableID": "manual|example.org|18789",
            ])

            let loaded = GatewaySettingsStore.loadLastGatewayConnection()
            #expect(loaded == .manual(host: "example.org", port: 18789, useTLS: false, stableID: "manual|example.org|18789"))

            // Legacy keys should be cleaned up after migration.
            let defaults = UserDefaults.standard
            #expect(defaults.object(forKey: "gateway.last.stableID") == nil)
            #expect(defaults.object(forKey: "gateway.last.host") == nil)
        }
    }

    @Test func talkProviderApiKey_genericRoundTrip() {
        let keychainSnapshot = snapshotKeychain([talkAcmeProviderEntry, legacyTalkAcmeProviderEntry])
        defer { restoreKeychain(keychainSnapshot) }

        _ = KeychainStore.delete(service: talkService, account: talkAcmeProviderEntry.account)
        _ = KeychainStore.delete(service: legacyTalkService, account: talkAcmeProviderEntry.account)

        GatewaySettingsStore.saveTalkProviderApiKey("acme-key", provider: "acme")
        #expect(GatewaySettingsStore.loadTalkProviderApiKey(provider: "acme") == "acme-key")
        #expect(KeychainStore.loadString(service: legacyTalkService, account: talkAcmeProviderEntry.account) == nil)

        GatewaySettingsStore.saveTalkProviderApiKey(nil, provider: "acme")
        #expect(GatewaySettingsStore.loadTalkProviderApiKey(provider: "acme") == nil)
    }

    @Test func bootstrapLoadsLegacyKeychainEntries() {
        withBootstrapSnapshots {
            applyDefaults([
                "node.instanceId": nil,
                "gateway.preferredStableID": nil,
                "gateway.lastDiscoveredStableID": nil,
            ])
            applyKeychain([
                instanceIdEntry: nil,
                preferredGatewayEntry: nil,
                lastGatewayEntry: nil,
                legacyInstanceIdEntry: "legacy-node-id",
                legacyPreferredGatewayEntry: "legacy-preferred",
                legacyLastGatewayEntry: "legacy-last",
            ])

            GatewaySettingsStore.bootstrapPersistence()

            let defaults = UserDefaults.standard
            #expect(defaults.string(forKey: "node.instanceId") == "legacy-node-id")
            #expect(defaults.string(forKey: "gateway.preferredStableID") == "legacy-preferred")
            #expect(defaults.string(forKey: "gateway.lastDiscoveredStableID") == "legacy-last")
        }
    }

    @Test func gatewayCredentialsLoadFromLegacyAndSaveIntoPreferredService() {
        let tokenEntry = KeychainEntry(service: gatewayService, account: "gateway-token.instance-1")
        let legacyTokenEntry = KeychainEntry(service: legacyGatewayService, account: "gateway-token.instance-1")
        let passwordEntry = KeychainEntry(service: gatewayService, account: "gateway-password.instance-1")
        let legacyPasswordEntry = KeychainEntry(service: legacyGatewayService, account: "gateway-password.instance-1")
        let snapshot = snapshotKeychain([tokenEntry, legacyTokenEntry, passwordEntry, legacyPasswordEntry])
        defer { restoreKeychain(snapshot) }

        applyKeychain([
            tokenEntry: nil,
            legacyTokenEntry: "legacy-token",
            passwordEntry: nil,
            legacyPasswordEntry: "legacy-password",
        ])

        #expect(GatewaySettingsStore.loadGatewayToken(instanceId: "instance-1") == "legacy-token")
        #expect(GatewaySettingsStore.loadGatewayPassword(instanceId: "instance-1") == "legacy-password")

        GatewaySettingsStore.saveGatewayToken("fresh-token", instanceId: "instance-1")
        GatewaySettingsStore.saveGatewayPassword("fresh-password", instanceId: "instance-1")

        #expect(KeychainStore.loadString(service: gatewayService, account: tokenEntry.account) == "fresh-token")
        #expect(KeychainStore.loadString(service: legacyGatewayService, account: legacyTokenEntry.account) == nil)
        #expect(KeychainStore.loadString(service: gatewayService, account: passwordEntry.account) == "fresh-password")
        #expect(KeychainStore.loadString(service: legacyGatewayService, account: legacyPasswordEntry.account) == nil)
    }
}
