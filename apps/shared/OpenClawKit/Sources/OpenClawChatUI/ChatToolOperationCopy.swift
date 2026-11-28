import Foundation
import OpenClawKit

/// What a tool row says, in the Control UI's words: `catalogToolOperation` (chat-tool-operation-copy.ts) and
/// the named branches of `resolveToolOperationLabel` (chat-tool-row-presentation.ts), openclaw main
/// `1b06bd7b898e`. The wording lives in `tool-operations.json`, generated from the web's catalogs.
enum ChatToolOperationCopy {
    enum Outcome {
        case running
        case succeeded
        /// Failed, blocked, unknown or unrecorded: the row names the action.
        case other
        case failed
    }

    struct Call {
        var name: String
        var args: [String: Any]
        var outcome: Outcome
        var details: [String: Any]?
        var resultText: String?
        var addressedName: String?
        var exitCode: Int?
    }

    private static func pick(_ outcome: Outcome, _ running: String, _ succeeded: String, _ other: String) -> String {
        switch outcome {
        case .running: running
        case .succeeded: succeeded
        case .other, .failed: other
        }
    }

    private static func string(_ value: Any?) -> String? {
        guard let text = value as? String else { return nil }
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    /// The result as JSON. A dispatcher's envelope (`{tool, result: {content: [text]}}`) yields the called
    /// tool's own result (web unwrapToolResultTextForDisplay).
    private static func json(_ text: String?) -> [String: Any]? {
        guard let data = text?.trimmingCharacters(in: .whitespacesAndNewlines).data(using: .utf8),
              let object = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any]
        else { return nil }
        return object
    }

    private static func unwrappedText(_ text: String?) -> String? {
        guard let object = self.json(text), object["tool"] is [String: Any],
              let content = (object["result"] as? [String: Any])?["content"] as? [[String: Any]] else { return text }
        return content.compactMap { $0["type"] as? String == "text" ? $0["text"] as? String : nil }
            .joined(separator: "\n")
    }

    /// The structured result: the called tool's details when a dispatcher wrapped them.
    private static func structured(_ call: Call) -> [String: Any]? {
        ((call.details?["result"] as? [String: Any])?["details"] as? [String: Any]) ?? call.details
    }

    private static func toolCards(_ key: String, _ values: [String: String] = [:]) -> String? {
        ToolOperationCatalog.text("\(key)", values)
    }

    // MARK: - Row label (web chat-tool-card-row.solid.tsx rowLabel)

    /// The row's label, or nil when the web would fall back to the tool's display title.
    static func label(_ call: Call) -> String? {
        var call = call
        call.resultText = self.unwrappedText(call.resultText)
        let name = call.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if let verb = self.fileVerb(name: name, call: call) { return verb }
        if let operation = self.operation(call) { return operation }
        if ChatToolActivityItem.commandToolNames.contains(name) ||
            (call.args["command"] is String && call.args.count <= 3 && !self.editorTools.contains(name))
        {
            if let command = (call.args["command"] as? String).flatMap(self.shellPreview) {
                let key = self.pick(
                    call.outcome,
                    "runningCommand",
                    "ranCommand",
                    call.outcome == .failed && call.exitCode != nil ? "ranCommand" : "runCommand")
                return self.toolCards(key, ["command": command])
            }
            if name == "exec", let purpose = self.string(call.args["title"]) { return purpose }
            return self.toolCards(self.pick(call.outcome, "executingCode", "executedCode", "codeExecution"))
        }
        return self.namedLabel(name: name, call: call)
    }

    private static let editorTools: Set<String> = ["str_replace_editor", "str_replace_based_edit_tool"]

