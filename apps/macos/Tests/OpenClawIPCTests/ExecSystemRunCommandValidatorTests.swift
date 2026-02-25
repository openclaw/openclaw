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
    @Test func matchesSharedSystemRunCommandContractFixture() throws {
        for entry in try Self.loadContractCases() {
            let result = ExecSystemRunCommandValidator.resolve(command: entry.command, rawCommand: entry.rawCommand)

            if !entry.expected.valid {
                switch result {
                case .ok(let resolved):
                    Issue.record("\(entry.name): expected invalid result, got displayCommand=\(resolved.displayCommand)")
                case .invalid(let message):
                    if let expected = entry.expected.errorContains {
                        #expect(
                            message.contains(expected),
                            "\(entry.name): expected error containing \(expected), got \(message)")
                    }
                }
                continue
            }

            switch result {
            case .ok(let resolved):
                #expect(
                    resolved.displayCommand == entry.expected.displayCommand,
                    "\(entry.name): unexpected display command")
            case .invalid(let message):
                Issue.record("\(entry.name): unexpected invalid result: \(message)")
            }
        }
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
