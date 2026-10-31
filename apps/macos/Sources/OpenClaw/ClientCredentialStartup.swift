import Foundation
import OpenClawNativeState

@MainActor
enum ClientCredentialStartup {
    /// The matching CLI reports that a running Gateway holds the state this migration must change.
    struct GatewayHeldError: LocalizedError {
        let detail: String
        var errorDescription: String? {
            "Could not prepare local client credentials. " + self.detail
        }
    }

    /// Recovery for a Gateway-held preparation while another owner keeps that Gateway's version.
    /// Migration retires the credential layout that Gateway reads, so the app neither stops it
    /// nor migrates under it; the operator updates it through its owner or keeps a matching app.
    nonisolated static func excludedGatewayRecovery(
        _ exclusion: CLIInstallPrompter.ManagedRepairExclusion,
        appVersion: String?,
        detail: String) -> (title: String, message: String)
    {
        let target = appVersion.map { "OpenClaw \($0) or newer" } ?? "this app's version or newer"
        let owner: String
        let update: String
        switch exclusion {
        case .extendedStable:
            owner = "Your local Gateway follows the extended-stable channel, so OpenClaw kept its version."
            update = "To use this app, move the Gateway to \(target) with openclaw update --channel stable."
        case let .installPolicy(policy):
            owner = "OpenClaw installs Gateways from the \(policy) channel, so it left this Gateway's version " +
                "to openclaw update."
            update = "To use this app, update the Gateway to \(target) with openclaw update."
        case .independentlyManaged:
            owner = "Your local Gateway service is managed outside OpenClaw, so the app did not stop or replace it."
            update = "To use this app, update the Gateway to \(target) with the tool that manages it."
        }
        let message = [
            owner,
            "This app must migrate local client credentials, and that Gateway is still using them. " +
                "Its current version can't read the migrated credentials, so the app left it running " +
                "and stopped before migrating.",
            update + " Then choose Retry.",
            "To keep the Gateway's current version, quit and install the OpenClaw app release that matches it.",
            "Details: " + detail.suffix(300),
        ].joined(separator: "\n\n")
        return ("OpenClaw couldn't migrate client credentials", message)
    }

    typealias CommandRunner = @Sendable ([String], String, [String: String]) async -> ShellExecutor.ShellResult

    /// Run the app's matching migration owner before native credential admission.
    /// The selected Gateway may still use an older runtime; PATH is not an update authority.
    static func prepare(
        executionRoot: URL,
        configURL: URL,
        bundle: Bundle = .main,
        profile: AppProfile = .current,
        environment: [String: String] = ProcessInfo.processInfo.environment,
        runCommand: CommandRunner = { command, cwd, environment in
            await ShellExecutor.runDetailed(
                command: command,
                cwd: cwd,
                env: environment,
                timeout: CLIInstaller.managedUpdateTimeout)
        }) async throws
    {
        try Task.checkCancellation()
        let runtime = try BundledRuntime.resolve(bundle: bundle)
        var childEnvironment = environment.merging(runtime.environment) { _, bundled in bundled }
        childEnvironment["OPENCLAW_PROFILE"] = profile.name ?? "default"
        childEnvironment["OPENCLAW_STATE_DIR"] = executionRoot.path
        childEnvironment["OPENCLAW_CONFIG_PATH"] = configURL.path
        let command = profile.localCLICommand(
            prefix: runtime.cliCommand,
            arguments: ["doctor", "--client-credentials", "--fix", "--non-interactive", "--json"])
        let result = await runCommand(command, runtime.packageRoot.path, childEnvironment)
        try Task.checkCancellation()
        guard result.success, !result.timedOut, result.exitCode == 0 else {
            // --json reports the failure on stdout; stderr keeps warnings and pre-dispatch errors.
            let output = try? JSONSerialization.jsonObject(with: Data(result.stdout.utf8)) as? [String: Any]
            let failure = output?["error"] as? [String: Any]
            let candidates = [failure?["message"] as? String, result.preflightError, result.stderr, result.errorMessage]
            let message = candidates.compactMap { $0?.nonEmpty }.first ?? "Credential preparation did not complete."
            let detail = String(message.suffix(4000))
            if failure?["code"] as? String == "client_credentials_gateway_held" {
                throw GatewayHeldError(detail: detail)
            }
            throw OpenClawNativeStateError("Could not prepare local client credentials. " + detail)
        }
    }
}
