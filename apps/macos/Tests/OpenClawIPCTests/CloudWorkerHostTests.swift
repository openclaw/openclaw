import Darwin
import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct CloudWorkerHostTests {
    @Test func `cloud mode requires its dedicated bundle and cannot open ordinary app UI`() throws {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let cases: [(String, Int?, [String])] = [
            ("ai.openclaw.mac", 1, ["--cloud-worker-host"]),
            ("ai.openclaw.mac", 1, ["--cloud-worker-inspect-process", "123"]),
            ("ai.openclaw.mac.debug", 1, ["--background-only", "--cloud-worker-host"]),
            ("ai.openclaw.cloud-worker", nil, ["--cloud-worker-host"]),
            ("ai.openclaw.cloud-worker", 0, ["--cloud-worker-host"]),
            ("ai.openclaw.cloud-worker", 1, []),
            ("ai.openclaw.cloud-worker", 1, ["--dashboard"]),
            ("ai.openclaw.cloud-worker", 1, ["--cloud-worker-host", "--unknown", "value"]),
            ("ai.openclaw.cloud-worker", 1, ["--cloud-worker-inspect-process"]),
            ("ai.openclaw.cloud-worker", 1, ["--cloud-worker-inspect-process", "-1"]),
            ("ai.openclaw.cloud-worker", 1, ["--cloud-worker-inspect-process", "123", "-1"]),
        ]
        for (index, (identifier, marker, arguments)) in cases.enumerated() {
            let bundle = try self.makeBundle(root: root, name: String(index), identifier: identifier, marker: marker)
            var applicationConstructed = false
            let result = OpenClawProcessEntrypoint.run(
                arguments: ["OpenClaw"] + arguments,
                bundle: bundle,
                launchApplication: { applicationConstructed = true })
            #expect(result == 2)
            #expect(!applicationConstructed)
        }
        let normal = try self.makeBundle(root: root, name: "normal", identifier: "ai.openclaw.mac", marker: nil)
        var applicationConstructed = false
        #expect(OpenClawProcessEntrypoint.run(
            arguments: ["OpenClaw"], bundle: normal, launchApplication: { applicationConstructed = true }) == nil)
        #expect(applicationConstructed)
    }

    @Test(arguments: ["connect", "resume"])
    func `cloud node executes canonical enrollment and publishes its actual process identity`(
        mode: String) async throws
    {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = try self.makeConfiguration(root: root, mode: mode)
        try configuration.validateFiles()
        let node = CloudWorkerNodeProcess(configuration: configuration)
        let endpoint = CuaDriverWorkerEndpoint(
            socketPath: root.appendingPathComponent("cua.sock").path,
            binaryPath: "/fixture/cua-driver")
        try node.start(endpoint: endpoint, onExit: { _ in })
        do {
            let observed = configuration.stateDirectory.appendingPathComponent("observed")
            #expect(await self.waitUntil { FileManager.default.fileExists(atPath: observed.path) })
            let lines = try String(contentsOf: observed, encoding: .utf8).components(separatedBy: "\n")
            #expect(lines[0] == configuration.stateDirectory.path)
            let observedEndpoint = try #require(JSONSerialization
                .jsonObject(with: Data(lines[1].utf8)) as? [String: Any])
            #expect(observedEndpoint["socketPath"] as? String == endpoint.socketPath)
            #expect(observedEndpoint["binaryPath"] as? String == endpoint.binaryPath)
            let expected = mode == "connect"
                ? ["connect", "--target-file", configuration.stateDirectory.appendingPathComponent("setup-code").path]
                : ["node", "run"]
            #expect(Array(lines.dropFirst(2).dropLast()) == expected + ["--ephemeral", "--display-name", "Cloud test"])
            let receipt = try #require(JSONSerialization.jsonObject(
                with: Data(contentsOf: configuration.stateDirectory.appendingPathComponent("node-launch.json")))
                as? [String: Any])
            let pid = try #require(receipt["pid"] as? Int32)
            #expect(kill(pid, 0) == 0)
            #expect(receipt["hostPid"] as? Int32 == getpid())
            #expect(!(receipt["hostStartTime"] as? String ?? "").isEmpty)
            #expect(!(receipt["startTime"] as? String ?? "").isEmpty)
            #expect(receipt["cli"] as? String == configuration.cliURL.path)
            #expect(receipt["runtimeDir"] as? String == configuration.runtimeDirectory.path)
            #expect(try String(
                contentsOf: configuration.stateDirectory.appendingPathComponent("node.pid"),
                encoding: .utf8).trimmingCharacters(in: .whitespacesAndNewlines) == String(pid))
        } catch {
            await node.stop()
            throw error
        }
        await node.stop()
        #expect(!node.isRunning)
    }

    @Test(arguments: [
        "daemon", "host", "preparation", "locked", "unknown", "assertion",
        "initial-locked", "initial-unknown", "initial-assertion",
    ])
    func `cloud lifetime holds power only while healthy and never revives after retirement`(
        reason: String) async throws
    {
        let root = try ExecApprovalsSocketTestSupport.makeRoot()
        defer { try? FileManager.default.removeItem(at: root) }
        let configuration = try self.makeConfiguration(root: root, mode: "resume")
        let node = CloudWorkerNodeProcess(configuration: configuration)
        let notifications = NotificationCenter()
        let platform = DesktopPlatformProbe()
        let initiallyUnavailable = reason.hasPrefix("initial-")
        if reason == "initial-locked" { platform.state = .locked }
        if reason == "initial-unknown" { platform.state = .unknown }
        if reason == "initial-assertion" { platform.assertionCreationSucceeds = false }
        var daemon: CloudHostDaemonProbe?
        var launches = 0
        var admission: CheckedContinuation<Void, Never>?
        let driver = CuaDriverHostCoordinator(
            notificationCenter: notifications,
            artifactURL: { root.appendingPathComponent("cua-driver") },
            applicationSupportURL: { configuration.desktopDirectory },
            bundleIdentifier: { "ai.openclaw.test" },
            processLauncher: { _, onTermination in
                launches += 1
                let process = CloudHostDaemonProbe(
                    onTermination: onTermination,
                    beforeClose: { #expect(!node.isRunning) })
                daemon = process
                return process
            },
            readinessProbe: { _ in true },
            permissionSnapshot: { [:] },
            beforeDaemonStop: { await node.stop() })
        let host = CloudWorkerHostSession(
            node: node,
            driver: driver,
            notifications: notifications,
            platform: platform,
            prepareNode: {
                if reason == "preparation" {
                    await withCheckedContinuation { admission = $0 }
                }
            })
        var completed = false
        let run = Task {
            let result = await host.run()
            completed = true
            return result
        }
        if initiallyUnavailable {
            #expect(await self.waitUntil { completed || launches > 0 })
            #expect(completed)
        } else {
            #expect(await self.waitUntil { platform.monitoring })
            #expect(platform.assertions.count == 1)
            for uptime in [5.0, 10.0, 15.0] {
                let previous = platform.assertions
                platform.uptime = uptime
                platform.invalidate()
                #expect(platform.assertions.count == 1)
                #expect(platform.assertions != previous)
            }
            #expect(platform.timeouts == [15, 15, 15, 15])
        }
        let queuedChange = platform.changed
        if reason == "preparation" {
            #expect(await self.waitUntil { admission != nil })
            host.requestStop(reason: "fixture revoked before node launch")
            admission?.resume()
        } else if !initiallyUnavailable {
            #expect(await self.waitUntil { node.isRunning })
            switch reason {
            case "daemon":
                daemon?.crash()
            case "locked", "unknown":
                platform.state = reason == "locked" ? .locked : .unknown
                platform.invalidate()
            case "assertion":
                platform.assertionCreationSucceeds = false
                platform.uptime += 5
                platform.invalidate()
            default:
                host.requestStop(reason: "fixture shutdown")
            }
        }
        #expect(await self.waitUntil { !platform.monitoring })
        host.requestStop(reason: "fixture cleanup")
        let acquisitions = platform.timeouts.count
        platform.state = .unlocked
        platform.assertionCreationSucceeds = true
        platform.uptime += 15
        queuedChange?()
        #expect(platform.timeouts.count == acquisitions)
        #expect(platform.assertions.isEmpty)
        #expect(await run.value == 1)
        #expect(!node.isRunning)
        #expect(driver.workerEndpoint == nil)
        #expect(launches == (initiallyUnavailable ? 0 : 1))
        if initiallyUnavailable || reason == "preparation" {
            #expect(!FileManager.default
                .fileExists(atPath: configuration.stateDirectory.appendingPathComponent("node.pid").path))
        }
    }

    private func makeBundle(root: URL, name: String, identifier: String, marker: Int?) throws -> Bundle {
        let application = root.appendingPathComponent("\(name).app", isDirectory: true)
        let contents = application.appendingPathComponent("Contents", isDirectory: true)
        try FileManager.default.createDirectory(at: contents, withIntermediateDirectories: true)
        var plist: [String: Any] = [
            "CFBundleIdentifier": identifier, "CFBundleExecutable": "OpenClaw", "CFBundlePackageType": "APPL",
        ]
        if let marker { plist["OpenClawCloudWorkerHostVersion"] = marker }
        try PropertyListSerialization.data(fromPropertyList: plist, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        return try #require(Bundle(url: application))
    }

    private func makeConfiguration(root: URL, mode: String) throws -> CloudWorkerHostConfiguration {
        let stateDirectory = root
            .appendingPathComponent("long home Développement 👨‍👩‍👧‍👦 with additional workspace components")
            .appendingPathComponent(root.lastPathComponent)
        try FileManager.default.createDirectory(
            at: stateDirectory, withIntermediateDirectories: true, attributes: [.posixPermissions: 0o700])
        let cliDirectory = root.appendingPathComponent("runtime/node_modules/openclaw", isDirectory: true)
        try FileManager.default.createDirectory(at: cliDirectory, withIntermediateDirectories: true)
        try """
        printf '%s\\n' "$OPENCLAW_STATE_DIR" "$OPENCLAW_CUA_DRIVER_ENDPOINT" "$@" > "$OPENCLAW_STATE_DIR/observed"
        exec /bin/sleep 30
        """.write(to: cliDirectory.appendingPathComponent("openclaw.mjs"), atomically: true, encoding: .utf8)
        try "synthetic-enrollment".write(
            to: stateDirectory.appendingPathComponent("setup-code"),
            atomically: true,
            encoding: .utf8)
        return try CloudWorkerHostConfiguration(arguments: [
            "--node-executable", "/bin/sh", "--runtime-dir", root.appendingPathComponent("runtime").path,
            "--state-dir", stateDirectory.path, "--desktop-dir", root.path, "--lease-id", root.lastPathComponent,
            "--display-name", "Cloud test", "--enrollment-mode", mode,
        ])
    }

    private func waitUntil(_ condition: () -> Bool) async -> Bool {
        for _ in 0..<200 {
            if condition() { return true }
            try? await Task.sleep(for: .milliseconds(10))
        }
        return condition()
    }
}

@MainActor
private final class CloudHostDaemonProbe: CuaDriverProcessControlling {
    var isRunning = true
    let processIdentifier: pid_t = 424_242
    private let onTermination: @Sendable (Int32) -> Void
    private let beforeClose: @MainActor () -> Void

    init(onTermination: @escaping @Sendable (Int32) -> Void, beforeClose: @escaping @MainActor () -> Void) {
        self.onTermination = onTermination
        self.beforeClose = beforeClose
    }

    func closeLiveness() {
        guard self.isRunning else { return }
        self.beforeClose()
        self.isRunning = false
        self.onTermination(0)
    }

    func terminate() {
        self.closeLiveness()
    }

    func forceKill() {
        self.closeLiveness()
    }

    func crash() {
        self.isRunning = false
        self.onTermination(7)
    }
}
