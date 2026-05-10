import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct OpenClawConfigFileTests {
    private func makeConfigOverridePath() -> String {
        FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-config-\(UUID().uuidString)")
            .appendingPathComponent("openclaw.json")
            .path
    }

    private func configSidecarURLs(in stateDir: URL) -> (audit: URL, health: URL) {
        let logsDir = stateDir.appendingPathComponent("logs", isDirectory: true)
        return (
            logsDir.appendingPathComponent("config-audit.jsonl"),
            logsDir.appendingPathComponent("config-health.json")
        )
    }

    private func configRecoveryFile(
        in directory: URL,
        configName: String,
        marker: String) throws -> URL?
    {
        try FileManager().contentsOfDirectory(at: directory, includingPropertiesForKeys: nil)
            .first { $0.lastPathComponent.hasPrefix("\(configName).\(marker).") }
    }

    @Test
    func `config path respects env override`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            #expect(OpenClawConfigFile.url().path == override)
        }
    }

    @MainActor
    @Test
    func `remote gateway port parses and matches host`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "ws://gateway.ts.net:19999",
                    ],
                ],
            ])
            #expect(OpenClawConfigFile.remoteGatewayPort() == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway.ts.net") == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "GATEWAY.ts.net.") == 19999)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway") == nil)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "other.ts.net") == nil)
            #expect(OpenClawConfigFile.remoteGatewayPort(matchingHost: "gateway.attacker.tld") == nil)
        }
    }

    @MainActor
    @Test
    func `set remote gateway url string replaces scheme`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            OpenClawConfigFile.setRemoteGatewayUrlString("ws://127.0.0.1:18789")
            let root = OpenClawConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "ws://127.0.0.1:18789")
        }
    }

    @MainActor
    @Test
    func `set remote gateway url preserves scheme`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                    ],
                ],
            ])
            OpenClawConfigFile.setRemoteGatewayUrl(host: "new-host", port: 2222)
            let root = OpenClawConfigFile.loadDict()
            let url = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any])?["url"] as? String
            #expect(url == "wss://new-host:2222")
        }
    }

    @MainActor
    @Test
    func `clear remote gateway url removes only url field`() async {
        let override = self.makeConfigOverridePath()

        await TestIsolation.withEnvValues(["OPENCLAW_CONFIG_PATH": override]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "remote": [
                        "url": "wss://old-host:111",
                        "token": "tok",
                    ],
                ],
            ])
            OpenClawConfigFile.clearRemoteGatewayUrl()
            let root = OpenClawConfigFile.loadDict()
            let remote = ((root["gateway"] as? [String: Any])?["remote"] as? [String: Any]) ?? [:]
            #expect((remote["url"] as? String) == nil)
            #expect((remote["token"] as? String) == "tok")
        }
    }

    @Test
    func `state dir override sets config path`() async {
        let dir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
            .path

        await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": nil,
            "OPENCLAW_STATE_DIR": dir,
        ]) {
            #expect(OpenClawConfigFile.stateDirURL().path == dir)
            #expect(OpenClawConfigFile.url().path == "\(dir)/openclaw.json")
        }
    }

    @MainActor
    @Test
    func `save dict does not write config state sidecars`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let sidecars = self.configSidecarURLs(in: stateDir)

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": ["mode": "local"],
            ])

            let configData = try Data(contentsOf: configPath)
            let configRoot = try JSONSerialization.jsonObject(with: configData) as? [String: Any]
            #expect((configRoot?["meta"] as? [String: Any]) != nil)
            #expect(!FileManager().fileExists(atPath: sidecars.audit.path))
            #expect(!FileManager().fileExists(atPath: sidecars.health.path))
        }
    }

    @MainActor
    @Test
    func `save dict preserves gateway auth unless explicitly allowed`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "auth": [
                        "mode": "token",
                        "token": "existing-token", // pragma: allowlist secret
                    ],
                ],
            ])

            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                ],
            ])

            let root = OpenClawConfigFile.loadDict()
            let gateway = root["gateway"] as? [String: Any]
            let auth = gateway?["auth"] as? [String: Any]
            #expect(gateway?["mode"] as? String == "local")
            #expect(auth?["mode"] as? String == "token")
            #expect(auth?["token"] as? String == "existing-token") // pragma: allowlist secret

            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                ],
            ], allowGatewayAuthMutation: true)

            let allowedRoot = OpenClawConfigFile.loadDict()
            let allowedGateway = allowedRoot["gateway"] as? [String: Any]
            #expect(allowedGateway?["mode"] as? String == "local")
            #expect((allowedGateway?["auth"] as? [String: Any]) == nil)
        }
    }

    @MainActor
    @Test
    func `save dict can merge local fallback writes with fresh config`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")

        defer { try? FileManager().removeItem(at: stateDir) }

        await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "remote",
                    "auth": [
                        "mode": "password",
                        "password": "existing-password", // pragma: allowlist secret
                    ],
                ],
                "browser": [
                    "enabled": true,
                    "profile": "work",
                ],
                "channels": [
                    "discord": [
                        "enabled": true,
                    ],
                ],
            ])

            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                ],
                "browser": [
                    "enabled": false,
                ],
            ], preserveExistingKeys: true)

            let root = OpenClawConfigFile.loadDict()
            let gateway = root["gateway"] as? [String: Any]
            let auth = gateway?["auth"] as? [String: Any]
            let browser = root["browser"] as? [String: Any]
            let discord = ((root["channels"] as? [String: Any])?["discord"] as? [String: Any])
            #expect(gateway?["mode"] as? String == "local")
            #expect(auth?["mode"] as? String == "password")
            #expect(auth?["password"] as? String == "existing-password") // pragma: allowlist secret
            #expect(browser?["enabled"] as? Bool == false)
            #expect(browser?["profile"] as? String == "work")
            #expect(discord?["enabled"] as? Bool == true)
        }
    }

    @MainActor
    @Test
    func `load dict preserves suspicious out-of-band clobbers without state sidecars`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let sidecars = self.configSidecarURLs(in: stateDir)

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            try OpenClawConfigFile.withTestingFileLock {
                OpenClawConfigFile.saveDict([
                    "update": ["channel": "beta"],
                    "browser": ["enabled": true],
                    "gateway": ["mode": "local"],
                    "channels": [
                        "discord": [
                            "enabled": true,
                            "dmPolicy": "pairing",
                        ],
                    ],
                ])
                _ = OpenClawConfigFile.loadDict()

                let clobbered = """
                {
                  "update": {
                    "channel": "beta"
                  }
                }
                """
                try clobbered.write(to: configPath, atomically: true, encoding: .utf8)

                let loaded = OpenClawConfigFile.loadDict()
                #expect((loaded["gateway"] as? [String: Any]) == nil)

                #expect(!FileManager().fileExists(atPath: sidecars.audit.path))
                #expect(!FileManager().fileExists(atPath: sidecars.health.path))

                let clobberedURL = try self.configRecoveryFile(
                    in: configPath.deletingLastPathComponent(),
                    configName: configPath.lastPathComponent,
                    marker: "clobbered")
                #expect(clobberedURL != nil)
                if let clobberedURL {
                    let preserved = try String(contentsOf: clobberedURL, encoding: .utf8)
                    #expect(preserved == clobbered)
                }
            }
        }
    }

    @MainActor
    @Test
    func `save dict preserves gateway auth without audit sidecar`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let sidecars = self.configSidecarURLs(in: stateDir)

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                    "auth": [
                        "mode": "token",
                        "token": "test-token", // pragma: allowlist secret
                    ],
                ],
            ])

            let saved = OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                ],
                "browser": [
                    "enabled": false,
                ],
            ])

            #expect(saved)
            let data = try Data(contentsOf: configPath)
            let root = try JSONSerialization.jsonObject(with: data) as? [String: Any]
            let gateway = root?["gateway"] as? [String: Any]
            let auth = gateway?["auth"] as? [String: Any]
            #expect(gateway?["mode"] as? String == "local")
            #expect(auth?["mode"] as? String == "token")
            #expect(auth?["token"] as? String == "test-token") // pragma: allowlist secret
            #expect((root?["meta"] as? [String: Any]) != nil)
            #expect(!FileManager().fileExists(atPath: sidecars.audit.path))
            #expect(!FileManager().fileExists(atPath: sidecars.health.path))
        }
    }

    @MainActor
    @Test
    func `save dict rejects gateway mode removal and keeps previous config`() async throws {
        let stateDir = FileManager().temporaryDirectory
            .appendingPathComponent("openclaw-state-\(UUID().uuidString)", isDirectory: true)
        let configPath = stateDir.appendingPathComponent("openclaw.json")
        let sidecars = self.configSidecarURLs(in: stateDir)

        defer { try? FileManager().removeItem(at: stateDir) }

        try await TestIsolation.withEnvValues([
            "OPENCLAW_STATE_DIR": stateDir.path,
            "OPENCLAW_CONFIG_PATH": configPath.path,
        ]) {
            OpenClawConfigFile.saveDict([
                "gateway": [
                    "mode": "local",
                    "auth": [
                        "mode": "token",
                        "token": "test-token", // pragma: allowlist secret
                    ],
                ],
                "browser": [
                    "enabled": true,
                ],
            ])
            let before = try String(contentsOf: configPath, encoding: .utf8)

            let saved = OpenClawConfigFile.saveDict([
                "browser": [
                    "enabled": false,
                ],
            ])

            #expect(!saved)
            let after = try String(contentsOf: configPath, encoding: .utf8)
            #expect(after == before)

            #expect(!FileManager().fileExists(atPath: sidecars.audit.path))
            #expect(!FileManager().fileExists(atPath: sidecars.health.path))

            let rejectedURL = try self.configRecoveryFile(
                in: configPath.deletingLastPathComponent(),
                configName: configPath.lastPathComponent,
                marker: "rejected")
            if let rejectedURL {
                #expect(FileManager().fileExists(atPath: rejectedURL.path))
                let attributes = try FileManager().attributesOfItem(atPath: rejectedURL.path)
                let mode = attributes[.posixPermissions] as? NSNumber
                #expect(mode?.intValue == 0o600)
            } else {
                Issue.record("Missing rejected payload path")
            }
        }
    }
}
