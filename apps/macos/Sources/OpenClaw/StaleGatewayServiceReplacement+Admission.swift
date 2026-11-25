import Foundation

extension StaleGatewayServiceReplacement {
    /// Ask the captured build to inspect the current profile with its own read-only update admission.
    /// The previous attempt may already have migrated state before this attempt even stopped the service.
    static func previousServiceAcceptsState(
        _ previous: GatewayLaunchAgentManager.InstalledServiceCLI,
        entrypoint: String,
        authority: GatewayLaunchAgentManager.ServiceAuthority) async -> Bool
    {
        guard let installed = BundledRuntime(serviceEntrypoint: entrypoint),
              let appVersion = GatewayEnvironment.appVersionString(),
              let data = try? Data(contentsOf: installed.packageRoot.appendingPathComponent("package.json")),
              let manifest = try? JSONDecoder().decode(AdmissionManifest.self, from: data),
              manifest.name == "openclaw", manifest.openclaw.updateAdmissionProtocol == 1,
              let snapshot = LaunchAgentPlist.snapshot(
                  url: authority.plist,
                  generatedEnvironmentFileURL: authority.environment,
                  generatedEnvironmentWrapperURL: authority.wrapper),
              let environment = admissionEnvironment(
                  service: snapshot, package: installed.packageRoot.path, version: manifest.version)
        else { return false }

        let package = installed.packageRoot.path
        let version = manifest.version
        let runID = UUID().uuidString
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent(runID, isDirectory: true)
        do {
            try FileManager.default.createDirectory(
                at: directory, withIntermediateDirectories: false, attributes: [.posixPermissions: 0o700])
            defer { try? FileManager.default.removeItem(at: directory) }
            // An unreadable generated environment must not turn an override into a default.
            if previous.usesGeneratedEnvironment {
                let exports = try String(contentsOf: authority.environment, encoding: .utf8)
                _ = try LaunchAgentPlist.parseGeneratedEnvironment(exports)
            }
            let context = directory.appendingPathComponent("context.json")
            let request: [String: Any] = [
                "protocol": 1,
                "installation": [
                    "root": package,
                    "canonicalRoot": package,
                    "version": version,
                    "installKind": "package",
                    "packageManager": "bun",
                ],
                "target": [
                    "spec": package,
                    "version": version,
                    "source": "artifact",
                    "channel": authority.updateSelection.gatewayUpdateChannel ?? "stable",
                ],
                "request": ["yes": false, "noRestart": true, "acceptCapabilities": false, "json": true],
                "run": ["id": runID],
                "supervisor": [
                    "version": appVersion,
                    "host": ProcessInfo.processInfo.hostName,
                    "pid": ProcessInfo.processInfo.processIdentifier,
                ],
            ]
            let bytes = try JSONSerialization.data(withJSONObject: request)
            guard FileManager.default.createFile(
                atPath: context.path, contents: bytes, attributes: [.posixPermissions: 0o600])
            else { return false }
            let result = await ShellExecutor.runDetailed(
                command: previous.prefix + ["update", "admit", "--context", context.path],
                cwd: snapshot.workingDirectory ?? "/",
                env: environment,
                timeout: CLIInstaller.managedUpdateTimeout,
                beforeSpawn: { GatewayLaunchAgentManager.serviceUpdateAuthorityError(for: previous) })
            return Self.admitsRestore(result, version: version)
        } catch {
            return false
        }
    }

    static func admissionEnvironment(service: LaunchAgentPlistSnapshot, package: String, version: String)
        -> [String: String]?
    {
        // The app's profile can differ from the service's. Inspect with the captured launchd selectors.
        guard !service.programArguments.contains(where: {
            $0 == "--dev" || $0 == "--profile" || $0.hasPrefix("--profile=") ||
                $0 == "--container" || $0.hasPrefix("--container=")
        }), service.environment["OPENCLAW_CONTAINER"]?.nonEmpty == nil,
        service.environment["HOME"]?.hasPrefix("/") == true
        else { return nil }
        var environment = GatewayChildSupervisor.environmentWithoutSupervisorMarkers(service.environment)
        environment = environment.filter { !$0.key.hasPrefix("OPENCLAW_UPDATE_") }
        for key in [
            "OPENCLAW_CONTROL_PLANE_UPDATE_SENTINEL_META", "OPENCLAW_GATEWAY_SERVICE_PID",
            "OPENCLAW_COMPATIBILITY_HOST_VERSION", "OPENCLAW_REPLACING_GATEWAY_SERVICE_ENTRYPOINT",
            "OPENCLAW_BUNDLED_PLUGINS_DIR", "NODE_COMPILE_CACHE",
        ] {
            environment[key] = nil
        }
        environment["OPENCLAW_DEV_SOURCE_ROOT"] = package
        environment["OPENCLAW_VERSION"] = version
        environment["NODE_DISABLE_COMPILE_CACHE"] = "1"
        environment["OPENCLAW_NO_RESPAWN"] = "1"
        return environment
    }

    static func admitsRestore(_ result: ShellExecutor.ShellResult, version: String) -> Bool {
        guard result.success, result.exitCode == 0, !result.timedOut, !result.signaled,
              let receipt = try? JSONDecoder().decode(AdmissionVerdict.self, from: Data(result.stdout.utf8))
        else { return false }
        // A projected config can pass update admission because Doctor could repair it later.
        // Starting the old service needs its current config and schemas to pass as they stand.
        let checks = receipt.facts.checks
        let passed = Set(checks.filter { $0.status == "ok" }.map(\.name))
        return receipt.protocol == 1 && receipt.verdict == "admit" && receipt.reasons.isEmpty &&
            receipt.facts.candidateVersion == version && receipt.facts.installedVersion == version &&
            Set(checks.map(\.name)).count == checks.count &&
            checks.allSatisfy { $0.status == "ok" || $0.status == "warn" } &&
            passed.contains("config") && passed.contains("database-schema")
    }

    private struct AdmissionManifest: Decodable {
        struct Capabilities: Decodable { let updateAdmissionProtocol: Int }
        let name: String
        let version: String
        let openclaw: Capabilities
    }

    private struct AdmissionVerdict: Decodable {
        struct Facts: Decodable {
            struct Check: Decodable {
                let name: String
                let status: String
            }

            let installedVersion: String
            let candidateVersion: String
            let checks: [Check]
        }

        struct Diagnostic: Decodable {
            let code: String
            let message: String
        }

        let `protocol`: Int
        let reasons: [Diagnostic]
        let warnings: [Diagnostic]
        let verdict: String
        let facts: Facts
    }
}
