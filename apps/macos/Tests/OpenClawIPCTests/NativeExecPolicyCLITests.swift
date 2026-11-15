import Foundation
import Testing
@testable import OpenClaw

struct NativeExecPolicyCLITests {
    @Test(arguments: [false, true])
    func `packaged approvals use matching payload without gateway setup`(explicitConfig: Bool) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = try self.makeBundle(in: root)
        let state = root.appendingPathComponent("remote-only-state")
        let external = try self.makeExternalCLI(in: root)
        let selectedConfig = state.appendingPathComponent(explicitConfig ? "selected.json" : "openclaw.json")
        var environment = [
            "OPENCLAW_PROFILE": "remote-policy",
            "OPENCLAW_SQLITE_LIBRARY": "/stale/libsqlite3.dylib",
            "PRESERVED": "inherited value",
        ]
        environment["OPENCLAW_CONFIG_PATH"] = explicitConfig ? selectedConfig.path : " \n"
        let launch = try await NativeExecPolicyOwner.launch(
            stateDirectory: state,
            bundle: bundle,
            environment: environment,
            profile: AppProfile(environment: environment),
            searchPaths: [external.path],
            projectRoot: root)
        let result = try await BoundedProcess.runCapturingError(
            path: #require(launch.command.first),
            arguments: Array(launch.command.dropFirst()),
            environment: launch.environment,
            input: Data("{\"operation\":\"get\"}\n".utf8),
            outputLimit: 4096,
            timeout: 5)
        #expect(result.terminationStatus == 0)
        let runtime = bundle.bundleURL.appendingPathComponent("Contents/Resources/runtime")
        #expect(String(data: result.output, encoding: .utf8) == """
        {"operation":"get"}
        \(state.path)
        \(selectedConfig.path)
        remote-policy
        \(runtime.appendingPathComponent("lib/libsqlite3.dylib").path)
        inherited value
        --profile
        remote-policy
        approvals
        native
        --stdin
        --json

        """)
        #expect(!FileManager.default.fileExists(atPath: external.appendingPathComponent("invoked").path))
        #expect(!FileManager.default.fileExists(atPath: state.path))
    }

    @Test(arguments: ["build", "bun"])
    func `broken packaged payload does not run external CLI`(failure: String) async throws {
        let root = try makeTempDirForTests()
        defer { try? FileManager.default.removeItem(at: root) }
        let bundle = try self.makeBundle(in: root)
        let runtime = bundle.bundleURL.appendingPathComponent("Contents/Resources/runtime")
        try FileManager.default.removeItem(at: runtime.appendingPathComponent(
            failure == "build" ? "lib/node_modules/openclaw/dist/build-info.json" : "bin/bun"))
        let external = try self.makeExternalCLI(in: root)
        await #expect(throws: MacNodeHostWorker.WorkerError.self) {
            try await NativeExecPolicyOwner.launch(
                stateDirectory: root.appendingPathComponent("state"),
                bundle: bundle,
                environment: [:],
                profile: AppProfile(environment: [:]),
                searchPaths: [external.path],
                projectRoot: root)
        }
    }

    private func makeExternalCLI(in root: URL) throws -> URL {
        let bin = root.appendingPathComponent("old-nvm-bin")
        try FileManager.default.createDirectory(at: bin, withIntermediateDirectories: true)
        let cli = bin.appendingPathComponent("openclaw")
        try """
        #!/bin/sh
        /usr/bin/touch "$(/usr/bin/dirname "$0")/invoked"
        echo 'unknown option --stdin' >&2
        exit 64

        """.write(to: cli, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: cli.path)
        return bin
    }

    private func makeBundle(in root: URL) throws -> Bundle {
        let app = root.appendingPathComponent("Relocated.app")
        let contents = app.appendingPathComponent("Contents")
        let runtime = contents.appendingPathComponent("Resources/runtime")
        let package = runtime.appendingPathComponent("lib/node_modules/openclaw")
        try FileManager.default.createDirectory(
            at: contents.appendingPathComponent("MacOS"),
            withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: package.appendingPathComponent("dist"),
            withIntermediateDirectories: true)
        try FileManager.default.createDirectory(
            at: runtime.appendingPathComponent("bin"),
            withIntermediateDirectories: true)
        let commit = String(repeating: "a", count: 40)
        let info: [String: Any] = [
            "CFBundleIdentifier": "ai.openclaw.policy-fixture",
            "CFBundlePackageType": "APPL",
            "CFBundleShortVersionString": "2026.11.2",
            "OpenClawGitCommit": commit,
            "OpenClawBuildTimestamp": "2026-11-02T00:00:00Z",
            "OpenClawRuntimeBuildID": "policy-fixture",
        ]
        try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
            .write(to: contents.appendingPathComponent("Info.plist"))
        try JSONSerialization.data(withJSONObject: [
            "version": "2026.11.2", "commit": commit, "builtAt": "2026-11-02T00:00:00Z",
            "buildId": "policy-fixture",
        ]).write(to: package.appendingPathComponent("dist/build-info.json"))
        let bun = runtime.appendingPathComponent("bin/bun")
        try "#!/bin/sh\nexec /bin/sh \"$@\"\n".write(to: bun, atomically: true, encoding: .utf8)
        try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: bun.path)
        try Data().write(to: runtime.appendingPathComponent("lib/libsqlite3.dylib"))
        // Exercise the actual subprocess launch, stdin, arguments and environment, not a resolver mock.
        try """
        IFS= read -r request
        printf '%s\\n' "$request" "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" \\
          "$OPENCLAW_PROFILE" "$OPENCLAW_SQLITE_LIBRARY" "$PRESERVED" "$@"
        """.write(to: package.appendingPathComponent("openclaw.mjs"), atomically: true, encoding: .utf8)
        return try #require(Bundle(url: app))
    }
}
