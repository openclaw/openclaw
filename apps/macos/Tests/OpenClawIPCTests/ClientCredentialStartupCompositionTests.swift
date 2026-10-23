import AppKit
import Darwin
import Foundation
import OpenClawIPC
import OpenClawNativeState
import Testing
@testable import OpenClaw
@testable import OpenClawKit
@testable import OpenClawMacCLI

/// Runs the real app only inside the disposable, staged app-host CI lane.
@Suite(.testWaitLimit)
@MainActor
struct ClientCredentialStartupCompositionTests {
    private nonisolated static var isAppHost: Bool {
        Bundle.main.bundleIdentifier == "ai.openclaw.mac.recovery-fixture" &&
            BundledRuntime.isBundledApp && AppProfile.current.isActive
    }

    @Test(.enabled(if: Self.isAppHost))
    func `app startup migrates credentials and reconciles a remount without rotating keys`() async throws {
        let profileName = "credential-" + UUID().uuidString.lowercased()
        let profile = AppProfile(environment: ["OPENCLAW_PROFILE": profileName])
        let root = profile.stateDirectoryURL()
        let suite = try #require(profile.defaultsSuiteName)
        let defaults = try #require(UserDefaults(suiteName: suite))
        var canRemoveFixture = true
        defer {
            if canRemoveFixture {
                defaults.removePersistentDomain(forName: suite)
                try? FileManager.default.removeItem(at: profile.instanceLockURL())
                try? FileManager.default.removeItem(at: root)
            } else {
                print("[credential-startup-proof] retained profile after unverified shutdown: \(root.path)")
            }
        }
        // Keep the synthetic installation paused; credential admission still runs.
        defaults.set(true, forKey: pauseDefaultsKey)
        defaults.set(true, forKey: onboardingSeenKey)
        defaults.synchronize()
        let material = DeviceIdentityStore.generateMaterial()
        try Self.seedNativeSource(root: root, material: material)
        try Data("{}".utf8).write(to: root.appendingPathComponent("openclaw.json"))
        let app = Bundle.main.bundleURL.deletingLastPathComponent()
            .appendingPathComponent("OpenClawStartupFixture.app")
        try #require(FileManager.default.isExecutableFile(
            atPath: app.appendingPathComponent("Contents/MacOS/OpenClaw").path))

        try await Self.assertAppCredentials(
            app: app, root: root, profileName: profileName, material: material,
            retainFixture: { canRemoveFixture = false })
        print("[credential-startup-proof] pending migration: app admitted; identity, private key, token preserved")

        let sharedURL = root.appendingPathComponent("state/openclaw.sqlite")
        let actualBinding = try ClientCredentialReceipt.SharedFile.inspect(sharedURL)
        do {
            let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
            defer { owner.close() }
            var receipt = try #require(owner.readReceipt()?.receipt)
            try #require(receipt.source?.kind == "canonical")
            try #require(receipt.sharedFile == actualBinding)
            // A remount changes the volume's device number while preserving this file's inode.
            receipt.sharedFile?.dev = actualBinding.dev == "1" ? "2" : "1"
            try owner.writeReceipt(receipt)
            #expect(throws: OpenClawNativeStateError.self) { try owner.assertReady(rootURL: root) }
        }
        try await Self.assertAppCredentials(
            app: app, root: root, profileName: profileName, material: material,
            retainFixture: { canRemoveFixture = false })
        let owner = try OpenClawClientCredentialStore(rootURL: root, migration: true)
        defer { owner.close() }
        try #require(try owner.readReceipt()?.receipt.sharedFile == actualBinding)
        print(
            "[credential-startup-proof] remount: app admitted; binding repaired; identity, private key, token preserved")
    }

    private static func assertAppCredentials(
        app: URL,
        root: URL,
        profileName: String,
        material: DeviceIdentityMaterial,
        retainFixture: () -> Void) async throws
    {
        var environment = ProcessInfo.processInfo.environment
        environment["OPENCLAW_PROFILE"] = profileName
        environment["OPENCLAW_STATE_DIR"] = root.path
        environment["OPENCLAW_CONFIG_PATH"] = root.appendingPathComponent("openclaw.json").path
        var completion: ShellExecutor.ShellResult?
        let child = Task { @MainActor in
            completion = await ShellExecutor.runDetailed(
                command: [
                    app.appendingPathComponent("Contents/MacOS/OpenClaw").path,
                    "--no-activate", "--background-only", "--attach-only",
                ],
                cwd: root.path,
                env: environment,
                timeout: CLIInstaller.managedUpdateTimeout)
        }
        do {
            var identityOperation = ClientCredentialOperation(kind: .identityRead)
            identityOperation.identity_key = "primary"
            var identity: OpenClawClientCredentialStore.Identity?
            try await TestWait.state("real app credential admission") {
                if let completion {
                    throw OpenClawNativeStateError(
                        "App exited before credential admission: " + completion.stderr.suffix(4000))
                }
                do {
                    identity = try await Self.read(root: root, profileName: profileName, operation: identityOperation)
                        .identity
                    return identity != nil
                } catch is MacControlConnectionRefused {
                    return false
                } catch let error as MacControlError where error.code == "unreachable" {
                    return false
                }
            }
            try #require(identity?.deviceID == material.identity.deviceId)
            try #require(identity?.publicKeyPEM == material.publicKeyPEM)
            try #require(identity?.privateKeyPEM == material.privateKeyPEM)
            try #require(identity?.createdAtMs == material.identity.createdAtMs)
            var tokenOperation = ClientCredentialOperation(kind: .tokenRead)
            tokenOperation.key = .init(deviceID: material.identity.deviceId, role: "operator")
            let token = try await Self.read(root: root, profileName: profileName, operation: tokenOperation).token
            try #require(token?.token == "synthetic-startup-retained")
            try #require(token?.scopesJSON == "[]")
            try #require(token?.updatedAtMs == 19)
        } catch {
            try? await Self.stopApp(
                app: app, child: child, alreadyExited: completion != nil, retainFixture: retainFixture)
            throw error
        }
        try await Self.stopApp(
            app: app, child: child, alreadyExited: completion != nil, retainFixture: retainFixture)
    }

    private static func stopApp(
        app: URL,
        child: Task<Void, Never>,
        alreadyExited: Bool,
        retainFixture: () -> Void) async throws
    {
        // Cleanup must finish even when the suite cancelled its current test task.
        let cleanup = Task { @MainActor in
            if alreadyExited {
                await child.value
                return false
            }
            let executable = app.appendingPathComponent("Contents/MacOS/OpenClaw").resolvingSymlinksInPath()
            let matches = NSWorkspace.shared.runningApplications.filter {
                $0.executableURL?.resolvingSymlinksInPath() == executable
            }
            guard matches.count == 1, let owned = matches.first,
                  kill(owned.processIdentifier, SIGTERM) == 0
            else {
                child.cancel()
                await child.value
                return false
            }
            // Let the app stop workers with separate process groups before the outer owner exits.
            var forced = false
            let fallback = Task { @MainActor in
                do {
                    try await Task.sleep(for: .seconds(AppTerminationTiming.signalExitFailsafeSeconds + 2))
                    forced = true
                    child.cancel()
                } catch {}
            }
            await child.value
            fallback.cancel()
            await fallback.value
            return !forced
        }
        let stopped = await cleanup.value
        if !stopped { retainFixture() }
        try #require(stopped, "The exact fixture app did not complete graceful shutdown")
    }

    private static func read(
        root: URL,
        profileName: String,
        operation: ClientCredentialOperation) async throws -> ClientCredentialResult
    {
        try await ExecApprovalsSocketTestSupport.withBlockingSocketIO {
            var request = MacControlRequest(operation: "client.credentials")
            request.credentialRoot = root.resolvingSymlinksInPath().path
            request.credentialOperation = operation
            var options = try MacControlOptions(request: request, profile: MacControlProfile(rawValue: profileName))
            options.launch = false
            // Send directly to the app. The offline fallback would invalidate this startup proof.
            let data = try MacControlClient(options: options, directory: root).send(request)
            let response = try JSONDecoder().decode(MacControlResponse<ClientCredentialResult>.self, from: data)
            if let error = response.error { throw error }
            return try #require(response.result)
        }
    }

    private static func seedNativeSource(root: URL, material: DeviceIdentityMaterial) throws {
        let source = try OpenClawNativeStateSQLite(databaseURL: root.appendingPathComponent("state/openclaw.sqlite"))
        // Frozen native-v0 credential schema, before canonical-owner extraction.
        try source.execute("""
        CREATE TABLE device_identities (
          identity_key TEXT NOT NULL PRIMARY KEY, device_id TEXT NOT NULL, public_key_pem TEXT NOT NULL,
          private_key_pem TEXT NOT NULL, created_at_ms INTEGER NOT NULL, updated_at_ms INTEGER NOT NULL
        ) STRICT;
        CREATE INDEX idx_device_identities_device ON device_identities(device_id, updated_at_ms DESC);
        CREATE TABLE device_auth_tokens (
          device_id TEXT NOT NULL, role TEXT NOT NULL, token TEXT NOT NULL, scopes_json TEXT NOT NULL,
          updated_at_ms INTEGER NOT NULL, PRIMARY KEY (device_id, role)
        ) STRICT;
        CREATE INDEX idx_device_auth_tokens_updated ON device_auth_tokens(updated_at_ms DESC, device_id, role);
        """)
        let identity = try source.prepare("INSERT INTO device_identities VALUES ('primary',?,?,?,?,?)")
        try identity.bindText(material.identity.deviceId, at: 1)
        try identity.bindText(material.publicKeyPEM, at: 2)
        try identity.bindText(material.privateKeyPEM, at: 3)
        try identity.bindInt64(material.identity.createdAtMs, at: 4)
        try identity.bindInt64(material.identity.createdAtMs, at: 5)
        _ = try identity.step()
        let token = try source.prepare(
            "INSERT INTO device_auth_tokens VALUES (?, 'operator', 'synthetic-startup-retained', '[]', 19)")
        try token.bindText(material.identity.deviceId, at: 1)
        _ = try token.step()
    }
}
