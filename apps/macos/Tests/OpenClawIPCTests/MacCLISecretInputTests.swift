import Foundation
import Testing
@testable import OpenClawMacCLI

@Suite(.serialized)
struct MacCLISecretInputTests {
    @Test func `connect parses password file`() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cli-password-\(UUID().uuidString)")
        try "file-secret\n".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        let opts = try ConnectOptions.parse(["--password-file", fileURL.path])

        #expect(opts.password == "file-secret")
    }

    @Test func `configure remote parses password file`() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cli-configure-password-\(UUID().uuidString)")
        try "remote-secret\n".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        let opts = try ConfigureRemoteOptions.parse([
            "--ssh-target", "alice@gateway.example",
            "--password-file", fileURL.path,
        ])

        #expect(opts.password == "remote-secret")
    }

    @Test func `wizard parses password file`() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cli-wizard-password-\(UUID().uuidString)")
        try "wizard-secret\n".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        let opts = try WizardCliOptions.parse(["--password-file", fileURL.path])

        #expect(opts.password == "wizard-secret")
    }

    @Test func `safe password input rejects empty files instead of falling back`() throws {
        let fileURL = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-cli-empty-password-\(UUID().uuidString)")
        try "\n".write(to: fileURL, atomically: true, encoding: .utf8)
        defer { try? FileManager.default.removeItem(at: fileURL) }

        #expect(throws: CLISecretInputError.self) {
            _ = try ConnectOptions.parse(["--password-file", fileURL.path])
        }

        #expect(throws: CLISecretInputError.self) {
            _ = try ConfigureRemoteOptions.parse([
                "--ssh-target", "alice@gateway.example",
                "--password-file", fileURL.path,
            ])
        }

        #expect(throws: CLISecretInputError.self) {
            _ = try WizardCliOptions.parse(["--password-file", fileURL.path])
        }
    }

    @Test func `safe password input rejects missing env instead of falling back`() throws {
        let envName = "OPENCLAW_TEST_MISSING_PASSWORD_\(UUID().uuidString.replacingOccurrences(of: "-", with: "_"))"

        #expect(throws: CLISecretInputError.self) {
            _ = try ConnectOptions.parse(["--password-env", envName])
        }

        #expect(throws: CLISecretInputError.self) {
            _ = try ConfigureRemoteOptions.parse([
                "--ssh-target", "alice@gateway.example",
                "--password-env", envName,
            ])
        }

        #expect(throws: CLISecretInputError.self) {
            _ = try WizardCliOptions.parse(["--password-env", envName])
        }
    }

    @Test func `password inputs are mutually exclusive`() throws {
        #expect(throws: CLISecretInputError.self) {
            _ = try ConnectOptions.parse([
                "--password", "inline-secret",
                "--password-file", "/tmp/secret",
            ])
        }

        #expect(throws: CLISecretInputError.self) {
            _ = try ConfigureRemoteOptions.parse([
                "--ssh-target", "alice@gateway.example",
                "--password-file", "/tmp/secret",
                "--password-env", "OPENCLAW_PASSWORD",
            ])
        }

        #expect(throws: CLISecretInputError.self) {
            _ = try WizardCliOptions.parse([
                "--password-env", "OPENCLAW_PASSWORD",
                "--password-stdin",
            ])
        }
    }

    @Test func `legacy inline empty password preserves fallback compatibility`() throws {
        let opts = try ConnectOptions.parse(["--password", ""])

        #expect(opts.password == "")
    }
}
