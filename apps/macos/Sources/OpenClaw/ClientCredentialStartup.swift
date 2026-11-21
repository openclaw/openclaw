import Foundation
import OpenClawNativeState

@MainActor
enum ClientCredentialStartup {
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
            arguments: ["doctor", "--client-credentials", "--fix", "--non-interactive"])
        let result = await runCommand(command, runtime.packageRoot.path, childEnvironment)
        try Task.checkCancellation()
        guard result.success, !result.timedOut, result.exitCode == 0 else {
            let preflightError = result.preflightError?.nonEmpty
            let stderr = result.stderr.nonEmpty.map { String($0.suffix(4000)) }
            let detail = preflightError ?? stderr ?? result.errorMessage?.nonEmpty
            throw PreparationError(
                detail: detail ?? "Credential preparation did not complete.",
                // A timed-out child may have stopped mid-message; only a settled refusal is the CLI's answer.
                schemaRefusal: preflightError == nil && !result.timedOut ? Self.schemaRefusal(in: result.stderr) : nil)
        }
    }

    /// The refusal from `assertGatewayServiceSchemaMigrationAllowed` (src/state), which names both
    /// versions, the older service's root, and its recovery.
    nonisolated static func schemaRefusal(in stderr: String) -> String? {
        guard let start = stderr.range(of: "Refusing a forward database schema migration:") else { return nil }
        return String(stderr[start.lowerBound...].prefix(while: { !$0.isNewline }))
    }

    struct PreparationError: LocalizedError {
        let detail: String
        let schemaRefusal: String?

        var errorDescription: String? {
            "Could not prepare local client credentials. " + self.detail
        }
    }
}
