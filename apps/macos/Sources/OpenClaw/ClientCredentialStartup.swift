import Foundation
import OpenClawNativeState

@MainActor
enum ClientCredentialStartup {
    typealias CommandRunner = @Sendable ([String], String, [String: String]) async -> ShellExecutor.ShellResult

    /// The matching CLI reports a maintenance refusal without guessing the process owner.
    struct MaintenanceBlockedError: LocalizedError {
        let detail: String
        var errorDescription: String? {
            "Could not prepare local client credentials. " + self.detail
        }
    }

    /// Contention and unverifiable lock owners both require operator recovery, not manager guesses.
    nonisolated static func maintenanceBlockedRecovery(detail: String) -> (title: String, message: String) {
        let message = [
            "Local client credential maintenance could not acquire the shared state. Another OpenClaw process may hold it, or its owner could not be verified. The app did not stop or replace that process.",
            "Resolve the reported maintenance conflict through the matching CLI, service manager, or original terminal, then choose Retry.",
            "Change the Gateway or app version only if recovery identifies a version incompatibility.",
            "Details: " + detail,
        ].joined(separator: "\n\n")
        return ("Local credential maintenance is blocked", message)
    }

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
            if failure?["code"] as? String == "client_credentials_maintenance_blocked" {
                throw MaintenanceBlockedError(detail: detail)
            }
            throw OpenClawNativeStateError("Could not prepare local client credentials. " + detail)
        }
    }
}
