import Foundation
import Testing
@testable import OpenClaw

private struct SystemRunCommandContractFixture: Decodable {
    let cases: [SystemRunCommandContractCase]
}

private struct SystemRunCommandContractCase: Decodable {
    let name: String
    let command: [String]
    let rawCommand: String?
    let expected: SystemRunCommandContractExpected
}

private struct SystemRunCommandContractExpected: Decodable {
    let valid: Bool
    let displayCommand: String?
    let errorContains: String?
}

struct ExecSystemRunCommandValidatorTests {
    @Test func `matches shared system run command contract fixture`() throws {
        for entry in try Self.loadContractCases() {
            let result = ExecSystemRunCommandValidator.resolve(command: entry.command, rawCommand: entry.rawCommand)

            if !entry.expected.valid {
                switch result {
                case let .ok(resolved):
                    Issue
                        .record("\(entry.name): expected invalid result, got displayCommand=\(resolved.displayCommand)")
                case let .invalid(message):
                    if let expected = entry.expected.errorContains {
                        #expect(
                            message.contains(expected),
                            "\(entry.name): expected error containing \(expected), got \(message)")
                    }
                }
                continue
            }

            switch result {
            case let .ok(resolved):
                #expect(
                    resolved.displayCommand == entry.expected.displayCommand,
                    "\(entry.name): unexpected display command")
            case let .invalid(message):
                Issue.record("\(entry.name): unexpected invalid result: \(message)")
            }
        }
    }

    @Test func `env dash shell wrapper requires canonical raw command binding`() {
        let command = ["/usr/bin/env", "-", "bash", "-lc", "echo hi"]

        let legacy = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: "echo hi")
        switch legacy {
        case .ok:
            Issue.record("expected rawCommand mismatch for env dash prelude")
        case let .invalid(message):
            #expect(message.contains("rawCommand does not match command"))
        }

        let canonicalRaw = "/usr/bin/env - bash -lc \"echo hi\""
        let canonical = ExecSystemRunCommandValidator.resolve(command: command, rawCommand: canonicalRaw)
        switch canonical {
        case let .ok(resolved):
            #expect(resolved.displayCommand == canonicalRaw)
        case let .invalid(message):
            Issue.record("unexpected invalid result for canonical raw command: \(message)")
        }
    }

    @Test func `resolve keeps env dash wrapper as effective executable`() {
        let resolution = ExecCommandResolution.resolve(
            command: ["/usr/bin/env", "-", "/usr/bin/printf", "ok"],
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolution?.rawExecutable == "/usr/bin/env")
        #expect(resolution?.resolvedPath == "/usr/bin/env")
        #expect(resolution?.executableName == "env")
    }

    private static func loadContractCases() throws -> [SystemRunCommandContractCase] {
        let fixtureURL = try self.findContractFixtureURL()
        let data = try Data(contentsOf: fixtureURL)
        let decoded = try JSONDecoder().decode(SystemRunCommandContractFixture.self, from: data)
        return decoded.cases
    }

    private static func findContractFixtureURL() throws -> URL {
        var cursor = URL(fileURLWithPath: #filePath).deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = cursor
                .appendingPathComponent("test")
                .appendingPathComponent("fixtures")
                .appendingPathComponent("system-run-command-contract.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return candidate
            }
            cursor.deleteLastPathComponent()
        }
        throw NSError(
            domain: "ExecSystemRunCommandValidatorTests",
            code: 1,
            userInfo: [NSLocalizedDescriptionKey: "missing shared system-run command contract fixture"])
    }
}
