import Foundation
import Observation

@MainActor
@Observable
final class ChatSessionSidebarPreviews {
    struct Target: Hashable {
        let key: String
        let agentID: String?
        let sessionID: String?
        let updatedAt: Double?
        let lastActivityAt: Double?

        init?(session: OpenClawChatSessionEntry, fallbackAgentID: String?) {
            let keyOwner = OpenClawChatSessionKey.agentID(from: session.key)
            let owner = session.agentId ?? keyOwner ?? fallbackAgentID
            guard keyOwner != nil || owner != nil else { return nil }
            self.key = session.key
            self.agentID = keyOwner == nil ? owner : nil
            self.sessionID = session.sessionId
            self.updatedAt = session.updatedAt
            self.lastActivityAt = session.lastActivityAt
        }
    }

    struct Request: Hashable {
        let modelID: ObjectIdentifier
        let sessionKey: String
        let agentID: String?
        let targets: [Target]

        @MainActor
        init(viewModel: OpenClawChatViewModel, sessions: [OpenClawChatSessionEntry]) {
            self.modelID = ObjectIdentifier(viewModel)
            self.sessionKey = viewModel.sessionKey
            let agentID = viewModel.selectedAgentID
            self.agentID = agentID
            var seen = Set<Target>()
            self.targets = Array(sessions.compactMap {
                Target(session: $0, fallbackAgentID: agentID)
            }.filter { seen.insert($0).inserted }.prefix(32))
        }
    }

    private var request: Request?
    private var previews: [Target: String] = [:]
    @ObservationIgnored private var generation: UInt64 = 0

    func refresh(_ request: Request, cache: (any OpenClawChatTranscriptCache)?) async {
        self.generation &+= 1
        let generation = self.generation
        let sameOwner = self.request?.modelID == request.modelID && self.request?.agentID == request.agentID
        self.previews = sameOwner ? self.previews.filter { request.targets.contains($0.key) } : [:]
        self.request = request
        guard let cache else {
            self.previews = [:]
            return
        }
        for target in request.targets {
            guard !Task.isCancelled, self.generation == generation else { return }
            let messages = await cache.loadTranscript(sessionKey: target.key, agentID: target.agentID)
            guard !Task.isCancelled, self.generation == generation else { return }
            self.previews[target] = ChatSessionSidebarModel.messagePreview(from: messages)
        }
    }

    func text(for session: OpenClawChatSessionEntry, in request: Request) -> String? {
        guard self.request == request,
              let target = Target(session: session, fallbackAgentID: request.agentID)
        else { return nil }
        return self.previews[target]
    }
}