    /// chat-command-highlight.solid.tsx: strip up to four shell setup clauses, then cap the one-line preview.
    static func shellPreview(_ command: String) -> String? {
        var rest = command.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !rest.isEmpty else { return nil }
        // tool-call-view.ts displays what the harness wrapped in sh -lc, not its wrapper.
        if let match = rest.wholeMatch(of: /(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-l?c\s+(['"])([\s\S]+)\1/) {
            rest = String(match.2)
        }
        let inner = rest
        for pass in 0..<4 {
            var quote: Character?
            var escaped = false
            var depth = 0
            var separator: Range<String.Index>?
            for index in rest.indices {
                let char = rest[index]
                if escaped { escaped = false
                    continue
                }
                if char == "\\", quote != "'" { escaped = true
                    continue
                }
                if let active = quote {
                    if char == active { quote = nil }
                    continue
                }
                if char == "'" || char == "\"" || char == "`" { quote = char
                    continue
                }
                if char == "(" || char == "{" { depth += 1
                    continue
                }
                if char == ")" || char == "}" { depth = max(0, depth - 1)
                    continue
                }
                guard depth == 0 else { continue }
                let next = rest.index(after: index)
                if char == ";" || char == "\n" { separator = index..<next
                    break
                }
                if char == "&" || char == "|", next < rest.endIndex, rest[next] == char {
                    separator = index..<rest.index(after: next)
                    break
                }
            }
            let head = rest[..<(separator?.lowerBound ?? rest.endIndex)]
            let first = head.split(whereSeparator: \.isWhitespace).first.map(String.init) ?? ""
            let changesDirectory = ["cd", "pushd", "popd"].contains((first as NSString).lastPathComponent)
                && (separator.map { rest[$0] != "||" } ?? (pass > 0))
            guard head.hasPrefix("set ") || head.hasPrefix("export ") || head.hasPrefix("unset ") || changesDirectory
            else { break }
            rest = separator.map { String(rest[
                $0.upperBound...,
            ]).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
            if rest.isEmpty { rest = inner
                break
            }
        }
        return self.prefixUTF16(rest.split(whereSeparator: \.isWhitespace).joined(separator: " "), limit: 200)
    }

    private static func prefixUTF16(_ text: String, limit: Int) -> String {
        guard text.utf16.count > limit else { return text }
        var units = text.utf16.prefix(limit)
        if let last = units.last, (0xD800...0xDBFF).contains(last) { units = units.dropLast() }
        return String(decoding: units, as: UTF16.self)
    }

    static func launchLabel(_ launch: ChatSessionLaunch, call: Call) -> String? {
        var receipt = self.json(self.unwrappedText(call.resultText)) ?? [:]
        receipt.merge(call.details ?? [:]) { $1 }
        let name = call.addressedName ?? launch.label
        let limitPrefix = "sessions_spawn has reached max active children for this session "
        if launch.kind == .subagent, receipt["status"] as? String == "forbidden",
           let error = receipt["error"] as? String,
           error.hasPrefix(limitPrefix),
           let match = error.dropFirst(limitPrefix.count).wholeMatch(
               of: /^\((\d+)\/(\d+); agents\.defaults\.subagents\.maxChildrenPerAgent\)\.$/)
        {
            return self.toolCards(
                name == nil ? "launch.subagent.limitReached" : "launch.subagent.namedLimitReached",
                ["name": name ?? "", "active": String(match.1), "limit": String(match.2)])
        }
        return self.toolCards("launch.\(launch.kind).\(launch.phase)")
            .map { [$0, name].compactMap(\.self).joined(separator: " ") }
    }

    private static let readTools: Set = ["read", "read_file", "readfile", "notebookread", "notebook_read"]
    private static let patchTools: Set = ["apply_patch", "applypatch", "patch"]
    private static let editTools: Set = [
        "edit", "edit_file", "multiedit", "multi_edit", "notebookedit", "notebook_edit",
    ]
    private static let writeTools: Set = ["write", "write_file", "create_file"]
    private static let searchTools: Set = ["grep", "find", "glob", "ls", "list", "codebase_search"]
    private static let fetchTools: Set = ["web_fetch", "webfetch", "fetch"]

    /// "Read Header.swift", "Searching ChatTheme", "Couldn't fetch https://…" (web resolveToolRowVerb).
    private static func fileVerb(name: String, call: Call) -> String? {
        let args = call.args
        var name = name
        if self.editorTools.contains(name) {
            switch self.string(args["command"])?.lowercased() {
            case "view": name = "read"
            case "insert", "str_replace", "undo_edit": name = "edit"
            case "create": name = "write"
            default: return nil
            }
        }
        let path = ["path", "file_path", "filePath", "file", "filepath", "filename", "notebook_path"]
            .lazy.compactMap { self.string(args[$0]) }.first
        let file = path.map { ($0 as NSString).lastPathComponent }
        let failed = call.outcome == .failed
        let verb: (String, String)? = if self.readTools.contains(name) {
            (self.pick(call.outcome, "reading", "read", failed ? "readFailed" : "read"), file ?? "")
        } else if self.searchTools.contains(name) {
            (
                self.pick(call.outcome, "searching", "searched", failed ? "searchFailed" : "search"),
                self.string(args["pattern"]) ?? self.string(args["query"]) ?? self.string(args["glob"]) ?? file ?? "")
        } else if self.fetchTools.contains(name) {
            (
                self.pick(call.outcome, "fetching", "fetched", failed ? "fetchFailed" : "fetch"),
                self.string(args["url"]) ?? "")
        } else if self.editTools.contains(name) {
            (self.pick(call.outcome, "editing", "edited", "edit"), file ?? "")
        } else if self.writeTools.contains(name) {
            (self.pick(call.outcome, "writing", "wrote", "write"), file ?? "")
        } else {
            nil
        }
        guard let (key, target) = verb, !target.isEmpty, let word = self.toolCards("verbs.\(key)") else { return nil }
        return "\(word) \(target)"
    }

    // MARK: - Catalog operations (web catalogToolOperation)

    private static let knowledgePublicationTools: Set = [
        "knowledge_annotate", "knowledge_correct", "knowledge_create_claim", "knowledge_create_relationship",
        "knowledge_edit_body", "knowledge_extract_section", "knowledge_merge", "knowledge_publish_batch",
        "knowledge_recall", "knowledge_reconcile_evidence", "knowledge_resume", "knowledge_save_page",
        "knowledge_supersede", "knowledge_unmerge", "knowledge_withdraw",
    ]

    // One function, case for case with the web's catalogToolOperation, so the two can be read side by side.
    // swiftlint:disable:next cyclomatic_complexity
    static func operation(_ call: Call) -> String? {
        let name = call.name.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let args = call.args
        let outcome = call.outcome
        if name == "toolsearch" || name == "tool_search" {
            let selecting = name == "toolsearch" && (self.string(args["query"])?.hasPrefix("select:") ?? false)
            return self.toolCards(selecting
                ? self.pick(outcome, "selectingTools", "selectedTools", "selectTools")
                : self.pick(outcome, "searchingTools", "searchedTools", "searchTools"))
        }
        if name == "sessions_list" {
            return self.toolCards(self.pick(outcome, "listingChats", "listedChats", "listChats"))
        }
        if outcome == .succeeded, name == "conversations_send" || name == "conversations_turn" {
            let status = (call.details?["status"] ?? self.json(call.resultText)?["status"]) as? String
            let known = ["sent", "queued", "suppressed"] + (name == "conversations_turn" ? ["replied", "timeout"] : [])
            let receipt = status.flatMap { known.contains($0) ? $0 : nil } ?? "unknown"
            return self.toolCards("conversationDelivery.\(receipt)")
        }
        guard let labels = ToolOperationCatalog.entry("operationLabels.\(name)") else { return nil }
        var action = args["action"] as? String
        let media = ["image_generate", "music_generate", "video_generate"].contains(name)
        if name == "message", action == "react" {
            let receipt = outcome == .succeeded && args["dryRun"] as? Bool != true ? self.messageReceipt(call) : nil
            let removed = receipt?["removed"]
            let clearCount = (removed as? [Any])?.count ?? (removed as? Int)
            if args["remove"] as? Bool == true || receipt?["remove"] as? Bool == true || removed is NSNull {
                action = "remove_reaction"
            } else if clearCount != nil ||
                (args["emoji"] as? String).map({ $0.trimmingCharacters(in: .whitespaces).isEmpty }) ??
                (args["channel"] as? String == "feishu" && args["clearAll"] as? Bool == true)
            {
                action = "clear_reactions"
            }
            if receipt?["ok"] as? Bool == false || receipt?["dryRun"] as? Bool == true {
                return self.toolCards("operationLabels.message.\(action ?? "").action")
            }
            if receipt?["changed"] as? Bool == false || removed is NSNull || clearCount == 0 {
                return self.toolCards("operationLabels.message.\(action ?? "").unchanged")
            }
        }
        if name == "workboard_board_archive" {
            action = args["archived"] as? Bool == false ? "restore" : nil
        } else if name == "workboard_verify" {
            action = args["outcome"] as? String == "confirmed" ? "confirmed" : nil
        } else if name == "lobster", action == "resume" {
            if args["cancel"] as? Bool == true {
                action = "cancel"
            } else if args["approve"] as? Bool == false {
                action = "decline"
            }
        }
        let key: String? = if name == "update_goal", let status = args["status"] as? String {
            "status_\(status)"
        } else if name == "browser", action == "act" {
            self.browserOperation(args, labels)
        } else if name == "local_image", args["task"] as? String == "ocr" {
            "task_ocr"
        } else if media {
            action?.trimmingCharacters(in: .whitespaces).lowercased().nilIfEmpty ?? "generate"
        } else {
            action?.replacingOccurrences(of: ".", with: "_")
        }
        var operation = key.flatMap { labels[$0] != nil ? $0 : nil } ?? "default"
        if name == "knowledge_attach", args["final"] as? Bool == true {
            operation = "final"
        } else if name == "knowledge_relink" || name == "knowledge_reconcile_evidence",
                  args["dryRun"] as? Bool == true
        {
            operation = "preview"
        } else if name == "knowledge_supersede", args["undo"] as? Bool == true {
            operation = "restore"
        }
        guard labels[operation] != nil else { return nil }
        var qualifier: String?
        var phase = outcome == .running ? "running"
            : outcome == .succeeded && !(name == "message" && args["dryRun"] as? Bool == true) ? "done" : "action"
        if media, operation == "generate", phase == "done" {
            phase = self.mediaPhase(call, kind: String(name.dropLast("_generate".count)))
        }
        if name == "message", operation == "reply", phase == "done" {
            let receipt = self.messageReceipt(call)
            let messageID = self.string(receipt?["messageId"])
            if self.string(receipt?["repliedTo"]) == nil || messageID == nil
                || ["ok", "unknown", "skipped", "suppressed"].contains(messageID ?? "")
                || receipt?["dryRun"] as? Bool == true || receipt?["status"] as? String == "suppressed"
            {
                phase = "action"
            }
        }
        let remember = name == "knowledge_remember"
        if phase == "done", remember || self.knowledgePublicationTools.contains(name) {
            let structured = self.structured(call)
            let result = structured.flatMap { value in
                (remember ? value["receipt"] != nil : value["state"] != nil || value["revision"] != nil) ? value : nil
            } ?? self.json(call.resultText)
            let receipt = remember ? result?["receipt"] as? [String: Any] : result
            let items = result?["items"] as? [Any] ?? []
            let allDuplicates = remember && result?["receipt"] is NSNull && !items.isEmpty
                && items.allSatisfy { ($0 as? [String: Any])?["status"] as? String == "duplicate" }
            if name == "knowledge_reconcile_evidence", receipt?["state"] as? String == "preview" {
                operation = "preview"
            } else if !allDuplicates {
                qualifier = operation == "preview" ? "operationUnknown" : self.publicationQualifier(receipt)
                if qualifier != nil { phase = "action" }
            }
        } else if phase == "done", name == "knowledge_relink" || name == "knowledge_verify" {
            var result = self.structured(call) ?? [:]
            result.merge(self.json(call.resultText) ?? [:]) { $1 }
            if name == "knowledge_relink" {
                if result["dryRun"] as? Bool == true {
                    operation = "preview"
                } else if operation != "preview", (result["linked"] as? Int ?? 0) > 0 {
                    phase = "linked"
                }
            } else {
                phase = result["failed"] as? Int == 0 && (result["passed"] as? Int ?? 0) > 0 ? "done" : "checked"
            }
        }
        let input = (name == "web_search" || name == "memory_search") ? args["query"] as? String
            : name == "wiki_get" ? args["lookup"] as? String : nil
        let query = input.map { value in
            let flat = value.replacingOccurrences(
                of: #"[\s\p{Cc}\p{Bidi_Control}]+"#,
                with: " ",
                options: .regularExpression)
                .trimmingCharacters(in: .whitespaces)
            return flat.utf16.count > 120 ? self.prefixUTF16(flat, limit: 119) + "…" : flat
        }.flatMap(\.nilIfEmpty)
        let base = "operationLabels.\(name).\(operation).\(phase)"
        guard let label = query.flatMap({ self.toolCards(base + "WithQuery", ["query": $0]) }) ?? self.toolCards(base)
        else { return nil }
        let target = name == "nodes" && operation == "describe"
            ? self.describedNode(args["node"], call) : call.addressedName
        let named = target.flatMap { self.toolCards("namedOperation", ["action": label, "name": $0]) } ?? label
        return qualifier.flatMap { self.toolCards($0, ["action": named]) } ?? named
    }

    private static func messageReceipt(_ call: Call) -> [String: Any]? {
        var receipt = self.json(call.resultText) ?? [:]
        receipt.merge(self.structured(call) ?? [:]) { $1 }
        if receipt["ok"] as? Bool == false { return ["ok": false] }
        return receipt["ok"] as? Bool == true ? receipt : nil
    }

    private static func browserOperation(_ args: [String: Any], _ labels: [String: Any]) -> String {
        guard let kind = ((args["request"] as? [String: Any])?["kind"] ?? args["kind"]) as? String else { return "act" }
        return labels["act_\(kind)"] != nil ? "act_\(kind)" : "act"
    }

    private static func describedNode(_ selector: Any?, _ call: Call) -> String? {
        guard let node = (selector as? String)?.trimmingCharacters(in: .whitespaces), !node.isEmpty,
              node.first?.isLetter == true,
              node.allSatisfy({ $0.isLetter || $0.isNumber || " '’-".contains($0) })
        else { return nil }
        if node.contains(" ") { return node }
        let described = self.structured(call)
        return node == described?["displayName"] as? String && node != described?["nodeId"] as? String ? node : nil
    }

    private static func mediaPhase(_ call: Call, kind: String) -> String {
        let receipt = self.structured(call)
        if receipt?["action"] as? String == "status" || receipt?["duplicateGuard"] as? Bool == true { return "action" }
        if receipt?["async"] as? Bool == true, let status = receipt?["status"] as? String {
            return status == "started" ? "requested" : "action"
        }
        if let attachments = receipt?["attachments"] as? [Any] {
            return receipt?["async"] as? Bool != true && !attachments.isEmpty ? "done" : "action"
        }
        let output = call.resultText ?? ""
        let notice = #"^(?:Review-before-delivery is enabled\.[^\n]*\n)?"#
        let started = notice + "Background task started for " + kind + #" generation \([^\s()]+\)\."#
        if output.range(of: started, options: .regularExpression) != nil {
            return "requested"
        }
        let unit = kind == "music" ? "track" : kind
        let sentence = #"^Generated [1-9]\d* "# + unit + #"s? with [^/\n]+/[^\n]+\.(?:\r?\n|$)"#
        let generated = output.range(of: sentence, options: .regularExpression) != nil
        return receipt?["async"] as? Bool != true && generated ? "done" : "action"
    }

    private static func publicationQualifier(_ receipt: [String: Any]?) -> String? {
        switch receipt?["state"] as? String {
        case "published": return nil
        case "accepted": return "operationPendingPublication"
        case "conflict", "rejected": return "operationNotApplied"
        case nil where receipt?["state"] == nil:
            if let id = receipt?["id"] as? String, !id.isEmpty, id.count <= 96, !id.contains(where: \.isWhitespace),
               let revision = receipt?["revision"] as? Int, revision > 0,
               let hash = receipt?["hash"] as? String, hash.count == 64,
               hash.allSatisfy({ "0123456789abcdef".contains($0) })
            {
                return nil
            }
            return "operationUnknown"
        default: return "operationUnknown"
        }
    }

    // MARK: - Named rows (web resolveToolOperationLabel)

    private static func namedLabel(name: String, call: Call) -> String? {
        let args = call.args
        let outcome = call.outcome
        if name == "subagents" && args["action"] as? String == "cancel" ||
            name == "sessions" && args["action"] as? String == "stop" &&
            (args["sessionKey"] as? String)?.lowercased().contains(":subagent:") == true
        {
            var receipt = self.json(call.resultText) ?? [:]
            receipt.merge(call.details ?? [:]) { $1 }
            let aborted = self.string(receipt["abortedRunId"])
            let requested = self.string(args["runId"])
            let state = receipt["targetState"] as? [String: Any]
            let task = state?["task"] as? [String: Any]
            let stopped = name == "sessions"
                ? outcome != .failed && receipt["ok"] as? Bool == true && receipt["status"] as? String == "aborted"
                && aborted != nil && (requested == nil || requested == aborted)
                : receipt["found"] as? Bool == true && receipt["killed"] as? Bool == true && task?[
                    "status",
                ] as? String ==
                "cancelled"
            return self
                .toolCards(outcome == .running ? "stoppingSubagent" : stopped ? "stoppedSubagent" : "stopSubagent")
                .map { [$0, call.addressedName].compactMap(\.self).joined(separator: " ") }
        }
        switch name {
        case "get_goal":
            return self.toolCards(self.pick(outcome, "checkingGoal", "checkedGoal", "checkGoal"))
        case "sessions_send":
            return self.sessionSend(call)
        case _ where self.patchTools.contains(name):
            return self.toolCards(self.pick(outcome, "changingFiles", "changedFiles", "fileChanges"))
        case "view_image":
            return self.toolCards(self.pick(outcome, "viewingImage", "viewedImage", "viewImage"))
        case "ask_user":
            let key = self.pick(outcome, "askingQuestion", "askedQuestion", "questionRequest")
            let many = (args["questions"] as? [Any])?.count ?? 0 > 1 && key != "questionRequest"
            return self.toolCards(key + (many ? "s" : ""))
        case "agents_wait":
            if outcome == .running { return self.toolCards("waitingForAgents") }
            let key = outcome == .succeeded ? "waitedFor" : "waitFor"
            let receipt = call.details ?? self.json(call.resultText)
            if let ids = args["ids"] as? [String], !ids.isEmpty,
               let completed = receipt?["completed"] as? [[String: Any]]
            {
                let names = ids
                    .compactMap { id in self.string(completed.first { $0["runId"] as? String == id }?["label"]) }
                if names.count == ids.count {
                    return self.toolCards(
                        key + "NamedAgents",
                        ["names": ListFormatter.localizedString(byJoining: names)])
                }
            }
            return self.toolCards(key + "Agents")
        case "skills_search", "skills_read":
            let key = name == "skills_search"
                ? self.pick(outcome, "searchingSkills", "searchedSkills", "skillSearch")
                : self.pick(outcome, "readingSkill", "readSkill", "readSkill")
            let target = self.string(name == "skills_search" ? args["query"] : args["name"])
            return self.toolCards(key).map { [$0, target].compactMap(\.self).joined(separator: " ") }
        case "subagents" where args["action"] as? String == "list":
            return self.toolCards(self.pick(outcome, "listingSubagents", "listedSubagents", "listSubagents"))
        case "sessions_history", "sessions_search":
            let key = name == "sessions_history"
                ? self.pick(outcome, "readingChat", "readChat", "chatRead")
                : self.pick(outcome, "searchingChats", "searchedChats", "chatSearch")
            return self.toolCards(key).map { [$0, call.addressedName].compactMap(\.self).joined(separator: " ") }
        default:
            return nil
        }
    }

    /// A message to another chat names the chat and what its receipt proves (web :146-174).
    static func sessionSend(_ call: Call, showsReceipt: Bool = true) -> String? {
        var result = call.details ?? [:]
        result.merge(self.json(self.unwrappedText(call.resultText)) ?? [:]) { $1 }
        let status = result["status"] as? String
        var action = call.outcome == .running ? "sending" : "send"
        if call.outcome == .failed || call.outcome == .succeeded, result["sentBeforeError"] as? Bool == true,
           status == "timeout" || status == "error"
        {
            action = status == "timeout" ? "replyTimedOut" : "unconfirmed"
        } else if call.outcome == .succeeded {
            action = switch status {
            case "ok", "no_reply", "accepted": "sent"
            case "queued": "queued"
            case "started" where (result["retained"] as? [String: Any])?["acceptance"] as? String == "not_accepted":
                "deferred"
            default: "unconfirmed"
            }
        }
        // The transcript names the action; the sheet keeps the precise receipt. An explicitly
        // deferred or unconfirmed send is not described as having reached the other session.
        if !showsReceipt {
            switch action {
            case "queued", "replyTimedOut": action = "sent"
            case "deferred", "unconfirmed": action = "send"
            default: break
            }
        }
        let target = call.addressedName ?? self.string(call.args["label"])
        // Catalog keys, not copy: "sendNamed" is the named form of "send".
        var key = "sessionSend.\(action)"
        if target != nil { key += "Named" }
        return self.toolCards(key, ["name": target ?? ""])
    }
}

extension String {
    fileprivate var nilIfEmpty: String? {
        self.isEmpty ? nil : self
    }
}
