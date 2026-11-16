import Foundation
import OpenClawKit

enum ChatCompletedWorkSummary {
    static func latestItem(work: ChatTranscriptRow.CompletedWork) -> ChatToolActivityItem? {
        work.messages.reversed().compactMap { message in
            ChatToolActivity.items(message: message).last(where: \.isVisible)
        }.first
    }

    static func liveLabel(work: ChatTranscriptRow.CompletedWork) -> String {
        guard let latest = self.latestItem(work: work) else { return String(localized: "Working") }
        let call = ToolDisplayRegistry.displayCall(name: latest.name, args: latest.arguments)
        let display = ToolDisplayRegistry.resolve(name: call.name, args: call.args)
        return display.detailLine ?? latest.activity?.preparedTitle ?? display.title
    }

    static func rollupLabel(messages: [OpenClawChatMessage], expanded: Bool) -> String {
        let label = String(localized: "Worked")
        let count = self.items(messages).count
        guard expanded, count > 0 else { return label }
        let total = String(
            format: count == 1 ?
                String(localized: "%lld tool call") : String(localized: "%lld tool calls"),
            count)
        return "\(label) · \(total)"
    }

    static func label(work: ChatTranscriptRow.CompletedWork, expanded: Bool) -> String {
        var parts: [String] = []
        let items = self.items(work.messages)
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
            let count = items.filter {
                // Like web unpairedCall, a call awaiting output has no unknown outcome.
                $0.displayState == state && (state != .unavailable || $0.resultText != nil)
            }.count
            if count > 0 {
                parts.append(String(format: format, count))
            }
        }
        return parts.joined(separator: " · ")
    }

    static func items(_ messages: [OpenClawChatMessage]) -> [ChatToolActivityItem] {
        var items: [[String]: ChatToolActivityItem] = [:]
        for message in ChatTranscriptRow.mergeToolResults(in: messages) {
            // Summaries count calls, not standalone or orphan result rows.
            guard !message.isToolResult else { continue }
            // Split envelopes keep the result recorded on the call fragment;
            // pairing must see it even though the text renders elsewhere.
            let pairedResults = message.content.filter(\.isToolResult) +
                message.presentationRecordedToolResults
            let pairedIDs = Set(pairedResults.compactMap(\.id))
            let callIDs = Set(message.content.filter(\.isToolCall).enumerated().map {
                $0.element.id ?? "call-\($0.offset)"
            })
            let explicitIDs = Set(message.content.compactMap(\.id) + [message.toolCallId].compactMap(\.self))
            for var item in ChatToolActivity.items(message: message) where callIDs.contains(item.id) {
                if item.resultText == nil, pairedIDs.contains(item.id) {
                    item.resultText = pairedResults.first { $0.id == item.id }?.text ?? ""
                }
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
