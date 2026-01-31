import OpenClawKit
import Foundation
import Testing
import UIKit
@testable import OpenClaw

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

@Suite(.serialized) struct GatewayConnectionControllerTests {
    @Test @MainActor func resolvedDisplayNameSetsDefaultWhenMissing() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withUserDefaults([displayKey: nil, "node.instanceId": "ios-test"]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let resolved = controller._test_resolvedDisplayName(defaults: defaults)
            #expect(!resolved.isEmpty)
            #expect(resolved != "iOS Node")
            #expect(defaults.string(forKey: displayKey) == resolved)
        }
    }

    @Test @MainActor func currentCapsReflectToggles() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "node.displayName": "Test Node",
            "camera.enabled": true,
            "location.enabledMode": OpenClawLocationMode.always.rawValue,
            VoiceWakePreferences.enabledKey: true,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let caps = Set(controller._test_currentCaps())

            #expect(caps.contains(OpenClawCapability.canvas.rawValue))
            #expect(caps.contains(OpenClawCapability.screen.rawValue))
            #expect(caps.contains(OpenClawCapability.camera.rawValue))
            #expect(caps.contains(OpenClawCapability.location.rawValue))
            #expect(caps.contains(OpenClawCapability.voiceWake.rawValue))
            #expect(caps.contains(OpenClawCapability.device.rawValue))
            #expect(caps.contains(OpenClawCapability.photos.rawValue))
            #expect(caps.contains(OpenClawCapability.contacts.rawValue))
            #expect(caps.contains(OpenClawCapability.calendar.rawValue))
            #expect(caps.contains(OpenClawCapability.reminders.rawValue))
        }
    }

    @Test @MainActor func currentCommandsIncludeLocationWhenEnabled() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "location.enabledMode": OpenClawLocationMode.whileUsing.rawValue,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            #expect(commands.contains(OpenClawLocationCommand.get.rawValue))
        }
    }

    @Test @MainActor func currentCommandsExcludeShellAndIncludeNotifyAndDevice() {
        withUserDefaults([
            "node.instanceId": "ios-test",
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            #expect(commands.contains(OpenClawSystemCommand.notify.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.run.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.which.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.execApprovalsGet.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.execApprovalsSet.rawValue))

            #expect(commands.contains(OpenClawDeviceCommand.status.rawValue))
            #expect(commands.contains(OpenClawDeviceCommand.info.rawValue))
            #expect(commands.contains(OpenClawContactsCommand.add.rawValue))
            #expect(commands.contains(OpenClawCalendarCommand.add.rawValue))
            #expect(commands.contains(OpenClawRemindersCommand.add.rawValue))
        }
    }

    @Test @MainActor func currentPermissionsIncludeExpectedKeys() {
        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let permissions = controller._test_currentPermissions()
        let keys = Set(permissions.keys)

        #expect(keys.contains("camera"))
        #expect(keys.contains("microphone"))
        #expect(keys.contains("location"))
        #expect(keys.contains("screenRecording"))
        #expect(keys.contains("photos"))
        #expect(keys.contains("contacts"))
        #expect(keys.contains("calendar"))
        #expect(keys.contains("reminders"))
        #expect(keys.contains("motion"))
    }
}
