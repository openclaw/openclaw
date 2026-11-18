import Foundation
import OpenClawNativeState
import Testing
@testable import OpenClaw

@MainActor
struct ClientCredentialStartupTests {
    @Test(arguments: ["default", "credential-fixture"])
    func `startup uses the matching bundled owner and explicit execution root`(_ profileName: String) async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": profileName])
        try await ClientCredentialStartup.prepare(
            executionRoot: fixture.executionRoot,
            configURL: fixture.configURL,
            bundle: fixture.bundle,
            profile: profile,
            environment: fixture.environment)

        let expectedArguments = (profileName == "default" ? [] : ["--profile", profileName]) +
            ["doctor", "--client-credentials", "--fix", "--non-interactive"]
        let observed = try String(contentsOf: fixture.capture, encoding: .utf8)
            .split(separator: "\n").map(String.init)
        #expect(observed == [
            fixture.executionRoot.path,
            fixture.configURL.path,
            profileName,
            fixture.app.appendingPathComponent("Contents/Resources/runtime/lib/libsqlite3.dylib").path,
        ] + expectedArguments)
        #expect(!FileManager.default.fileExists(atPath: fixture.externalMarker.path))
    }

    @Test func `failed preparation cannot report startup ready or select a fallback CLI`() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        var environment = fixture.environment
        environment["TEST_EXIT_CODE"] = "7"
        do {
            try await ClientCredentialStartup.prepare(
                executionRoot: fixture.executionRoot,
                configURL: fixture.configURL,
                bundle: fixture.bundle,
                profile: AppProfile(environment: [:]),
                environment: environment)
            Issue.record("Failed credential preparation was reported as ready")
        } catch let error as OpenClawNativeStateError {
            #expect(error.message.contains("synthetic preparation failure"))
        }
        #expect(FileManager.default.fileExists(atPath: fixture.capture.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.externalMarker.path))
    }

    @Test func `a mismatched bundled build never dispatches preparation through another CLI`() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        try Data("{}".utf8).write(to: fixture.buildInfo)
        await #expect(throws: MacNodeHostWorker.WorkerError.self) {
            try await ClientCredentialStartup.prepare(
                executionRoot: fixture.executionRoot,
                configURL: fixture.configURL,
                bundle: fixture.bundle,
                profile: AppProfile(environment: [:]),
                environment: fixture.environment)
        }
        #expect(!FileManager.default.fileExists(atPath: fixture.capture.path))
        #expect(!FileManager.default.fileExists(atPath: fixture.externalMarker.path))
    }

    @Test func `cancellation after preparation settles cannot report startup ready`() async throws {
        let fixture = try Fixture()
        defer { fixture.remove() }
        let operation = Task { @MainActor in
            try await ClientCredentialStartup.prepare(
                executionRoot: fixture.executionRoot,
                configURL: fixture.configURL,
                bundle: fixture.bundle,
                profile: AppProfile(environment: [:]),
                environment: fixture.environment,
                runCommand: { _, _, _ in
                    // Model a child that completed as shutdown cancelled its parent.
                    withUnsafeCurrentTask { $0?.cancel() }
                    return ShellExecutor.ShellResult(
                        stdout: "", stderr: "", exitCode: 0, timedOut: false, success: true)
                })
        }
        await #expect(throws: CancellationError.self) { try await operation.value }
        #expect(!FileManager.default.fileExists(atPath: fixture.capture.path))
    }

    private struct Fixture {
        let root: URL
        let app: URL
        let bundle: Bundle
        let executionRoot: URL
        let configURL: URL
        let capture: URL
        let externalMarker: URL
        let buildInfo: URL
        let environment: [String: String]

        init() throws {
            let root = try makeTempDirForTests()
            do {
                let app = root.appendingPathComponent("Moved App.app")
                let runtime = app.appendingPathComponent("Contents/Resources/runtime")
                let package = runtime.appendingPathComponent("lib/node_modules/openclaw")
                let executionRoot = root.appendingPathComponent("execution root")
                let configURL = root.appendingPathComponent("selected config.json")
                let capture = root.appendingPathComponent("preparation.txt")
                let external = root.appendingPathComponent("external/openclaw")
                let externalMarker = root.appendingPathComponent("external-called")
                for directory in [
                    app.appendingPathComponent("Contents/MacOS"),
                    runtime.appendingPathComponent("bin"),
                    package.appendingPathComponent("dist"),
                    external.deletingLastPathComponent(),
                    executionRoot,
                ] {
                    try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                }
                let commit = String(repeating: "a", count: 40)
                let info: [String: Any] = [
                    "CFBundleIdentifier": "ai.openclaw.credential-startup-tests",
                    "CFBundleExecutable": "OpenClaw",
                    "CFBundlePackageType": "APPL",
                    "CFBundleShortVersionString": "2026.10.5",
                    "CFBundleVersion": "1",
                    "OpenClawGitCommit": commit,
                    "OpenClawBuildTimestamp": "2026-10-20T00:00:00.000Z",
                    "OpenClawRuntimeBuildID": "credential-fixture",
                ]
                try PropertyListSerialization.data(fromPropertyList: info, format: .xml, options: 0)
                    .write(to: app.appendingPathComponent("Contents/Info.plist"))
                let buildInfo = package.appendingPathComponent("dist/build-info.json")
                try JSONSerialization.data(withJSONObject: [
                    "version": "2026.10.5", "commit": commit,
                    "builtAt": "2026-10-20T00:00:00.000Z", "buildId": "credential-fixture",
                ]).write(to: buildInfo)
                let bun = runtime.appendingPathComponent("bin/bun")
                try "#!/bin/sh\nexec /bin/sh \"$@\"\n".write(to: bun, atomically: true, encoding: .utf8)
                try "#!/bin/sh\n: > \"$TEST_EXTERNAL_MARKER\"\nexit 99\n"
                    .write(to: external, atomically: true, encoding: .utf8)
                for executable in [bun, external] {
                    try FileManager.default.setAttributes([.posixPermissions: 0o755], ofItemAtPath: executable.path)
                }
                try Data().write(to: runtime.appendingPathComponent("lib/libsqlite3.dylib"))
                try """
                printf '%s\\n' "$OPENCLAW_STATE_DIR" "$OPENCLAW_CONFIG_PATH" "$OPENCLAW_PROFILE" \\
                  "$OPENCLAW_SQLITE_LIBRARY" "$@" > "$TEST_CAPTURE"
                if [ "${TEST_EXIT_CODE:-0}" != 0 ]; then
                  printf '%s\\n' 'synthetic preparation failure' >&2
                  exit "$TEST_EXIT_CODE"
                fi
                """.write(to: package.appendingPathComponent("openclaw.mjs"), atomically: true, encoding: .utf8)
                self.root = root
                self.app = app
                self.bundle = try #require(Bundle(url: app))
                self.executionRoot = executionRoot
                self.configURL = configURL
                self.capture = capture
                self.externalMarker = externalMarker
                self.buildInfo = buildInfo
                self.environment = [
                    "HOME": root.path,
                    "PATH": external.deletingLastPathComponent().path,
                    "OPENCLAW_PROFILE": "wrong-inherited-profile",
                    "OPENCLAW_STATE_DIR": root.appendingPathComponent("wrong-state").path,
                    "OPENCLAW_CONFIG_PATH": root.appendingPathComponent("wrong-config").path,
                    "TEST_CAPTURE": capture.path,
                    "TEST_EXTERNAL_MARKER": externalMarker.path,
                ]
            } catch {
                try? FileManager.default.removeItem(at: root)
                throw error
            }
        }

        func remove() {
            try? FileManager.default.removeItem(at: self.root)
        }
    }
}
