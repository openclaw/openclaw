import Foundation
import Testing
@testable import OpenClaw

#if canImport(Darwin)
import Darwin
#endif

struct PortGuardianDiagnosticsTests {
    @Test(arguments: [nil as UInt16?, 49219]) @MainActor
    func `direct remote diagnostics do not invent a local tunnel listener`(activeTunnelPort: UInt16?) async throws {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: ["OPENCLAW_CONFIG_PATH": configPath]) {
            try Data(
                #"{"gateway":{"mode":"remote","remote":{"transport":"direct","url":"wss://gateway.example.test"}}}"#
                    .utf8)
                .write(to: URL(fileURLWithPath: configPath))
            let reports = await PortGuardian.shared.diagnose(mode: .remote, activeTunnelPort: activeTunnelPort)
            #expect(reports.isEmpty)
        }
    }

    @Test(arguments: [AppState.RemoteTransport.direct, .ssh], [nil as UInt16?, 49219]) @MainActor
    func `remote diagnostics include the separately hosted local Gateway`(
        transport: AppState.RemoteTransport,
        activeTunnelPort: UInt16?) async throws
    {
        let configPath = TestIsolation.tempConfigPath()
        defer { try? FileManager.default.removeItem(atPath: configPath) }
        try await TestIsolation.withIsolatedState(env: [
            "OPENCLAW_CONFIG_PATH": configPath,
            "OPENCLAW_GATEWAY_PORT": "49217",
        ]) {
            let root: [String: Any] = ["gateway": [
                "mode": "remote",
                "port": 49217,
                "remote": [
                    "transport": transport.rawValue,
                    "url": transport == .ssh ? "ws://127.0.0.1:49218" : "wss://gateway.example.test",
                ],
            ]]
            try JSONSerialization.data(withJSONObject: root).write(to: URL(fileURLWithPath: configPath))
            let reports = await PortGuardian.shared.diagnose(
                mode: .remote,
                activeTunnelPort: activeTunnelPort,
                hostsLocalGateway: true)
            let expectedPorts = transport == .ssh ? [activeTunnelPort == nil ? 49218 : 49219, 49217] : [49217]
            #expect(reports.map(\.port) == expectedPorts)
            #expect(reports.last?.expected == "Gateway websocket (node/tsx)")
        }
    }

    @Test func `listener classification keeps failed probes undecided`() {
        func result(
            stdout: String,
            stderr: String = "",
            exitCode: Int?,
            timedOut: Bool = false,
            success: Bool,
            preflightError: String? = nil) -> ShellExecutor.ShellResult
        {
            ShellExecutor.ShellResult(
                stdout: stdout,
                stderr: stderr,
                exitCode: exitCode,
                timedOut: timedOut,
                success: success,
                errorMessage: success ? nil : "failure",
                preflightError: preflightError)
        }

        let timedOut = result(stdout: "", exitCode: nil, timedOut: true, success: false)
        guard case .inconclusive = PortGuardian.classifyListenerInspection(timedOut) else {
            Issue.record("a timed out lsof must stay undecided")
            return
        }
        let launchFailed = result(stdout: "", exitCode: nil, success: false, preflightError: "spawn failed")
        guard case .inconclusive = PortGuardian.classifyListenerInspection(launchFailed) else {
            Issue.record("an lsof launch failure must stay undecided")
            return
        }
        let noMatches = result(stdout: "", exitCode: 1, success: false)
        guard case let .listeners(rows) = PortGuardian.classifyListenerInspection(noMatches), rows.isEmpty else {
            Issue.record("lsof exit 1 without output means no listener")
            return
        }
        let broken = result(stdout: "", exitCode: 2, success: false)
        guard case .inconclusive = PortGuardian.classifyListenerInspection(broken) else {
            Issue.record("an unexpected lsof exit must stay undecided")
            return
        }
        // A filesystem warning says nothing about the port, so it must not turn a
        // genuine "no match" into an undecided probe. The `-b` note is what lsof
        // prints on a clean run, so it must be ignored too.
        for note in [
            "lsof: WARNING: can't stat() nfs file system /Volumes/x\n",
            "lsof: avoiding readlink(/): -b was specified.\n",
            "lsof: avoiding stat(/dev): -b was specified.\n",
        ] {
            let warned = result(stdout: "", stderr: note, exitCode: 1, success: false)
            guard case let .listeners(warnedRows) = PortGuardian.classifyListenerInspection(warned),
                  warnedRows.isEmpty
            else {
                Issue.record("\(note.trimmingCharacters(in: .newlines)) is not an inspection failure")
                return
            }
        }
        // lsof also exits 1 on its own errors, after printing a diagnostic to stderr.
        let failedInspection = result(stdout: "", stderr: "lsof: proc_listpids failed\n", exitCode: 1, success: false)
        guard case .inconclusive = PortGuardian.classifyListenerInspection(failedInspection) else {
            Issue.record("exit 1 with an lsof diagnostic is an error, not an empty port")
            return
        }
        let unparsable = result(stdout: "garbage", exitCode: 0, success: true)
        guard case .inconclusive = PortGuardian.classifyListenerInspection(unparsable) else {
            Issue.record("unparsable rows must not prove the port is free")
            return
        }
    }

    @Test @MainActor func `a missing lsof is unknown instead of a free port`() async throws {
        let inspection = try await TestIsolation.withEnvValues(["PATH": ""]) {
            await PortGuardian.shared.inspect(port: 49321)
        }
        guard case .unknown = inspection else {
            Issue.record("expected unknown when lsof cannot launch")
            return
        }
    }

    @Test @MainActor func `an lsof timeout stays unknown within the probe deadline`() async throws {
        let bin = try Self.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try Self.writeStub(named: "lsof", to: bin, script: "#!/bin/sh\n/bin/sleep 8\n")

        let (inspection, elapsed) = try await TestIsolation.withEnvValues(["PATH": bin.path]) {
            let started = ContinuousClock.now
            let inspection = await PortGuardian.shared.inspect(port: 49322)
            return (inspection, ContinuousClock.now - started)
        }
        guard case .unknown = inspection else {
            Issue.record("a timed out lsof must not prove the port is idle")
            return
        }
        #expect(elapsed < Duration.seconds(8))
        #expect(elapsed > Duration.seconds(4))
    }

    @Test @MainActor func `a failing lsof never reports the port as idle`() async throws {
        let bin = try Self.makeStubDirectory()
        defer { try? FileManager.default.removeItem(at: bin) }
        try Self.writeStub(
            named: "lsof",
            to: bin,
            script: "#!/bin/sh\n/usr/bin/printf 'lsof: cannot inspect\\n' >&2\nexit 2\n")

        let listening = try await TestIsolation.withEnvValues(["PATH": bin.path]) {
            await PortGuardian.shared.isListening(port: 49323)
        }
        #expect(listening)
    }

    #if canImport(Darwin)
    @Test @MainActor func `real lsof reports a loopback listener as owned`() async throws {
        let listener = try Self.makeSocket(listen: true)
        defer { _ = Darwin.close(listener.fd) }

        let inspection = try await TestIsolation.withEnvValues(["PATH": "/usr/sbin:/usr/bin:/bin"]) {
            await PortGuardian.shared.inspect(port: Int(listener.port))
        }
        #expect(inspection.ownedDescriptor?.pid == getpid())
    }

    @Test @MainActor func `real lsof reports an idle port as free`() async throws {
        let bound = try Self.makeSocket(listen: false)
        defer { _ = Darwin.close(bound.fd) }

        let inspection = try await TestIsolation.withEnvValues(["PATH": "/usr/sbin:/usr/bin:/bin"]) {
            await PortGuardian.shared.inspect(port: Int(bound.port))
        }
        guard case .free = inspection else {
            Issue.record("an unlistened port must be reported free")
            return
        }
    }

    private static func makeSocket(listen shouldListen: Bool) throws -> (fd: Int32, port: UInt16) {
        let fd = socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)

        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_port = 0
        address.sin_addr = in_addr(s_addr: inet_addr("127.0.0.1"))

        let bindResult = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                Darwin.bind(fd, socketAddress, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        guard bindResult == 0, !shouldListen || Darwin.listen(fd, 1) == 0 else {
            _ = Darwin.close(fd)
            throw PortGuardianProbeFixtureError.openFailed
        }

        var boundAddress = sockaddr_in()
        var boundLength = socklen_t(MemoryLayout<sockaddr_in>.size)
        let nameResult = withUnsafeMutablePointer(to: &boundAddress) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { socketAddress in
                getsockname(fd, socketAddress, &boundLength)
            }
        }
        guard nameResult == 0 else {
            _ = Darwin.close(fd)
            throw PortGuardianProbeFixtureError.openFailed
        }
        return (fd, UInt16(bigEndian: boundAddress.sin_port))
    }
    #endif

    private static func makeStubDirectory() throws -> URL {
        let directory = FileManager.default.temporaryDirectory
            .appendingPathComponent("portguardian-lsof-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        return directory
    }

    private static func writeStub(named name: String, to directory: URL, script: String) throws {
        let stub = directory.appendingPathComponent(name)
        try script.write(to: stub, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: stub.path)
    }
}

private enum PortGuardianProbeFixtureError: Error {
    case openFailed
}
