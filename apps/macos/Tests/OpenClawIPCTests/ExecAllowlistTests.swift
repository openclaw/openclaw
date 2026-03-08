import Foundation
import Testing
@testable import OpenClaw

/// These cases cover optional `security=allowlist` behavior.
/// Default install posture remains deny-by-default for exec on macOS node-host.
struct ExecAllowlistTests {
    private struct ShellParserParityFixture: Decodable {
        struct Case: Decodable {
            let id: String
            let command: String
            let ok: Bool
            let executables: [String]
        }

        let cases: [Case]
    }

    private struct WrapperResolutionParityFixture: Decodable {
        struct Case: Decodable {
            let id: String
            let argv: [String]
            let expectedRawExecutable: String?
        }

        let cases: [Case]
    }

    private static func loadShellParserParityCases() throws -> [ShellParserParityFixture.Case] {
        let fixtureURL = self.fixtureURL(filename: "exec-allowlist-shell-parser-parity.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(ShellParserParityFixture.self, from: data)
        return fixture.cases
    }

    private static func loadWrapperResolutionParityCases() throws -> [WrapperResolutionParityFixture.Case] {
        let fixtureURL = self.fixtureURL(filename: "exec-wrapper-resolution-parity.json")
        let data = try Data(contentsOf: fixtureURL)
        let fixture = try JSONDecoder().decode(WrapperResolutionParityFixture.self, from: data)
        return fixture.cases
    }

    private static func fixtureURL(filename: String) -> URL {
        var repoRoot = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repoRoot.deleteLastPathComponent()
        }
        return repoRoot
            .appendingPathComponent("test")
            .appendingPathComponent("fixtures")
            .appendingPathComponent(filename)
    }

    private static func homebrewRGResolution() -> ExecCommandResolution {
        ExecCommandResolution(
            rawExecutable: "rg",
            resolvedPath: "/opt/homebrew/bin/rg",
            executableName: "rg",
            cwd: nil)
    }

    @Test func `match uses resolved path`() {
        let entry = ExecAllowlistEntry(pattern: "/opt/homebrew/bin/rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match ignores basename pattern`() {
        let entry = ExecAllowlistEntry(pattern: "rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match == nil)
    }

    @Test func `match ignores basename for relative executable`() {
        let entry = ExecAllowlistEntry(pattern: "echo")
        let resolution = ExecCommandResolution(
            rawExecutable: "./echo",
            resolvedPath: "/tmp/oc-basename/echo",
            executableName: "echo",
            cwd: "/tmp/oc-basename")
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match == nil)
    }

    @Test func `match is case insensitive`() {
        let entry = ExecAllowlistEntry(pattern: "/OPT/HOMEBREW/BIN/RG")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `match supports glob star`() {
        let entry = ExecAllowlistEntry(pattern: "/opt/**/rg")
        let resolution = Self.homebrewRGResolution()
        let match = ExecAllowlistMatcher.match(entries: [entry], resolution: resolution)
        #expect(match?.pattern == entry.pattern)
    }

    @Test func `resolve for allowlist splits shell chains`() {
        let command = ["/bin/sh", "-lc", "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist keeps quoted operators in single segment`() {
        let command = ["/bin/sh", "-lc", "echo \"a && b\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"a && b\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].executableName == "echo")
    }

    @Test func `resolve for allowlist fails closed on command substitution`() {
        let command = ["/bin/sh", "-lc", "echo $(/usr/bin/touch /tmp/openclaw-allowlist-test-subst)"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo $(/usr/bin/touch /tmp/openclaw-allowlist-test-subst)",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on quoted command substitution`() {
        let command = ["/bin/sh", "-lc", "echo \"ok $(/usr/bin/touch /tmp/openclaw-allowlist-test-quoted-subst)\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"ok $(/usr/bin/touch /tmp/openclaw-allowlist-test-quoted-subst)\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist fails closed on quoted backticks`() {
        let command = ["/bin/sh", "-lc", "echo \"ok `/usr/bin/id`\""]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: "echo \"ok `/usr/bin/id`\"",
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.isEmpty)
    }

    @Test func `resolve for allowlist matches shared shell parser fixture`() throws {
        let fixtures = try Self.loadShellParserParityCases()
        for fixture in fixtures {
            let resolutions = ExecCommandResolution.resolveForAllowlist(
                command: ["/bin/sh", "-lc", fixture.command],
                rawCommand: fixture.command,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])

            #expect(!resolutions.isEmpty == fixture.ok)
            if fixture.ok {
                let executables = resolutions.map { $0.executableName.lowercased() }
                let expected = fixture.executables.map { $0.lowercased() }
                #expect(executables == expected)
            }
        }
    }

    @Test func `resolve matches shared wrapper resolution fixture`() throws {
        let fixtures = try Self.loadWrapperResolutionParityCases()
        for fixture in fixtures {
            let resolution = ExecCommandResolution.resolve(
                command: fixture.argv,
                cwd: nil,
                env: ["PATH": "/usr/bin:/bin"])
            #expect(resolution?.rawExecutable == fixture.expectedRawExecutable)
        }
    }

    @Test func `resolve for allowlist treats plain sh invocation as direct exec`() {
        let command = ["/bin/sh", "./script.sh"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: "/tmp",
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].executableName == "sh")
    }

    @Test func `resolve for allowlist unwraps env shell wrapper chains`() {
        let command = [
            "/usr/bin/env",
            "/bin/sh",
            "-lc",
            "echo allowlisted && /usr/bin/touch /tmp/openclaw-allowlist-test",
        ]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 2)
        #expect(resolutions[0].executableName == "echo")
        #expect(resolutions[1].executableName == "touch")
    }

    @Test func `resolve for allowlist unwraps env to effective direct executable`() {
        let command = ["/usr/bin/env", "FOO=bar", "/usr/bin/printf", "ok"]
        let resolutions = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: nil,
            cwd: nil,
            env: ["PATH": "/usr/bin:/bin"])
        #expect(resolutions.count == 1)
        #expect(resolutions[0].resolvedPath == "/usr/bin/printf")
        #expect(resolutions[0].executableName == "printf")
    }

    @Test func `match all requires every segment to match`() {
        let first = ExecCommandResolution(
            rawExecutable: "echo",
            resolvedPath: "/usr/bin/echo",
            executableName: "echo",
            cwd: nil)
        let second = ExecCommandResolution(
            rawExecutable: "/usr/bin/touch",
            resolvedPath: "/usr/bin/touch",
            executableName: "touch",
            cwd: nil)
        let resolutions = [first, second]

        let partial = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/usr/bin/echo")],
            resolutions: resolutions)
        #expect(partial.isEmpty)

        let full = ExecAllowlistMatcher.matchAll(
            entries: [ExecAllowlistEntry(pattern: "/USR/BIN/ECHO"), ExecAllowlistEntry(pattern: "/usr/bin/touch")],
            resolutions: resolutions)
        #expect(full.count == 2)
    }
}
