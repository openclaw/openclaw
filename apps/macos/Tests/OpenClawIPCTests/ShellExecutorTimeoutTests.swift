import Darwin
import Foundation
import Testing
@testable import OpenClaw

private actor ShellLineRecorder {
    private var lines: [String] = []

    func append(_ line: String) {
        self.lines.append(line)
    }

    func snapshot() -> [String] {
        self.lines
    }
}

struct ShellExecutorTimeoutTests {
    /// The executor's deadline starts at spawn, so allow ample process startup time.
    /// This is a fixture budget, not the timeout behavior under test.
    private static let fixtureTimeout: TimeInterval = 1.0

    @Test(arguments: [false, true])
    func `parallel instant exits preserve their exit status`(streaming: Bool) async {
        await withTaskGroup(of: Void.self) { group in
            for index in 0..<32 {
                group.addTask {
                    let exitCode = index.isMultiple(of: 2) ? 0 : 7
                    let command = ["/bin/sh", "-c", "exit \(exitCode)"]
                    // Process startup under concurrent load is not a latency assertion.
                    let result = if streaming {
                        await ShellExecutor.runStreamingDetailed(
                            command: command,
                            cwd: nil,
                            env: nil,
                            timeout: 30,
                            onStandardOutputLine: { _ in })
                    } else {
                        await ShellExecutor.runDetailed(
                            command: command,
                            cwd: nil,
                            env: nil,
                            timeout: 30)
                    }
                    #expect(!result.timedOut)
                    #expect(result.exitCode == exitCode)
                    #expect(result.success == (exitCode == 0))
                }
            }
        }
    }

    @Test func `streaming captures both streams while delivering stdout lines`() async {
        let recorder = ShellLineRecorder()
        let result = await ShellExecutor.runStreamingDetailed(
            command: [
                "/bin/sh",
                "-c",
                "printf 'one\\ntwo\\n'; printf 'problem\\n' >&2",
            ],
            cwd: nil,
            env: nil,
            timeout: 5)
        { line in
            await recorder.append(line)
        }

        #expect(result.success)
        #expect(await recorder.snapshot() == ["one", "two"])
        #expect(result.stdout == "one\ntwo\n")
        #expect(result.stderr == "problem\n")
    }

    @Test(arguments: [false, true])
    @MainActor
    func `bundled repair cancellation waits for Doctor cleanup`(bundledRepair: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let readyURL = directory.appendingPathComponent("ready")
        let waitURL = directory.appendingPathComponent("wait")
        let pidURL = directory.appendingPathComponent("pid")
        let settledURL = directory.appendingPathComponent("settled")
        let ready = try self.makeFIFO(at: readyURL)
        let wait = try self.makeFIFO(at: waitURL)
        defer {
            try? ready.close()
            try? wait.close()
        }

        let script = """
        /bin/cat "$WAIT" >/dev/null &
        worker=$!
        trap 'wait "$worker" || :; printf settled > "$SETTLED"; exit 0' TERM
        printf '%s\\n' "$$" > "$PID"
        printf R > "$READY"
        wait "$worker"
        """
        let runtime: BundledRuntime?
        if bundledRepair {
            let app = directory.appendingPathComponent("OpenClaw.app")
            _ = try makeBundledRuntimeTestBundle(
                at: app, builtAt: "2026-10-16T00:00:00.000Z", command: "unused", doctorScript: script)
            runtime = try BundledRuntime.resolve(bundle: #require(Bundle(url: app)))
        } else {
            runtime = nil
        }
        let environment = [
            "READY": readyURL.path, "WAIT": waitURL.path, "PID": pidURL.path, "SETTLED": settledURL.path,
        ]
        let task = Task {
            if let runtime {
                let absent = directory.appendingPathComponent("absent-service")
                let authority = GatewayLaunchAgentManager.ServiceAuthority(
                    plist: absent, environment: absent, wrapper: absent,
                    definition: .init(plist: nil, environment: nil, wrapper: nil),
                    isLocalGateway: false,
                    updateSelection: .init(installPolicy: nil, gatewayUpdateChannel: nil))
                _ = try? await CLIInstaller.repairBundledGateway(
                    runtime: runtime, environment: environment, expectedServiceAuthority: authority,
                    checkCurrent: {}, statusHandler: { _ in })
            } else {
                _ = await ShellExecutor.runDetailed(
                    command: ["/bin/sh", "-c", script], cwd: nil, env: environment, timeout: 30)
            }
        }
        let readyData = try await Task.detached { try ready.read(upToCount: 1) }.value
        try #require(readyData == Data("R".utf8))
        let pid = try self.readPID(from: pidURL)
        defer {
            if kill(pid, 0) == 0 { kill(pid, SIGKILL) }
        }

        task.cancel()
        _ = await task.value

        #expect(FileManager.default.fileExists(atPath: settledURL.path) == bundledRepair)
        if bundledRepair {
            #expect(try String(contentsOf: settledURL, encoding: .utf8) == "settled")
        }
        #expect(kill(pid, 0) == -1 && errno == ESRCH)
    }

    @Test func `timeout kills and reaps a TERM-ignoring command`() async throws {
        try await self.assertTimeoutKillsAndReaps(streaming: false)
    }

    @Test func `streaming timeout kills and reaps a TERM-ignoring command`() async throws {
        try await self.assertTimeoutKillsAndReaps(streaming: true)
    }

    @Test func `timeout terminates TERM-ignoring descendants`() async throws {
        try await self.assertTimeoutTerminatesDescendants(streaming: false)
    }

    @Test func `streaming timeout terminates TERM-ignoring descendants`() async throws {
        try await self.assertTimeoutTerminatesDescendants(streaming: true)
    }

    private func assertTimeoutKillsAndReaps(streaming: Bool) async throws {
        let pidFile = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-timeout-\(UUID().uuidString).pid")
        defer { try? FileManager.default.removeItem(at: pidFile) }

        let command = [
            "/bin/sh",
            "-c",
            "echo $$ > \"$PID_FILE\"; trap '' TERM; exec /bin/sleep 30",
        ]
        let environment = ["PID_FILE": pidFile.path]
        let result = if streaming {
            await ShellExecutor.runStreamingDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout,
                onStandardOutputLine: { _ in })
        } else {
            await ShellExecutor.runDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout)
        }

