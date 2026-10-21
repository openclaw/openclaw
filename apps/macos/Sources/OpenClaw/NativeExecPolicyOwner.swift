import Foundation
import OpenClawKit

struct NativeExecPolicySnapshot: Decodable, Sendable {
    let path: String
    let exists: Bool
    let hash: String
    let file: ExecApprovalsFile
}

/// The CLI selects the running shared-state owner or takes exclusive offline custody.
enum NativeExecPolicyOwner {
    private struct Request: Encodable {
        let operation: String
        var file: ExecApprovalsFile?
        var baseHash: String?
        var agentId: String?
        var command: String?
        var uses: [Use]?
        var grants: [Grant]?
        var authorization: Authorization?
    }

    private struct Use: Encodable {
        let match: ExecAllowlistEntry
        let resolvedPath: String?
    }

    private struct Grant: Encodable {
        let pattern: String
        let argPattern: String?
        let resolvedPath: String?
    }

    private struct Authorization: Encodable {
        let source: String
        let security: ExecSecurity
        let ask: ExecAsk
        let allowlistSatisfied: Bool
        let policySnapshot: Policy?
        let requireAutoAllowSkills: Bool?
    }

    private struct Policy: Encodable {
        struct Rule: Encodable {
            let pattern: String
            let argPattern: String?
            let source: String?
        }

        let security: ExecSecurity
        let ask: ExecAsk
        let askFallback: ExecSecurity
        let autoAllowSkills: Bool
        let allowlistRules: [Rule]

        init(_ snapshot: ExecApprovalPolicySnapshot) {
            self.security = snapshot.security
            self.ask = snapshot.ask
            self.askFallback = snapshot.askFallback
            self.autoAllowSkills = snapshot.autoAllowSkills
            self.allowlistRules = snapshot.allowlistRules.map {
                Rule(
                    // Match keys are created only from String. Preserve their exact UTF-8 bytes.
                    pattern: String(data: $0.match.pattern, encoding: .utf8)!,
                    argPattern: $0.match.argPattern.isEmpty ? nil : String(data: $0.match.argPattern, encoding: .utf8)!,
                    source: $0.source)
            }.sorted {
                ($0.pattern, $0.argPattern ?? "", $0.source ?? "") <
                    ($1.pattern, $1.argPattern ?? "", $1.source ?? "")
            }
        }
    }

    private struct CommitResult: Decodable {
        let authorized: Bool
    }

    private struct Unavailable: LocalizedError {
        let detail: String
        var errorDescription: String? {
            "Exec policy unavailable: \(self.detail). " +
                "Update OpenClaw or inspect the local Gateway and selected database."
        }
    }

    static func snapshot(stateDirectory: URL) async throws -> NativeExecPolicySnapshot {
        try await self.run(Request(operation: "get"), stateDirectory: stateDirectory)
    }

    static func replace(
        file: ExecApprovalsFile,
        baseHash: String,
        stateDirectory: URL) async throws -> NativeExecPolicySnapshot
    {
        try await self.run(
            Request(operation: "set", file: file, baseHash: baseHash),
            stateDirectory: stateDirectory)
    }

    static func commit(
        _ commit: ExecApprovalExecutionCommit,
        stateDirectory: URL) async throws
    {
        let source: String
        let security: ExecSecurity
        let ask: ExecAsk
        let policy: Policy?
        let basis: ExecApprovalAuthorization.Basis?
        let grants: [ExecAllowlistUse]
        switch commit.authorization {
        case let .currentPolicy(evaluatedSecurity, evaluatedAsk, authorizationBasis):
            (source, security, ask, policy, basis, grants) =
                ("current-policy", evaluatedSecurity, evaluatedAsk, nil, authorizationBasis, [])
        case let .askFallback(evaluatedSecurity, authorizationBasis):
            (source, security, ask, policy, basis, grants) =
                ("ask-fallback", evaluatedSecurity, .off, nil, authorizationBasis, [])
        case let .autoReview(evaluatedSecurity, snapshot):
            (source, security, ask, policy, basis, grants) =
                ("auto-review", evaluatedSecurity, snapshot.ask, Policy(snapshot), nil, [])
        case let .explicitOnce(evaluatedSecurity, snapshot):
            (source, security, ask, policy, basis, grants) =
                ("explicit-approval", evaluatedSecurity, snapshot.ask, Policy(snapshot), nil, [])
        case let .explicitAlways(evaluatedSecurity, snapshot, allowAlways):
            (source, security, ask, policy, basis, grants) =
                ("explicit-approval", evaluatedSecurity, snapshot.ask, Policy(snapshot), nil, allowAlways)
        }
        let skillTrust: Bool
        if case let .autoAllowedSkill(snapshot)? = basis {
            guard snapshot.isCurrent else { throw Unavailable(detail: "Gateway skill trust changed") }
            skillTrust = true
        } else {
            skillTrust = false
        }
        let result: CommitResult = try await self.run(
            Request(
                operation: "commit",
                agentId: commit.agentId ?? "main",
                command: commit.command,
                uses: commit.uses.map { Use(match: $0.match, resolvedPath: $0.resolvedPath) },
                grants: grants.map {
                    Grant(pattern: $0.match.pattern, argPattern: $0.match.argPattern, resolvedPath: $0.resolvedPath)
                },
                authorization: Authorization(
                    source: source,
                    security: security,
                    ask: ask,
                    allowlistSatisfied: basis != nil,
                    policySnapshot: policy,
                    requireAutoAllowSkills: skillTrust ? true : nil)),
            stateDirectory: stateDirectory)
        guard result.authorized else { throw Unavailable(detail: "Owner denied execution") }
    }

    private static func run<Response: Decodable>(
        _ request: Request,
        stateDirectory: URL) async throws -> Response
    {
        // Resolve the bundled CLI, never the configured remote Gateway endpoint.
        let command = await CommandResolver.localOpenclawCommand(
            subcommand: "approvals", extraArgs: ["native", "--stdin", "--json"])
        try Task.checkCancellation()
        guard let executable = command.first else { throw Unavailable(detail: "Local CLI is missing") }
        var environment = ProcessInfo.processInfo.environment
        environment["OPENCLAW_STATE_DIR"] = stateDirectory.path
        if environment["OPENCLAW_CONFIG_PATH"]?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty != false {
            environment["OPENCLAW_CONFIG_PATH"] = stateDirectory.appendingPathComponent("openclaw.json").path
        }
        environment["OPENCLAW_NO_BANNER"] = "1"
        let result = try await BoundedProcess.runCapturingError(
            path: executable,
            arguments: Array(command.dropFirst()),
            environment: environment,
            input: JSONEncoder().encode(request),
            outputLimit: 1024 * 1024,
            timeout: 60)
        try Task.checkCancellation()
        guard result.terminationStatus == 0 else {
            // The owner prints a bounded diagnostic, never the request's environment or command payload.
            let diagnostic = String(data: result.errorOutput.prefix(4096), encoding: .utf8)?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            throw Unavailable(detail: diagnostic?.isEmpty == false ? diagnostic! : "The local owner failed")
        }
        do {
            return try JSONDecoder().decode(Response.self, from: result.output)
        } catch {
            throw Unavailable(detail: "The local CLI returned an incompatible policy response")
        }
    }
}
