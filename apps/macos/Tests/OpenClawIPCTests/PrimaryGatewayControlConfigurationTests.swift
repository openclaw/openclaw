import Foundation
import Testing
@testable import OpenClaw

struct PrimaryGatewayControlConfigurationTests {
    private let previous: [String: Any] = [
        "agents": ["defaults": ["workspace": "/example/workspace"]],
        "gateway": [
            "mode": "remote",
            "port": 19000,
            "auth": ["token": "local-credential"],
            "remote": [
                "transport": "ssh",
                "url": "ws://127.0.0.1:19000",
                "remotePort": 19100,
                "sshTarget": "operator@old.example",
                "sshIdentity": "/example/old-key",
                "sshHostKeyPolicy": "openssh",
                "token": "old-token",
                "password": "old-password",
                "tlsFingerprint": "old-pin",
            ],
        ],
    ]

    @Test
    func `direct replacement owns authentication and retains local gateway settings`() throws {
        let selection = try PrimaryGatewayControlConfiguration.direct(
            url: #require(URL(string: "wss://new.example/operator/")),
            token: nil,
            password: "replacement-password",
            tlsFingerprint: "replacement-pin")
        let replacement = try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        #expect(replacement.clearsTargetDefaults)
        #expect(!replacement.removesGatewayMode)
        #expect(GatewayRemoteConfig.resolvePasswordString(root: replacement.root) == "replacement-password")
        #expect(GatewayRemoteConfig.resolveTokenString(root: replacement.root) == nil)
        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: replacement.root) == "replacement-pin")
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(remote["sshTarget"] == nil)
        #expect(remote["sshIdentity"] == nil)
        #expect(remote["remotePort"] == nil)
        #expect(gateway["port"] as? Int == 19000)
        #expect((gateway["auth"] as? [String: String])?["token"] == "local-credential")
        #expect(replacement.root["agents"] as? [String: [String: String]] ==
            self.previous["agents"] as? [String: [String: String]])
    }

    @Test(arguments: [false, true])
    func `ssh replacement resets host scoped options only when the target changes`(changesTarget: Bool) throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: changesTarget ? "operator@new.example" : "operator@old.example",
            remotePort: nil,
            localPort: nil,
            identity: nil,
            hostKeyPolicy: nil,
            token: "new-token",
            password: nil)
        let replacement = try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(replacement.clearsTargetDefaults == changesTarget)
        #expect(!replacement.removesGatewayMode)
        #expect(remote["sshIdentity"] as? String == (changesTarget ? nil : "/example/old-key"))
        #expect(remote["sshHostKeyPolicy"] as? String == (changesTarget ? "strict" : "openssh"))
        #expect(GatewayRemoteConfig.resolveRemotePort(root: replacement.root) == (changesTarget ? 18789 : 19100))
        #expect(GatewayRemoteConfig.resolveTokenString(root: replacement.root) == "new-token")
        #expect(GatewayRemoteConfig.resolvePasswordString(root: replacement.root) == nil)
        #expect(GatewayRemoteConfig.resolveTLSFingerprint(root: replacement.root) == nil)
    }

    @Test
    func `explicit SSH options replace the previous route as one selection`() throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example:2222",
            remotePort: 22000,
            localPort: 23000,
            identity: "/example/new-key",
            hostKeyPolicy: .openssh,
            token: nil,
            password: "new-password")
        let replacement = try selection.replacingRoot(self.previous, effectiveLocalPort: 23000)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(gateway["port"] as? Int == 19000)
        #expect(remote["url"] as? String == "ws://127.0.0.1:23000")
        #expect(remote["remotePort"] as? Int == 22000)
        #expect(remote["sshIdentity"] as? String == "/example/new-key")
        #expect(remote["sshHostKeyPolicy"] as? String == "openssh")
        #expect(remote["password"] as? String == "new-password")
    }

    @Test
    func `fresh SSH selection uses the prepared tunnel port`() throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example", remotePort: nil, localPort: nil,
            identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
        let replacement = try selection.replacingRoot([:], effectiveLocalPort: 19789)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(remote["url"] as? String == "ws://127.0.0.1:19789")
        #expect(remote["remotePort"] as? Int == 18789)
        #expect(gateway["port"] == nil)
    }

    @Test
    func `SSH URL uses the requested tunnel port without adding a local gateway port`() throws {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example", remotePort: nil, localPort: 23000,
            identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
        let replacement = try selection.replacingRoot([:], effectiveLocalPort: 18789)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        let remote = try #require(gateway["remote"] as? [String: Any])
        #expect(remote["url"] as? String == "ws://127.0.0.1:23000")
        #expect(gateway["port"] == nil)
    }

    @Test(arguments: [false, true])
    func `hosting repair separates the bind port and preserves the remote route`(hasRemotePort: Bool) throws {
        var root = self.previous
        var gateway = try #require(root["gateway"] as? [String: Any])
        var remote = try #require(gateway["remote"] as? [String: Any])
        if !hasRemotePort { remote.removeValue(forKey: "remotePort") }
        gateway["remote"] = remote
        root["gateway"] = gateway
        let repaired = try PrimaryGatewayControlConfiguration.separatingLocalGatewayPort(root, environment: [:])
        let updated = try #require(repaired.root["gateway"] as? [String: Any])
        #expect(updated["port"] as? Int == 18789)
        #expect(updated["auth"] as? [String: String] == gateway["auth"] as? [String: String])
        var expectedRemote = remote
        expectedRemote["remotePort"] = hasRemotePort ? 19100 : 19000
        #expect(try NSDictionary(dictionary: #require(updated["remote"] as? [String: Any])) ==
            NSDictionary(dictionary: expectedRemote))
        #expect(RemotePortTunnel.resolveRemotePortOverride(
            defaultRemotePort: 18789, for: "old.example", root: repaired.root) ==
            (hasRemotePort ? 19100 : 19000))
        #expect(try NSDictionary(dictionary: PrimaryGatewayControlConfiguration
                .separatingLocalGatewayPort(repaired.root, environment: [:])
                .root) ==
            NSDictionary(dictionary: repaired.root))

        gateway["port"] = 20000
        root["gateway"] = gateway
        gateway["remote"] = expectedRemote
        var expected = root
        expected["gateway"] = gateway
        #expect(try NSDictionary(dictionary: PrimaryGatewayControlConfiguration.separatingLocalGatewayPort(
            root,
            environment: [:])
            .root) ==
            NSDictionary(dictionary: expected))
    }

    @Test(arguments: [(18789, 18789, 18790), (19789, 18789, 18789), (29000, 29000, 29001)])
    func `hosting materializes legacy SSH ports before changing the local bind`(
        scenario: (Int, Int, Int)) throws
    {
        let (legacyPort, preferredPort, expectedLocalPort) = scenario
        let root: [String: Any] = ["gateway": [
            "mode": "remote", "port": legacyPort,
            "auth": ["token": "local-credential"],
            "remote": ["transport": "ssh", "sshTarget": "operator@gateway.example"],
        ]]
        let replacement = try PrimaryGatewayControlConfiguration.separatingLocalGatewayPort(
            root, preferredLocalPort: preferredPort, legacyPort: legacyPort, environment: [:])
        #expect(OpenClawConfigFile.gatewayPort(root: replacement.root) == expectedLocalPort)
        #expect(GatewayRemoteConfig.resolveUrlString(root: replacement.root) == "ws://127.0.0.1:\(legacyPort)")
        #expect(GatewayRemoteConfig.resolveRemotePort(root: replacement.root) == legacyPort)
        let ports = RemotePortTunnel.ports(
            root: replacement.root, sshHost: "gateway.example", legacyPort: expectedLocalPort, environment: [:])
        #expect(ports.local == legacyPort)
        #expect(ports.remote == legacyPort)
        #expect(try NSDictionary(dictionary: PrimaryGatewayControlConfiguration.separatingLocalGatewayPort(
            replacement.root, preferredLocalPort: preferredPort, legacyPort: expectedLocalPort, environment: [:])
            .root) ==
            NSDictionary(dictionary: replacement.root))
    }

    @Test(arguments: [
        ("wss://localhost", "wss://localhost", 443),
        ("wss://localhost:19443", "wss://localhost:19443", 19443),
        ("wss://old.example:19443", "wss://127.0.0.1:19443", 19443),
        ("wss://old.example:19443/socket?tenant=a", "wss://127.0.0.1:19443/socket?tenant=a", 19443),
    ])
    func `hosting repair preserves secure SSH endpoints`(scenario: (String, String, Int)) throws {
        let (url, expectedURL, tunnelPort) = scenario
        var root = self.previous
        var gateway = try #require(root["gateway"] as? [String: Any])
        var remote = try #require(gateway["remote"] as? [String: Any])
        remote["url"] = url
        gateway["remote"] = remote
        gateway["port"] = tunnelPort
        root["gateway"] = gateway
        let repaired = try PrimaryGatewayControlConfiguration.separatingLocalGatewayPort(root, environment: [:])
        #expect(GatewayRemoteConfig.resolveUrlString(root: repaired.root) == expectedURL)
        #expect(RemotePortTunnel.localPort(root: repaired.root) == tunnelPort)
        #expect(GatewayRemoteConfig.resolveRemotePort(root: repaired.root) == 19100)
    }

    @Test
    func `clearing removes the remote URL and permits a subsequent direct selection`() throws {
        let replacement = try PrimaryGatewayControlConfiguration.clear.replacingRoot(
            self.previous, effectiveLocalPort: 19000)
        let gateway = try #require(replacement.root["gateway"] as? [String: Any])
        #expect(gateway["mode"] == nil)
        #expect(replacement.removesGatewayMode)
        #expect(GatewayRemoteConfig.resolveUrlString(root: replacement.root) == nil)
        #expect(gateway["remote"] == nil)
        #expect(gateway["auth"] as? [String: String] == ["token": "local-credential"])
        #expect(replacement.clearsTargetDefaults)

        let clearedAgain = try PrimaryGatewayControlConfiguration.clear.replacingRoot(
            replacement.root, effectiveLocalPort: 19000)
        #expect(!clearedAgain.removesGatewayMode)

        let local = try PrimaryGatewayControlConfiguration.local.replacingRoot(
            self.previous, effectiveLocalPort: 19000)
        #expect(!local.removesGatewayMode)

        let direct = try PrimaryGatewayControlConfiguration.direct(
            url: #require(URL(string: "wss://new.example/")), token: nil, password: nil, tlsFingerprint: nil)
            .replacingRoot(replacement.root, effectiveLocalPort: 19000)
        #expect((direct.root["gateway"] as? [String: Any])?["mode"] as? String == "remote")
        #expect(GatewayRemoteConfig.resolveUrlString(root: direct.root) == "wss://new.example/")
    }

    @Test(arguments: ["ws://public.example", "wss://user:secret@public.example", "wss://public.example?token=secret"])
    func `invalid direct selections fail before persistence`(address: String) throws {
        let selection = try PrimaryGatewayControlConfiguration.direct(
            url: #require(URL(string: address)), token: nil, password: nil, tlsFingerprint: nil)
        #expect(throws: PrimaryGatewayControlError.self) {
            try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        }
    }

    @Test(arguments: [0, 65536])
    func `invalid SSH ports fail before persistence`(port: Int) {
        let selection = PrimaryGatewayControlConfiguration.ssh(
            target: "operator@new.example", remotePort: port, localPort: nil,
            identity: nil, hostKeyPolicy: nil, token: nil, password: nil)
        #expect(throws: PrimaryGatewayControlError.self) {
            try selection.replacingRoot(self.previous, effectiveLocalPort: 19000)
        }
    }
}
