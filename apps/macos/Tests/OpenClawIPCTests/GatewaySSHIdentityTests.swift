import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
@MainActor
struct GatewaySSHIdentityTests {
    @Test
    func `legacy destination ports isolate identities and survive hosting repair`() async throws {
        try #require(!AppProfile.current.isActive)
        let configPath = TestIsolation.tempConfigPath()
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": nil,
        ]) {
            let target = "operator@gateway.example"
            var authOwners: Set<String> = []
            var cacheOwners: Set<String> = []
            for port in [19789, 19889] {
                let root: [String: Any] = ["gateway": [
                    "mode": "remote", "port": port,
                    "remote": ["transport": "ssh", "sshTarget": target, "sshIdentity": ""],
                ]]
                let expected = OnboardingSystemAgentResumeStore.routeIdentity(
                    connectionMode: .remote, preferredGatewayID: nil, remoteTransport: .ssh,
                    remoteURL: "", remoteTarget: target, sshRemotePort: port)
                let authOwner = try #require(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root))
                let cacheOwner = try #require(MacChatTranscriptCache.gatewayID(root: root))
                #expect(authOwner == expected)
                #expect(cacheOwner == "ssh:\(target):\(port)")
                authOwners.insert(authOwner)
                cacheOwners.insert(cacheOwner)
                let repaired = try PrimaryGatewayControlConfiguration.separatingLocalGatewayPort(
                    root, legacyPort: port, environment: [:])
                #expect(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: repaired.root) == authOwner)
                #expect(MacChatTranscriptCache.gatewayID(root: repaired.root) == cacheOwner)
                let selection = PrimaryGatewayControlConfiguration.ssh(
                    target: target, remotePort: nil, localPort: 23000,
                    identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
                let updated = try selection.replacingRoot(root, effectiveLocalPort: port)
                #expect(RemotePortTunnel.ports(root: updated.root, sshHost: "gateway.example").remote == port)
                #expect(GatewayDiscoveryPreferences.deviceAuthGatewayID(root: updated.root) == authOwner)
            }
            #expect(authOwners.count == 2)
            #expect(cacheOwners.count == 2)
        }
    }

    @Test
    func `onboarding resolves the configured legacy SSH destination`() async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager().removeItem(atPath: configPath) }
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": nil,
        ]) {
            var owners: Set<String> = []
            for port in [19789, 19889] {
                let root: [String: Any] = ["gateway": [
                    "mode": "remote", "port": port,
                    "remote": ["transport": "ssh", "sshTarget": "operator@gateway.example", "sshIdentity": ""],
                ]]
                try #require(OpenClawConfigFile.saveDict(root, preserveExistingKeys: true))
                let state = AppState(preview: true)
                let destination = try RemotePortTunnel.configuration().remotePort
                let owner = try #require(OnboardingSystemAgentResumeStore.selectedRouteIdentity(
                    state: state, preferredGatewayID: nil))
                #expect(destination == port)
                #expect(owner == GatewayDiscoveryPreferences.deviceAuthGatewayID(root: root))
                owners.insert(owner)
            }
            #expect(owners.count == 2)
        }
    }
}
