import Foundation
import OpenClawProtocol

extension OpenClawChatViewModel {
    /// The activity row's push events: the progress card and the chat's PRs.
    func handleActivityEvent(_ evt: OpenClawChatTransportEvent) -> Task<Void, Never>? {
        switch evt {
        case let .progressCardChanged(event):
            return self.handleProgressCardChanged(event)
        case let .sessionPullRequestsChanged(event):
            self.handleSessionPullRequestsChanged(event)
        default:
            break
        }
        return nil
    }

    /// Watches the current chat's PRs. One watch per key per connection; the transport says when it has no feed.
    func watchSessionPullRequests() {
        let key = self.sessionKey
        guard self.pullRequestWatch.key != key else { return }
        self.pullRequestWatch.task?.cancel()
        let transport = self.transport
        self.pullRequestWatch.task = Task { [weak self] in
            let watched = try? await transport.watchSessionPullRequests(sessionKeys: [key])
            guard let self, !Task.isCancelled, self.sessionKey == key else { return }
            // Nil is a transport without the feed; false is a Gateway that declined. Neither shows a PR.
            self.pullRequestWatch.key = watched == true ? key : nil
            if watched == nil, self.sessionPullRequests?.key == key { self.sessionPullRequests = nil }
        }
    }

    /// The PR sheet's "Try again": a fresh watch makes the Gateway push the chat's PRs again.
    func retrySessionPullRequests() {
        self.pullRequestWatch.key = nil
        self.watchSessionPullRequests()
    }

    func handleSessionPullRequestsChanged(_ event: OpenClawSessionPullRequestsChangedEvent) {
        // Another owner on this connection (the Mac's hover cards) may watch other keys.
        guard let watched = self.pullRequestWatch.key, watched == self.sessionKey else { return }
        guard let snapshot = event.sessions.first(where: { incoming, _ in
            self.matchesCurrentSessionKey(incoming: incoming, agentId: nil, current: watched)
        })?.value else { return }
        let previous = self.sessionPullRequests?.key == watched ? self.sessionPullRequests?.snapshot : nil
        self.sessionPullRequests = (watched, snapshot.retaining(previous))
    }

    private var activityParentKey: String {
        (self.currentSessionEntry() ?? self.retainedActiveSession)?.key ?? self.sessionKey
    }

    /// Only a route change clears the roster; a reconnect or a sequence gap keeps it.
    func forgetActivityChildrenOnRouteChange(_ evt: OpenClawChatTransportEvent) {
        if case .routeChanged = evt {
            self.activityChildren = ChatActivityChildren()
        }
    }

    func observeActivityChildChange(_ change: OpenClawChatSessionsChangedEvent) {
        guard let key = change.sessionKey ?? change.session?.key, key != self.activityParentKey else { return }
        let row = self.activityChildren.rows[key]
        let parent = change.parentSessionKey ?? change.spawnedBy ??
            change.session?.parentSessionKey ?? change.session?.spawnedBy
        guard row != nil || parent == self.activityParentKey else { return }
        if change.reason == "delete" {
            self.activityChildren.remove(key)
            self.activityChildren.revision += 1
            return
        }
        if let row, let update = ChatSessionSidebarModel.applying(
            sessionChange: change, to: [row], activeAgentId: self.currentSessionSnapshot().deliveryAgentID)?.first
        {
            self.activityChildren.observe(page: [update], parentKey: self.activityParentKey, advertised: [key])
        }
        // A status receipt can omit the registry state; the parent-scoped read also sees off-window children.
        if change.reason == "subagent-status" || change.reason == "patch" || change.phase == "end" ||
            change.phase == "error" || (row == nil && change.phase != "message")
        {
            self.activityChildren.revision += 1
        }
    }

    struct ActivityChildrenRequest: Equatable {
        let session: SessionSnapshot
        let parentKey: String
        let advertised: Set<String>
        let connection: UInt64
        let revision: Int
    }

    var activityChildrenRequest: ActivityChildrenRequest {
        let parent = self.currentSessionEntry() ?? self.retainedActiveSession
        return ActivityChildrenRequest(
            session: self.currentSessionSnapshot(),
            parentKey: parent?.key ?? self.sessionKey,
            advertised: Set(parent?.childSessions ?? []),
            connection: self.sessionMetadataGeneration,
            revision: self.activityChildren.revision)
    }

    func loadActivityChildren(_ request: ActivityChildrenRequest) async {
        let result = try? await self.transport.listChildSessions(parentKey: request.parentKey)
        guard !Task.isCancelled, self.isCurrentSession(request.session), request == self.activityChildrenRequest
        else { return }
        if let result { self.activityChildren.receive(result) } else { self.activityChildren.load = .failed }
    }

    /// What the activity row above the composer reads. The approval card's presence comes from the view.
    func activityInput(approvalPending: Bool, showsProgress: Bool) -> ChatActivityInput {
        let session = self.currentSessionEntry()
        let card = showsProgress ? self.progressCard : nil
        return ChatActivityInput(
            approvalPending: approvalPending,
            children: self.activityChildren.roster,
            goal: session?.goal,
            goalOperationLabel: session?.goal.flatMap { self.goalOperationLabel(for: $0) },
            plan: card.map { card in
                ChatActivityPlan(
                    steps: card.steps ?? [],
                    note: card.markdown,
                    runActive: self.hasBlockingRunActivity,
                    sessionStatus: session?.status,
                    refreshPending: self.progressCardRefreshPending)
            },
            pullRequests: self.sessionPullRequests?.key == self.sessionKey ? self.sessionPullRequests?.snapshot : nil)
    }
}

struct ChatGoalActivity {
    var operation: OpenClawChatGoalMutation?
    var pending = false
}

/// The session key this connection watches for PRs (nil until the transport confirms a watch), and the request.
struct ChatPullRequestWatch {
    var key: String?
    var task: Task<Void, Never>?
}
