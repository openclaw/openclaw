import Foundation
import Testing
@testable import Clawdis

@Suite
struct AnthropicAuthResolverTests {
    @Test
    func prefersOAuthFileOverEnv() throws {
        let key = "CLAWDIS_OAUTH_DIR"
        let previous = ProcessInfo.processInfo.environment[key]
        defer {
            if let previous {
                setenv(key, previous, 1)
            } else {
                unsetenv(key)
            }
        }

        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-oauth-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        setenv(key, dir.path, 1)

        let oauthFile = dir.appendingPathComponent("oauth.json")
        let payload = [
            "anthropic": [
                "type": "oauth",
                "refresh": "r1",
                "access": "a1",
                "expires": 1_234_567_890,
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: payload, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: oauthFile, options: [.atomic])

        let mode = AnthropicAuthResolver.resolve(environment: [
            "ANTHROPIC_API_KEY": "sk-ant-ignored",
        ])
        #expect(mode == .oauthFile)
    }

    @Test
    func reportsOAuthEnvWhenPresent() {
        let mode = AnthropicAuthResolver.resolve(environment: [
            "ANTHROPIC_OAUTH_TOKEN": "token",
        ], oauthStatus: .missingFile)
        #expect(mode == .oauthEnv)
    }

    @Test
    func reportsAPIKeyEnvWhenPresent() {
        let mode = AnthropicAuthResolver.resolve(environment: [
            "ANTHROPIC_API_KEY": "sk-ant-key",
        ], oauthStatus: .missingFile)
        #expect(mode == .apiKeyEnv)
    }

    @Test
    func reportsMissingWhenNothingConfigured() {
        let mode = AnthropicAuthResolver.resolve(environment: [:], oauthStatus: .missingFile)
        #expect(mode == .missing)
    }
}
