import Foundation
import Observation

@MainActor
@Observable
final class ChatSourcePreviewState {
    private struct PartLinks {
        let messageID: UUID
        let role: String
        let content: [OpenClawChatMessageContent]
        let ownsFooter: Bool
        let stopReason: String?
        let errorMessage: String?
        let links: [URL]

        init(_ message: OpenClawChatMessage, links: [URL]) {
            self.messageID = message.id
            self.role = message.role
            self.content = message.content
            self.ownsFooter = message.presentationOwnsFooter
            self.stopReason = message.stopReason
            self.errorMessage = message.errorMessage
            self.links = links
        }

        /// Visible text reads the footer's error text, so it is part of the key.
        func matches(_ message: OpenClawChatMessage) -> Bool {
            self.role == message.role && self.content == message.content &&
                self.ownsFooter == message.presentationOwnsFooter &&
                self.stopReason == message.stopReason && self.errorMessage == message.errorMessage
        }
    }

    private(set) var context: OpenClawChatSourceContext?
    private(set) var revision = UUID()
    private(set) var previews: [UUID: [ChatSourcePreview]] = [:]
    @ObservationIgnored private var projector = ChatSourcePreviewProjector()
    @ObservationIgnored private var messages: [OpenClawChatMessage] = []
    @ObservationIgnored private var task: Task<Void, Never>?
    // Split rows come from the narrated transcript, not from update(), so each
    // part's links are checked against the part's own visible-text inputs on read.
    @ObservationIgnored private var partLinks: [UUID: PartLinks] = [:]

    func update(_ messages: [OpenClawChatMessage]) {
        self.messages = messages
        self.previews = self.projector.project(messages, context: self.context)
        self.partLinks = self.partLinks.filter { self.previews[$0.value.messageID]?.isEmpty == false }
    }

    func previews(for message: OpenClawChatMessage) -> [ChatSourcePreview] {
        let previews = self.previews[message.id] ?? []
        guard message.presentationBlockIndex != nil, !previews.isEmpty else { return previews }
        let links: [URL]
        if let cached = self.partLinks[message.presentationID], cached.matches(message) {
            links = cached.links
        } else {
            links = ChatSourcePreviewProjector.citations(in: message)
            self.partLinks[message.presentationID] = PartLinks(message, links: links)
        }
        return previews.filter { preview in links.contains(where: preview.represents) }
    }

    func refresh(transport: any OpenClawChatTransport) {
        self.invalidate()
        self.task = Task { [weak self] in
            let context = await transport.loadSourceContext()
            guard !Task.isCancelled, let self else { return }
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

    func sourcePreviews(for message: OpenClawChatMessage) -> [ChatSourcePreview] {
        guard let runID = message.transcriptRunID,
              !self.liveLocalRunIDs.contains(runID), !self.liveAdvertisedRunIDs.contains(runID)
        else { return [] }
        return self.sourcePreviewState.previews(for: message)
    }
}
