import ConcurrencyExtras
import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import SQLite3
import Testing
@testable import OpenClaw

/// Run only in the explicitly isolated native-policy proof process.
@Suite(
    .serialized,
    .testWaitLimit,
    .enabled(if: ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_POLICY_PROOF"] == "1"))
@MainActor
struct NativeExecPolicyOwnerTests {
    enum Engine: String, CaseIterable { case sqlite, postgres }
    enum PolicyEdit: CaseIterable { case removeMatchedRule, deny, removeUnrelatedRule }

    @Test(arguments: Engine.allCases, PolicyEdit.allCases)
    func `final commit reauthorizes against the current effective policy`(
        engine: Engine,
        edit: PolicyEdit) async throws
    {
        try await self.withFixture(engine: engine) { fixture in
            let matched = ExecAllowlistEntry(id: "matched", pattern: "/usr/bin/touch")
            let unrelated = ExecAllowlistEntry(id: "unrelated", pattern: "/usr/bin/true")
            var policy = self.policy(security: .allowlist, ask: .off)
            policy.agents = ["main": ExecApprovalsAgent(allowlist: [matched, unrelated])]
            try await fixture.replace(policy)
            let command = ["/usr/bin/touch", fixture.marker.path]
            let evaluation = await ExecApprovalEvaluator.evaluate(
                command: command, rawCommand: nil, cwd: fixture.root.path,
                envOverrides: nil, agentId: "main")
            try #require(evaluation.allowlistAuthorizationSatisfied)
            let boundCommand = try #require(evaluation.boundCommand)
            let cwd = try #require(ExecCommandResolution.captureApprovalCwdSnapshot(fixture.root.path))
            let executableSnapshots = ExecCommandResolution.captureApprovalExecutables(evaluation.allowlistResolutions)
            let commit = ExecApprovalExecutionCommit.build(
                context: evaluation, effectiveSecurity: evaluation.security,
                approvalSource: nil, explicitlyApproved: false, persistAllowlist: false)
            switch edit {
            case .removeMatchedRule:
                policy.agents?["main"]?.allowlist = [unrelated]
            case .deny:
                policy.defaults?.security = .deny
            case .removeUnrelatedRule:
                policy.agents?["main"]?.allowlist = [matched]
            }
            try await fixture.replace(policy)
            switch await ExecApprovalsStore.commitExecution(commit) {
            case .success:
                #expect(edit == .removeUnrelatedRule)
                let result = await ExecHostExecutor.runApprovedCommand(
                    authorization: commit.authorization, command: boundCommand,
                    cwd: cwd, env: evaluation.env, timeout: 2,
                    executableSnapshots: executableSnapshots)
                #expect(result.success)
            case let .failure(error):
                #expect(edit != .removeUnrelatedRule)
                #expect(
                    error.localizedDescription.contains("changed before execution"),
                    Comment(rawValue: error.localizedDescription))
            }
            #expect(FileManager.default.fileExists(atPath: fixture.marker.path) == (edit == .removeUnrelatedRule))
        }
    }

    @Test(arguments: Engine.allCases)
    func `native execution and CLI policy edits share the same owner`(engine: Engine) async throws {
        try await self.withFixture(engine: engine) { fixture in
            var policy = self.policy(security: .allowlist, ask: .off)
            policy.agents = ["main": ExecApprovalsAgent(allowlist: [
                ExecAllowlistEntry(id: "native-proof-touch", pattern: "/usr/bin/touch"),
            ])]
            try await fixture.replace(policy)
            if engine == .postgres {
                #expect(try fixture.sqliteText("SELECT engine FROM openclaw_engine_anchor") == "postgres")
                #expect(try fixture.sqliteText(
                    "SELECT count(*) FROM sqlite_schema WHERE name='exec_approvals_config'") == "0")
            }
            let command = ["/usr/bin/touch", fixture.marker.path]
            let allowed = await ExecHostExecutor.handle(ExecHostRequest(command: command, cwd: fixture.root.path))
            #expect(allowed.ok)
            #expect(allowed.payload?.success == true)
            #expect(FileManager.default.fileExists(atPath: fixture.marker.path))
            let used = try await NativeExecPolicyOwner.snapshot(stateDirectory: fixture.root)
            #expect(used.file.agents?["main"]?.allowlist?.first?.lastUsedAt != nil)
            try FileManager.default.removeItem(at: fixture.marker)

            // This mutation enters through the CLI separately from the Swift adapter.
            let before = try await NativeExecPolicyOwner.snapshot(stateDirectory: fixture.root)
            _ = try await fixture.cli([
                "operation": "set", "baseHash": before.hash,
                "file": ["version": 1, "defaults": ["security": "deny"]],
            ])
            let observed = try await NativeExecPolicyOwner.snapshot(stateDirectory: fixture.root)
            #expect(observed.file.defaults?.security == .deny)
            let denied = await ExecHostExecutor.handle(ExecHostRequest(command: command, cwd: fixture.root.path))
            #expect(!denied.ok)
            #expect(denied.error?.reason == "security=deny")
            #expect(!FileManager.default.fileExists(atPath: fixture.marker.path))
        }
    }

    @Test func `explicit config path selects the native policy owner`() async throws {
        try await self.withFixture(engine: .sqlite, alternateConfig: true) { fixture in
            try await fixture.replace(self.policy(security: .full, ask: .off))
            let snapshot = try await NativeExecPolicyOwner.snapshot(stateDirectory: fixture.root)
            #expect(snapshot.file.defaults?.security == .full)
            let response = await ExecHostExecutor.handle(ExecHostRequest(
                command: ["/usr/bin/touch", fixture.marker.path], cwd: fixture.root.path))
            #expect(response.ok)
            #expect(response.payload?.success == true)
            #expect(FileManager.default.fileExists(atPath: fixture.marker.path))
        }
    }

    @Test(arguments: Engine.allCases)
    func `forwarded approval cannot restore policy changed while the decision was pending`(engine: Engine) async throws {
        try await self.withFixture(engine: engine) { fixture in
            try await fixture.replace(self.policy(security: .allowlist, ask: .onMiss))
            let pending = OpenClawSystemRunApprovalPolicySnapshot(
                security: .allowlist, ask: .onMiss, askFallback: .deny,
                autoAllowSkills: false, allowlistRules: [])
            try await fixture.replace(self.policy(security: .allowlist, ask: .always))
            let response = await ExecHostExecutor.handle(ExecHostRequest(
                command: ["/usr/bin/touch", fixture.marker.path], cwd: fixture.root.path,
                approvalDecision: .allowOnce, policySnapshot: pending))
            #expect(!response.ok)
            #expect(response.error?.reason == "approval-store-unavailable")
            #expect(
                response.error?.message.contains("changed before execution") == true,
                Comment(rawValue: response.error?.message ?? "Missing denial diagnostic"))
            #expect(!FileManager.default.fileExists(atPath: fixture.marker.path))
        }
    }

    @Test func `allow always owner failure after policy read prevents the native spawn`() async throws {
        try await self.withFixture(engine: .postgres) { fixture in
            try await fixture.replace(self.policy(security: .allowlist, ask: .onMiss))
            try Data().write(to: fixture.root.appendingPathComponent("fail-commit"))
            let pending = OpenClawSystemRunApprovalPolicySnapshot(
                security: .allowlist, ask: .onMiss, askFallback: .deny,
                autoAllowSkills: false, allowlistRules: [])
            let response = await ExecHostExecutor.handle(ExecHostRequest(
                command: ["/usr/bin/touch", fixture.marker.path], cwd: fixture.root.path,
                approvalDecision: .allowAlways, policySnapshot: pending))
            #expect(!response.ok)
            #expect(response.error?.reason == "approval-store-unavailable")
            #expect(response.error?.message.contains("Exec policy unavailable") == true)
            #expect(FileManager.default
                .fileExists(atPath: fixture.root.appendingPathComponent("commit-attempted").path))
            #expect(!FileManager.default.fileExists(atPath: fixture.marker.path))
            try fixture.writeConfig(connection: ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_POLICY_PG_URL"])
            let after = try await NativeExecPolicyOwner.snapshot(stateDirectory: fixture.root)
            #expect(after.file.agents?["main"]?.allowlist?.isEmpty != false)
        }
    }

    @Test func `unavailable PostgreSQL denies with a visible diagnostic without an anchor policy`() async throws {
        try await self.withFixture(engine: .postgres) { fixture in
            try await fixture.replace(self.policy(security: .full, ask: .off))
            try fixture.writeConfig(connection: "postgresql://nativeproof@127.0.0.1:1/postgres?connect_timeout=1")
            let response = await ExecHostExecutor.handle(ExecHostRequest(
                command: ["/usr/bin/touch", fixture.marker.path], cwd: fixture.root.path))
            #expect(!response.ok)
            #expect(response.error?.reason == "approval-store-unavailable")
            #expect(response.error?.message.contains("Exec policy unavailable") == true)
            #expect(!FileManager.default.fileExists(atPath: fixture.marker.path))
            #expect(try fixture.sqliteText(
                "SELECT count(*) FROM sqlite_schema WHERE name='exec_approvals_config'") == "0")
        }
    }

    @Test(arguments: [false, true])
    func `cancellation or disconnect after the owner commit never spawns`(disconnect: Bool) async throws {
        try await self.withFixture(engine: .sqlite) { fixture in
            try await fixture.replace(self.policy(security: .full, ask: .off))
            let request = ExecHostRequest(command: ["/usr/bin/touch", fixture.marker.path], cwd: fixture.root.path)
            try fixture.holdCommitResponse()
            if disconnect {
                let response = LockIsolated<ExecHostResponse?>(nil)
                let finished = AsyncTestSignal()
                let server = ExecApprovalsSocketServer(
                    socketPath: fixture.root.appendingPathComponent("exec.sock").path,
                    token: "native-proof-token", onPrompt: { _ in .deny },
                    onExec: { request in
                        let result = await ExecApprovalsStore.withStateDirectory(fixture.root) {
                            await ExecHostExecutor.handle(request)
                        }
                        response.setValue(result)
                        finished.notify()
                        return result
                    }, onUnexpectedStop: { _ in })
                try #require(await server.start())
                var client: Int32 = -1
                do {
                    client = try fixture.send(request)
                    try await fixture.waitForCommit()
                    close(client)
                    client = -1
                    try await finished.wait("disconnected native request unwound") { response.value != nil }
                    #expect(response.value?.ok == false)
                    try fixture.releaseCommitResponse()
                    await server.stop().value
                } catch {
                    if client >= 0 { close(client) }
                    try? fixture.releaseCommitResponse()
                    await server.stop().value
                    throw error
                }
            } else {
                let execution = Task { await ExecHostExecutor.handle(request) }
                do {
                    try await fixture.waitForCommit()
                    execution.cancel()
                    let response = try await TestWait.value(of: execution, "cancelled native request unwound")
                    #expect(!response.ok)
                    try fixture.releaseCommitResponse()
                } catch {
                    execution.cancel()
                    try? fixture.releaseCommitResponse()
                    _ = await execution.value
                    throw error
                }
            }
            #expect(!FileManager.default.fileExists(atPath: fixture.marker.path))
        }
    }

    @Test(arguments: ["rename", "symlink-retarget", "path-shadow"])
    func `replaced executable cannot cross the native pre-spawn boundary`(replacementKind: String) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let originalDirectory = root.appendingPathComponent("original-bin")
        let shadowDirectory = root.appendingPathComponent("shadow-bin")
        try FileManager.default.createDirectory(at: originalDirectory, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: shadowDirectory, withIntermediateDirectories: true)
        let executable = root.appendingPathComponent("tool")
        let original = replacementKind == "rename" ? executable : originalDirectory.appendingPathComponent("tool")
        let replacement = replacementKind == "path-shadow"
            ? shadowDirectory.appendingPathComponent("tool") : root.appendingPathComponent("replacement")
        let marker = root.appendingPathComponent("unexpected-spawn")
        try "#!/bin/sh\nexit 0\n".write(to: original, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: original.path)
        if replacementKind == "symlink-retarget" {
            try FileManager.default.createSymbolicLink(at: executable, withDestinationURL: original)
        }
        let command = replacementKind == "path-shadow" ? ["tool"] : [executable.path]
        let environment = ["PATH": "\(shadowDirectory.path):\(originalDirectory.path):/usr/bin:/bin"]
        let resolution = try #require(ExecCommandResolution.resolve(
            command: command, cwd: root.path, env: environment))
        let snapshots = ExecCommandResolution.captureApprovalExecutables([resolution])
        try #require(snapshots.count == 1)
        let cwd = try #require(ExecCommandResolution.captureApprovalCwdSnapshot(root.path))
        try "#!/bin/sh\n/usr/bin/touch '\(marker.path)'\n".write(
            to: replacement, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: replacement.path)
        if replacementKind == "rename" {
            try #require(rename(replacement.path, executable.path) == 0)
        } else if replacementKind == "symlink-retarget" {
            try FileManager.default.removeItem(at: executable)
            try FileManager.default.createSymbolicLink(at: executable, withDestinationURL: replacement)
        }
        let result = await ExecHostExecutor.runApprovedCommand(
            authorization: .currentPolicy(evaluatedSecurity: .full, evaluatedAsk: .off, basis: nil),
            command: command, cwd: cwd, env: environment, timeout: 2,
            executableSnapshots: snapshots)
        #expect(result.preflightError?.contains("approved executable changed") == true)
        #expect(!FileManager.default.fileExists(atPath: marker.path))
    }

    private func policy(security: ExecSecurity, ask: ExecAsk) -> ExecApprovalsFile {
        ExecApprovalsFile(version: 1, defaults: ExecApprovalsDefaults(
            security: security, ask: ask, askFallback: .deny, autoAllowSkills: false), agents: [:])
    }

    private func withFixture(
        engine: Engine,
        alternateConfig: Bool = false,
        _ body: (NativePolicyFixture) async throws -> Void) async throws
    {
        try #require(
            AppProfile.current.name?.hasPrefix("native-policy-") == true,
            "Select a private native-policy-* profile before loading the test process")
        let fixture = try NativePolicyFixture(engine: engine, alternateConfig: alternateConfig)
        try await TestIsolation.withIsolatedState(
            env: [
                "OPENCLAW_STATE_DIR": fixture.root.path,
                "OPENCLAW_CONFIG_PATH": fixture.configURL.path,
            ],
            defaults: ["openclaw.gatewayProjectRootPath": fixture.project.path])
        {
            do {
                try await ExecApprovalsStore.withStateDirectory(fixture.root) {
                    try await body(fixture)
                }
            } catch {
                try? await fixture.cleanUp()
                throw error
            }
            try await fixture.cleanUp()
        }
    }
}

