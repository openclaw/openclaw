import Foundation
import OpenClawKit

enum ChatCompletedWorkSummary {
    /// Completed work names only its elapsed time (web chat-work-group-summary.tsx:56-62); an
    /// activity run names what it did.
    static func label(work: ChatTranscriptRow.CompletedWork, liveTools: [OpenClawChatPendingToolCall] = []) -> String {
        if work.isActivityRun { return self.activityHeadline(work.messages, liveTools: liveTools) }
        return self.workedFor(work.durationMilliseconds) ?? String(localized: "Worked")
    }

    /// "Worked for 1m 31s", or nil when the run has no positive duration. The reply footer shares it.
    static func workedFor(_ milliseconds: Double?) -> String? {
        milliseconds.flatMap(ChatWorkingDurationFormatter.completed(milliseconds:))
            .map { String(format: String(localized: "Worked for %@"), $0) }
    }

    /// "Read and changed files, ran commands": each kind of work once, in the web's order and words, by its
    /// phase; outcomes other than failure follow. Failures stay on their own rows
    /// (web describeToolGroup and summarizeToolGroup, ui/src/lib/chat/tool-call-grouping.ts, main 1b06bd7b898e).
    static func activityHeadline(
        _ messages: [OpenClawChatMessage],
        liveTools: [OpenClawChatPendingToolCall] = []) -> String
    {
        var seen = Set<[String]>()
        var items: [ChatToolActivityItem] = []
        for message in messages {
            let live = liveTools.filter { $0.runID == message.workRunID }
            for item in ChatToolActivity.items(message: message, liveTools: live) where item.isVisible {
                if seen.insert([message.workRunID ?? "", item.id]).inserted { items.append(item) }
            }
        }
        return self.headline(items)
    }

    static func headline(_ items: [ChatToolActivityItem]) -> String {
        let grouped = Dictionary(grouping: items, by: Kind.init)
        func isRunning(_ item: ChatToolActivityItem) -> Bool {
            item.displayState == .running
        }
        func isCompleted(_ item: ChatToolActivityItem) -> Bool {
            item.displayState == .finished ||
                (![.blocked, .skipped].contains(item.displayState) && item.exitCode != nil)
        }
        func phase(_ actions: [ChatToolActivityItem]) -> Phase {
            actions.contains(where: isRunning) ? .running : actions.contains(where: isCompleted) ? .summary : .pending
        }
        let reads = grouped[.reads] ?? []
        let changes = grouped[.changes] ?? []
        let hasFileWork = !reads.isEmpty || !changes.isEmpty
        // Combine the same kind of work only when both verbs describe the recorded state.
        let combineFiles = !reads.isEmpty && !changes.isEmpty && phase(reads) == phase(changes)
        let meaningfulWork = grouped.contains { $0.key != .other && !$0.value.isEmpty }
        let phrases = Kind.allCases.compactMap { kind -> String? in
            guard let actions = grouped[kind], !actions.isEmpty, !(combineFiles && kind == .changes) else { return nil }
            // Completed discovery supports file work; active, uncertain and write operations keep their labels.
            if actions.allSatisfy({ isCompleted($0) && !isRunning($0) }) {
                if kind == .other, meaningfulWork { return nil }
                let discovery = kind == .searches || (kind == .memory && !actions.contains(where: \.updatesMemory))
                if hasFileWork, discovery { return nil }
            }
            switch kind {
            case .memory:
                let updates = actions.filter(\.updatesMemory)
                let memoryReads = actions.filter { !$0.updatesMemory }
                if updates.contains(where: isRunning) { return String(localized: "Updating memory") }
                if memoryReads.contains(where: isRunning) { return String(localized: "Reading memory") }
                if updates.contains(where: isCompleted) {
                    return memoryReads.contains(where: isCompleted)
                        ? String(localized: "Read and updated memory") : String(localized: "Updated memory")
                }
                return memoryReads.contains(where: isCompleted)
                    ? String(localized: "Read memory") : String(localized: "Memory operations")
            case .subagents:
                return actions.contains(where: isCompleted)
                    ? String(localized: "Launched subagents") : String(localized: "Subagent launches")
            case .reads where combineFiles:
                return Kind.readChangesLabel(phase(actions))
            default:
                return kind.label(phase(actions))
            }
        }
        let label = phrases.enumerated().map { index, phrase in
            index == 0 ? phrase : phrase.prefix(1).lowercased() + phrase.dropFirst()
        }.joined(separator: ", ")
        var outcomes: [String] = []
        if items.contains(where: { $0.displayState == .blocked }) { outcomes.append(String(localized: "Blocked")) }
        // A call with no result yet is unpaired, not an unknown outcome.
        if items.contains(where: { $0.displayState == .unavailable && $0.resultText != nil }) {
            outcomes.append(String(localized: "Outcome unknown"))
        }
        return ([label] + outcomes).filter { !$0.isEmpty }.joined(separator: " · ")
    }

