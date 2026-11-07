import CryptoKit
import Darwin
import Foundation
import OpenClawKit
import OpenClawNativeState
import OSLog
import Security

enum ExecApprovalsStore {
    // Test stores are task-scoped so parallel suites cannot redirect unrelated
    // shared-state consumers through the process environment.
    @TaskLocal private static var scopedStateDirectoryURL: URL?
    private static let logger = Logger(subsystem: "ai.openclaw", category: "exec-approvals")
    private static let defaultAgentId = "main"
    // Keep omitted-file behavior aligned with the TypeScript gateway/CLI contract.
    private static let defaultSecurity: ExecSecurity = .full
    private static let defaultAsk: ExecAsk = .off
    private static let defaultAskFallback: ExecSecurity = .deny
    private static let defaultAutoAllowSkills = false

    #if compiler(>=6.4)
    nonisolated(nonsending) static func withStateDirectory<T>(
        _ url: URL,
        operation: () async throws -> T) async rethrows -> T
    {
        try await self.$scopedStateDirectoryURL.withValue(url) {
            try await operation()
        }
    }
    #else
    static func withStateDirectory<T>(
        _ url: URL,
        operation: () async throws -> T,
        isolation: isolated (any Actor)? = #isolation) async rethrows -> T
    {
        try await self.$scopedStateDirectoryURL.withValue(
            url,
            operation: operation,
            isolation: isolation)
    }
    #endif

    static func socketPath() -> String {
        self.socketPath(
            stateDirectoryURL: self.stateDirURL(),
            profileActive: AppProfile.current.isActive)
    }

    static func socketPath(stateDirectoryURL: URL, profileActive: Bool) -> String {
        let canonical = stateDirectoryURL.appendingPathComponent("exec-approvals.sock").path
        let maximumLength = MemoryLayout.size(ofValue: sockaddr_un().sun_path)
        guard canonical.utf8.count >= maximumLength, profileActive else {
            return canonical
        }
        let digest = SHA256.hash(data: Data(canonical.utf8))
            .prefix(8)
            .map { String(format: "%02x", $0) }
            .joined()
        return "/tmp/openclaw-\(geteuid())/exec-approvals-\(digest).sock"
    }

    private static func homeURL() -> URL {
        guard let configured = OpenClawEnv.path("OPENCLAW_HOME") else {
            return FileManager().homeDirectoryForCurrentUser
        }
        return URL(
            fileURLWithPath: (configured as NSString).expandingTildeInPath,
            isDirectory: true)
    }

    static func stateDirURL() -> URL {
        if let scopedStateDirectoryURL {
            return scopedStateDirectoryURL
        }
        guard let configured = OpenClawEnv.path("OPENCLAW_STATE_DIR") else {
            return AppProfile.current.stateDirectoryURL(homeDirectory: self.homeURL())
        }
        return URL(fileURLWithPath: self.expandPath(configured), isDirectory: true).standardizedFileURL
    }

    private static func failClosedFallbackFile() -> ExecApprovalsFile {
        ExecApprovalsFile(
            version: 1,
            socket: nil,
            defaults: ExecApprovalsDefaults(
                security: .deny,
                ask: .off,
                askFallback: .deny,
                autoAllowSkills: false),
            agents: [:])
    }

    static func localSocketCredentials() throws -> (socketPath: String, token: String) {
        var operation = ClientCredentialOperation(kind: .socketEnsure)
        operation.fallback = .init(
            path: self.socketPath(),
            token: self.generateToken(),
            updatedAtMs: Int64(Date().timeIntervalSince1970 * 1000))
        let result = try DeviceCredentialAccess.execute(root: self.stateDirURL(), operation: operation)
        guard let socket = result.socket, let path = socket.path, let token = socket.token else {
            throw OpenClawNativeStateError("Could not acquire local execution socket credentials")
        }
        return (self.expandPath(path), token)
    }

    static func resolve(agentId: String?) async -> ExecApprovalsResolved {
        switch await self.resolveResult(agentId: agentId) {
        case let .success(resolved):
            resolved
        case let .failure(error):
            self.resolveFromFile(
                self.failClosedFallbackFile(), agentId: agentId, unavailableReason: error.localizedDescription)
        }
    }

    static func resolveResult(
        agentId: String?) async -> Result<ExecApprovalsResolved, ExecApprovalsReadError>
    {
        do {
            let snapshot = try await NativeExecPolicyOwner.snapshot(stateDirectory: self.stateDirURL())
            let socket = try self.localSocketCredentials()
            return .success(self.resolveFromFile(
                snapshot.file,
                agentId: agentId,
                socket: (socket.socketPath, socket.token)))
        } catch {
            let diagnostic = error.localizedDescription
            self.logger.error("exec approvals unavailable: \(diagnostic, privacy: .public)")
            return .failure(.unavailable(diagnostic))
        }
    }

    static func resolveDefaults(from file: ExecApprovalsFile) -> ExecApprovalsResolvedDefaults {
        let defaults = file.defaults ?? ExecApprovalsDefaults()
        return ExecApprovalsResolvedDefaults(
            security: defaults.security ?? self.defaultSecurity,
            ask: defaults.ask ?? self.defaultAsk,
            askFallback: defaults.askFallback ?? self.defaultAskFallback,
            autoAllowSkills: defaults.autoAllowSkills ?? self.defaultAutoAllowSkills)
    }

    static func resolveFromFile(
        _ file: ExecApprovalsFile,
        agentId: String?,
        socket: (path: String, token: String)? = nil,
        unavailableReason: String? = nil) -> ExecApprovalsResolved
    {
        let resolvedDefaults = self.resolveDefaults(from: file)
        let key = self.agentKey(agentId)
        let agentEntry = file.agents?[key] ?? ExecApprovalsAgent()
        let wildcardEntry = file.agents?["*"] ?? ExecApprovalsAgent()
        let resolvedAgent = ExecApprovalsResolvedDefaults(
            security: agentEntry.security ?? wildcardEntry.security ?? resolvedDefaults.security,
            ask: agentEntry.ask ?? wildcardEntry.ask ?? resolvedDefaults.ask,
            askFallback: agentEntry.askFallback ?? wildcardEntry.askFallback
                ?? resolvedDefaults.askFallback,
            autoAllowSkills: agentEntry.autoAllowSkills ?? wildcardEntry.autoAllowSkills
                ?? resolvedDefaults.autoAllowSkills)
        let allowlist = (wildcardEntry.allowlist ?? []) + (agentEntry.allowlist ?? [])
        let socketPath = self.expandPath(socket?.path ?? self.socketPath())
        let token = socket?.token ?? ""
        return ExecApprovalsResolved(
            socketPath: socketPath,
            token: token,
            agent: resolvedAgent,
            allowlist: allowlist,
            file: file,
            unavailableReason: unavailableReason)
    }
}

extension ExecApprovalsStore {
    @discardableResult
    static func commitExecution(
        _ commit: ExecApprovalExecutionCommit) async -> Result<Void, ExecApprovalsMutationError>
    {
        do {
            try await NativeExecPolicyOwner.commit(commit, stateDirectory: self.stateDirURL())
            return .success(())
        } catch {
            let diagnostic = error.localizedDescription
            self.logger.error("exec approval execution commit failed: \(diagnostic, privacy: .public)")
            return .failure(.unavailable(diagnostic))
        }
    }

    static func allowlistEntryMatchKey(_ entry: ExecAllowlistEntry) -> ExecAllowlistEntryMatchKey {
        ExecAllowlistEntryMatchKey(
            pattern: entry.pattern,
            argPattern: entry.argPattern)
    }

    private static func generateToken() -> String {
        var bytes = [UInt8](repeating: 0, count: 24)
        let status = SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes)
        if status == errSecSuccess {
            return Data(bytes)
                .base64EncodedString()
                .replacingOccurrences(of: "+", with: "-")
                .replacingOccurrences(of: "/", with: "_")
                .replacingOccurrences(of: "=", with: "")
        }
        return UUID().uuidString
    }

    static func expandPath(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        let home = self.homeURL()
        if trimmed == "~" {
            return home.path
        }
        if trimmed.hasPrefix("~/") {
            let suffix = trimmed.dropFirst(2)
            return home.appendingPathComponent(String(suffix)).path
        }
        return trimmed
    }

    private static func agentKey(_ agentId: String?) -> String {
        let trimmed = agentId?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.defaultAgentId : trimmed
    }
}
