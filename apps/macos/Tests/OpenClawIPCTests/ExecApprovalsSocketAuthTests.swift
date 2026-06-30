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
    func `exec host output limiter keeps responses below jsonl socket cap`() throws {
        let output = String(repeating: "x", count: 1024 * 1024 + 1024)
        let truncated = ExecHostOutputLimiter.truncate(output)
        let response = EncodedExecHostResponse(
            type: "exec-res",
            id: "test",
            ok: true,
            payload: EncodedExecHostRunResult(
                exitCode: 0,
                timedOut: false,
                success: true,
                stdout: truncated,
                stderr: "",
                error: nil),
            error: nil)
        let encoded = try JSONEncoder().encode(response)

        #expect(truncated.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(truncated.hasPrefix("... (truncated) "))
        #expect(truncated.hasSuffix(String(repeating: "x", count: 32)))
        #expect(encoded.count < 1024 * 1024)
    }

    @Test
    func `exec host output limiter preserves valid utf8 tails`() {
        let output = String(repeating: "a", count: ExecHostOutputLimiter.maxOutputFieldBytes)
            + String(repeating: "猫", count: 64)
        let truncated = ExecHostOutputLimiter.truncate(output)

        #expect(truncated.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(truncated.hasPrefix("... (truncated) "))
        #expect(truncated.hasSuffix(String(repeating: "猫", count: 64)))
    }

    @Test
    func `exec host output limiter keeps escaped stdout and stderr below jsonl socket cap`() throws {
        let output = String(repeating: "\u{0000}", count: 1024 * 1024)
        let truncated = ExecHostOutputLimiter.truncate(output)
        let response = EncodedExecHostResponse(
            type: "exec-res",
            id: "test",
            ok: true,
            payload: EncodedExecHostRunResult(
                exitCode: 0,
                timedOut: false,
                success: true,
                stdout: truncated,
                stderr: truncated,
                error: nil),
            error: nil)
        let encoded = try JSONEncoder().encode(response)

        #expect(encoded.count < 1024 * 1024)
    }

    @Test
    func `exec host command output is truncated below jsonl socket cap`() async throws {
        let script = """
        print "x" x 120000;
        print STDERR "y" x 120000;
        """
        let result = await ShellExecutor.runDetailed(
            command: ["/usr/bin/perl", "-e", script],
            cwd: nil,
            env: nil,
            timeout: 2)
        let stdout = ExecHostOutputLimiter.truncate(result.stdout)
        let stderr = ExecHostOutputLimiter.truncate(result.stderr)
        let response = EncodedExecHostResponse(
            type: "exec-res",
            id: "test",
            ok: true,
            payload: EncodedExecHostRunResult(
                exitCode: result.exitCode,
                timedOut: result.timedOut,
                success: result.success,
                stdout: stdout,
                stderr: stderr,
                error: result.errorMessage),
            error: nil)
        let encoded = try JSONEncoder().encode(response)

        #expect(result.success == true)
        #expect(result.stdout.count == 120000)
        #expect(result.stderr.count == 120000)
        #expect(stdout.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(stderr.utf8.count <= ExecHostOutputLimiter.maxOutputFieldBytes)
        #expect(stdout.hasPrefix("... (truncated) "))
        #expect(stderr.hasPrefix("... (truncated) "))
        #expect(encoded.count < 1024 * 1024)
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
