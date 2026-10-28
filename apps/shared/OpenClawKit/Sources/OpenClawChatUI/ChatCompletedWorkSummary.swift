import Foundation
import OpenClawKit

enum ChatCompletedWorkSummary {
    static func label(work: ChatTranscriptRow.CompletedWork, expanded: Bool) -> String {
        var parts = [work.durationMilliseconds.map {
            String(format: String(localized: "Worked for %@"), ChatWorkingDurationFormatter.compact(milliseconds: $0))
        } ?? String(localized: "Worked")]
        let items = self.items(work.messages)
        if expanded, !items.isEmpty {
            parts.append(String(
                format: items.count == 1 ?
                    String(localized: "%lld tool call") : String(localized: "%lld tool calls"),
                items.count))
        }
        let counts = Dictionary(grouping: items, by: { self.category($0) })
        for category in Category.allCases {
            guard let count = counts[category]?.count, count > 0 else { continue }
            parts.append(String(format: category.format(count), count))
        }
        for (state, format) in [
            (ChatToolActivityItem.State.failed, String(localized: "%lld failed")),
            (.blocked, String(localized: "%lld blocked")),
            (.skipped, String(localized: "%lld skipped")),
            (.unavailable, String(localized: "%lld unknown")),
        ] {
            let count = items.filter { $0.displayState == state }.count
            if count > 0 {
                parts.append(String(format: format, count))
            }
        }
        return parts.joined(separator: " · ")
    }

    private static func items(_ messages: [OpenClawChatMessage]) -> [ChatToolActivityItem] {
        var items: [[String]: ChatToolActivityItem] = [:]
        for message in messages {
            let explicitIDs = Set(message.content.compactMap(\.id) + [message.toolCallId].compactMap(\.self))
            for item in ChatToolActivity.items(message: message) {
                // Recorded IDs are run-scoped; generated fallback IDs belong
                // only to the source fragment that assigned them.
                let key = [
                    message.workRunID ?? "",
                    explicitIDs.contains(item.id) ? "" : message.presentationID.uuidString,
                    item.id,
                ]
                // Prepared visibility wins over the raw fallback for the same call.
                if items[key]?.activity != nil, item.activity == nil {
                    continue
                }
                items[key] = item
            }
        }
        return items.values.filter(\.isVisible)
    }

    private enum Category: CaseIterable {
        case commands, reads, edits, writes, searches, fetches, other, subagents

        func format(_ count: Int) -> String {
            switch self {
            case .commands:
                if count == 1 {
                    return String(localized: "%lld command")
                }
                return String(localized: "%lld commands")
            case .reads:
                if count == 1 {
                    return String(localized: "%lld read")
                }
                return String(localized: "%lld reads")
            case .edits:
                if count == 1 {
                    return String(localized: "%lld edit")
                }
                return String(localized: "%lld edits")
            case .writes:
                if count == 1 {
                    return String(localized: "%lld write")
                }
                return String(localized: "%lld writes")
            case .searches:
                if count == 1 {
                    return String(localized: "%lld search")
                }
                return String(localized: "%lld searches")
            case .fetches:
                if count == 1 {
                    return String(localized: "%lld fetch")
                }
                return String(localized: "%lld fetches")
            case .other:
                if count == 1 {
                    return String(localized: "%lld other operation")
                }
                return String(localized: "%lld other operations")
            case .subagents:
                if count == 1 {
                    return String(localized: "%lld subagent")
                }
                return String(localized: "%lld subagents")
            }
        }
    }

    private static func category(_ item: ChatToolActivityItem) -> Category {
        let call = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
        let name = call.name?.lowercased() ?? ""
        switch name {
        case "exec", "bash", "shell", "run_command", "run_terminal_cmd": return .commands
        case "read", "read_file", "readfile", "notebookread", "notebook_read": return .reads
        case "edit", "apply_patch", "applypatch", "patch", "edit_file", "multiedit", "multi_edit",
             "notebookedit", "notebook_edit": return .edits
        case "write", "write_file", "create_file": return .writes
        case "grep", "glob", "find", "ls", "list", "codebase_search", "web_search": return .searches
        case "web_fetch", "webfetch", "fetch": return .fetches
        case "sessions_spawn":
            return item.displayState == .finished && call.args?.dictionaryValue?["visible"]?.boolValue != true
                ? .subagents : .other
        default: return .other
        }
    }
}