    private enum Phase { case running, summary, pending }

    /// Order is the order a headline lists them (web describeToolGroup groups).
    private enum Kind: CaseIterable {
        case reads, changes, commands, searches, fetches, memory, messages, waits, questions, other, subagents

        init(_ item: ChatToolActivityItem) {
            let call = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
            let name = call.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
            if item.commandPreview != nil {
                self = .commands
                return
            }
            switch name {
            case "exec", "bash", "shell", "run_command", "run_terminal_cmd": self = .commands
            case "read", "read_file", "readfile", "notebookread", "notebook_read", "skills_read": self = .reads
            case "edit", "apply_patch", "applypatch", "patch", "edit_file", "multiedit", "multi_edit",
                 "notebookedit", "notebook_edit", "write", "write_file", "create_file": self = .changes
            case "grep", "glob", "find", "ls", "list", "codebase_search", "web_search", "skills_search",
                 "memory_search", "knowledge_grep": self = .searches
            case "web_fetch", "webfetch", "fetch": self = .fetches
            case "memory_get", "knowledge_record", "knowledge_records", "knowledge_lookup", "knowledge_remember",
                 "knowledge_edit_body", "knowledge_save_page", "knowledge_create_claim": self = .memory
            case "sessions_send", "conversations_send": self = .messages
            case "agents_wait": self = .waits
            case "ask_user": self = .questions
            case "sessions_spawn":
                // A launch that ended without starting a worker, or opened its own chat, is an operation.
                let ended = [ChatToolActivityItem.State.failed, .blocked, .skipped].contains(item.displayState)
                self = ended || item.sessionLaunch?.kind == .chat ? .other : .subagents
            default: self = .other
            }
        }

        static func readChangesLabel(_ phase: Phase) -> String {
            switch phase {
            case .running: String(localized: "Reading and changing files")
            case .summary: String(localized: "Read and changed files")
            case .pending: String(localized: "File reads and changes")
            }
        }

        /// web i18n/locales/en-chat-tool-labels.ts `activity` (memory and subagents are phrased above).
        func label(_ phase: Phase) -> String {
            let (running, summary, pending): (String, String, String) = switch self {
            case .reads: (
                    String(localized: "Reading files"),
                    String(localized: "Read files"),
                    String(localized: "File reads"))
            case .changes:
                (
                    String(localized: "Changing files"),
                    String(localized: "Changed files"),
                    String(localized: "File changes"))
            case .commands:
                (
                    String(localized: "Running commands"),
                    String(localized: "Ran commands"),
                    String(localized: "Commands"))
            case .searches: (
                    String(localized: "Searching"),
                    String(localized: "Searched"),
                    String(localized: "Searches"))
            case .fetches:
                (
                    String(localized: "Fetching pages"),
                    String(localized: "Fetched pages"),
                    String(localized: "Page fetches"))
            case .messages:
                (
                    String(localized: "Sending messages"),
                    String(localized: "Sent messages"),
                    String(localized: "Message sends"))
            case .waits: (
                    String(localized: "Waiting for agents"),
                    String(localized: "Waited for agents"),
                    String(localized: "Wait for agents"))
            case .questions: (
                    String(localized: "Asking questions"),
                    String(localized: "Asked questions"),
                    String(localized: "Question requests"))
            case .other, .memory, .subagents:
                (String(localized: "Using tools"), String(localized: "Used tools"), String(localized: "Tool calls"))
            }
            return switch phase {
            case .running: running
            case .summary: summary
            case .pending: pending
            }
        }
    }
}

extension ChatToolActivityItem {
    /// Knowledge tools that change memory rather than read it (web MEMORY_UPDATE_TOOLS).
    fileprivate var updatesMemory: Bool {
        let call = ToolDisplayRegistry.displayCall(name: self.name, args: self.arguments)
        return ["knowledge_remember", "knowledge_edit_body", "knowledge_save_page", "knowledge_create_claim"]
            .contains(call.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "")
    }
}
