import Foundation
import OpenClawKit
import Testing
@testable import OpenClaw

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let gatewayService = "ai.openclawfoundation.app.gateway"
private let nodeService = "ai.openclawfoundation.app.node"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredGatewayEntry = KeychainEntry(service: gatewayService, account: "preferredStableID")
private let lastGatewayEntry = KeychainEntry(service: gatewayService, account: "lastDiscoveredStableID")
private let bootstrapDefaultsKeys = [
    "node.instanceId",
    "gateway.preferredStableID",
    "gateway.lastDiscoveredStableID",
]
private let bootstrapKeychainEntries = [instanceIdEntry, preferredGatewayEntry, lastGatewayEntry]
private let lastGatewayDefaultsKeys = [
    "gateway.last.kind",
    "gateway.last.host",
    "gateway.last.port",
    "gateway.last.tls",
    "gateway.last.stableID",
]
private let lastGatewayKeychainEntry = KeychainEntry(service: gatewayService, account: "lastConnection")

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
    let keychainSnapshot = snapshotKeychain([lastGatewayKeychainEntry])
    defer {
        restoreDefaults(defaultsSnapshot)
        restoreKeychain(keychainSnapshot)
    }
    body()
}

@Suite(.serialized) struct GatewaySettingsStoreTests {
    @Test func `credentials stay bound to their gateway`() {
        let instanceID = "credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let firstGatewayID = "manual|first.example.com|443"
        let secondGatewayID = "manual|second.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "first-token",
            bootstrapToken: nil,
            password: "first-password",
            gatewayStableID: firstGatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        let first = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstGatewayID)
        #expect(first.token == "first-token")
        #expect(first.password == "first-password")
        #expect(first.suppressStoredDeviceAuth)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID) == .empty)

