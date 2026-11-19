import Foundation
import Testing
@testable import OpenClaw

@Suite(.serialized)
struct AppHostedGatewayAuthTests {
    @Test func `only missing token auth is initialized`() {
        let persist: [[String: Any]] = [
            [:],
            ["gateway": ["mode": "local"]],
            ["gateway": ["auth": ["mode": "token"]]],
            ["gateway": ["auth": ["token": " \n"]]],
            ["env": ["vars": ["OTHER": "x"]]],
            ["env": ["vars": ["OPENCLAW_GATEWAY_TOKEN": " "]]],
        ]
        for root in persist {
            #expect(AppHostedGatewayAuth.decision(root: root, environment: [:]) == .persist)
        }
        let keep: [[String: Any]] = [
            ["$include": "./base.json"],
            ["gateway": ["$include": "./gateway.json"]],
            ["gateway": ["mode": "local", "auth": ["$include": "./auth.json"]]],
            ["env": ["vars": ["OPENCLAW_GATEWAY_PASSWORD": "test-password"]]],
            ["env": ["OPENCLAW_GATEWAY_TOKEN": "test-token"]],
            ["env": ["vars": ["openclaw_gateway_token": "test-token"]]],
            ["env": "invalid"],
            ["env": ["vars": ["OPENCLAW_GATEWAY_TOKEN": ""], "OPENCLAW_GATEWAY_TOKEN": "test-token"]],
            ["env": ["vars": ["$include": "./gateway-env.json"]]],
            ["env": ["$include": "./env.json"]],
            ["env": ["vars": "invalid"]],
            ["env": ["shellEnv": ["enabled": true]]],
            ["env": ["shellEnv": ["$include": "./shell.json"]]],
            ["env": ["shellEnv": "invalid"]],
            ["env": ["vars": ["OPENCLAW_LOAD_SHELL_ENV": "yes"]]],
            ["env": ["OPENCLAW_LOAD_SHELL_ENV": "ON"]],
            ["env": ["vars": ["OPENCLAW_HOME": "/another-home"]]],
            ["gateway": ["remote": ["token": "test-remote-token"]]],
            ["gateway": ["remote": ["password": ["source": "env", "provider": "default", "id": "PASSWORD"]]]],
            ["gateway": ["remote": ["$include": "./remote.json"]]],
            ["gateway": ["remote": "invalid"]],
            ["gateway": ["auth": ["token": "test-configured-token"]]],
            ["gateway": ["auth": ["token": "${OPENCLAW_GATEWAY_TOKEN}"]]],
            ["gateway": ["auth": ["token": "$OTHER_TOKEN"]]],
            ["gateway": ["auth": ["token": ["source": "env", "provider": "default", "id": "TOKEN"]]]],
            ["gateway": ["auth": ["password": "test-password"]]],
            ["gateway": ["auth": ["password": ""]]],
            ["gateway": ["auth": ["password": ["source": "env", "provider": "default", "id": "PASSWORD"]]]],
            ["gateway": ["auth": ["mode": "password"]]],
            ["gateway": ["auth": ["mode": "none"]]],
            ["gateway": ["auth": ["mode": "trusted-proxy"]]],
            ["gateway": ["auth": "invalid"]],
            ["gateway": "invalid"],
        ]
        for root in keep {
            #expect(AppHostedGatewayAuth.decision(root: root, environment: [:]) == .keep)
        }
        #expect(AppHostedGatewayAuth.decision(root: nil, environment: [:]) == .keep)
        for name in ["OPENCLAW_GATEWAY_TOKEN", "OPENCLAW_GATEWAY_PASSWORD"] {
            #expect(AppHostedGatewayAuth.decision(root: [:], environment: [name: "test-env"]) == .keep)
            #expect(AppHostedGatewayAuth.decision(root: [:], environment: [name: " \n"]) == .persist)
        }
        for value in ["true", "1", " YES ", "On"] {
            #expect(AppHostedGatewayAuth.decision(root: [:], environment: ["OPENCLAW_LOAD_SHELL_ENV": value]) == .keep)
        }
        for value in ["false", "0", "no", "off", ""] {
            #expect(AppHostedGatewayAuth
                .decision(root: [:], environment: ["OPENCLAW_LOAD_SHELL_ENV": value]) == .persist)
        }
        let preserved: [AppHostedGatewayAuth.DotEnvFile] = [
            .unreadable,
            .contents("OPENCLAW_GATEWAY_TOKEN=test-token"),
            .contents("  export OPENCLAW_GATEWAY_PASSWORD = ''"),
            .contents("export\topenclaw_gateway_token=\"quoted\""),
            .contents("OPENCLAW_GATEWAY_TOKEN="),
            .contents("OPENCLAW_LOAD_SHELL_ENV=yes"),
            .contents("OPENCLAW_HOME=/another-home"),
        ]
        for file in preserved {
            #expect(AppHostedGatewayAuth.decision(root: [:], environment: [:], trustedDotEnvFiles: [file]) == .keep)
        }
        for file in [
            AppHostedGatewayAuth.DotEnvFile.missing,
            .contents(""),
            .contents("# OPENCLAW_GATEWAY_TOKEN=comment\nOPENAI_API_KEY=test\nOPENCLAW_GATEWAY_TOKEN_OTHER=x"),
        ] {
            #expect(AppHostedGatewayAuth.decision(root: [:], environment: [:], trustedDotEnvFiles: [file]) == .persist)
        }
    }

    @Test func `trusted dotenv paths follow child state and effective home`() throws {
        func paths(_ environment: [String: String]) throws -> [String] {
            try #require(AppHostedGatewayAuth.trustedDotEnvURLs(environment: environment)).map(\.path)
        }
        #expect(try paths(["HOME": "/test-home"]) == [
            "/test-home/.openclaw/.env", "/test-home/.config/openclaw/gateway.env",
        ])
        #expect(try paths([
            "HOME": "/test-home",
            "OPENCLAW_STATE_DIR": "/profile",
            "OPENCLAW_CONFIG_PATH": "/ignored/openclaw.json",
        ]) == ["/profile/.env"])
        #expect(try paths(["HOME": "/test-home", "OPENCLAW_CONFIG_PATH": "/config/openclaw.json"]) == [
            "/test-home/.openclaw/.env", "/config/.env", "/test-home/.config/openclaw/gateway.env",
        ])
        #expect(try paths([
            "HOME": "/test-home",
            "OPENCLAW_HOME": "~/alternate",
            "OPENCLAW_STATE_DIR": "~/.openclaw",
        ]) == [
            "/test-home/alternate/.openclaw/.env", "/test-home/alternate/.config/openclaw/gateway.env",
        ])
        #expect(AppHostedGatewayAuth.trustedDotEnvURLs(environment: [:]) == nil)
        #expect(AppHostedGatewayAuth.trustedDotEnvURLs(environment: [
            "HOME": "/test-home", "OPENCLAW_STATE_DIR": "relative",
        ]) == nil)
    }

    @MainActor
    @Test func `trusted dotenv and shell credentials preserve config at the write boundary`() async throws {
        enum Source { case state, unreadable, gateway }
        let cases: [(dotenv: String?, shell: Bool, persists: Bool, source: Source)] = [
            ("OPENCLAW_GATEWAY_TOKEN=test-existing-token", false, false, .state),
            ("OPENAI_API_KEY=test", false, true, .state),
            ("export OPENCLAW_GATEWAY_PASSWORD=x", false, false, .state),
            (nil, true, false, .state),
            (nil, false, false, .unreadable),
            ("OPENCLAW_GATEWAY_TOKEN=test-gateway-env-token", false, false, .gateway),
        ]
        for fixture in cases {
            let directory = try makeFirstRunTempDirForTests()
            defer { try? FileManager.default.removeItem(at: directory) }
            let state = fixture.source == .gateway ? directory.appendingPathComponent(".openclaw") : directory
            try FileManager.default.createDirectory(at: state, withIntermediateDirectories: true)
            let config = state.appendingPathComponent("openclaw.json")
            let original = Data((fixture.shell
                    ? #"{"gateway":{"mode":"local"},"env":{"shellEnv":{"enabled":true}}}"#
                    : #"{"gateway":{"mode":"local"}}"#).utf8)
            try original.write(to: config)
            let dotenv = fixture.source == .gateway
                ? directory.appendingPathComponent(".config/openclaw/gateway.env")
                : state.appendingPathComponent(".env")
            try FileManager.default.createDirectory(
                at: dotenv.deletingLastPathComponent(),
                withIntermediateDirectories: true)
            if let contents = fixture.dotenv { try Data(contents.utf8).write(to: dotenv) }
            if fixture.source == .unreadable { try FileManager.default.createDirectory(
                at: dotenv,
                withIntermediateDirectories: false) }
            let environment = [
                "HOME": directory.path,
                "OPENCLAW_STATE_DIR": state.path,
                "OPENCLAW_CONFIG_PATH": config.path,
            ]
            try await TestIsolation.withEnvValues([
                "OPENCLAW_STATE_DIR": state.path,
                "OPENCLAW_CONFIG_PATH": config.path,
            ]) {
                try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: environment)
                if fixture.persists {
                    #expect(GatewayEndpointStore.resolveGatewayCredential(
                        .token, isRemote: false, root: OpenClawConfigFile.loadDict(), env: [:])?.count == 48)
                } else {
                    #expect(try Data(contentsOf: config) == original)
                }
            }
        }
    }

    @MainActor
    @Test func `persisted first-run token resolves locally and preserves authored config`() async throws {
        let directory = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let config = directory.appendingPathComponent("openclaw.json")
        let environment = ["HOME": directory.path, "OPENCLAW_STATE_DIR": directory.path]
        try Data(#"{"gateway":{"mode":"local","auth":{"allowTailscale":false}},"custom":{"keep":42}}"#.utf8)
            .write(to: config)
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": config.path,
            "OPENCLAW_STATE_DIR": directory.path,
        ]) {
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: environment)
            let root = OpenClawConfigFile.loadDict()
            let gateway = try #require(root["gateway"] as? [String: Any])
            let auth = try #require(gateway["auth"] as? [String: Any])
            let token = try #require(auth["token"] as? String)
            #expect(token.count == 48)
            #expect(token.allSatisfy { "0123456789abcdef".contains($0) })
            #expect(gateway["mode"] as? String == "local")
            #expect(auth["mode"] as? String == "token")
            #expect(auth["allowTailscale"] as? Bool == false)
            #expect((root["custom"] as? [String: Any])?["keep"] as? Int == 42)
            #expect(GatewayEndpointStore.resolveGatewayCredential(
                .token, isRemote: false, root: root, env: [:]) == token)
            let saved = try Data(contentsOf: config)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: environment)
            #expect(try Data(contentsOf: config) == saved)
        }
    }

    @MainActor
    @Test func `missing config is initialized but invalid and unreadable configs are preserved`() async throws {
        let directory = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let config = directory.appendingPathComponent("openclaw.json")
        let environment = ["HOME": directory.path, "OPENCLAW_STATE_DIR": directory.path]
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": config.path,
            "OPENCLAW_STATE_DIR": directory.path,
        ]) {
            #expect(OpenClawConfigFile.loadDictIfReadable()?.isEmpty == true)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: environment)
            #expect(GatewayEndpointStore.resolveGatewayCredential(
                .token, isRemote: false, root: OpenClawConfigFile.loadDict(), env: [:])?.count == 48)
            let invalid = Data("invalid JSON".utf8)
            try invalid.write(to: config)
            #expect(OpenClawConfigFile.loadDictIfReadable() == nil)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: environment)
            #expect(try Data(contentsOf: config) == invalid)
            try FileManager.default.removeItem(at: config)
            try FileManager.default.createDirectory(at: config, withIntermediateDirectories: false)
            #expect(OpenClawConfigFile.loadDictIfReadable() == nil)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: environment)
            #expect(try config.resourceValues(forKeys: [.isDirectoryKey]).isDirectory == true)
        }
    }
}

func makeFirstRunTempDirForTests() throws -> URL {
    // Foundation's Darwin temp directory ignores the native sandbox launcher's TMPDIR.
    let base = ProcessInfo.processInfo.environment["TMPDIR"].map { URL(fileURLWithPath: $0) }
        ?? FileManager.default.temporaryDirectory
    let directory = base.appendingPathComponent(UUID().uuidString, isDirectory: true)
    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
    return directory
}
