import Foundation
import OpenClawProtocol

extension OpenClawChatViewModel {
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
            plan: card.map { card in
                ChatActivityPlan(
                    steps: card.steps ?? [],
                    note: card.markdown,
                    runActive: self.hasBlockingRunActivity,
                    sessionStatus: session?.status,
                    refreshPending: self.progressCardRefreshPending)
            })
    }

    /// A child's order and latest reply, through the transcript's own decoding and visible-text rules.
    func loadActivityChildTranscript(sessionKey: String) async throws -> ChatActivityChildTranscript {
        var page = try await self.transport.requestHistory(sessionKey: sessionKey)
        let sessionID = page.sessionId
        var order: String?
        var reply: String?
        var cursors = Set<String>()
        repeat {
            try Task.checkCancellation()
            let messages = await Self.decodeMessages(page.messages ?? [], activity: page.activity)
            let transcript = ChatActivityChildTranscript(messages: messages)
            order = order ?? transcript.order
            reply = reply ?? transcript.latestReply
            guard order == nil || reply == nil, page.hasMore != false,
                  let cursor = page.olderCursor, cursors.insert(cursor).inserted else { break }
            page = try await self.transport.requestHistory(sessionKey: sessionKey, cursor: cursor)
        } while page.sessionId == sessionID
        return ChatActivityChildTranscript(order: order, latestReply: reply)
    }
}

struct ChatActivityChildTranscript: Equatable {
    let order: String?
    let latestReply: String?

    init(order: String?, latestReply: String?) {
        self.order = order
        self.latestReply = latestReply
    }

    init(messages: [OpenClawChatMessage]) {
        var order: String?
        var reply: String?
        for message in messages.reversed() {
            let role = message.role.lowercased()
            let origin = message.provenance
            // chat.history presents sessions_send input as an assistant bubble from the sending agent.
            let instruction = message.isForwardedTurnBoundary ||
                (origin?.kind == "inter_session" && origin?.sourceTool == "sessions_spawn") ||
                (role == "user" && (origin == nil || origin?.kind == "external_user"))
            let authoredReply = role == "assistant" && origin?.kind != "inter_session" &&
                origin?.kind != "internal_system" && message.stopReason != "error"
            guard (order == nil && instruction) || (reply == nil && authoredReply),
                  let text = ChatMessageVisibleText.visibleText(in: message).trimmedNonEmpty else { continue }
            if instruction { order = text } else { reply = text }
            if order != nil, reply != nil { break }
        }
        self.init(order: order, latestReply: reply)
    }
}
