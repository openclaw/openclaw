import Foundation

struct ChatTranscriptPresentation {
    let rows: [ChatTranscriptRow]
    let metadata: [UUID: ChatMessageMetadata]

    /// A disclosure can change identity when paging discovers its earlier turn.
    /// Preserve the exposed message, not that derived summary.
    var historyAnchorID: UUID? {
        self.rows.first {
            if case .message = $0 { return true }
            return false
        }?.id
    }
}

/// Holds the last transcript layout. The chat body re-runs on every streamed delta, but the layout only
/// changes with the transcript or these inputs; rebuilding it per delta pegged the main thread on long chats.
@MainActor
final class ChatTranscriptPresentationMemo {
    private var key: ChatTranscriptPresentationKey?
    private var value: ChatTranscriptPresentation?

    func value(
        for key: ChatTranscriptPresentationKey,
        build: () -> ChatTranscriptPresentation) -> ChatTranscriptPresentation
    {
        if self.key == key, let value { return value }
        let value = build()
        self.key = key
        self.value = value
        return value
    }
}

struct ChatTranscriptPresentationKey: Equatable {
    let viewModel: ObjectIdentifier
    let revision: UInt64
    let style: OpenClawChatView.Style
    let runWorking: Bool
    let activeRunIDs: Set<String>
    let collapsesCompletedWork: Bool
    let searchActive: Bool
    var preservedRowID: UUID?
    let displayOptions: OpenClawChatDisplayOptions
}
