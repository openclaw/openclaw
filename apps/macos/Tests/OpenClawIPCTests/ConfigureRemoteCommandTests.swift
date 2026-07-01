import Foundation
import Testing
@testable import OpenClawMacCLI

@Suite(.serialized)
struct ConfigureRemoteCommandTests {
    @Test @MainActor func `configure remote writes ssh config and app defaults`() async throws {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-configure-remote-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        let defaultSuites = ["ai.openclaw.mac", "ai.openclaw.mac.debug"]
        let keys = [
            "openclaw.connectionMode",
            "openclaw.remoteTarget",
            "openclaw.onboardingSeen",
            "openclaw.onboardingVersion",
            "openclaw.remoteCliPath",
        ]
        let defaultsBySuite = defaultSuites.compactMap { suite in
            UserDefaults(suiteName: suite).map { (suite, $0) }
        }
        let previousDefaults = Dictionary(uniqueKeysWithValues: defaultsBySuite.map { suite, defaults in
            (suite, Dictionary(uniqueKeysWithValues: keys.map { ($0, defaults.object(forKey: $0)) }))
        })
        defer {
            for (suite, defaults) in defaultsBySuite {
                for (key, value) in previousDefaults[suite] ?? [:] {
                    if let value {
                        defaults.set(value, forKey: key)
                    } else {
                        defaults.removeObject(forKey: key)
                    }
                }
            }
        }

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(.init(
                sshTarget: "alice@gateway.example",
                localPort: 19089,
                remotePort: 18789,
                token: "test-token", // pragma: allowlist secret
                password: nil,
                identity: nil,
                projectRoot: nil,
                cliPath: "/opt/homebrew/bin/openclaw"))

            #expect(output.status == "ok")
            #expect(output.localUrl == "ws://127.0.0.1:19089")
            #expect(output.remotePort == 18789)

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
                ],
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try FileManager().createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try initialData.write(to: configURL)

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            try configureRemote(.init(sshTarget: "alice@gateway.example"))

            let data = try Data(contentsOf: configURL)
            let root = try #require(JSONSerialization.jsonObject(with: data) as? [String: Any])
            let gateway = try #require(root["gateway"] as? [String: Any])
            let remote = try #require(gateway["remote"] as? [String: Any])
            #expect(remote["token"] as? String == "keep-token") // pragma: allowlist secret
            #expect(remote["sshIdentity"] as? String == "/tmp/id")
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
            ],
        ]
        let initialData = try JSONSerialization.data(withJSONObject: initial, options: [.prettyPrinted])
        try FileManager().createDirectory(at: configURL.deletingLastPathComponent(), withIntermediateDirectories: true)
        try initialData.write(to: configURL)

        let defaultSuites = ["ai.openclaw.mac", "ai.openclaw.mac.debug"]
        let keys = [
            "openclaw.connectionMode",
            "openclaw.remoteTarget",
            "openclaw.onboardingSeen",
            "openclaw.onboardingVersion",
            "openclaw.remoteCliPath",
        ]
        let defaultsBySuite = defaultSuites.compactMap { suite in
            UserDefaults(suiteName: suite).map { (suite, $0) }
        }
        let previousDefaults = Dictionary(uniqueKeysWithValues: defaultsBySuite.map { suite, defaults in
            (suite, Dictionary(uniqueKeysWithValues: keys.map { ($0, defaults.object(forKey: $0)) }))
        })
        defer {
            for (suite, defaults) in defaultsBySuite {
                for (key, value) in previousDefaults[suite] ?? [:] {
                    if let value {
                        defaults.set(value, forKey: key)
                    } else {
                        defaults.removeObject(forKey: key)
                    }
                }
            }
        }

        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configURL.path]) {
            let output = try configureRemote(.init(
                directUrl: "ws://192.168.0.202:18789",
                token: "test-token")) // pragma: allowlist secret

            #expect(output.transport == "direct")
            #expect(output.remoteUrl == "ws://192.168.0.202:18789")
            #expect(output.localUrl == nil)
            #expect(output.sshTarget == nil)

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

    @Test func `resolveOpenClawConfigURL prefers explicit config path`() async {
        let configURL = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-test-\(UUID().uuidString).json")
        defer { try? FileManager().removeItem(at: configURL) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": configURL.path,
            "OPENCLAW_STATE_DIR": nil,
        ]) {
            let resolved = resolveOpenClawConfigURL()
            #expect(resolved.path == configURL.path)
        }
    }

    @Test func `resolveOpenClawConfigURL falls back to state dir`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)")
        try FileManager().createDirectory(at: stateDir, withIntermediateDirectories: true)
        let expectedConfig = stateDir.appendingPathComponent("openclaw.json")
        try "{}".write(to: expectedConfig, atomically: true, encoding: .utf8)
        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": stateDir.path,
        ]) {
            let resolved = resolveOpenClawConfigURL()
            #expect(resolved.path == expectedConfig.path)
        }
    }

    @Test func `resolveOpenClawConfigURL uses default home when no overrides`() async {
        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": nil,
        ]) {
            let resolved = resolveOpenClawConfigURL()
            let expected = FileManager().homeDirectoryForCurrentUser
                .appendingPathComponent(".openclaw/openclaw.json")
            #expect(resolved.path == expected.path)
        }
    }
}
