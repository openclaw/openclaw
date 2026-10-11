import Foundation
import OpenClawProtocol

@MainActor
public struct OpenClawGroupDefaultsBrowser {
    let listDirectory: (String?) async throws -> FsListDirResult
    let inspectRepository: (String) async throws -> WorktreeRepositoryStatus

    public init(
        listDirectory: @escaping (String?) async throws -> FsListDirResult,
        inspectRepository: @escaping (String) async throws -> WorktreeRepositoryStatus)
    {
        self.listDirectory = listDirectory
        self.inspectRepository = inspectRepository
    }
}

extension OpenClawChatGatewayRequests {
    static func groupDefaultsUpdate(name: String, cwd: String, worktree: Bool) -> OpenClawChatGatewayRequest {
        let path = cwd.trimmingCharacters(in: .whitespacesAndNewlines)
        return .init(
            method: "sessions.groups.update",
            params: [
                "name": .init(name), "cwd": path.isEmpty ? .init(NSNull()) : .init(path), "worktree": .init(worktree),
            ],
            timeoutMs: 15000)
    }

    public static func groupDefaultsDirectory(_ path: String?) -> OpenClawChatGatewayRequest {
        .init(
            method: "fs.listDir",
            params: path.map { ["path": .init($0)] } ?? [:],
            timeoutMs: 15000)
    }

    public static func groupDefaultsRepository(_ path: String) -> OpenClawChatGatewayRequest {
        .init(
            method: "worktrees.branches",
            params: [
                "repoRoot": .init(path), "includeRepositoryStatus": .init(true),
            ],
            timeoutMs: 15000)
    }
}
