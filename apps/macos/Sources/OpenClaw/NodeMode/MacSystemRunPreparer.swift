import Foundation
import OpenClawKit

enum MacSystemRunPreparer {
    private static let timeoutSeconds = 15.0

    static func prepare(_ params: OpenClawSystemRunPrepareParams) async throws
        -> OpenClawSystemRunPreparedArtifacts
    {
        let input = try JSONEncoder().encode(params)
        let command = CommandResolver.matchingLocalOpenClawCommand(
            subcommand: "node",
            extraArgs: ["_prepare-system-run"])
        let path = CommandResolver.preferredPaths().joined(separator: ":")
        var environment = ProcessInfo.processInfo.environment
        environment["PATH"] = path
        let result = await ShellExecutor.runDetailed(
            command: command,
            cwd: nil,
            env: environment,
            timeout: self.timeoutSeconds,
            stdin: input)
        guard result.success else {
            let detail = result.timedOut ? "timed out" : (result.errorMessage ?? "failed")
            throw NSError(domain: "MacSystemRunPreparer", code: 1, userInfo: [
                NSLocalizedDescriptionKey: "SYSTEM_RUN_PREPARE_FAILED: local CLI \(detail)",
            ])
        }
        guard let data = result.stdout.data(using: .utf8) else {
            throw NSError(domain: "MacSystemRunPreparer", code: 2, userInfo: [
                NSLocalizedDescriptionKey: "SYSTEM_RUN_PREPARE_FAILED: local CLI returned invalid UTF-8",
            ])
        }
        do {
            return try JSONDecoder().decode(OpenClawSystemRunPreparedArtifacts.self, from: data)
        } catch {
            throw NSError(domain: "MacSystemRunPreparer", code: 3, userInfo: [
                NSLocalizedDescriptionKey: "SYSTEM_RUN_PREPARE_FAILED: local CLI returned invalid JSON",
            ])
        }
    }
}
