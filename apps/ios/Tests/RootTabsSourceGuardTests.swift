import Foundation
import Testing
@testable import OpenClaw

struct RootTabsSourceGuardTests {
    @Test func `initial scene phase reaches the model before gateway admission`() throws {
        let startup = try Self.extract(
            Self.source("Sources/OpenClawApp.swift"),
            from: ".task {",
            to: ".onReceive(")
        let modelPhase = try #require(startup.range(of: "self.appModel.setScenePhase(self.scenePhase)"))
        let gatewayPhase = try #require(
            startup.range(of: "self.gatewayController.setScenePhase(self.scenePhase)"))

        #expect(modelPhase.lowerBound < gatewayPhase.lowerBound)
    }

    @Test func `scanner starts only while its view is visible`() throws {
        let source = try Self.source("Sources/Onboarding/QRScannerView.swift")
        let make = try Self.extract(source, from: "func makeUIViewController", to: "func updateUIViewController")
        let lifecycle = try Self.extract(
            source,
            from: "final class QRScannerContainerViewController",
            to: "final class Coordinator")

        #expect(!make.contains("startScanning()"))
        #expect(lifecycle.contains("override func viewDidAppear"))
        #expect(lifecycle.contains("try self.scanner.startScanning()"))
        #expect(lifecycle.contains("override func viewWillDisappear"))
        #expect(lifecycle.contains("self.stopScannerCapture()"))
    }

    @Test @MainActor func `credential fields stay scoped to exact gateway owners`() throws {
        let instanceID = "credential-fields-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let firstID = "manual|caf\u{e9}.example|443"
        let secondID = "manual|cafe\u{301}.example|443"
        for (stableID, token) in [(firstID, "first-token"), (secondID, "second-token")] {
            #expect(GatewaySettingsStore.saveGatewayCredentials(
                token: token,
                bootstrapToken: nil,
                password: nil,
                gatewayStableID: stableID,
                suppressStoredDeviceAuth: true,
                instanceId: instanceID))
        }
        var fields = GatewayConnectionController.ManualAuthOverride.Fields()
        fields.load(instanceId: instanceID, targetStableID: firstID)
        #expect(fields.token == "first-token")
        fields.token = "edited-token"
        fields.persist(instanceId: instanceID, targetStableID: firstID)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstID).token == "edited-token")

        fields.selectTarget(secondID, instanceId: instanceID, allowManualOverride: false)
        #expect(fields.token == "second-token")
        #expect(fields.pendingOverride == nil)
        #expect(fields.prepareManualConnection(instanceId: instanceID, targetStableID: firstID) == nil)
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: firstID).token == "edited-token")
        let selected = try #require(fields.prepareManualConnection(instanceId: instanceID, targetStableID: secondID))
        #expect(selected.token == "second-token")
        #expect(GatewaySettingsStore.loadGatewayCredentials(
            instanceId: instanceID,
            gatewayStableID: secondID).token == "second-token")
    }

    @Test @MainActor func `a credential typed after onboarding pairing saves to the active gateway`() {
        let instanceID = "credential-active-\(UUID().uuidString)"
        defer { GatewaySettingsStore.deleteAllGatewayCredentials(instanceId: instanceID) }
        let activeID = "manual|gateway.example.ts.net|443"
        let registry = GatewaySettingsStore.GatewayRegistry(
            activeStableID: activeID,
            connectedStableIDs: [activeID],
            entries: [GatewaySettingsStore.GatewayRegistryEntry(
                stableID: activeID,
                kind: .manual,
                name: "gateway.example.ts.net:443",
                host: "gateway.example.ts.net",
                port: 443,
                useTLS: true,
                lastConnectedAtMs: nil)])
        #expect(GatewaySettingsStore.saveGatewayCredentials(
            token: "kept-token",
            bootstrapToken: nil,
            password: nil,
            gatewayStableID: activeID,
            suppressStoredDeviceAuth: false,
            instanceId: instanceID))
        // Onboarding pairing leaves Settings' manual host empty and the fields unbound.
        let defaultTarget = SettingsProTab.defaultCredentialTargetStableID(manualStableID: nil, registry: registry)
        var fields = GatewayConnectionController.ManualAuthOverride.Fields()
        fields.edit(\.password, to: "rotated-password", instanceId: instanceID, defaultTarget: defaultTarget)

        let saved = GatewaySettingsStore.loadGatewayCredentials(instanceId: instanceID, gatewayStableID: activeID)
        #expect(saved.password == "rotated-password")
        #expect(saved.token == "kept-token")
    }

    private static func source(_ path: String) throws -> String {
        try String(contentsOf: self.iOSRoot.appendingPathComponent(path), encoding: .utf8)
    }

    private static var iOSRoot: URL {
        URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()
            .deletingLastPathComponent()
    }

    private static func extract(_ source: String, from start: String, to end: String) throws -> String {
        let startRange = try #require(source.range(of: start))
        let tail = source[startRange.lowerBound...]
        let endRange = try #require(tail.range(of: end))
        return String(tail[..<endRange.lowerBound])
    }
}