        GatewaySettingsStore.discardUnscopedGatewayCredentials(instanceId: instanceID)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID) == .empty)
    }

    @Test func `shared tls certificate does not alias distinct routes`() {
        let instanceID = "tls-owner-\(UUID().uuidString)"
        let discoveredID = "bonjour|_openclaw._tcp|local|gateway-\(UUID().uuidString)"
        let manualID = "manual|gateway-\(UUID().uuidString).local|443"
        let fingerprint = "AA:BB:CC:DD"
        defer {
            GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID)
            GatewayTLSStore.clearFingerprint(stableID: discoveredID)
            GatewayTLSStore.clearFingerprint(stableID: manualID)
        }

        GatewaySettingsStore.saveGatewayCredentials(
            token: "shared-token",
            bootstrapToken: nil,
            password: "shared-password",
            gatewayStableID: discoveredID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID)
        GatewayTLSStore.saveFingerprint(fingerprint, stableID: discoveredID)
        GatewayTLSStore.saveFingerprint(fingerprint, stableID: manualID)

        let manualCredentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: manualID)
        #expect(manualCredentials == .empty)
        #expect(GatewaySettingsStore.authenticationOwnerID(routeStableID: discoveredID) == discoveredID)
        #expect(GatewaySettingsStore.authenticationOwnerID(routeStableID: manualID) == manualID)
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(instanceId: instanceID)?.gatewayStableID ==
            discoveredID)
    }

    @Test func `ambiguous legacy credentials are discarded`() {
        let instanceID = "legacy-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let firstGatewayID = "manual|first.example.com|443"
        let secondGatewayID = "manual|second.example.com|443"
        GatewaySettingsStore.saveLegacyGatewayTokenForMigrationTest("legacy-token", instanceId: instanceID)

        GatewaySettingsStore.discardUnscopedGatewayCredentials(instanceId: instanceID)

        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstGatewayID) == .empty)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID) == .empty)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-token.\(instanceID)") == nil)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-credentials.\(instanceID)") == nil)
    }

    @Test func `proven relay migration does not overwrite a canonical credential bundle`() {
        let instanceID = "relay-migration-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"
        GatewaySettingsStore.saveGatewayCredentials(
            token: "current-token",
            bootstrapToken: "current-bootstrap",
            password: "current-password",
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        GatewaySettingsStore.saveLegacyGatewayTokenForMigrationTest(
            "obsolete-token",
            instanceId: instanceID)

        #expect(GatewaySettingsStore.migrateProvenRelayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID,
            token: "stale-relay-token",
            password: "stale-relay-password"))
        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(credentials.token == "current-token")
        #expect(credentials.bootstrapToken == "current-bootstrap")
        #expect(credentials.password == "current-password")
        #expect(credentials.suppressStoredDeviceAuth)
        #expect(KeychainStore.loadString(
            service: gatewayService,
            account: "gateway-token.\(instanceID)") == nil)
    }

    @Test func `proven relay credentials are not reimported after legacy cleanup`() {
        let instanceID = "completed-relay-migration-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        #expect(GatewaySettingsStore.migrateProvenRelayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID,
            token: "stale-relay-token",
            password: "stale-relay-password"))
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == .empty)
    }

    @Test func `credentialless setup suppresses stored auth until handoff completes`() {
        let instanceID = "credentialless-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: nil,
            bootstrapToken: nil,
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        let pending = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(!pending.hasCredentials)
        #expect(pending.suppressStoredDeviceAuth)

        GatewaySettingsStore.completeGatewayCredentialHandoff(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == .empty)
        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(instanceId: instanceID) == nil)
    }

    @Test func `bootstrap handoff clears bootstrap while enabling stored auth`() {
        let instanceID = "bootstrap-handoff-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "shared-token",
            bootstrapToken: "one-time-bootstrap",
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)

        #expect(GatewaySettingsStore.completeGatewayCredentialHandoff(
            instanceId: instanceID,
            gatewayStableID: gatewayID))
        let completed = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(completed.token == "shared-token")
        #expect(completed.bootstrapToken == nil)
        #expect(!completed.suppressStoredDeviceAuth)
    }

    @Test func `field edits preserve pending bootstrap handoff for the same gateway`() {
        let instanceID = "edited-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: nil,
            bootstrapToken: "bootstrap-token",
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        GatewaySettingsStore.updateGatewayCredentials(
            token: "edited-token",
            password: "edited-password",
            gatewayStableID: gatewayID,
            instanceId: instanceID)

        let credentials = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID)
        #expect(credentials.token == "edited-token")
        #expect(credentials.bootstrapToken == "bootstrap-token")
        #expect(credentials.password == "edited-password")
        #expect(credentials.suppressStoredDeviceAuth)
    }

    @Test func `field edits do not carry pending handoff to another gateway`() {
        let instanceID = "switched-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let firstGatewayID = "manual|first.example.com|443"
        let secondGatewayID = "manual|second.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "first-token",
            bootstrapToken: "first-bootstrap-token",
            password: "first-password",
            gatewayStableID: firstGatewayID,
            suppressStoredDeviceAuth: true,
            instanceId: instanceID)
        GatewaySettingsStore.updateGatewayCredentials(
            token: "second-token",
            password: nil,
            gatewayStableID: secondGatewayID,
            instanceId: instanceID)

        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstGatewayID) == .empty)
        let second = GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondGatewayID)
        #expect(second.token == "second-token")
        #expect(second.bootstrapToken == nil)
        #expect(second.password == nil)
        #expect(!second.suppressStoredDeviceAuth)
    }

    @Test func `clearing ordinary credentials removes their owner metadata`() {
        let instanceID = "cleared-credential-owner-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteGatewayCredentials(instanceId: instanceID) }
        let gatewayID = "manual|gateway.example.com|443"

        GatewaySettingsStore.saveGatewayCredentials(
            token: "one-time-token",
            bootstrapToken: nil,
            password: nil,
            gatewayStableID: gatewayID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID)
        GatewaySettingsStore.updateGatewayCredentials(
            token: nil,
            password: nil,
            gatewayStableID: gatewayID,
            instanceId: instanceID)

        #expect(GatewaySettingsStore.loadGatewayCredentialMetadata(instanceId: instanceID) == nil)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: gatewayID) == .empty)
    }

    @Test func `bootstrap copies defaults to keychain when missing`() {
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

    @Test func `bootstrap copies keychain to defaults when missing`() {
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

    @Test func `last gateway manual round trip`() {
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

    @Test func `last gateway discovered overwrites manual`() {
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

    @Test func `last gateway migrates from user defaults`() {
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
            #expect(loaded == .manual(
                host: "example.org",
                port: 18789,
                useTLS: false,
                stableID: "manual|example.org|18789"))

            // Legacy keys should be cleaned up after migration.
            let defaults = UserDefaults.standard
            #expect(defaults.object(forKey: "gateway.last.stableID") == nil)
            #expect(defaults.object(forKey: "gateway.last.host") == nil)
        }
    }
}
