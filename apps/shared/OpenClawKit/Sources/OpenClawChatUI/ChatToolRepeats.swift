import Foundation
import OpenClawKit
import SwiftUI

/// Repeated failures read as one row. Inside one stretch of tool-only rows (nothing the agent said
/// in between), failed calls of the same tool on the same target join the first one's row, which
/// keeps its place and lists every attempt. Successes, other tools and other targets keep their rows.
struct ChatToolRepeats: Equatable {
    struct Key: Hashable {
        let tool: String
        let target: String
    }

    /// Lead item ID → every attempt in order, lead first. Only groups of two or more.
    private(set) var attempts: [String: [ChatToolActivityItem]] = [:]
    /// Item IDs drawn in a lead's row instead of their own.
    private(set) var absorbed: Set<String> = []

    static let none = Self()

    /// What makes two failures the same for the reader: the tool, and the chat it addressed or else
    /// what its row names. Nil for anything that is not a visible, finished failure.
    static func key(for item: ChatToolActivityItem) -> Key? {
        guard item.isVisible, item.isError else { return nil }
        let call = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
        let tool = call.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        let target = item.addressedSessionKey ??
            [
                item.rowTitle,
                item.commandPreview ?? ToolDisplayRegistry.resolve(name: call.name, args: call.args)
                    .detailLine ?? "",
            ].joined(separator: "\u{0}")
        return Key(tool: tool, target: target)
    }

    static func project(spans: [[ChatToolActivityItem]]) -> Self {
        var result = Self()
        var groups: [String: [ChatToolActivityItem]] = [:]
        for span in spans {
            var leads: [Key: String] = [:]
            // A call without an ID gets a positional one that can recur across rows; it never groups.
            for item in span where item.id.range(of: #"^(call|result)-\d+$"#, options: .regularExpression) == nil {
                guard let key = self.key(for: item) else { continue }
                if let lead = leads[key] {
                    groups[lead, default: []].append(item)
                    result.absorbed.insert(item.id)
                } else {
                    leads[key] = item.id
                    groups[item.id] = [item]
                }
            }
        }
        result.attempts = groups.filter { $0.value.count > 1 }
        return result
    }

    /// Spans over the merged transcript: tool-only rows extend one; a person's input, the agent's
    /// text, a notice or a failed run ends it.
    static func project(_ messages: [OpenClawChatMessage]) -> Self {
        var spans: [[ChatToolActivityItem]] = [[]]
        for message in messages {
            if message.isNestedToolActivity || message.isActivityRow {
                spans[spans.count - 1] += ChatToolActivity.items(message: message)
            } else if !spans[spans.count - 1].isEmpty {
                spans.append([])
            }
        }
        return self.project(spans: spans)
    }

    /// A row whose every call is drawn in another row has nothing left to show.
    func absorbsAll(of message: OpenClawChatMessage) -> Bool {
        guard !self.absorbed.isEmpty else { return false }
        let items = ChatToolActivity.items(message: message)
        return !items.isEmpty && items.allSatisfy { self.absorbed.contains($0.id) }
    }
}

/// Names for the chats tool calls address, from the session list's own titles
/// (`ChatSessionSidebarModel.displayName(for:)`). A key the list cannot name has no entry:
/// the key is routing, never a name (web chat-spawned-subagent.ts:212-216).
struct ChatSessionNames: Equatable {
    private var names: [String: String] = [:]

    static let none = Self()

    init() {}

    init(sessions: [OpenClawChatSessionEntry]) {
        for session in sessions {
            let name = ChatSessionSidebarModel.displayName(for: session)
            guard name != ChatSessionSidebarModel.displayName(forKey: session.key) else { continue }
            self.names[Self.normalized(session.key)] = name
        }
    }

    func name(for key: String) -> String? {
        self.names[Self.normalized(key)]
    }

    private static func normalized(_ key: String) -> String {
        key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    }
}

/// The transcript as its rows draw it.
struct ChatTranscriptPresentation {
    let rows: [ChatTranscriptRow]
    let metadata: [UUID: ChatMessageMetadata]
    var tools: ChatToolRowContext = .none
    var inspectionRows: [ChatTranscriptRow] = []

