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

    /// Favicon leaves key their loads on this value, so it changes only when the context does.
    private(set) var context: OpenClawChatSourceContext?
    private(set) var previews: [UUID: [ChatSourcePreview]] = [:]
    @ObservationIgnored private var projector = ChatSourcePreviewProjector()
    @ObservationIgnored private var messages: [OpenClawChatMessage] = []
    @ObservationIgnored private var task: Task<Void, Never>?
    /// Split rows come from the narrated transcript, not from update(), so each
    /// part's links are checked against the part's own visible-text inputs on read.
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

    /// The current context stays in place until the new one lands, so a refresh that finds the
    /// same context changes nothing and one that finds a new context changes it once.
    func refresh(_ load: @escaping @MainActor @Sendable () async -> OpenClawChatSourceContext?) {
        self.task?.cancel()
        self.task = Task { [weak self] in
            let context = await load()
            guard !Task.isCancelled, let self else { return }
            self.task = nil
            self.apply(context)
        }
    }

    /// The connection that served the context is gone; cards and favicons drop it now.
    func invalidate() {
        self.task?.cancel()
        self.task = nil
        self.apply(nil)
    }

    private func apply(_ context: OpenClawChatSourceContext?) {
        guard context != self.context else { return }
        self.context = context
        self.update(self.messages)
    }
}

extension OpenClawChatViewModel {
    func refreshSourceContext() {
        self.sourcePreviewState.refresh { [transport = self.transport] in
            await transport.loadSourceContext()
        }
    }

    func sourcePreviews(for message: OpenClawChatMessage) -> [ChatSourcePreview] {
        guard let runID = message.transcriptRunID,
              !self.liveLocalRunIDs.contains(runID), !self.liveAdvertisedRunIDs.contains(runID)
        else { return [] }
        return self.sourcePreviewState.previews(for: message)
    }
}
