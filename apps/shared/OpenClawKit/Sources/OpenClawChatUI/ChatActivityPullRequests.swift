import Foundation

/// One PR linked to the chat as the row and its sheet show it: the branch's PRs and the ones this chat or its
/// children published, merged by URL (ui/src/lib/session-pull-request-presentation.ts displaySessionPullRequests).
/// `details` is nil when GitHub didn't answer for a published PR; the page keeps the published identity and branch.
struct ChatActivityPullRequest: Equatable {
    let number: Int
    let owner: String
    let repo: String
    let url: String
    let title: String?
    let branch: String
    let details: OpenClawSessionPullRequestSnapshot.PullRequest?

    var id: String {
        "\(self.owner)/\(self.repo)#\(self.number)"
    }

    /// Checks describe an open PR's head, and only when the last read reached GitHub.
    func liveChecks(status: String) -> OpenClawSessionPullRequestSnapshot.Checks? {
        guard let details, ["open", "draft"].contains(details.state), status == "ready" else { return nil }
        return details.checks
    }

    static func list(_ snapshot: OpenClawSessionPullRequestSnapshot) -> [Self] {
        var byURL: [String: Self] = [:]
        var order: [String] = []
        func put(_ pr: Self) {
            if byURL[pr.url] == nil { order.append(pr.url) }
            byURL[pr.url] = pr
        }
        for task in snapshot.taskPullRequests ?? [] {
            put(Self(
                number: task.number,
                owner: task.owner,
                repo: task.repo,
                url: task.url,
                title: task.pullRequest?.title ?? task.title,
                branch: task.pullRequest?.branch ?? task.branch,
                details: task.pullRequest))
        }
        for pr in snapshot.pullRequests {
            put(Self(
                number: pr.number,
                owner: pr.owner,
                repo: pr.repo,
                url: pr.url,
                title: pr.title,
                branch: pr.branch,
                details: pr))
        }
        // Active PRs keep their incoming order, ahead of publications without details and finished PRs.
        let rank: [String: Double] = ["open": 0, "draft": 0, "merged": 2, "closed": 3]
        return order.enumerated().compactMap { index, url in byURL[url].map { (index, $0) } }.sorted {
            let l = $0.1.details.map { rank[$0.state] ?? 4 } ?? 1.5
            let r = $1.1.details.map { rank[$0.state] ?? 4 } ?? 1.5
            return l == r ? $0.0 < $1.0 : l < r
        }.map(\.1)
    }
}

/// A row of the PR sheet's Checks group: failed first, then running, then passed, and none at zero.
struct ChatActivityCheckRow: Equatable {
    enum Kind: Hashable {
        case failed
        case running
        case passed
        case skipped
    }

    let kind: Kind
    let count: Int

    var label: String {
        switch self.kind {
        case .failed: String(format: String(localized: "%lld failed"), self.count)
        case .running: String(format: String(localized: "%lld running"), self.count)
        case .passed: String(format: String(localized: "%lld passed"), self.count)
        case .skipped: String(format: String(localized: "%lld skipped"), self.count)
        }
    }

    static func rows(_ checks: OpenClawSessionPullRequestSnapshot.Checks) -> [Self] {
        [
            Self(kind: .failed, count: checks.failed),
            Self(kind: .running, count: checks.running),
            Self(kind: .passed, count: checks.passed),
            Self(kind: .skipped, count: checks.skipped),
        ].filter { $0.count >= 1 }
    }
}

/// The PR pill's look lives here alone, so its shape can change without touching the row or the sheet.
extension ChatActivityRules {
    static func pullRequestPills(_ snapshot: OpenClawSessionPullRequestSnapshot) -> [ChatActivityPill] {
        ChatActivityPullRequest.list(snapshot).map { self.pullRequest($0, status: snapshot.status) }
    }

    static func pullRequestStateLabel(_ state: String) -> String {
        switch state {
        case "open": String(localized: "Open")
        case "draft": String(localized: "Draft")
        case "merged": String(localized: "Merged")
        case "closed": String(localized: "Closed")
        default: state.capitalized
        }
    }

    static func checksLabel(_ checks: OpenClawSessionPullRequestSnapshot.Checks) -> String {
        switch checks.state {
        case "passing": String(localized: "Checks passed")
        case "failing": String(localized: "Checks failed")
        default: String(localized: "Checks running")
        }
    }

    static func pullRequest(_ pr: ChatActivityPullRequest, status: String) -> ChatActivityPill {
        let number = "#\(pr.number)"
        let place = String(format: String(localized: "Pull request %@ in %@"), number, "\(pr.owner)/\(pr.repo)")
        let checks = pr.liveChecks(status: status)
        let state = pr.details.flatMap { ChatPullRequestState(rawValue: $0.state) }
        let mark: ChatActivityCheckRow.Kind? = checks.flatMap {
            guard $0.failed + $0.running + $0.passed + $0.skipped > 0 else { return nil }
            switch $0.state {
            case "failing": return .failed
            case "pending": return .running
            default: return nil
            }
        }
        let statusLabel: String? = if pr.details == nil {
            String(localized: "Details unavailable")
        } else if status != "ready" {
            String(localized: "Couldn’t update; showing the last details")
        } else {
            checks.map(self.checksLabel)
        }
        return ChatActivityPill(
            kind: .pullRequest(pr.id),
            symbol: nil,
            label: number,
            count: nil,
            badge: nil,
            labelTone: .neutral,
            accessibilityLabel: [place, pr.title, pr.details.map { self.pullRequestStateLabel($0.state) }, statusLabel]
                .compactMap(\.self).joined(separator: ", "),
            pullRequestState: state,
            checkMark: mark)
    }
}

enum ChatPullRequestState: String {
    case open, draft, merged, closed
}
