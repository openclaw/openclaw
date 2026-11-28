import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Capture section membership at the tap. A late PR push must not move a control under someone's finger.
/// Values already on screen (usage, title and action availability) can still update in place.
struct ChatInfoVisit: Hashable {
    enum Kind { case chat, mainProfile }

    let id = UUID()
    let model: OpenClawChatViewModel
    let target: OpenClawChatSessionTarget
    let kind: Kind
    var isProfile: Bool {
        self.kind != .chat
    }

    let agentName: String
    let badge: String
    let avatar: UIImage?
    let session: OpenClawChatSessionEntry?
    let environment: ChatInfoEnvironment?
    let pullRequests: OpenClawChatInfoPullRequests?
    let usage: OpenClawChatContextUsage?
    let checkoutChanges: ChatInfoCheckoutChanges?
    let catalogTarget: OpenClawChatSessionTarget
    let catalogGatewayID: String?

    @MainActor init(
        model: OpenClawChatViewModel,
        kind: Kind,
        agentName: String,
        badge: String,
        avatar: UIImage?,
        gatewayID: String?,
        agentID: String,
        uncommittedChanges: ChatInfoCheckoutChanges? = nil)
    {
        self.model = model
        self.target = model.currentSessionTarget
        self.kind = kind
        self.catalogGatewayID = gatewayID
        self.catalogTarget = OpenClawChatSessionTarget(
            sessionKey: model.sessionKey,
            agentID: agentID)
        self.agentName = agentName
        self.badge = badge
        self.avatar = avatar
        self.session = kind == .chat ? model.currentSessionEntry() : nil
        self.usage = model.contextUsage
        if kind == .chat {
            let feed = OpenClawChatInfoPullRequests(model: model)
            let branch = OpenClawChatInfoPullRequests.checkoutBranch(for: model)
            self.environment = ChatInfoEnvironment(session: self.session, feedBranch: branch?.branch)
            self.checkoutChanges = branch?.additions != nil || branch?.deletions != nil
                ? ChatInfoCheckoutChanges(additions: branch?.additions, deletions: branch?.deletions) :
                uncommittedChanges
            self.pullRequests = feed.isEmpty ? nil : feed
        } else {
            self.environment = nil
            self.pullRequests = nil
            self.checkoutChanges = nil
        }
    }

    static func offersArchive(isProfile: Bool, session: OpenClawChatSessionEntry?, mainSessionKey: String) -> Bool {
        guard !isProfile, let session else { return false }
        return ChatSessionSidebarModel.canArchiveSession(session, mainSessionKey: mainSessionKey)
    }

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.id == rhs.id
    }

    func hash(into hasher: inout Hasher) {
        hasher.combine(self.id)
    }
}

struct ChatInfoCheckoutChanges: Equatable {
    let additions: Int?
    let deletions: Int?

    init?(additions: Int?, deletions: Int?) {
        self.additions = additions.flatMap { $0 > 0 ? $0 : nil }
        self.deletions = deletions.flatMap { $0 > 0 ? $0 : nil }
        guard self.additions != nil || self.deletions != nil else { return nil }
    }

    init?(summary: SessionsDiffResult) {
        guard summary.computing != true, summary.unavailablereason == nil, summary.truncated != true else { return nil }
        self.init(additions: summary.additions, deletions: summary.deletions)
    }
}

/// Preload one summary for the selected checkout. Each visit freezes the available counts before showing the page.
struct ChatInfoCheckoutRead: Hashable {
    let target: OpenClawChatSessionTarget
    let gatewayID: String?
    let presentationID: UUID
    let branch: String?

    @MainActor func changes(in app: NodeAppModel) async -> ChatInfoCheckoutChanges? {
        if app.isLocalChatFixtureEnabled {
            return ScreenshotFixtureMode.checkoutSummary(for: self.target.sessionKey)
                .flatMap(ChatInfoCheckoutChanges.init(summary:))
        }
        let gateway = app.operatorSession
        guard let gatewayID, let route = await gateway.currentRoute(ifGatewayID: gatewayID),
              await gateway.supportsServerMethod("sessions.diff", ifCurrentRoute: route) == true else { return nil }
        let params = SessionsDiffParams(
            sessionkey: self.target.sessionKey, agentid: self.target.agentID, scope: .uncommitted, summaryonly: true)
        guard let bytes = try? JSONEncoder().encode(params), let json = String(bytes: bytes, encoding: .utf8),
              let data = try? await gateway.request(
                  method: "sessions.diff", paramsJSON: json, ifCurrentRoute: route),
              let result = try? await GatewayPayloadDecoding.decode(SessionsDiffResult.self, from: data)
        else { return nil }
        return ChatInfoCheckoutChanges(summary: result)
    }
}

struct ChatInfoEnvironment: Equatable {
    let project: String?
    let branch: String?
    let worktree: Bool

    init?(session: OpenClawChatSessionEntry?, feedBranch: String?) {
        self.project = session?.projectId?.trimmedNonEmpty ?? session.flatMap { entry in
            // A plain agent workspace or exec CWD is not a repository or a configured project.
            guard (entry.repository?["url"]?.value as? String)?.trimmedNonEmpty != nil ||
                entry.worktree?.repoRoot?.trimmedNonEmpty != nil else { return nil }
            return ChatSessionSidebarModel.projectName(for: entry)
        }
        self.branch = (session?.repository?["branch"]?.value as? String)?.trimmedNonEmpty ??
            session?.worktree?.branch?.trimmedNonEmpty ?? feedBranch?.trimmedNonEmpty
        self.worktree = session?.worktree != nil
        guard self.project != nil || self.branch != nil || self.worktree else { return nil }
    }
}
