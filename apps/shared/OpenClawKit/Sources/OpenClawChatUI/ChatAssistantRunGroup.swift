import Foundation
import SwiftUI

/// Presentation only: keep transcript messages and their individual actions intact.
struct ChatAssistantRunGroup: Identifiable {
    enum ID: Hashable {
        case row(UUID)
        case tool(String)
        case run(String, UUID, Int)
        case live
    }

    enum Part: Identifiable {
        case row(ChatTranscriptRow)
        case tool(OpenClawChatPendingToolCall)
        case liveTools(runID: String, anchor: String, items: [ChatToolActivityItem])

        var id: String {
            switch self {
            case let .row(row): "row:\(row.id)"
            case let .tool(tool): "tool:\(tool.id)"
            case let .liveTools(_, anchor, _): anchor
            }
        }

        var runID: String? {
            switch self {
            case let .row(row): row.assistantRunID
            case let .tool(tool): tool.runID
            case let .liveTools(runID, _, _): runID
            }
        }

        var timestamp: Double? {
            switch self {
            case let .row(row): row.timestamp
            case let .tool(tool): tool.startedAt
            case .liveTools: nil
            }
        }

        var boundaryID: UUID? {
            if case let .row(row) = self, row.startsTurn { return row.id }
            return nil
        }
    }

    let id: ID
    let runID: String?
    var parts: [Part]
    var includesLive = false

    var answerID: UUID? {
        self.parts.reversed().compactMap { part -> UUID? in
            if case let .row(.message(message)) = part, message.presentationOwnsFooter,
               message.isCompletedReply { return message.presentationID }
            return nil
        }.first
    }

    static func build(
        _ rows: [ChatTranscriptRow],
        tools: [OpenClawChatPendingToolCall] = [],
        liveRunID: String?,
        hasLiveContent: Bool,
        searchActive: Bool,
        compactLiveRunIDs: Set<String> = []) -> [Self]
    {
        var parts = rows.map(Part.row)
        // Use the producer's start time, not the active-first tool list order.
        // Persisted calls take over their live copy without duplicating activity.
        let recordedCalls = Set(rows.flatMap { row -> [String] in
            let messages: [OpenClawChatMessage] = switch row {
            case let .message(message): [message]
            case let .completedWork(work): work.messages
            default: []
            }
            return messages.flatMap { message in
                message.content.filter(\.isToolCall).compactMap { block in
                    message.workRunID.map { "\($0):\(block.id ?? "")" }
                }
            }
        })
        for tool in tools.sorted(by: {
            if $0.startedAt == $1.startedAt { return $0.id < $1.id }
            return ($0.startedAt ?? .infinity) < ($1.startedAt ?? .infinity)
        }) {
            if let runID = tool.runID, recordedCalls.contains("\(runID):\(tool.id)") { continue }
            // Live yield context is never a tool row either (web chat-sessions-yield.ts:290-293).
            if ChatToolActivityItem(live: tool).isYieldContext { continue }
            let index = tool.startedAt.flatMap { startedAt in
                parts.firstIndex { ($0.timestamp.map { $0 > startedAt }) == true }
            } ?? parts.endIndex
            parts.insert(.tool(tool), at: index)
        }
        if !compactLiveRunIDs.isEmpty, !searchActive {
            parts = Self.compactLiveTools(parts, runIDs: compactLiveRunIDs, tools: tools)
        }
        var groups: [Self] = []
        var boundaries: [String: UUID] = [:]
        var segments: [String: Int] = [:]
        for part in parts {
            // Overlapping runs retain their own input even after another turn
            // begins. Metadata-free inputs never establish guessed ownership.
            if case let .row(.message(message)) = part, part.boundaryID != nil,
               let runID = message.workRunID
            {
                boundaries[runID] = message.id
            }
            let runID = searchActive ? nil : part.runID
            if let runID, let boundary = boundaries[runID] {
                if groups.last?.runID == runID {
                    groups[groups.count - 1].parts.append(part)
                } else {
                    let segment = segments[runID, default: 0]
                    segments[runID] = segment + 1
                    groups.append(Self(id: .run(runID, boundary, segment), runID: runID, parts: [part]))
                }
            } else {
                let id: ID = switch part {
                case let .row(row): .row(row.id)
                case let .tool(tool): .tool(tool.id)
                case let .liveTools(_, anchor, _): .tool(anchor)
                }
                groups.append(Self(id: id, runID: nil, parts: [part]))
            }
        }
        if hasLiveContent {
            // Unknown ownership must never make unrelated runs look like one reply.
            if !searchActive, let liveRunID, let boundary = boundaries[liveRunID] {
                // A waiting follow-up must not move the current stream into
                // a new frame. Reuse its latest segment for the same input.
                if let index = groups.lastIndex(where: { group in
                    guard case let .run(runID, inputBoundary, _) = group.id else { return false }
                    return runID == liveRunID && inputBoundary == boundary
                }) {
                    groups[index].includesLive = true
                } else {
                    groups.append(Self(
                        id: .run(liveRunID, boundary, segments[liveRunID, default: 0]),
                        runID: liveRunID,
                        parts: [],
                        includesLive: true))
                }
            } else {
                groups.append(Self(id: .live, runID: nil, parts: [], includesLive: true))
            }
        }
        return groups
    }

