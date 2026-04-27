import OpenClawKit
import Foundation
import Testing
import UIKit
@testable import OpenClaw

@Suite(.serialized) struct GatewayConnectionControllerTests {
    @Test @MainActor func resolvedDisplayNameSetsDefaultWhenMissing() {
        let defaults = UserDefaults.standard
        let displayKey = "node.displayName"

        withUserDefaults([displayKey: nil, "node.instanceId": "ios-test"]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)

            let resolved = controller._test_resolvedDisplayName(defaults: defaults)
            #expect(!resolved.isEmpty)
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
    @Test @MainActor func currentCommandsExcludeDangerousSystemExecCommands() {
        withUserDefaults([
            "node.instanceId": "ios-test",
            "camera.enabled": true,
            "location.enabledMode": OpenClawLocationMode.whileUsing.rawValue,
        ]) {
            let appModel = NodeAppModel()
            let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
            let commands = Set(controller._test_currentCommands())

            // iOS should expose notify, but not host shell/exec-approval commands.
            #expect(commands.contains(OpenClawSystemCommand.notify.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.run.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.which.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.execApprovalsGet.rawValue))
            #expect(!commands.contains(OpenClawSystemCommand.execApprovalsSet.rawValue))
        }
    }

    @Test @MainActor func operatorConnectOptionsOnlyRequestApprovalScopeWhenEnabled() {
        let appModel = NodeAppModel()
        let withoutApprovalScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: false)
        let withApprovalScope = appModel._test_makeOperatorConnectOptions(
            clientId: "openclaw-ios",
            displayName: "OpenClaw iOS",
            includeApprovalScope: true)

        #expect(withoutApprovalScope.role == "operator")
        #expect(withoutApprovalScope.scopes.contains("operator.read"))
        #expect(withoutApprovalScope.scopes.contains("operator.write"))
        #expect(!withoutApprovalScope.scopes.contains("operator.approvals"))
        #expect(withoutApprovalScope.scopes.contains("operator.talk.secrets"))

        #expect(withApprovalScope.scopes.contains("operator.approvals"))
    }

