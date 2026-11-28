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
            let detail = [result.preflightError, result.stderr, result.errorMessage]
                .compactMap { $0?.nonEmpty }.first ?? "Credential preparation did not complete."
            if !result.timedOut, let mismatch = NewerStateSchemaError(diagnostic: detail) {
                throw mismatch
            }
            if !result.timedOut, result.preflightError?.nonEmpty == nil,
               let start = result.stderr.range(of: "Refusing a forward database schema migration:")
            {
                let sentence = result.stderr[start.lowerBound...].prefix(while: { !$0.isNewline })
                throw GatewayServiceSchemaRefusal(message: String(sentence))
            }
            throw OpenClawNativeStateError("Could not prepare local client credentials. " + detail.suffix(4000))
        }
    }

    struct GatewayServiceSchemaRefusal: LocalizedError {
        let message: String

        var errorDescription: String? { "Could not prepare local client credentials. " + self.message }
        var recoverySuggestion: String? { self.message }
    }
}
