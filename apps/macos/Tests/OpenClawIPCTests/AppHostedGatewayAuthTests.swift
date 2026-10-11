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
        ]
        for root in persist {
            #expect(AppHostedGatewayAuth.decision(root: root, environment: [:]) == .persist)
        }
        let keep: [[String: Any]] = [
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
    }

    @MainActor
    @Test func `persisted first-run token resolves locally and preserves authored config`() async throws {
        let directory = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let config = directory.appendingPathComponent("openclaw.json")
        try Data(#"{"gateway":{"mode":"local","auth":{"allowTailscale":false}},"custom":{"keep":42}}"#.utf8)
            .write(to: config)
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": config.path,
            "OPENCLAW_STATE_DIR": directory.path,
        ]) {
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: [:])
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
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: [:])
            #expect(try Data(contentsOf: config) == saved)
        }
    }

    @MainActor
    @Test func `missing config is initialized but invalid and unreadable configs are preserved`() async throws {
        let directory = try makeFirstRunTempDirForTests()
        defer { try? FileManager.default.removeItem(at: directory) }
        let config = directory.appendingPathComponent("openclaw.json")
        try await TestIsolation.withEnvValues([
            "OPENCLAW_CONFIG_PATH": config.path,
            "OPENCLAW_STATE_DIR": directory.path,
        ]) {
            #expect(OpenClawConfigFile.loadDictIfReadable()?.isEmpty == true)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: [:])
            #expect(GatewayEndpointStore.resolveGatewayCredential(
                .token, isRemote: false, root: OpenClawConfigFile.loadDict(), env: [:])?.count == 48)
            let invalid = Data("invalid JSON".utf8)
            try invalid.write(to: config)
            #expect(OpenClawConfigFile.loadDictIfReadable() == nil)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: [:])
            #expect(try Data(contentsOf: config) == invalid)
            try FileManager.default.removeItem(at: config)
            try FileManager.default.createDirectory(at: config, withIntermediateDirectories: false)
            #expect(OpenClawConfigFile.loadDictIfReadable() == nil)
            try OpenClawConfigFile.ensureAppHostedGatewayAuth(environment: [:])
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
