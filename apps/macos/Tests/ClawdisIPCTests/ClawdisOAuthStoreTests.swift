import Foundation
import Testing
@testable import Clawdis

@Suite
struct ClawdisOAuthStoreTests {
    @Test
    func returnsMissingWhenFileAbsent() {
        let url = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-oauth-\(UUID().uuidString)")
            .appendingPathComponent("oauth.json")
        #expect(ClawdisOAuthStore.anthropicOAuthStatus(at: url) == .missingFile)
    }

    @Test
    func usesEnvOverrideForClawdisOAuthDir() throws {
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
        setenv(key, dir.path, 1)

        #expect(ClawdisOAuthStore.oauthDir().standardizedFileURL == dir.standardizedFileURL)
    }

    @Test
    func acceptsPiFormatTokens() throws {
        let url = try self.writeOAuthFile([
            "anthropic": [
                "type": "oauth",
                "refresh": "r1",
                "access": "a1",
                "expires": 1_234_567_890,
            ],
        ])

        #expect(ClawdisOAuthStore.anthropicOAuthStatus(at: url).isConnected)
    }

    @Test
    func acceptsTokenKeyVariants() throws {
        let url = try self.writeOAuthFile([
            "anthropic": [
                "type": "oauth",
                "refresh_token": "r1",
                "access_token": "a1",
            ],
        ])

        #expect(ClawdisOAuthStore.anthropicOAuthStatus(at: url).isConnected)
    }

    @Test
    func reportsMissingProviderEntry() throws {
        let url = try self.writeOAuthFile([
            "other": [
                "type": "oauth",
                "refresh": "r1",
                "access": "a1",
            ],
        ])

        #expect(ClawdisOAuthStore.anthropicOAuthStatus(at: url) == .missingProviderEntry)
    }

    @Test
    func reportsMissingTokens() throws {
        let url = try self.writeOAuthFile([
            "anthropic": [
                "type": "oauth",
                "refresh": "",
                "access": "a1",
            ],
        ])

        #expect(ClawdisOAuthStore.anthropicOAuthStatus(at: url) == .missingTokens)
    }

    private func writeOAuthFile(_ json: [String: Any]) throws -> URL {
        let dir = FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdis-oauth-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)

        let url = dir.appendingPathComponent("oauth.json")
        let data = try JSONSerialization.data(withJSONObject: json, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: url, options: [.atomic])
        return url
    }
}
