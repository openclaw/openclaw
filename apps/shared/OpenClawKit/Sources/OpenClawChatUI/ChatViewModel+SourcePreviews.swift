import Foundation
import Observation

@MainActor
@Observable
final class ChatSourcePreviewState {
    private(set) var context: OpenClawChatSourceContext?
    private(set) var revision = UUID()
    private(set) var previews: [UUID: [ChatSourcePreview]] = [:]
    @ObservationIgnored private var projector = ChatSourcePreviewProjector()
    @ObservationIgnored private var messages: [OpenClawChatMessage] = []
    @ObservationIgnored private var task: Task<Void, Never>?

    func update(_ messages: [OpenClawChatMessage]) {
        self.messages = messages
        self.previews = self.projector.project(messages, context: self.context)
    }

    func refresh(transport: any OpenClawChatTransport) {
        self.invalidate()
        let revision = self.revision
        self.task = Task { [weak self] in
            let context = await transport.loadSourceContext()
            guard !Task.isCancelled, let self, self.revision == revision else { return }
            self.context = context
            self.update(self.messages)
            self.task = nil
        }
    }

    func invalidate() {
        self.task?.cancel()
        self.task = nil
        self.revision = UUID()
        self.context = nil
        self.update(self.messages)
    }
}

extension OpenClawChatViewModel {
    func refreshSourceContext() {
        self.sourcePreviewState.refresh(transport: self.transport)
    }

    func invalidateSourceContext() {
        self.sourcePreviewState.invalidate()
    }

    func sourcePreviews(for message: OpenClawChatMessage) -> [ChatSourcePreview] {
        guard let runID = message.transcriptRunID,
              !self.liveLocalRunIDs.contains(runID), !self.liveAdvertisedRunIDs.contains(runID)
        else { return [] }
        return self.sourcePreviewState.previews[message.id] ?? []
    }
}