    @MainActor
    static func project(
        _ base: [OpenClawChatMessage],
        model: OpenClawChatViewModel,
        includesTools: Bool,
        searchActive: Bool,
        collapsesWork: Bool,
        streamingTextRunID: String?,
        isMessageVisible: (OpenClawChatMessage, Set<String>) -> Bool) -> Self
    {
        #if os(iOS)
        let calls = includesTools ? model.toolActivities : []
        let messagesWithTools = calls.isEmpty ? base : ChatAssistantRunGroup.orderedParts(
            base.map(ChatTranscriptRow.message),
            tools: calls).compactMap { part -> OpenClawChatMessage? in
            switch part {
            case let .row(.message(message)): message
            case let .tool(call):
                OpenClawChatMessage(
                    id: call.presentationID,
                    role: "assistant",
                    content: [.init(type: "toolCall", id: call.id, name: call.name, arguments: call.args)],
                    timestamp: call.startedAt,
                    transcriptRunID: call.runID,
                    activity: call.activity.map { [$0] })
            default: nil
            }
        }
        #else
        let messagesWithTools = base
        #endif
        let (merged, tools) = ChatToolRowContext.present(
            messagesWithTools, sessions: model.sessions, searchActive: searchActive)
        var rows = ChatTranscriptRow.build(from: merged)
        let runWorking = model.hasBlockingRunActivity || model.hasStreamingAssistantText
        let activeRunIDs = Set(model.liveAdvertisedRunIDs).union(model.liveLocalRunIDs)
        // One duration map serves the reply footers and the "Worked for" summaries.
        let runDurations = ChatTranscriptRow.runDurations(in: rows, activeRunIDs: activeRunIDs)
        // Footers and visible rows share the merged, onboarding-trimmed input, before work moves into disclosures.
        let metadata = ChatTranscriptRow.footerMetadata(
            in: rows,
            activeRunIDs: activeRunIDs,
            runWorking: runWorking,
            runDurations: runDurations,
            isMessageVisible: { isMessageVisible($0, activeRunIDs) })
        let inspectionRows = rows
        if collapsesWork {
            var liveToolRunIDs = activeRunIDs
            if let streamingTextRunID {
                #if os(iOS)
                if !calls.contains(where: { $0.runID == streamingTextRunID && !$0.isComplete }) {
                    liveToolRunIDs.remove(streamingTextRunID)
                }
                #else
                liveToolRunIDs.remove(streamingTextRunID)
                #endif
            }
            rows = ChatTranscriptRow.collapseCompletedWork(
                rows,
                runWorking: runWorking,
                activeRunIDs: activeRunIDs,
                searchActive: searchActive,
                liveToolRunIDs: liveToolRunIDs,
                narratedRunID: model.liveUsageRunID,
                runDurations: runDurations)
        }
        rows = rows.compactMap { row in
            switch row {
            case let .message(message):
                return isMessageVisible(message, activeRunIDs) ? row : nil
            case let .completedWork(work):
                let visible = work.messages.filter { isMessageVisible($0, activeRunIDs) }
                return visible.isEmpty ? nil : .completedWork(work.replacingMessages(visible))
            default:
                return row
            }
        }
        return Self(rows: rows, metadata: metadata, tools: tools, inspectionRows: inspectionRows)
    }
}

/// What a tool row needs from the whole transcript: which failures it carries, and chat names.
struct ChatToolRowContext: Equatable {
    var repeats: ChatToolRepeats = .none
    var names: ChatSessionNames = .none

    static let none = Self()

    /// Merges results into their calls and retires dispatcher envelopes; on iPhone, also groups
    /// repeated failures (the rows they fold into leave) and names addressed chats.
    static func present(
        _ messages: [OpenClawChatMessage],
        sessions: [OpenClawChatSessionEntry],
        searchActive: Bool) -> (messages: [OpenClawChatMessage], context: Self)
    {
        let merged = ChatTranscriptRow.retiringDispatchEnvelopes(in: ChatTranscriptRow.mergeToolResults(in: messages))
        #if os(iOS)
        // Search lists matching rows on their own; a match must not hide inside another row.
        let repeats = searchActive ? ChatToolRepeats.none : ChatToolRepeats.project(merged)
        let context = Self(repeats: repeats, names: ChatSessionNames(sessions: sessions))
        return (merged.filter { !repeats.absorbsAll(of: $0) }, context)
        #else
        return (merged, .none)
        #endif
    }
}

extension EnvironmentValues {
    @Entry var openClawToolRowContext: ChatToolRowContext = .none
}
