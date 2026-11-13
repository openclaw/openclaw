import Foundation

/// Each mounted chat owns one preparation, shared by rendering and scroll decisions.
/// Keep the actual inputs, not timelineRevision: history/outbox and display changes can
/// arrive independently of a timeline notification. No state is shared between views.
@MainActor
final class ChatTranscriptPresentation {
    private struct Inputs: Equatable {
        let model: ObjectIdentifier
        let session: OpenClawChatSessionTarget
        let messages: [OpenClawChatMessage]
        let narration: ChatNarration
        let readerHistory: ChatReaderHistorySnapshot?
        let deletionRevision: UInt64
        let onboarding: Bool
        let displayOptions: OpenClawChatDisplayOptions
        let collapsesCompletedWork: Bool
        let searchActive: Bool
        let activeRunIDs: Set<String>
        let runWorking: Bool
        let hasLiveContent: Bool
        let tools: [OpenClawChatPendingToolCall]
    }

    /// Immutable so List and the scroll callbacks consume the same preparation.
    final class Prepared {
        private let sourceMessages: [OpenClawChatMessage]
        let rows: [ChatTranscriptRow]
        let metadata: [UUID: ChatMessageMetadata]
        let groups: [ChatAssistantRunGroup]
        let visibleTurnStartIDs: [UUID]
        #if os(iOS)
        let cells: [ChatAssistantListCell]
        #endif

        fileprivate init(
            sourceMessages: [OpenClawChatMessage],
            rows: [ChatTranscriptRow],
            metadata: [UUID: ChatMessageMetadata],
            groups: [ChatAssistantRunGroup])
        {
            self.sourceMessages = sourceMessages
            self.rows = rows
            self.metadata = metadata
            self.groups = groups
            self.visibleTurnStartIDs = rows.compactMap { $0.startsTurn ? $0.id : nil }
            #if os(iOS)
            self.cells = ChatAssistantListCell.cells(groups[...])
            #endif
        }

        /// Split display parts still act on the full current message. Reuse narration already
        /// projected for this presentation instead of projecting the whole history per part.
        func actionMessage(for message: OpenClawChatMessage) -> OpenClawChatMessage {
            guard message.presentationBlockIndex != nil else { return message }
            return self.sourceMessages.first(where: { $0.id == message.id }) ?? message
        }
    }

    private var previous: (inputs: Inputs, prepared: Prepared)?

    func resolve(
        viewModel: OpenClawChatViewModel,
        onboarding: Bool,
        displayOptions: OpenClawChatDisplayOptions,
        collapsesCompletedWork: Bool,
        searchActive: Bool,
        readerHistory: ChatReaderHistorySnapshot? = nil) -> Prepared
    {
        let blocking = viewModel.hasBlockingRunActivity
        let hasLiveContent = blocking || viewModel.liveAssistantTextShape.map {
            AssistantTextParser.hasVisibleContent(in: $0, includeThinking: displayOptions.contains(.reasoning))
        } == true
        // Read every observed dependency even on a hit, so SwiftUI keeps its subscriptions.
        // Outbox insertion/removal changes messages; delivery badges still observe the model directly.
        let inputs = Inputs(
            model: ObjectIdentifier(viewModel),
            session: viewModel.currentSessionTarget,
            messages: viewModel.messages,
            narration: viewModel.narration,
            readerHistory: readerHistory,
            deletionRevision: viewModel.readerHistoryDeletionRevision,
            onboarding: onboarding,
            displayOptions: displayOptions,
            collapsesCompletedWork: collapsesCompletedWork,
            searchActive: searchActive,
            activeRunIDs: Set(viewModel.liveAdvertisedRunIDs).union(viewModel.liveLocalRunIDs),
            runWorking: blocking || viewModel.hasStreamingAssistantText,
            hasLiveContent: hasLiveContent,
            tools: displayOptions.contains(.toolActivity) ? viewModel.toolActivities : [])
        if let previous = self.previous, previous.inputs == inputs { return previous.prepared }

        let current = inputs.narration.projecting(inputs.messages)
        let messages = inputs.readerHistory?.presentation(
            current: current, deletionRevision: inputs.deletionRevision) ?? current
        let base = inputs.onboarding && messages.first?.role.lowercased() == "user"
            ? Array(messages.dropFirst()) : messages
        let isMessageVisible = { Self.shouldDisplayMessage($0, options: inputs.displayOptions) }
        var rows = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: base))
        // Footers precede disclosure/filtering, using the same merged and onboarding-trimmed rows.
        let metadata = ChatTranscriptRow.footerMetadata(
            in: rows,
            activeRunIDs: inputs.activeRunIDs,
            runWorking: inputs.runWorking,
            isMessageVisible: isMessageVisible)
        if inputs.collapsesCompletedWork {
            rows = ChatTranscriptRow.collapseCompletedWork(
                rows,
                runWorking: inputs.runWorking,
                activeRunIDs: inputs.activeRunIDs,
                searchActive: inputs.searchActive)
        }
        rows = rows.compactMap { row in
            switch row {
            case let .message(message):
                return isMessageVisible(message) ? row : nil
            case let .completedWork(work):
                let visible = work.messages.filter(isMessageVisible)
                return visible.isEmpty ? nil : .completedWork(.init(
                    anchorID: work.anchorID, messages: visible, durationMilliseconds: work.durationMilliseconds))
            default:
                return row
            }
        }
        let groups = ChatAssistantRunGroup.build(
            rows,
            tools: inputs.tools,
            liveRunID: inputs.activeRunIDs.count == 1 ? inputs.activeRunIDs.first : nil,
            hasLiveContent: inputs.hasLiveContent,
            searchActive: inputs.searchActive)
        let prepared = Prepared(sourceMessages: current, rows: rows, metadata: metadata, groups: groups)
        self.previous = (inputs, prepared)
        return prepared
    }

    private static func shouldDisplayMessage(
        _ message: OpenClawChatMessage,
        options: OpenClawChatDisplayOptions) -> Bool
    {
        let primaryText = ChatMessageVisibleText.displayText(
            in: message,
            includeThinking: options.contains(.reasoning))
        if message.content.contains(where: \.isInlineAttachment) {
            return true
        }

        if message.isToolResult {
            return options.contains(.toolActivity)
        }

        if !primaryText.isEmpty {
            if message.role.lowercased() == "user" {
                return true
            }
            if AssistantTextParser.hasVisibleContent(
                in: primaryText,
                includeThinking: options.contains(.reasoning))
            {
                return true
            }
        }

        return options.contains(.toolActivity) &&
            message.content.contains { $0.isToolCall || $0.isToolResult }
    }
}
