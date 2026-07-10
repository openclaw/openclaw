import Foundation
import Testing
@testable import OpenClaw

struct ExecApprovalsSocketAuthTests {
    @Test
    func `timing safe hex compare matches equal strings`() {
        #expect(timingSafeHexStringEquals(String(repeating: "a", count: 64), String(repeating: "a", count: 64)))
    }

    @Test
    func `timing safe hex compare rejects mismatched strings`() {
        let expected = String(repeating: "a", count: 63) + "b"
        let provided = String(repeating: "a", count: 63) + "c"
        #expect(!timingSafeHexStringEquals(expected, provided))
    }

    @Test
    func `timing safe hex compare rejects different length strings`() {
        #expect(!timingSafeHexStringEquals(String(repeating: "a", count: 64), "deadbeef"))
    }

    @Test
    func `exec host limiter preserves small output`() {
        #expect(ExecHostOutputLimiter.truncate("hello") == "hello")
    }

    @Test
    func `exec host limiter preserves a valid utf8 tail`() {
        let input = String(repeating: "x", count: 2 * 1024 * 1024) + "✅"
        let limited = ExecHostOutputLimiter.truncate(input)

        #expect(limited.hasPrefix("... (truncated) "))
        #expect(limited.hasSuffix("✅"))
        #expect(limited.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
    }

    @Test
    func `exec host limiter keeps escaped output below the jsonl cap`() throws {
        let escaped = String(repeating: "\u{0}", count: 2 * 1024 * 1024)
        let limited = ExecHostOutputLimiter.truncate(escaped)
        let response = EncodedExecHostResponse(
            type: "exec-res",
            id: "test",
            ok: true,
            payload: EncodedExecHostRunResult(
                exitCode: 0,
                timedOut: false,
                success: true,
                stdout: limited,
                stderr: limited,
                error: nil),
            error: nil)

        #expect(try JSONEncoder().encode(response).count < ExecHostOutputLimiter.maxJsonlResponseBytes)
    }

    @Test
    func `exec host limiter bounds real command output`() async throws {
        let result = await ShellExecutor.runDetailed(
            command: [
                "/usr/bin/perl",
                "-e",
                "print 'x' x (2 * 1024 * 1024); print STDERR 'y' x (2 * 1024 * 1024);",
            ],
            cwd: nil,
            env: nil,
            timeout: 10)

        #expect(ExecHostOutputLimiter.truncate(result.stdout).utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(ExecHostOutputLimiter.truncate(result.stderr).utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(result.exitCode == 0)
    }

    private struct EncodedExecHostResponse: Codable {
        var type: String
        var id: String
        var ok: Bool
        var payload: EncodedExecHostRunResult?
        var error: String?
    }

    private struct EncodedExecHostRunResult: Codable {
        var exitCode: Int?
        var timedOut: Bool
        var success: Bool
        var stdout: String
        var stderr: String
        var error: String?
    }
}
