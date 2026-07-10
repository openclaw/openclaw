import Foundation
import Testing
@testable import OpenClawMacCLI

@Suite(.serialized)
struct ConfigureRemoteCommandTests {
    @Test @MainActor func `configure remote writes ssh config and app defaults`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let defaultSuites = [
            "ConfigureRemoteCommandTests.release.\(UUID().uuidString)",
            "ConfigureRemoteCommandTests.debug.\(UUID().uuidString)",
        ]
        let defaultsBySuite = defaultSuites.compactMap { suite in
            UserDefaults(suiteName: suite).map { (suite, $0) }
        }
        defer {
            for (suite, _) in defaultsBySuite {
                UserDefaults.standard.removePersistentDomain(forName: suite)
            }
        }

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(
                .init(
                    sshTarget: "alice@gateway.example",
                    localPort: 19089,
                    remotePort: 18789,
                    sshHostKeyPolicy: "openssh",
                    token: "test-token", // pragma: allowlist secret
                    password: nil,
                    identity: nil,
                    projectRoot: nil,
                    cliPath: "/opt/homebrew/bin/openclaw"),
                defaultsSuites: defaultSuites)

            #expect(output.status == "ok")
            #expect(output.localUrl == "ws://127.0.0.1:19089")
            #expect(output.remotePort == 18789)
            #expect(output.sshHostKeyPolicy == "openssh")

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(gateway["mode"] as? String == "remote")
            #expect(gateway["port"] as? Int == 19089)
            #expect(remote["transport"] as? String == "ssh")
            #expect(remote["url"] as? String == "ws://127.0.0.1:19089")
            #expect(remote["remotePort"] as? Int == 18789)
            #expect(remote["sshTarget"] as? String == "alice@gateway.example")
            #expect(remote["sshHostKeyPolicy"] as? String == "openssh")
            #expect(remote["token"] as? String == "test-token") // pragma: allowlist secret

            for (_, defaults) in defaultsBySuite {
                #expect(defaults.string(forKey: "openclaw.connectionMode") == "remote")
                #expect(defaults.string(forKey: "openclaw.remoteTarget") == "alice@gateway.example")
                #expect(defaults.bool(forKey: "openclaw.onboardingSeen") == true)
                #expect(defaults.string(forKey: "openclaw.remoteCliPath") == "/opt/homebrew/bin/openclaw")
            }
        }
    }

    @Test @MainActor func `configure remote preserves existing optional credentials when flags omitted`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-preserve-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let initial: [String: Any] = [
            "gateway": [
                "remote": [
                    "token": "keep-token", // pragma: allowlist secret
                    "sshIdentity": "/tmp/id",
                    "sshHostKeyPolicy": "openssh",
                    "sshTarget": "alice@gateway.example",
                ],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try FileManager().createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            try configureRemote(.init(sshTarget: "alice@gateway.example"), defaultsSuites: [])

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(remote["token"] as? String == "keep-token") // pragma: allowlist secret
            #expect(remote["sshIdentity"] as? String == "/tmp/id")
            #expect(remote["sshHostKeyPolicy"] as? String == "openssh")
        }
    }

    @Test @MainActor func `configure remote defaults SSH host key policy to strict`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-strict-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let initial: [String: Any] = [
            "gateway": [
                "remote": [
                    "sshHostKeyPolicy": "openssh",
                    "sshTarget": "old-gateway-alias",
                ],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(.init(sshTarget: "gateway-alias"), defaultsSuites: [])

            #expect(output.sshHostKeyPolicy == "strict")
            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(remote["sshHostKeyPolicy"] as? String == "strict")
        }
    }

    @Test func `configure remote rejects invalid explicit ports`() throws {
        #expect(throws: Error.self) {
            _ = try ConfigureRemoteOptions.parse(["--ssh-target", "alice@gateway.example", "--remote-port", "99999"])
        }
        #expect(throws: Error.self) {
            _ = try ConfigureRemoteOptions.parse(["--ssh-target", "alice@gateway.example", "--local-port", "nope"])
        }
    }

    @Test func `configure remote validates SSH host key policy`() throws {
        #expect(ConfigureRemoteOptions().sshHostKeyPolicy == nil)
        #expect(try ConfigureRemoteOptions.parse([
            "--ssh-target", "gateway-alias",
            "--ssh-host-key-policy", "openssh",
        ]).sshHostKeyPolicy == "openssh")
        #expect(throws: Error.self) {
            _ = try ConfigureRemoteOptions.parse([
                "--ssh-target", "gateway-alias",
                "--ssh-host-key-policy", "accept-new",
            ])
        }
    }

    @Test func `configure remote rejects ssh targets without a host`() throws {
        #expect(throws: Error.self) {
            try configureRemote(.init(sshTarget: "user@"))
        }
        #expect(throws: Error.self) {
            try configureRemote(.init(sshTarget: "alice@:2222"))
        }
    }

    @Test @MainActor func `configure remote can write direct private url`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-direct-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let initial: [String: Any] = [
            "gateway": [
                "port": 19089,
                "remote": ["sshHostKeyPolicy": "openssh"],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try FileManager().createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(
                .init(
                    directUrl: "ws://192.168.0.202:18789",
                    token: "test-token"), // pragma: allowlist secret
                defaultsSuites: [])

            #expect(output.transport == "direct")
            #expect(output.remoteUrl == "ws://192.168.0.202:18789")
            #expect(output.localUrl == nil)
            #expect(output.sshTarget == nil)
            #expect(output.sshHostKeyPolicy == nil)

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(gateway["mode"] as? String == "remote")
            #expect(gateway["port"] as? Int == 19089)
            #expect(remote["transport"] as? String == "direct")
            #expect(remote["url"] as? String == "ws://192.168.0.202:18789")
            #expect(remote["remotePort"] == nil)
            #expect(remote["sshTarget"] == nil)
            #expect(remote["sshHostKeyPolicy"] == nil)
            #expect(remote["token"] as? String == "test-token") // pragma: allowlist secret
        }
    }

    @Test @MainActor func `configure remote rejects plaintext public prefix bypass`() async {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-direct-reject-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        _ = await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            #expect(throws: Error.self) {
                try configureRemote(.init(directUrl: "ws://fd-example.com:18789"))
            }
            #expect(throws: Error.self) {
                try configureRemote(.init(directUrl: "ws://192.168.0.202.attacker.example:18789"))
            }
        }
    }
}