private final class NativePolicyFixture: @unchecked Sendable {
    let root: URL
    let project: URL
    let marker: URL
    let configURL: URL
    private let engine: NativeExecPolicyOwnerTests.Engine
    private let connection: String?
    private let schemaPrefix: String
    private var gate: FileHandle?

    init(engine: NativeExecPolicyOwnerTests.Engine, alternateConfig: Bool = false) throws {
        self.engine = engine
        self.connection = ProcessInfo.processInfo.environment["OPENCLAW_NATIVE_POLICY_PG_URL"]
        self.schemaPrefix = "native_proof_" + UUID().uuidString.replacingOccurrences(of: "-", with: "").prefix(12)
            .lowercased()
        self.root = try ExecApprovalsSocketTestSupport.makeRoot()
        self.project = self.root.appendingPathComponent("cli")
        self.marker = self.root.appendingPathComponent("spawned")
        self.configURL = self.root.appendingPathComponent(alternateConfig ? "selected-config.json" : "openclaw.json")
        try self.writeConfig(connection: self.connection)
        if alternateConfig {
            // The fallback selects an unavailable owner, so ignoring the custom path cannot pass.
            let unavailable: [String: Any] = ["database": ["engine": "postgres", "postgres": [
                "connection": "postgresql://nativeproof@127.0.0.1:1/postgres?connect_timeout=1",
                "schemaPrefix": "unselected_native_proof",
            ]]]
            try JSONSerialization.data(withJSONObject: unavailable)
                .write(to: self.root.appendingPathComponent("openclaw.json"))
        }
        let bin = self.project.appendingPathComponent("node_modules/.bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        var repo = URL(fileURLWithPath: #filePath)
        for _ in 0..<5 {
            repo.deleteLastPathComponent()
        }
        try #require(
            FileManager.default.fileExists(atPath: repo.appendingPathComponent("dist/entry.js").path),
            "Build the CLI with pnpm build:runtime before native policy proof")
        let wrapper = bin.appendingPathComponent("openclaw")
        let quotedRepo = try #require(String(data: JSONEncoder().encode(repo.path), encoding: .utf8))
        let quotedRoot = try #require(String(data: JSONEncoder().encode(self.root.path), encoding: .utf8))
        try """
        #!/usr/bin/env node
        import fs from 'node:fs';
        import path from 'node:path';
        import { spawn } from 'node:child_process';
        const repo = \(quotedRepo);
        const root = \(quotedRoot);
        let input = '';
        for await (const chunk of process.stdin) input += chunk;
        const request = JSON.parse(input);
        if (request.operation === 'commit' && fs.existsSync(path.join(root, 'fail-commit'))) {
          fs.writeFileSync(path.join(root, 'commit-attempted'), 'final owner operation');
          const configPath = process.env.OPENCLAW_CONFIG_PATH;
          const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
          config.database.postgres.connection = 'postgresql://nativeproof@127.0.0.1:1/postgres?connect_timeout=1';
          fs.writeFileSync(configPath, JSON.stringify(config));
        }
        const child = spawn(process.execPath, [path.join(repo, 'openclaw.mjs'), ...process.argv.slice(2)],
          { cwd: repo, env: process.env, stdio: ['pipe', 'pipe', 'inherit'] });
        const output = [];
        child.stdout.on('data', chunk => output.push(chunk));
        child.stdin.end(input);
        const code = await new Promise(resolve => child.once('close', resolve));
        if (code === 0 && request.operation === 'commit' && fs.existsSync(path.join(root, 'hold'))) {
          fs.writeFileSync(path.join(root, 'committed'), 'owner committed');
          const descriptor = fs.openSync(path.join(root, 'gate'), 'r');
          fs.readSync(descriptor, Buffer.alloc(1), 0, 1, null);
          fs.closeSync(descriptor);
        }
        process.stdout.write(Buffer.concat(output));
        process.exitCode = code ?? 1;
        """.write(to: wrapper, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: wrapper.path)
    }

