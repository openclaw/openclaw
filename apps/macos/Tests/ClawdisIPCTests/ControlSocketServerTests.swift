import Foundation
import Testing
@testable import Clawdis

@Suite struct ControlSocketServerTests {
    private static func codesignTeamIdentifier(executablePath: String) -> String? {
        let proc = Process()
        proc.executableURL = URL(fileURLWithPath: "/usr/bin/codesign")
        proc.arguments = ["-dv", "--verbose=4", executablePath]
        proc.standardOutput = Pipe()
        let stderr = Pipe()
        proc.standardError = stderr

        do {
            try proc.run()
            proc.waitUntilExit()
        } catch {
            return nil
        }

        guard proc.terminationStatus == 0 else {
            return nil
        }

        let data = stderr.fileHandleForReading.readDataToEndOfFile()
        guard let text = String(data: data, encoding: .utf8) else { return nil }
        for line in text.split(separator: "\n") {
            if line.hasPrefix("TeamIdentifier=") {
                let raw = String(line.dropFirst("TeamIdentifier=".count)).trimmingCharacters(in: .whitespacesAndNewlines)
                return raw == "not set" ? nil : raw
            }
        }
        return nil
    }

    @Test func teamIdentifierLookupMatchesCodesign() async {
        let pid = getpid()
        let execPath = CommandLine.arguments.first ?? ""

        let expected = Self.codesignTeamIdentifier(executablePath: execPath)
        let actual = ControlSocketServer._testTeamIdentifier(pid: pid)

        if let expected, !expected.isEmpty {
            #expect(actual == expected)
        } else {
            #expect(actual == nil || actual?.isEmpty == true)
        }
    }
}
