import Darwin
import Foundation
import Testing
@testable import OpenClaw

enum TestProcessSupport {
    static func pollPID(in file: URL) -> pid_t? {
        guard let value = try? String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        else { return nil }
        return pid_t(value)
    }

    static func waitForPID(
        in file: URL,
        sourceLocation: SourceLocation = #_sourceLocation) async throws -> pid_t
    {
        try await TestWait.state("PID file \(file.lastPathComponent)", sourceLocation: sourceLocation) {
            self.pollPID(in: file) != nil
        }
        return try #require(self.pollPID(in: file), sourceLocation: sourceLocation)
    }

    static func processIsGone(_ pid: pid_t) -> Bool {
        errno = 0
        return kill(pid, 0) == -1 && errno == ESRCH
    }

    static func waitUntilGone(
        _ pid: pid_t,
        sourceLocation: SourceLocation = #_sourceLocation) async throws -> Bool
    {
        try await TestWait.state("exit of \(pid)", sourceLocation: sourceLocation) { self.processIsGone(pid) }
        return self.processIsGone(pid)
    }

    /// SIGPIPE from a write whose reader already exited kills the entire test
    /// process (swiftpm-testing-helper dies with signal 13, blaming whatever
    /// test happens to be running). Mirror the production F_SETNOSIGPIPE guard
    /// (MacNodeHostWorker) so a racing reader exit surfaces as a thrown EPIPE
    /// on that one write instead.
    static func suppressSIGPIPE(_ writeEnd: FileHandle) throws {
        try #require(writeEnd.disableSIGPIPE())
    }

    static func killLeakedProcesses(in files: [URL]) {
        let pids = files.compactMap { self.pollPID(in: $0) }
        for pid in pids where !self.processIsGone(pid) {
            _ = kill(pid, SIGKILL)
        }
        let deadline = Date().addingTimeInterval(2)
        while Date() < deadline, pids.contains(where: { !self.processIsGone($0) }) {
            usleep(10000)
        }
    }
}