    func writeConfig(connection: String?) throws {
        var config: [String: Any] = [:]
        if self.engine == .postgres {
            let connection = try #require(
                connection,
                "Set OPENCLAW_NATIVE_POLICY_PG_URL to the disposable PostgreSQL server")
            config = ["database": ["engine": "postgres", "postgres": [
                "connection": connection, "schemaPrefix": self.schemaPrefix,
            ]]]
        }
        try JSONSerialization.data(withJSONObject: config).write(to: self.configURL)
    }

    func replace(_ file: ExecApprovalsFile) async throws {
        let current = try await NativeExecPolicyOwner.snapshot(stateDirectory: self.root)
        _ = try await NativeExecPolicyOwner.replace(file: file, baseHash: current.hash, stateDirectory: self.root)
        try ExecApprovalsSocketTestSupport.seedLocalCredentials(in: self.root)
    }

    func cli(_ request: [String: Any]) async throws -> Data {
        var environment = ProcessInfo.processInfo.environment
        environment["OPENCLAW_STATE_DIR"] = self.root.path
        environment["OPENCLAW_CONFIG_PATH"] = self.configURL.path
        environment["OPENCLAW_NO_BANNER"] = "1"
        let result = try await BoundedProcess.run(
            path: self.project.appendingPathComponent("node_modules/.bin/openclaw").path,
            arguments: AppProfile.current.cliRootArguments + ["approvals", "native", "--stdin", "--json"],
            environment: environment, input: JSONSerialization.data(withJSONObject: request),
            outputLimit: 1024 * 1024, timeout: 60)
        try #require(result.terminationStatus == 0, Comment(rawValue: String(decoding: result.output, as: UTF8.self)))
        return result.output
    }

    func sqliteText(_ sql: String) throws -> String {
        var database: OpaquePointer?
        let path = self.root.appendingPathComponent("state/openclaw.sqlite").path
        try #require(sqlite3_open_v2(path, &database, SQLITE_OPEN_READONLY, nil) == SQLITE_OK)
        defer { sqlite3_close(database) }
        var statement: OpaquePointer?
        try #require(sqlite3_prepare_v2(database, sql, -1, &statement, nil) == SQLITE_OK)
        defer { sqlite3_finalize(statement) }
        try #require(sqlite3_step(statement) == SQLITE_ROW)
        return String(cString: sqlite3_column_text(statement, 0))
    }

    func holdCommitResponse() throws {
        let fifo = self.root.appendingPathComponent("gate").path
        try #require(mkfifo(fifo, 0o600) == 0)
        let descriptor = open(fifo, O_RDWR | O_CLOEXEC)
        try #require(descriptor >= 0)
        self.gate = FileHandle(fileDescriptor: descriptor, closeOnDealloc: true)
        try Data().write(to: self.root.appendingPathComponent("hold"))
    }

    func waitForCommit() async throws {
        try await TestWait.state("actual owner commit before response") {
            FileManager.default.fileExists(atPath: self.root.appendingPathComponent("committed").path)
        }
    }

    func releaseCommitResponse() throws {
        try self.gate?.write(contentsOf: Data([1]))
    }

    func send(_ request: ExecHostRequest) throws -> Int32 {
        let descriptor = socket(AF_UNIX, SOCK_STREAM, 0)
        try #require(descriptor >= 0)
        do {
            var address = sockaddr_un()
            address.sun_family = sa_family_t(AF_UNIX)
            let path = self.root.appendingPathComponent("exec.sock").path
            try #require(path.utf8.count < MemoryLayout.size(ofValue: address.sun_path))
            path.withCString { source in
                withUnsafeMutablePointer(to: &address.sun_path) {
                    $0.withMemoryRebound(to: CChar.self, capacity: 104) { _ = strcpy($0, source) }
                }
            }
            let code = withUnsafePointer(to: &address) {
                $0.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                    Darwin.connect(descriptor, $0, socklen_t(MemoryLayout<sockaddr_un>.size))
                }
            }
            try #require(code == 0)
            let json = try #require(String(data: JSONEncoder().encode(request), encoding: .utf8))
            let nonce = UUID().uuidString
            let timestamp = Int(Date().timeIntervalSince1970 * 1000)
            let hmac = HMAC<SHA256>.authenticationCode(
                for: Data("\(nonce):\(timestamp):\(json)".utf8),
                using: SymmetricKey(data: Data("native-proof-token".utf8)))
                .map { String(format: "%02x", $0) }.joined()
            var bytes = try JSONEncoder().encode(ExecHostSocketRequest(
                type: "exec", id: nonce, nonce: nonce, ts: timestamp, hmac: hmac, requestJson: json))
            bytes.append(0x0A)
            try FileHandle(fileDescriptor: descriptor, closeOnDealloc: false).write(contentsOf: bytes)
            return descriptor
        } catch {
            close(descriptor)
            throw error
        }
    }

    func cleanUp() async throws {
        try self.gate?.close()
        if self.engine == .postgres, let connection, FileManager.default.fileExists(
            atPath: self.root.appendingPathComponent("state/openclaw.sqlite").path)
        {
            let schema = try self.sqliteText("SELECT schema FROM openclaw_engine_anchor")
            try #require(schema.hasPrefix(self.schemaPrefix + "_"))
            let result = try await BoundedProcess.run(
                path: "/opt/homebrew/opt/postgresql@17/bin/psql",
                arguments: [
                    connection, "-X", "-q", "-v", "ON_ERROR_STOP=1", "-c",
                    "SET client_min_messages = warning; DROP SCHEMA \"\(schema)\" CASCADE",
                ],
                outputLimit: 4096, timeout: 15)
            try #require(result.terminationStatus == 0, "Could not remove disposable PostgreSQL schema")
        }
        try FileManager.default.removeItem(at: self.root)
    }
}
