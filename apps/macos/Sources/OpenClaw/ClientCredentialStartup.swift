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

    /// A Gateway-held refusal establishes maintenance contention, not version incompatibility.
    nonisolated static func excludedGatewayRecovery(
        _ exclusion: CLIInstallPrompter.ManagedRepairExclusion,
        detail: String) -> (title: String, message: String)
    {
        let owner = switch exclusion {
        case .extendedStable:
            "Your local Gateway follows the extended-stable channel, so OpenClaw kept its version."
        case let .installPolicy(policy):
            "OpenClaw installs Gateways from the \(policy) channel, so it left this Gateway's version " +
                "to openclaw update."
        case .independentlyManaged:
            "Your local Gateway service is managed outside OpenClaw, so the app did not stop or replace it."
        }
        let message = [
            owner,
            "This app needs to perform local client credential maintenance, but a running Gateway holds " +
                "the shared state. The app left it running and stopped before performing that maintenance.",
            "Resolve the reported maintenance conflict through the tool that manages your Gateway, then choose Retry.",
            "Change the Gateway or app version only if recovery identifies a version incompatibility.",
            "Details: " + detail.suffix(300),
        ].joined(separator: "\n\n")
        return ("OpenClaw couldn't prepare client credentials", message)
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