    @Test func operatorApprovalScopeRequestsStayBackwardCompatible() {
        #expect(
            !NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: nil,
                password: nil,
                storedOperatorScopes: ["operator.read", "operator.write", "operator.talk.secrets"])
        )
        #expect(
            NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: nil,
                password: nil,
                storedOperatorScopes: [
                    "operator.approvals",
                    "operator.read",
                    "operator.write",
                    "operator.talk.secrets",
                ])
        )
        #expect(
            NodeAppModel._test_shouldRequestOperatorApprovalScope(
                token: "shared-token",
                password: nil,
                storedOperatorScopes: [])
        )
    }

    @Test @MainActor func loadLastConnectionReadsSavedValues() {
        let prior = KeychainStore.loadString(service: "ai.openclaw.gateway", account: "lastConnection")
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: "ai.openclaw.gateway", account: "lastConnection")
            } else {
                _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")
            }
        }
        _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")

        GatewaySettingsStore.saveLastGatewayConnectionManual(
            host: "gateway.example.com",
            port: 443,
            useTLS: true,
            stableID: "manual|gateway.example.com|443")
        let loaded = GatewaySettingsStore.loadLastGatewayConnection()
        #expect(loaded == .manual(host: "gateway.example.com", port: 443, useTLS: true, stableID: "manual|gateway.example.com|443"))
    }

    @Test @MainActor func loadLastConnectionReturnsNilForInvalidData() {
        let prior = KeychainStore.loadString(service: "ai.openclaw.gateway", account: "lastConnection")
        defer {
            if let prior {
                _ = KeychainStore.saveString(prior, service: "ai.openclaw.gateway", account: "lastConnection")
            } else {
                _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")
            }
        }
        _ = KeychainStore.delete(service: "ai.openclaw.gateway", account: "lastConnection")

        // Plant legacy UserDefaults with invalid host/port to exercise migration + validation.
        withUserDefaults([
            "gateway.last.kind": "manual",
            "gateway.last.host": "",
            "gateway.last.port": 0,
            "gateway.last.tls": false,
            "gateway.last.stableID": "manual|invalid|0",
        ]) {
            let loaded = GatewaySettingsStore.loadLastGatewayConnection()
            #expect(loaded == nil)
        }
    }

    @Test @MainActor func startAutoConnectReappliesConfigAfterDisconnect() async {
        let defaults = UserDefaults.standard
        let priorInstanceId = defaults.object(forKey: "node.instanceId")
        defaults.set("ios-test", forKey: "node.instanceId")
        defer {
            if let priorInstanceId {
                defaults.set(priorInstanceId, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
        }

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let url = URL(string: "wss://gateway.example.com:443")!

        appModel.disconnectGateway()
        #expect(appModel.activeGatewayConnectConfig == nil)
        #expect(appModel.gatewayAutoReconnectEnabled == false)

        await controller._test_startAutoConnect(
            url: url,
            gatewayStableID: "manual|gateway.example.com|443")

        #expect(appModel.activeGatewayConnectConfig?.url == url)
        #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == "manual|gateway.example.com|443")
        #expect(appModel.gatewayAutoReconnectEnabled == true)
    }

    @Test @MainActor func startAutoConnectCanReplaceExistingGatewayConfig() async {
        let defaults = UserDefaults.standard
        let priorInstanceId = defaults.object(forKey: "node.instanceId")
        defaults.set("ios-test", forKey: "node.instanceId")
        defer {
            if let priorInstanceId {
                defaults.set(priorInstanceId, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
        }

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let firstURL = URL(string: "wss://first.example.com:443")!
        let secondURL = URL(string: "wss://second.example.com:443")!

        appModel.applyGatewayConnectConfig(
            GatewayConnectConfig(
                url: firstURL,
                stableID: "manual|first.example.com|443",
                tls: nil,
                token: nil,
                bootstrapToken: nil,
                password: nil,
                nodeOptions: GatewayConnectOptions(
                    role: "node",
                    scopes: [],
                    caps: [],
                    commands: [],
                    permissions: [:],
                    clientId: "openclaw-ios",
                    clientMode: "node",
                    clientDisplayName: "Test Node")))

        await controller._test_startAutoConnect(
            url: secondURL,
            gatewayStableID: "manual|second.example.com|443")

        #expect(appModel.activeGatewayConnectConfig?.url == secondURL)
        #expect(appModel.activeGatewayConnectConfig?.effectiveStableID == "manual|second.example.com|443")
    }

    @Test @MainActor func refreshActiveGatewayRegistrationPreservesLatestAuthAcrossAwait() async {
        let defaults = UserDefaults.standard
        let priorInstanceId = defaults.object(forKey: "node.instanceId")
        defaults.set("ios-test", forKey: "node.instanceId")
        defer {
            if let priorInstanceId {
                defaults.set(priorInstanceId, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
        }

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let url = URL(string: "wss://gateway.example.com:443")!
        let stableID = "manual|gateway.example.com|443"
        let placeholderOptions = GatewayConnectOptions(
            role: "node",
            scopes: [],
            caps: [],
            commands: [],
            permissions: [:],
            clientId: "openclaw-ios",
            clientMode: "node",
            clientDisplayName: "Test Node")

        // Step 1: apply an initial config carrying the old auth.
        appModel.applyGatewayConnectConfig(
            GatewayConnectConfig(
                url: url,
                stableID: stableID,
                tls: nil,
                token: "old-token",
                bootstrapToken: "old-bootstrap",
                password: "old-pass",
                nodeOptions: placeholderOptions))
        appModel.gatewayAutoReconnectEnabled = true

        // Step 2: kick off refresh; this captures `cfg` and schedules a Task.
        controller._test_refreshActiveGatewayRegistrationFromSettings()

        // Step 3: replace the active config with new auth BEFORE the refresh
        // Task gets to run. Same url/stableID/tls so the post-await guard
        // still passes — only the auth credentials change.
        appModel.applyGatewayConnectConfig(
            GatewayConnectConfig(
                url: url,
                stableID: stableID,
                tls: nil,
                token: "new-token",
                bootstrapToken: "new-bootstrap",
                password: "new-pass",
                nodeOptions: placeholderOptions))

        // Step 4: yield until the refresh Task has had a chance to commit.
        for _ in 0..<200 {
            await Task.yield()
        }

        // Step 5: the refresh must not overwrite the newer auth with the
        // pre-await snapshot. The applied config must still carry the new
        // credentials.
        #expect(appModel.activeGatewayConnectConfig?.token == "new-token")
        #expect(appModel.activeGatewayConnectConfig?.bootstrapToken == "new-bootstrap")
        #expect(appModel.activeGatewayConnectConfig?.password == "new-pass")
    }

    @Test @MainActor func startAutoConnectIncrementsAndDecrementsConnectInFlightCount() async {
        let defaults = UserDefaults.standard
        let priorInstanceId = defaults.object(forKey: "node.instanceId")
        defaults.set("ios-test", forKey: "node.instanceId")
        defer {
            if let priorInstanceId {
                defaults.set(priorInstanceId, forKey: "node.instanceId")
            } else {
                defaults.removeObject(forKey: "node.instanceId")
            }
        }

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let url = URL(string: "wss://gateway.example.com:443")!

        #expect(controller._test_connectInFlightCount == 0)

        controller._test_startAutoConnectWithoutWaiting(
            url: url,
            gatewayStableID: "manual|gateway.example.com|443")

        // Synchronous setup must have reserved one in-flight slot before the
        // Task body runs.
        #expect(controller._test_connectInFlightCount >= 1)

        await controller._test_waitForConnectInFlightToDrain()
        #expect(controller._test_connectInFlightCount == 0)
    }

    @Test @MainActor func attemptAutoReconnectStandsDownWhileConnectInFlight() async {
        let defaults = UserDefaults.standard
        let priorInstanceId = defaults.object(forKey: "node.instanceId")
        let priorAutoConnect = defaults.object(forKey: "gateway.autoconnect")
        let priorManualEnabled = defaults.object(forKey: "gateway.manual.enabled")
        let priorManualHost = defaults.object(forKey: "gateway.manual.host")
        let priorManualPort = defaults.object(forKey: "gateway.manual.port")
        let priorManualTLS = defaults.object(forKey: "gateway.manual.tls")
        defaults.set("ios-test", forKey: "node.instanceId")
        defaults.set(true, forKey: "gateway.autoconnect")
        defaults.set(true, forKey: "gateway.manual.enabled")
        defaults.set("gateway.example.com", forKey: "gateway.manual.host")
        defaults.set(443, forKey: "gateway.manual.port")
        defaults.set(true, forKey: "gateway.manual.tls")
        defer {
            if let priorInstanceId { defaults.set(priorInstanceId, forKey: "node.instanceId") }
            else { defaults.removeObject(forKey: "node.instanceId") }
            if let priorAutoConnect { defaults.set(priorAutoConnect, forKey: "gateway.autoconnect") }
            else { defaults.removeObject(forKey: "gateway.autoconnect") }
            if let priorManualEnabled { defaults.set(priorManualEnabled, forKey: "gateway.manual.enabled") }
            else { defaults.removeObject(forKey: "gateway.manual.enabled") }
            if let priorManualHost { defaults.set(priorManualHost, forKey: "gateway.manual.host") }
            else { defaults.removeObject(forKey: "gateway.manual.host") }
            if let priorManualPort { defaults.set(priorManualPort, forKey: "gateway.manual.port") }
            else { defaults.removeObject(forKey: "gateway.manual.port") }
            if let priorManualTLS { defaults.set(priorManualTLS, forKey: "gateway.manual.tls") }
            else { defaults.removeObject(forKey: "gateway.manual.tls") }
        }

        let appModel = NodeAppModel()
        let controller = GatewayConnectionController(appModel: appModel, startDiscovery: false)
        let url = URL(string: "wss://gateway.example.com:443")!

        let beforeGeneration = controller._test_autoConnectGeneration

        // Kick off an explicit connect; do NOT wait for it to commit.
        controller._test_startAutoConnectWithoutWaiting(
            url: url,
            gatewayStableID: "manual|gateway.example.com|443")

        let afterStartGeneration = controller._test_autoConnectGeneration
        #expect(afterStartGeneration == beforeGeneration + 1)
        #expect(controller._test_connectInFlightCount >= 1)

        // While the original Task is still suspended, simulate a scene-phase
        // event. With the in-flight guard in place this must NOT bump the
        // generation; without it, attemptAutoReconnectIfNeeded would call
        // maybeAutoConnect → startAutoConnect a second time, dropping the
        // original explicit connect.
        controller._test_attemptAutoReconnectIfNeeded()
        #expect(controller._test_autoConnectGeneration == afterStartGeneration)

        await controller._test_waitForConnectInFlightToDrain()
        #expect(controller._test_connectInFlightCount == 0)
    }
}
