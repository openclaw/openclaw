import ClawdisKit
import Foundation
import Testing
import UIKit
@testable import Clawdis

private struct KeychainEntry: Hashable {
    let service: String
    let account: String
}

private let bridgeService = "com.steipete.clawdis.bridge"
private let nodeService = "com.steipete.clawdis.node"
private let instanceIdEntry = KeychainEntry(service: nodeService, account: "instanceId")
private let preferredBridgeEntry = KeychainEntry(service: bridgeService, account: "preferredStableID")
private let lastBridgeEntry = KeychainEntry(service: bridgeService, account: "lastDiscoveredStableID")

private func withUserDefaults<T>(_ updates: [String: Any?], _ body: () throws -> T) rethrows -> T {
    let defaults = UserDefaults.standard
    var snapshot: [String: Any?] = [:]
    for key in updates.keys {
        snapshot[key] = defaults.object(forKey: key)
    }
    for (key, value) in updates {
        if let value {
            defaults.set(value, forKey: key)
        } else {
            defaults.removeObject(forKey: key)
        }
    }
    defer {
        for (key, value) in snapshot {
            if let value {
                defaults.set(value, forKey: key)
            } else {
                defaults.removeObject(forKey: key)
            }
        }
    }
    return try body()
}

private func withKeychainValues<T>(_ updates: [KeychainEntry: String?], _ body: () throws -> T) rethrows -> T {
    var snapshot: [KeychainEntry: String?] = [:]
    for entry in updates.keys {
        snapshot[entry] = KeychainStore.loadString(service: entry.service, account: entry.account)
    }
    for (entry, value) in updates {
        if let value {
            _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
        } else {
            _ = KeychainStore.delete(service: entry.service, account: entry.account)
        }
    }
    defer {
        for (entry, value) in snapshot {
            if let value {
                _ = KeychainStore.saveString(value, service: entry.service, account: entry.account)
            } else {
                _ = KeychainStore.delete(service: entry.service, account: entry.account)
            }
        }
    }
    return try body()
}

@Suite(.serialized) struct BridgeConnectionControllerTests {
    @Test @MainActor func resolvedDisplayNameSetsDefaultWhenMissing() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([displayKey: nil, "node.instanceId": "ios-test"]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)

                let resolved = controller._test_resolvedDisplayName(defaults: defaults)
                #expect(!resolved.isEmpty)
                #expect(defaults.string(forKey: displayKey) == resolved)
            }
        }
    }

    @Test @MainActor func resolvedDisplayNamePreservesCustomValue() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([displayKey: "My iOS Node", "node.instanceId": "ios-test"]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)

                let resolved = controller._test_resolvedDisplayName(defaults: defaults)
                #expect(resolved == "My iOS Node")
                #expect(defaults.string(forKey: displayKey) == "My iOS Node")
            }
        }
    }

    @Test @MainActor func makeHelloBuildsCapsAndCommands() {
        let defaults = UserDefaults.standard
        let voiceWakeKey = VoiceWakePreferences.enabledKey

        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([
                "node.instanceId": "ios-test",
                "node.displayName": "Test Node",
                "camera.enabled": false,
                voiceWakeKey: true,
            ]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)
                let hello = controller._test_makeHello(token: "token-123")

                #expect(hello.nodeId == "ios-test")
                #expect(hello.displayName == "Test Node")
                #expect(hello.token == "token-123")

                let caps = Set(hello.caps ?? [])
                #expect(caps.contains(ClawdisCapability.canvas.rawValue))
                #expect(caps.contains(ClawdisCapability.screen.rawValue))
                #expect(caps.contains(ClawdisCapability.voiceWake.rawValue))
                #expect(!caps.contains(ClawdisCapability.camera.rawValue))

                let commands = Set(hello.commands ?? [])
                #expect(commands.contains(ClawdisCanvasCommand.present.rawValue))
                #expect(commands.contains(ClawdisScreenCommand.record.rawValue))
                #expect(!commands.contains(ClawdisCameraCommand.snap.rawValue))

                #expect(!(hello.platform ?? "").isEmpty)
                #expect(!(hello.deviceFamily ?? "").isEmpty)
                #expect(!(hello.modelIdentifier ?? "").isEmpty)
                #expect(!(hello.version ?? "").isEmpty)
            }
        }
    }

    @Test @MainActor func makeHelloIncludesCameraCommandsWhenEnabled() {
        withKeychainValues([instanceIdEntry: nil, preferredBridgeEntry: nil, lastBridgeEntry: nil]) {
            withUserDefaults([
                "node.instanceId": "ios-test",
                "node.displayName": "Test Node",
                "camera.enabled": true,
                VoiceWakePreferences.enabledKey: false,
            ]) {
                let appModel = NodeAppModel()
                let controller = BridgeConnectionController(appModel: appModel, startDiscovery: false)
                let hello = controller._test_makeHello(token: "token-456")

                let caps = Set(hello.caps ?? [])
                #expect(caps.contains(ClawdisCapability.camera.rawValue))

                let commands = Set(hello.commands ?? [])
                #expect(commands.contains(ClawdisCameraCommand.snap.rawValue))
                #expect(commands.contains(ClawdisCameraCommand.clip.rawValue))
            }
        }
    }
}
