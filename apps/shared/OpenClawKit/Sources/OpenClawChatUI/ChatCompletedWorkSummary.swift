import Foundation
import OpenClawKit

enum ChatCompletedWorkSummary {
    /// Completed work names only its elapsed time (web chat-work-group-summary.tsx:56-62); an
    /// activity run names what it did.
    static func label(work: ChatTranscriptRow.CompletedWork) -> String {
        if work.isActivityRun { return self.activityHeadline(work.messages) }
        return self.workedFor(work.durationMilliseconds) ?? String(localized: "Worked")
    }

    /// "Worked for 1m 31s", or nil when the run has no positive duration. The reply footer shares it.
    static func workedFor(_ milliseconds: Double?) -> String? {
        milliseconds.flatMap(ChatWorkingDurationFormatter.completed(milliseconds:))
            .map { String(format: String(localized: "Worked for %@"), $0) }
    }

    /// "Ran commands, read files": each kind of operation once, in a fixed order, by its phase;
    /// outcomes other than failure follow. Failures stay on their own rows
    /// (web describeToolGroup and summarizeToolGroup, lib/chat/tool-call-grouping.ts:33-178).
    static func activityHeadline(_ messages: [OpenClawChatMessage]) -> String {
        var seen = Set<[String]>()
        var items: [ChatToolActivityItem] = []
        for message in messages {
            for item in ChatToolActivity.items(message: message) where item.isVisible {
                if seen.insert([message.workRunID ?? "", item.id]).inserted { items.append(item) }
            }
        }
        let grouped = Dictionary(grouping: items, by: Kind.init)
        var otherTools: [String] = []
        for item in grouped[.other] ?? [] {
            let call = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
            guard let name = call.name, name.lowercased() != "sessions_spawn" else { continue }
            let title = ToolDisplayRegistry.resolve(name: name, args: call.args).title
            if !otherTools.contains(title) { otherTools.append(title) }
        }
        let phrases = Kind.allCases.compactMap { kind -> String? in
            guard let members = grouped[kind], !members.isEmpty else { return nil }
            let running = kind != .subagents && members.contains { $0.displayState == .running }
            let completed = members.contains {
                $0.displayState == .finished || ($0.displayState == .failed && $0.exitCode != nil)
            }
            if kind == .other, !otherTools.isEmpty {
                let tools = otherTools.joined(separator: ", ")
                return String(
                    format: running ? String(localized: "Calling %@") : String(localized: "Called %@"),
                    tools)
            }
            return running ? kind.running : completed ? kind.summary : kind.pending
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

    /// Order is the order a headline lists them (web describeToolGroup counts).
    private enum Kind: CaseIterable {
        case commands, reads, edits, writes, searches, fetches
        case skillSearches, skillReads, waits, questions
        case other, subagents

        init(_ item: ChatToolActivityItem) {
            let call = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
            switch call.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "" {
            case "exec", "bash", "shell", "run_command", "run_terminal_cmd": self = .commands
            case "read", "read_file", "readfile", "notebookread", "notebook_read": self = .reads
            case "edit", "apply_patch", "applypatch", "patch", "edit_file", "multiedit", "multi_edit",
                 "notebookedit", "notebook_edit": self = .edits
            case "write", "write_file", "create_file": self = .writes
            case "grep", "glob", "find", "ls", "list", "codebase_search", "web_search": self = .searches
            case "web_fetch", "webfetch", "fetch": self = .fetches
            case "skills_search": self = .skillSearches
            case "skills_read": self = .skillReads
            case "agents_wait": self = .waits
            case "ask_user": self = .questions
            case "sessions_spawn":
                // A launch that ended without starting a worker, or opened its own chat, is an operation.
                let ended = [ChatToolActivityItem.State.failed, .blocked, .skipped].contains(item.displayState)
                self = ended || item.sessionLaunch?.kind == .chat ? .other : .subagents
            default: self = .other
            }
        }

        /// web i18n/locales/en-chat-tool-labels.ts:93-171
        var running: String {
            switch self {
            case .commands: String(localized: "Running commands")
            case .reads: String(localized: "Reading files")
            case .edits: String(localized: "Editing files")
            case .writes: String(localized: "Writing files")
            case .searches: String(localized: "Searching")
            case .fetches: String(localized: "Fetching pages")
            case .skillSearches: String(localized: "Searching skills")
            case .skillReads: String(localized: "Reading skills")
            case .waits: String(localized: "Waiting for agents")
            case .questions: String(localized: "Asking questions")
            case .other: String(localized: "Performing actions")
            case .subagents: String(localized: "Launched subagents")
            }
        }

        var summary: String {
            switch self {
            case .commands: String(localized: "Ran commands")
            case .reads: String(localized: "Read files")
            case .edits: String(localized: "Edited files")
            case .writes: String(localized: "Wrote files")
            case .searches: String(localized: "Searched")
            case .fetches: String(localized: "Fetched pages")
            case .skillSearches: String(localized: "Searched skills")
            case .skillReads: String(localized: "Read skills")
            case .waits: String(localized: "Waited for agents")
            case .questions: String(localized: "Asked questions")
            case .other: String(localized: "Performed actions")
            case .subagents: String(localized: "Launched subagents")
            }
        }

        var pending: String {
            switch self {
            case .commands: String(localized: "Commands")
            case .reads: String(localized: "File reads")
            case .edits: String(localized: "File edits")
            case .writes: String(localized: "File writes")
            case .searches: String(localized: "Searches")
            case .fetches: String(localized: "Page fetches")
            case .skillSearches: String(localized: "Skill searches")
            case .skillReads: String(localized: "Skill reads")
            case .waits: String(localized: "Wait for agents")
            case .questions: String(localized: "Question requests")
            case .other: String(localized: "Actions")
            case .subagents: String(localized: "Subagent launches")
            }
        }
    }
}
