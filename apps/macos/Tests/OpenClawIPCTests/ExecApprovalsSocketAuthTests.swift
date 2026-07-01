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
    func `exec host limiter leaves small output unchanged`() {
        #expect(ExecHostOutputLimiter.limit("hello") == "hello")
    }

    @Test
    func `exec host limiter truncates oversized output and preserves utf8 tail`() {
        let input = String(repeating: "x", count: 3 * 1024 * 1024) + "✅"
        let limited = ExecHostOutputLimiter.limit(input)

        #expect(limited.hasPrefix("... (truncated) "))
        #expect(limited.hasSuffix("✅"))
        #expect(limited.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
    }

    @Test
    func `exec host limiter keeps escaped response below jsonl requester cap`() throws {
        let escaped = String(repeating: "\u{0}", count: 3 * 1024 * 1024)
        let payload = ExecHostRunResult(
            exitCode: 0,
            timedOut: false,
            success: true,
            stdout: ExecHostOutputLimiter.limit(escaped),
            stderr: ExecHostOutputLimiter.limit(escaped),
            error: nil)
        let response = ExecHostResponse(type: "exec-res", id: "test", ok: true, payload: payload, error: nil)
        let encoded = try JSONEncoder().encode(response)

        #expect(encoded.count < ExecHostOutputLimiter.maxJsonlResponseBytes)
    }

    @Test
    func `exec host limiter bounds real command output response`() async throws {
        let result = await ShellExecutor.runDetailed(
            command: [
                "/usr/bin/perl",
                "-e",
                "print 'x' x (3 * 1024 * 1024); print STDERR 'y' x (3 * 1024 * 1024);",
            ],
            cwd: nil,
            env: nil,
            timeout: 10)
        let payload = ExecHostRunResult(
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            success: result.success,
            stdout: ExecHostOutputLimiter.limit(result.stdout),
            stderr: ExecHostOutputLimiter.limit(result.stderr),
            error: result.errorMessage)
        let response = ExecHostResponse(type: "exec-res", id: "test", ok: true, payload: payload, error: nil)
        let encoded = try JSONEncoder().encode(response)

        #expect(payload.stdout.hasPrefix("... (truncated) "))
        #expect(payload.stderr.hasPrefix("... (truncated) "))
        #expect(encoded.count < ExecHostOutputLimiter.maxJsonlResponseBytes)
    }
}