    private static func isLiveToolEnvelope(_ message: OpenClawChatMessage) -> Bool {
        message.content.allSatisfy {
            $0.isToolCall || $0.isToolResult ||
                ($0.type == "thinking" && ($0.thinking ?? "")
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
        }
    }

    private static func compactLiveTools(
        _ parts: [Part],
        runIDs: Set<String>,
        tools: [OpenClawChatPendingToolCall]) -> [Part]
    {
        let callsByRun = ChatRowPassInputs.liveToolCallsByRun(tools)
        var compacted: [Part] = []
        for part in parts {
            guard let runID = part.runID, runIDs.contains(runID) else {
                compacted.append(part)
                continue
            }
            let items: [ChatToolActivityItem]
            switch part {
            case let .tool(tool):
                let item = ChatToolActivityItem(live: tool)
                guard item.sessionLaunch == nil else {
                    compacted.append(part)
                    continue
                }
                items = [item]
            case let .row(.message(message)) where !message.isNestedToolActivity &&
                (message.isToolResult || Self.isLiveToolEnvelope(message)):
                items = ChatToolActivity.items(
                    message: message,
                    liveTools: callsByRun[runID] ?? [],
                    assumesPendingInActiveRun: true)
                if items.contains(where: { $0.sessionLaunch != nil }) {
                    compacted.append(part)
                    continue
                }
            default:
                compacted.append(part)
                continue
            }
            let visible = items.filter(\.isVisible)
            guard let first = visible.first else { continue }
            if case let .liveTools(previous, anchor, earlier) = compacted.last, previous == runID {
                compacted[compacted.count - 1] = .liveTools(runID: runID, anchor: anchor, items: earlier + visible)
            } else {
                compacted.append(.liveTools(runID: runID, anchor: first.id, items: visible))
            }
        }
        return compacted
    }

    /// Index of the group that starts the latest turn, or the end when no group starts one.
    static func latestTurnStart(in groups: [Self]) -> Int {
        groups.lastIndex { $0.parts.first?.boundaryID != nil } ?? groups.endIndex
    }
}

extension ChatTranscriptRow {
    fileprivate var assistantRunID: String? {
        switch self {
        case let .message(message):
            guard !self.startsTurn,
                  message.isNestedToolActivity ||
                  ["assistant", "tool", "toolresult", "tool_result"].contains(message.role.lowercased())
            else { return nil }
            return message.workRunID
        case let .completedWork(work):
            let runs = work.messages.map(\.workRunID)
            guard let first = runs.first, let first, runs.allSatisfy({ $0 == first }) else { return nil }
            return first
        case .systemNotice, .historyDivider:
            return nil
        }
    }
}

struct ChatAssistantRunFrame<Content: View>: View {
    let showsAssistantAvatar: Bool
    var joinsAbove = false
    var joinsBelow = false
    @ViewBuilder let content: () -> Content

    var body: some View {
        #if os(iOS)
        HStack(alignment: .top, spacing: 8) {
            if self.showsAssistantAvatar {
                if self.joinsAbove {
                    ChatAssistantAvatar()
                        .hidden()
                        .frame(height: 0)
                        .clipped()
                        .accessibilityHidden(true)
                } else {
                    ChatAssistantAvatar()
                        .padding(.top, 5)
                }
            }
            VStack(alignment: .leading, spacing: 8, content: self.content)
                .environment(\.openClawAssistantRunContent, true)
                .padding(.top, self.joinsAbove ? 0 : 4)
                .padding(.bottom, self.joinsBelow ? 0 : 4)
                .focusable(false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Include disclosure and action rows in the container's accessibility bounds.
        .contentShape(.accessibility, Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-assistant-run")
        .assistantSpeakerLabel(avatarHidden: !self.showsAssistantAvatar)
        #else
        HStack(alignment: .top, spacing: 8) {
            if self.showsAssistantAvatar {
                ChatAssistantAvatar()
                    .padding(.top, 5)
            }
            VStack(alignment: .leading, spacing: 8, content: self.content)
                .environment(\.openClawAssistantRunContent, true)
                .padding(.vertical, 4)
                .focusable(false)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        // Include disclosure and action rows in the container's accessibility bounds.
        .contentShape(.accessibility, Rectangle())
        .accessibilityElement(children: .contain)
        .accessibilityIdentifier("chat-assistant-run")
        .assistantSpeakerLabel(avatarHidden: !self.showsAssistantAvatar)
        #endif
    }
}

extension EnvironmentValues {
    @Entry var openClawAssistantRunContent: Bool = false
}
