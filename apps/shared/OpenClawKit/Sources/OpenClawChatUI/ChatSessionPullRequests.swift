import Foundation

/// The PRs a chat's working branch has on GitHub, as `controlUi.sessionPullRequests` pushes them
/// (src/gateway/control-ui-contract.ts). The Mac's hover cards and the phone's activity row read the same shape.
public struct OpenClawSessionPullRequestSnapshot: Codable, Sendable, Hashable {
    public struct Repository: Codable, Sendable, Hashable {
        public let owner: String
        public let repo: String
    }

    public struct Checks: Codable, Sendable, Hashable {
        public let state: String
        public let passed: Int
        public let failed: Int
        public let skipped: Int
        public let running: Int

        public init(state: String, passed: Int, failed: Int, skipped: Int, running: Int) {
            self.state = state
            self.passed = passed
            self.failed = failed
            self.skipped = skipped
            self.running = running
        }
    }

    public struct PullRequest: Codable, Sendable, Hashable {
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
        public let author: Author?
        public let checksUrl: String?

        public init(
            number: Int,
            owner: String,
            repo: String,
            branch: String,
            title: String,
            url: String,
            state: String,
            additions: Int? = nil,
            deletions: Int? = nil,
            changedFiles: Int? = nil,
            checks: Checks? = nil,
            author: Author? = nil,
            checksUrl: String? = nil)
        {
            self.number = number
            self.owner = owner
            self.repo = repo
            self.branch = branch
            self.title = title
            self.url = url
            self.state = state
            self.additions = additions
            self.deletions = deletions
            self.changedFiles = changedFiles
            self.checks = checks
            self.author = author
            self.checksUrl = checksUrl
        }
    }

    public struct Author: Codable, Sendable, Hashable {
        public let login: String

        public init(login: String) {
            self.login = login
        }
    }

    public struct Branch: Codable, Sendable, Hashable {
        public let owner: String
        public let repo: String
        public let branch: String
        public let additions: Int?
        public let deletions: Int?
        public let changedFiles: Int?
        public let createUrl: String?
    }

    /// A PR this chat or one of its children published. `pullRequest` holds GitHub's verified facts and is
    /// absent when GitHub didn't answer for it (src/gateway/control-ui-contract.ts ControlUiSessionTaskPullRequest).
    public struct TaskPullRequest: Codable, Sendable, Hashable {
        public let url: String
        public let owner: String
        public let repo: String
        public let number: Int
        public let branch: String
        public let title: String?
        public let pullRequest: PullRequest?

        public init(
            url: String,
            owner: String,
            repo: String,
            number: Int,
            branch: String,
            title: String? = nil,
            pullRequest: PullRequest? = nil)
        {
            self.url = url
            self.owner = owner
            self.repo = repo
            self.number = number
            self.branch = branch
            self.title = title
            self.pullRequest = pullRequest
        }
    }

    public var pullRequests: [PullRequest]
    public var taskPullRequests: [TaskPullRequest]?
    public var repository: Repository?
    public var branch: Branch?
    public let rateLimited: Bool
    public let status: String

    public init(
        pullRequests: [PullRequest],
        taskPullRequests: [TaskPullRequest]? = nil,
        rateLimited: Bool = false,
        status: String = "ready")
    {
        self.pullRequests = pullRequests
        self.taskPullRequests = taskPullRequests
        self.repository = nil
        self.branch = nil
        self.rateLimited = rateLimited
        self.status = status
    }

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
            result.taskPullRequests = self.taskPullRequests ?? previous.taskPullRequests
            result.branch = self.branch ?? previous.branch
            result.repository = self.repository ?? previous.repository
        }
        return result
    }
}

/// `controlUi.sessionPullRequests.changed`: snapshots for the sessions this connection watches, by key.
public struct OpenClawSessionPullRequestsChangedEvent: Codable, Sendable {
    public let sessions: [String: OpenClawSessionPullRequestSnapshot]

    public init(sessions: [String: OpenClawSessionPullRequestSnapshot]) {
        self.sessions = sessions
    }
}
