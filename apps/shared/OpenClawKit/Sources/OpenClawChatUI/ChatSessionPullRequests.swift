import Foundation

/// The PRs a chat's working branch has on GitHub, as `controlUi.sessionPullRequests` pushes them
/// (src/gateway/control-ui-contract.ts). The Mac's hover cards and the phone's activity row read the same shape.
public struct OpenClawSessionPullRequestSnapshot: Codable, Sendable {
    public struct Repository: Codable, Sendable {
        public let owner: String
        public let repo: String
    }

    public struct Checks: Codable, Sendable {
        public let state: String
        public let passed: Int
        public let failed: Int
        public let skipped: Int
        public let running: Int
    }

    public struct PullRequest: Codable, Sendable {
        public let number: Int
        public let owner: String
        public let repo: String
        public let branch: String
        public let title: String
        public let url: String
        public let state: String
        public let additions: Int?
        public let deletions: Int?
        public let changedFiles: Int?
        public let checks: Checks?
    }

    public struct Branch: Codable, Sendable {
        public let owner: String
        public let repo: String
        public let branch: String
        public let additions: Int?
        public let deletions: Int?
        public let changedFiles: Int?
        public let createUrl: String?
    }

    public var pullRequests: [PullRequest]
    public var repository: Repository?
    public var branch: Branch?
    public let rateLimited: Bool
    public let status: String

    private var repositoryID: String? {
        let owner = self.repository?.owner ?? self.branch?.owner ?? self.pullRequests.first?.owner
        let repo = self.repository?.repo ?? self.branch?.repo ?? self.pullRequests.first?.repo
        return owner.flatMap { owner in repo.map { "\(owner)/\($0)" } }
    }

    func retaining(_ previous: Self?) -> Self {
        var result = self
        // ui/src/lib/session-pull-requests.ts:299: transient failures retain only the same checkout's facts.
        if let previous, self.pullRequests.isEmpty, ["unavailable", "rate-limited"].contains(self.status),
           self.repositoryID == nil || self.repositoryID == previous.repositoryID,
           self.branch == nil || (previous.branch?.branch ?? previous.pullRequests.first?.branch) == nil ||
           self.branch?.branch == (previous.branch?.branch ?? previous.pullRequests.first?.branch)
        {
            result.pullRequests = previous.pullRequests
            result.branch = self.branch ?? previous.branch
            result.repository = self.repository ?? previous.repository
        }
        return result
    }
}
