import Foundation

/// One PR linked to the chat as the row and its sheet show it: the branch's PRs and the ones this chat or its
/// children published, merged by URL (ui/src/lib/session-pull-request-presentation.ts displaySessionPullRequests).
/// `details` is nil when GitHub didn't answer for a published PR; the phone shows it dimmed and opens only its link.
struct ChatActivityPullRequest: Equatable {
    let number: Int
    let owner: String
    let repo: String
    let url: String
    let title: String?
    let details: OpenClawSessionPullRequestSnapshot.PullRequest?

    var id: String {
        "\(self.owner)/\(self.repo)#\(self.number)"
    }

    var repositoryLine: String {
        "\(self.owner)/\(self.repo) #\(self.number)"
    }

    /// The sheet's line under the title: "Open · lisbon-trip/itinerary #4182 · +214 −18". Without details it's the
    /// repository line, and only when a title stands above it.
    var summaryLine: String? {
        guard let details else { return self.title == nil ? nil : self.repositoryLine }
        var parts = [ChatActivityRules.pullRequestStateLabel(details.state), self.repositoryLine]
        if let additions = details.additions, let deletions = details.deletions {
            parts.append("+\(additions) −\(deletions)")
        }
        return parts.joined(separator: " · ")
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
                details: task.pullRequest))
        }
        for pr in snapshot.pullRequests {
            put(Self(number: pr.number, owner: pr.owner, repo: pr.repo, url: pr.url, title: pr.title, details: pr))
        }
        // Open, then draft, a PR without details, merged and closed; the Gateway's order within a state.
        let rank: [String: Double] = ["open": 0, "draft": 1, "merged": 2, "closed": 3]
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
    }

    let kind: Kind
    let count: Int

    static func rows(_ checks: OpenClawSessionPullRequestSnapshot.Checks) -> [Self] {
        [
            Self(kind: .failed, count: checks.failed),
            Self(kind: .running, count: checks.running),
            Self(kind: .passed, count: checks.passed),
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

    static func pullRequestSymbol(_ pr: ChatActivityPullRequest) -> String {
        switch pr.details?.state {
        case nil: "lock"
        case "draft": "circle.dashed"
        case "merged": "arrow.triangle.merge"
        case "closed": "xmark.circle"
        default: "arrow.triangle.pull"
        }
    }

    static func checksLabel(_ checks: OpenClawSessionPullRequestSnapshot.Checks) -> String {
        switch checks.state {
        case "passing": String(localized: "Checks passed")
        case "failing": String(localized: "Checks failed")
        default: String(localized: "Checks running")
        }
    }

    /// Pill a: the number, the state's glyph, and a corner mark only while checks run or after they fail.
    static func pullRequest(_ pr: ChatActivityPullRequest, status: String) -> ChatActivityPill {
        let number = "#\(pr.number)"
        let place = String(format: String(localized: "Pull request %@ in %@"), number, "\(pr.owner)/\(pr.repo)")
        guard let details = pr.details else {
            return ChatActivityPill(
                kind: .pullRequest(pr.id),
                symbol: self.pullRequestSymbol(pr),
                label: number,
                count: nil,
                badge: nil,
                labelTone: .muted,
                accessibilityLabel: [place, pr.title, String(localized: "Details unavailable")]
                    .compactMap(\.self).joined(separator: ", "))
        }
        let badge: ChatActivityPill.Badge? = if status != "ready" {
            .init(
                mark: .symbol("exclamationmark.triangle.fill"),
                tone: .attention,
                label: String(localized: "Couldn’t update; showing the last details"))
        } else if let checks = pr.liveChecks(status: status) {
            switch checks.state {
            case "passing": nil
            case "failing": .init(mark: .symbol("xmark"), tone: .problem, label: self.checksLabel(checks))
            default: .init(mark: .spinner, tone: .neutral, label: self.checksLabel(checks))
            }
        } else {
            nil
        }
        let checksSpoken = pr.liveChecks(status: status).map(self.checksLabel)
        return ChatActivityPill(
            kind: .pullRequest(pr.id),
            symbol: self.pullRequestSymbol(pr),
            label: number,
            count: nil,
            badge: badge,
            labelTone: details.state == "draft" || details.state == "closed" ? .muted : .neutral,
            accessibilityLabel: [
                place,
                details.title,
                self.pullRequestStateLabel(details.state),
                badge?.label ?? checksSpoken,
            ]
                .compactMap(\.self).joined(separator: ", "))
    }
}
