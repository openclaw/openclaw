import Foundation

// MARK: - system.run.prepare handler

extension MacNodeRuntime {
    private func handleSystemRunPrepare(_ req: BridgeInvokeRequest) async throws -> BridgeInvokeResponse {
        let params = try Self.decodeParams(OpenClawSystemRunPrepareParams.self, from: req.paramsJSON)

        let trimmedCommand = params.command?.filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
        let trimmedRaw = params.rawCommand?.trimmingCharacters(in: .whitespacesAndNewlines)
        guard (trimmedCommand?.isEmpty == false) || (trimmedRaw?.isEmpty == false) else {
            return Self.errorResponse(req, code: .invalidRequest, message: "INVALID_REQUEST: command required")
        }

        let command: [String] = (trimmedCommand?.isEmpty == false)
            ? trimmedCommand!
            : ["/bin/sh", "-c", trimmedRaw!]

        let cwd = params.cwd?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedCwd = (cwd?.isEmpty == false) ? cwd : nil

        let agentId = params.agentId?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedAgentId = (agentId?.isEmpty == false) ? agentId : nil
        let sessionKey = params.sessionKey?.trimmingCharacters(in: .whitespacesAndNewlines)
        let resolvedSessionKey = (sessionKey?.isEmpty == false) ? sessionKey : nil

        let resolution = ExecCommandResolution.resolveForAllowlist(
            command: command,
            rawCommand: params.rawCommand,
            cwd: resolvedCwd,
            env: [:]).first

        let (argv, argvChanged): ([String], Bool)
        if let resolvedPath = resolution?.resolvedPath,
            let firstResolved = ExecCommandResolution.resolve(
                command: [command.first!],
                cwd: resolvedCwd,
                env: [:])?.resolvedPath,
            resolvedPath == firstResolved
        {
            argv = [resolvedPath] + command.dropFirst()
            argvChanged = true
        } else {
            argv = command
            argvChanged = false
        }

        let rawCommandString = argvChanged
            ? ExecCommandFormatter.displayString(for: argv)
            : ExecCommandFormatter.displayString(for: argv, rawCommand: params.rawCommand)

        let plan = OpenClawSystemRunApprovalPlan(
            argv: argv,
            cwd: resolvedCwd,
            rawCommand: rawCommandString,
            agentId: resolvedAgentId,
            sessionKey: resolvedSessionKey)

        struct PreparePayload: Encodable {
            var cmdText: String
            var plan: OpenClawSystemRunApprovalPlan
        }

        let cmdText = ExecCommandFormatter.displayString(for: command)
        let payload = try Self.encodePayload(PreparePayload(cmdText: cmdText, plan: plan))
        return BridgeInvokeResponse(id: req.id, ok: true, payloadJSON: payload)
    }
}
