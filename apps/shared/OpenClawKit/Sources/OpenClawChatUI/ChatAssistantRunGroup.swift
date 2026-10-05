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

        var id: String {
            switch self {
            case let .row(row): "row:\(row.id)"
            case let .tool(tool): "tool:\(tool.id)"
            }
        }

        var runID: String? {
            switch self {
            case let .row(row): row.assistantRunID
            case let .tool(tool): tool.runID
            }
        }

        var timestamp: Double? {
            switch self {
            case let .row(row): row.timestamp
            case let .tool(tool): tool.startedAt
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

    /// Keep the current turn eager and premeasure nearby history before live-edge positioning.
    /// Anchor the window to that turn, not the group count; appended tools cannot retire a reader's row.
    static func eagerHistoryStart(_ groups: [Self], warming count: Int) -> Int {
        let latestTurnIndex = groups.lastIndex { group in
            group.parts.contains { part in
                if case let .row(row) = part { return row.startsTurn }
                return false
            }
        } ?? groups.lastIndex(where: \.includesLive) ?? groups.endIndex
        return max(groups.startIndex, latestTurnIndex - count)
    }

    /// ScrollViewReader resolves the lazy group's root, not an unmeasured nested row.
    static func scrollTargets(_ groups: [Self]) -> [UUID: ID] {
        groups.reduce(into: [:]) { targets, group in
            for case let .row(row) in group.parts {
                targets[row.id] = group.id
            }
        }
    }

    static func build(
        _ rows: [ChatTranscriptRow],
        tools: [OpenClawChatPendingToolCall] = [],
        liveRunID: String?,
        hasLiveContent: Bool,
        searchActive: Bool) -> [Self]
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
            let index = tool.startedAt.flatMap { startedAt in
                parts.firstIndex { ($0.timestamp.map { $0 > startedAt }) == true }
            } ?? parts.endIndex
            parts.insert(.tool(tool), at: index)
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
                }
                groups.append(Self(id: id, runID: nil, parts: [part]))
            }
        }
        if hasLiveContent {
            // Unknown ownership must never make unrelated runs look like one reply.
            if !searchActive, let liveRunID, let boundary = boundaries[liveRunID] {
                if groups.last?.runID == liveRunID {
                    groups[groups.count - 1].includesLive = true
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
}

extension ChatTranscriptRow {
    fileprivate var assistantRunID: String? {
        switch self {
        case let .message(message):
            guard !self.startsTurn,
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