        #expect(result.timedOut)
        let pid = try self.readPID(from: pidFile)
        defer {
            if kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
        #expect(await self.waitUntilGone(pid))
    }

    private func assertTimeoutTerminatesDescendants(streaming: Bool) async throws {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("openclaw-shell-timeout-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        defer { try? FileManager.default.removeItem(at: directory) }
        let parentPIDFile = directory.appendingPathComponent("parent.pid")
        let childPIDFile = directory.appendingPathComponent("child.pid")

        let command = [
            "/bin/sh",
            "-c",
            """
            /bin/sh -c 'trap "" TERM; echo $$ > "$CHILD_PID_FILE"; while :; do sleep 10; done' &
            echo $$ > "$PARENT_PID_FILE"
            while [ ! -s "$CHILD_PID_FILE" ]; do sleep 0.01; done
            while :; do sleep 10; done
            """,
        ]
        let environment = [
            "PARENT_PID_FILE": parentPIDFile.path,
            "CHILD_PID_FILE": childPIDFile.path,
        ]
        let result = if streaming {
            await ShellExecutor.runStreamingDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout,
                onStandardOutputLine: { _ in })
        } else {
            await ShellExecutor.runDetailed(
                command: command,
                cwd: nil,
                env: environment,
                timeout: Self.fixtureTimeout)
        }

        #expect(result.timedOut)
        let parentPID = try self.readPID(from: parentPIDFile)
        let childPID = try self.readPID(from: childPIDFile)
        defer {
            for pid in [parentPID, childPID] where kill(pid, 0) == 0 {
                kill(pid, SIGKILL)
            }
        }
        #expect(await self.waitUntilGone(parentPID))
        #expect(await self.waitUntilGone(childPID))
    }

    private func readPID(from file: URL) throws -> pid_t {
        try #require(
            FileManager.default.fileExists(atPath: file.path),
            "Timeout fixture did not publish its PID file: \(file.path)")
        let value = try String(contentsOf: file, encoding: .utf8)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        return try #require(pid_t(value))
    }

    private func makeFIFO(at url: URL) throws -> FileHandle {
        try #require(mkfifo(url.path, 0o600) == 0)
        let descriptor = open(url.path, O_RDWR | O_CLOEXEC)
        try #require(descriptor >= 0)
        return FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
    }

    private func waitUntilGone(_ pid: pid_t) async -> Bool {
        let deadline = ContinuousClock.now + .seconds(1)
        while ContinuousClock.now < deadline {
            errno = 0
            if kill(pid, 0) == -1, errno == ESRCH {
                return true
            }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return false
    }
}
