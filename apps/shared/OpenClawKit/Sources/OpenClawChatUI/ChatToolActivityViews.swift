import Foundation
import OpenClawKit
import SwiftUI

struct ChatToolActivityItem: Identifiable, Equatable {
    enum State: Equatable {
        case running
        case finished
        case failed
        case blocked
        case skipped
        case unavailable

        var title: LocalizedStringResource {
            switch self {
            case .running: "Working"
            case .finished: "Finished"
            case .failed: "Failed"
            case .blocked: "Blocked"
            case .skipped: "Skipped"
            case .unavailable: "No result"
            }
        }
    }

    let id: String
    let name: String?
    let arguments: AnyCodable?
    let details: AnyCodable?
    let resultText: String?
    let state: State
    let liveDiffStat: ChatToolDiffStat?
    var activity: OpenClawAgentActivityItem?
    var activityPrepared = false
    var recordedExitCode: Int?
    /// The call's recorded result when it sits in another part of a split envelope. Receipts
    /// (launch, yield, exit status) read it; the row shows only its own part's result.
    var outcomeDetails: AnyCodable?
    var outcomeText: String?
    /// Live progress without a recorded result yet.
    var isLive = false
    /// A result shown at its own position in a split envelope, apart from its call's row.
    var isResultFragment = false

    var isVisible: Bool {
        self.activity?.isVisible ?? !self.activityPrepared
    }

    var displayState: State {
        guard let activity = self.activity else { return self.state }
        switch activity.status {
        case "running": return .running
        case "completed": return .finished
        case "failed": return .failed
        case "blocked": return .blocked
        case "skipped": return .skipped
        default: return .unavailable
        }
    }

    var statusTitle: LocalizedStringResource {
        // A failed command names its exit status (web chat-tool-outcome-summary.solid.tsx:19-25).
        if self.displayState == .failed, let code = self.exitCode, code != 0 {
            return "Exit code \(code)"
        }
        // Missing execution status is not missing output. Keep unknown outcomes
        // neutral while allowing the recorded result to be opened.
        if self.displayState == .unavailable,
           self.resultText?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        {
            return "Outcome unknown"
        }
        return self.displayState.title
    }

    var isError: Bool {
        self.displayState == .failed
    }

    var isPending: Bool {
        self.displayState == .running
    }
}

extension ChatToolActivityItem {
    init(live call: OpenClawChatPendingToolCall) {
        let result = call.result?.dictionaryValue
        let output = result?["text"]?.stringValue ?? call.result?.stringValue ?? result?["content"]?.arrayValue?
            .compactMap { block in
                let entry = block.dictionaryValue
                return entry?["type"]?.stringValue == "text" ? entry?["text"]?.stringValue : nil
            }.joined(separator: "\n")
        self.init(
            id: call.id,
            name: call.name,
            arguments: call.args,
            details: nil,
            resultText: nil,
            state: call.activity == nil && call.isComplete ?
                (ChatToolActivity.resultIsError(call.isError, text: output) ? .failed : .finished) :
                call.activity == nil || call.activity?.status == "running" ? .running :
                call.activity?.status == "completed" ? .finished :
                call.activity?.status == "failed" || call.activity?.status == "blocked" ? .failed : .unavailable,
            liveDiffStat: call.diffStat,
            activity: call.activity,
            recordedExitCode: result?["exitCode"]?.intValue,
            outcomeDetails: result?["details"],
            outcomeText: output,
            isLive: true)
    }
}

/// Opens a session through the transcript owner's navigation. Equal per owner so environment
/// readers do not re-render on every body pass.
struct ChatOpenSessionAction: Equatable {
    let owner: ObjectIdentifier
    let open: @MainActor (String) -> Void

    static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.owner == rhs.owner
    }
}

extension EnvironmentValues {
    @Entry var openClawOpenChatSession: ChatOpenSessionAction?
}

/// What one `sessions_spawn` call started (web chat-spawned-subagent.ts:78-139).
struct ChatSessionLaunch: Equatable {
    enum Kind: Equatable {
        case subagent
        case chat
    }

    enum Phase: Equatable {
        case running
        case succeeded
        case failed
        case interrupted
        case unknown
    }

    static let linkScheme = "openclaw-launch"

    let kind: Kind
    let phase: Phase
    let label: String?
    let childKey: String?

    /// web i18n/locales/en-chat-tool-labels.ts:24-38
    var verb: String {
        switch (self.kind, self.phase) {
        case (.subagent, .running): String(localized: "Launching")
        case (.subagent, .succeeded): String(localized: "Launched")
        case (.subagent, .failed): String(localized: "Couldn’t launch subagent")
        case (.subagent, .interrupted): String(localized: "Subagent launch interrupted")
        case (.subagent, .unknown): String(localized: "Subagent launch outcome unknown")
        case (.chat, .running): String(localized: "Opening child chat")
        case (.chat, .succeeded): String(localized: "Opened child chat")
        case (.chat, .failed): String(localized: "Couldn’t open child chat")
        case (.chat, .interrupted): String(localized: "Child chat creation interrupted")
        case (.chat, .unknown): String(localized: "Child chat creation outcome unknown")
        }
    }

    /// One line for adjacent launches: "Launched A and B", or "Launched N agents" when any is
    /// unnamed (web chat-message-activity-operation.tsx:112-215). A named child with a session
    /// links to `openclaw-launch:<index>` when `linksChildren` is set.
    static func title(_ launches: [Self], linksChildren: Bool) -> AttributedString {
        let first = launches[0]
        let running = launches.contains { $0.phase == .running }
        let names = launches.compactMap(\.label)
        guard names.count == launches.count else {
            // Agent counts describe subagents; a child chat names its own operation
            // (web chat-tool-row-presentation.ts:71-79).
            guard first.kind == .subagent else { return AttributedString(first.verb) }
            let count = launches.count
            if running {
                return AttributedString(count == 1 ? String(localized: "Launching an agent") :
                    String(format: String(localized: "Launching %lld agents"), count))
            }
            if first.phase == .succeeded {
                return AttributedString(count == 1 ? String(localized: "Launched an agent") :
                    String(format: String(localized: "Launched %lld agents"), count))
            }
            return AttributedString(first.verb)
        }
        let verb = running ? Self(kind: first.kind, phase: .running, label: nil, childKey: nil).verb : first.verb
        var listed = Array(names.prefix(2))
        if launches.count > 2 {
            listed.append(String(format: String(localized: "%lld more"), launches.count - 2))
        }
        var title = AttributedString(verb + " " + ListFormatter.localizedString(byJoining: listed))
        guard linksChildren else { return title }
        var cursor = title.characters.index(title.startIndex, offsetBy: verb.count + 1)
        for (index, launch) in launches.prefix(2).enumerated() {
            guard let label = launch.label, let range = title[cursor...].range(of: label) else { continue }
            if launch.childKey != nil {
                title[range].link = URL(string: "\(Self.linkScheme):\(index)")
            }
            cursor = range.upperBound
        }
        return title
    }
}

extension ChatToolActivityItem {
    /// web lib/chat/tool-call-input.ts COMMAND_TOOL_NAMES
    static let commandToolNames: Set<String> = ["bash", "exec", "shell", "run_command", "run_terminal_cmd"]
    /// Tools whose accepted receipt hands the turn off (web chat-sessions-yield.ts:51-79).
    static let handoffToolNames: Set<String> = [
        "sessions_yield", "github_publish", "image_generate", "video_generate", "music_generate",
    ]

    private var call: (name: String, args: [String: AnyCodable]?) {
        let call = ToolDisplayRegistry.operationCall(name: self.name, args: self.arguments)
        return (
            call.name?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "",
            call.args?.dictionaryValue)
    }

    private var receiptDetails: AnyCodable? {
        self.details ?? self.outcomeDetails
    }

    private var receiptText: String? {
        self.resultText ?? self.outcomeText
    }

    /// web lib/chat/tool-cards.ts:132-141: the result block, its details, then the recorded JSON result.
    var exitCode: Int? {
        self.recordedExitCode ?? OpenClawChatMessageContent.exitCode(in: self.receiptDetails) ??
            OpenClawChatMessageContent
            .exitCode(in: ChatToolActivity.jsonObject(self.receiptText).map { AnyCodable($0) })
    }

    /// The row's trailing outcome. A failed launch's verb already says it failed, so a single one shows
    /// none; repeats keep their count, which is new information (web chat-message-activity-operation.tsx:290-298).
    func trailingStatus(attempts: Int) -> String? {
        if attempts > 1 { return String(format: String(localized: "%lld failed"), Int64(attempts)) }
        #if os(iOS)
        if self.sessionLaunch?.phase == .failed || self
            .namesChatInTitle && (self.displayState == .finished || self.isPending)
        {
            return nil
        }
        #endif
        return String(localized: self.statusTitle)
    }

    /// The collapsed row's title (web chat-tool-row-presentation.ts:65-99).
    var rowTitle: String {
        self.rowTitle(chatName: nil)
    }

    /// The collapsed row's title, naming the chat a call addresses when the session list has it. On
    /// iPhone every call reads in the Control UI's words (`ChatToolOperationCopy`); a message to another
    /// chat names that chat, never its key.
    func rowTitle(chatName: String?) -> String {
        if self.commandPreview != nil { return self.commandLabel(includesObject: false) }
        if Self.commandToolNames.contains(self.call.name), self.arguments == nil {
            return self.commandLabel(includesObject: true)
        }
        #if os(iOS)
        if self.namesChatInTitle,
           let title = ChatToolOperationCopy.sessionSend(
               self.operationCall(addressedName: chatName),
               showsReceipt: false)
        { return title }
        return self.stepTitle(chatName: chatName)
        #else
        if let launch = self.sessionLaunch {
            return String(ChatSessionLaunch.title([launch], linksChildren: false).characters)
        }
        if Self.commandToolNames.contains(self.call.name) {
            return self.commandPurpose ?? self.commandLabel(includesObject: true)
        }
        let call = ToolDisplayRegistry.displayCall(name: self.name, args: self.arguments)
        return self.activity?.preparedTitle ?? ToolDisplayRegistry.resolve(name: call.name, args: call.args).title
        #endif
    }

    /// One title for the active group headline, timeline step and step detail. Shell previews remain
    /// separate from the raw command and its purpose in inspection, just as on the web.
    func stepTitle(chatName: String? = nil) -> String {
        let call = self.operationCall(addressedName: chatName)
        if let launch = self.sessionLaunch, let label = ChatToolOperationCopy.launchLabel(launch, call: call) {
            return label
        }
        if let label = ChatToolOperationCopy.label(call) { return label }
        let display = ToolDisplayRegistry.operationSummary(name: self.name, args: self.arguments)
        let identity = display.label == display.name ? display.title : display.label
        return [identity, chatName ?? display.detail].compactMap(\.self).joined(separator: " ")
    }

    private func operationCall(addressedName: String?) -> ChatToolOperationCopy.Call {
        func plain(_ value: AnyCodable?) -> Any? {
            guard let value, let data = try? JSONEncoder().encode(value) else { return nil }
            return try? JSONSerialization.jsonObject(with: data, options: .fragmentsAllowed)
        }
        let call = ToolDisplayRegistry.operationCall(name: self.name, args: self.arguments)
        let outcome: ChatToolOperationCopy.Outcome = switch self.displayState {
        case .running: .running
        case .finished: .succeeded
        case .failed: .failed
        default: .other
        }
        return .init(
            name: call.name ?? "",
            args: plain(call.args) as? [String: Any] ?? [:],
            outcome: outcome,
            details: plain(self.receiptDetails) as? [String: Any],
            resultText: self.receiptText,
            addressedName: addressedName,
            exitCode: self.exitCode)
    }

    /// A message to another chat carries that chat in its title, so its row has no detail line.
    var namesChatInTitle: Bool {
        self.call.name == "sessions_send"
    }

    /// The chat a call addresses by key (web readAddressedSessionKey, chat-spawned-subagent.ts:190-210).
    var addressedSessionKey: String? {
        let call = self.call
        let key: String? = switch call.name {
        case "sessions_send", "sessions_history": call.args?["sessionKey"]?.stringValue
        case "subagents" where ["steer", "kill"].contains(call.args?["action"]?.stringValue ?? ""):
            call.args?["target"]?.stringValue.flatMap { $0.contains(":") ? $0 : nil }
        default: nil
        }
        return ChatPayloadDecoding.trimmedNonEmptyString(key)
    }

    /// The name the agent gave the call's target, used when the session list has none.
    var callLabel: String? {
        ChatPayloadDecoding.trimmedNonEmptyString(self.call.args?["label"]?.stringValue)
    }

    /// Why a failed call failed, as recorded: the receipt's `error` text, else the result itself.
    var failureReason: String? {
        guard self.isError else { return nil }
        let receipt = ChatToolActivity.jsonObject(self.receiptText)
        return ChatPayloadDecoding.trimmedNonEmptyString(receipt?["error"]?.stringValue) ??
            ChatPayloadDecoding.trimmedNonEmptyString(self.receiptDetails?.dictionaryValue?["error"]?.stringValue) ??
            ChatPayloadDecoding.trimmedNonEmptyString(self.receiptText)
    }

    /// The shell command, whitespace collapsed and capped at 200 UTF-16 units
    /// (web chat-tool-row-presentation.ts:61-63).
    var commandPreview: String? {
        let call = self.call
        guard Self.commandToolNames.contains(call.name),
              let command = call.args?["command"]?.stringValue else { return nil }
        return ChatToolOperationCopy.shellPreview(command)
    }

    /// The agent's stated purpose for a command; inspection shows it, the row shows what ran
    /// (web lib/chat/tool-call-view.ts:364, chat-tool-purpose.test.ts:32-63).
    var commandPurpose: String? {
        let call = self.call
        guard Self.commandToolNames.contains(call.name) else { return nil }
        return ChatPayloadDecoding.trimmedNonEmptyString(call.args?["title"]?.stringValue)
    }

    /// "Ran" also for a failure with an exit status: the command did run (web chat-tool-card-row.solid.tsx:128-139).
    func commandLabel(includesObject: Bool) -> String {
        if self
            .isPending { return includesObject ? String(localized: "Running command") : String(localized: "Running") }
        if self.displayState == .finished || (self.isError && self.exitCode != nil) {
            return includesObject ? String(localized: "Ran command") : String(localized: "Ran")
        }
        return includesObject ? String(localized: "Run command") : String(localized: "Run")
    }

    var sessionLaunch: ChatSessionLaunch? {
        let call = self.call
        guard call.name == "sessions_spawn", !self.isResultFragment else { return nil }
        // Collector details carry routing only; the complete receipt stays in the text.
        let receipt = (ChatToolActivity.jsonObject(self.receiptText) ?? [:])
            .merging(self.receiptDetails?.dictionaryValue ?? [:]) { _, detail in detail }
        let childKey = ChatPayloadDecoding.trimmedNonEmptyString(receipt["childSessionKey"]?.stringValue)
        let isChat = childKey.map(Self.isDashboardSessionKey) ?? (call.args?["visible"]?.boolValue == true)
        let status = receipt["status"]?.stringValue ?? ""
        // Live progress ends before its receipt is recorded; until then the launch is still pending.
        let awaitingReceipt = self.isLive && self.receiptText == nil && self.receiptDetails == nil
        let phase: ChatSessionLaunch.Phase = if self.displayState == .running ||
            (awaitingReceipt && self.displayState == .finished)
        {
            .running
        } else if self.displayState == .skipped || ["skipped", "cancelled", "interrupted"].contains(status) {
            .interrupted
        } else if self.displayState == .failed || ["error", "failed"].contains(status) {
            .failed
        } else if self.displayState == .finished, childKey != nil, ["accepted", "created"].contains(status) {
            .succeeded
        } else {
            .unknown
        }
        return ChatSessionLaunch(
            kind: isChat ? .chat : .subagent,
            phase: phase,
            label: ChatPayloadDecoding.trimmedNonEmptyString(call.args?["label"]?.stringValue) ??
                ChatPayloadDecoding.trimmedNonEmptyString(receipt["label"]?.stringValue),
            childKey: childKey)
    }

    /// A paired, accepted receipt proves the turn intentionally handed off (web chat-sessions-yield.ts:29-79).
    var isConfirmedHandoff: Bool {
        let name = self.call.name
        guard Self.handoffToolNames.contains(name), self.arguments != nil, self.displayState == .finished,
              let receipt = ChatToolActivity.handoffReceipt(details: self.receiptDetails, text: self.receiptText)
        else { return false }
        if name == "sessions_yield" { return receipt["status"]?.stringValue == "yielded" }
        guard receipt["status"]?.stringValue == "started", receipt["async"]?.boolValue == true else { return false }
        return name == "github_publish" ? receipt["yielded"]?.boolValue == true :
            receipt["taskId"]?.stringValue?.isEmpty == false
    }

    /// Yield context is never a tool detail: a running or result-less call and a confirmed receipt
    /// hide; any other yield result stays visible (web chat-sessions-yield.ts:276-300).
    var isYieldContext: Bool {
        guard self.call.name == "sessions_yield" else { return false }
        if self.isPending || self.isConfirmedHandoff {
            return true
        }
        guard !self.isError else { return false }
        if self.isResultFragment, self.displayState == .finished,
           ChatToolActivity.handoffReceipt(details: self.receiptDetails, text: self.receiptText)?["status"]?
               .stringValue ==
               "yielded"
        {
            return true
        }
        return self.receiptText == nil && self.receiptDetails == nil
    }

    private static func isDashboardSessionKey(_ key: String) -> Bool {
        let parts = key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
            .split(separator: ":", omittingEmptySubsequences: false)
        return parts.count == 4 && parts[0] == "agent" && !parts[1].isEmpty && parts[2] == "dashboard" &&
            !parts[3].isEmpty
    }
}

extension OpenClawChatMessage {
    var hasConfirmedHandoff: Bool {
        // Only a handoff tool's receipt can confirm one; skip building items for every other row.
        guard self.recordedToolNames.contains(where: ChatToolActivityItem.handoffToolNames.contains) else {
            return false
        }
        return ChatToolActivity.recordedItems(message: self).contains(where: \.isConfirmedHandoff)
    }

    /// Whether this row has a tool row to show: hidden yield context alone leaves nothing.
    var hasDisplayableToolActivity: Bool {
        let names = self.recordedToolNames
        guard !names.isEmpty else { return false }
        // Only yield context can hide, so any other tool keeps the row without building items.
        guard names.allSatisfy({ $0 == "sessions_yield" }) else { return true }
        return !ChatToolActivity.items(message: self).isEmpty
    }

    /// A subagent or child-chat launch stands on its own: it never collapses into an activity log
    /// or completed work (web isStandaloneActivity, chat-activity-operations.ts:23-33). A wrapper
    /// whose prepared activity hides it leaves the launch to its recorded child row.
    var recordsSessionLaunch: Bool {
        self.recordedToolNames.contains("sessions_spawn") &&
            ChatToolActivity.items(message: self).contains { $0.isVisible && $0.sessionLaunch != nil }
    }

    /// One lowercased display name per tool block, or the result row's tool. A result
    /// named only by its call's ID takes that call's name.
    private var recordedToolNames: [String] {
        func displayName(_ name: String?, _ args: AnyCodable?) -> String {
            ToolDisplayRegistry.displayCall(name: name, args: args).name?
                .trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
        }
        if self.isToolResult { return [displayName(self.toolName, nil)] }
        return self.content.compactMap { block -> String? in
            if block.isToolCall { return displayName(block.name, block.arguments) }
            guard block.isToolResult else { return nil }
            if let name = block.name { return displayName(name, nil) }
            let call = self.content.first { $0.isToolCall && $0.id != nil && $0.id == block.id }
            return call.map { displayName($0.name, $0.arguments) } ?? ""
        }
    }
}

enum ChatToolActivity {
    /// Tool search dispatchers carry another tool's call; they are never the work itself
    /// (src/agents/tool-display-call.ts isToolCallDispatcherName).
    static func isDispatcher(_ name: String?) -> Bool {
        let key = ToolDisplayRegistry.operationCall(name: name, args: nil).name?
            .trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return key == "dispatch_action" || key == "tool_call"
    }

    static func items(
        message: OpenClawChatMessage,
        liveTools: [OpenClawChatPendingToolCall] = []) -> [ChatToolActivityItem]
    {
        self.recordedItems(message: message, liveTools: liveTools).filter { !$0.isYieldContext }
    }

    /// A yield receipt's details when they carry its status, else the leading JSON object of its
    /// text: plugin result hooks can append text after the receipt (web chat-sessions-yield.ts:29-39).
    static func handoffReceipt(details: AnyCodable?, text: String?) -> [String: AnyCodable]? {
        if let details = details?.dictionaryValue, details["status"] != nil { return details }
        guard let text = text?.drop(while: \.isWhitespace), text.first == "{" else { return nil }
        var depth = 0
        var inString = false
        var escaped = false
        for index in text.indices {
            let character = text[index]
            if inString {
                if escaped {
                    escaped = false
                } else if character == "\\" {
                    escaped = true
                } else if character == "\"" {
                    inString = false
                }
                continue
            }
            switch character {
            case "\"": inString = true
            case "{": depth += 1
            case "}":
                depth -= 1
                if depth == 0 { return self.jsonObject(String(text[...index])) }
            default: break
            }
        }
        return nil
    }

    static func jsonObject(_ text: String?) -> [String: AnyCodable]? {
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines), text.hasPrefix("{"),
              let data = text.data(using: .utf8) else { return nil }
        return (try? JSONDecoder().decode(AnyCodable.self, from: data))?.dictionaryValue
    }

    static func recordedItems(
        message: OpenClawChatMessage,
        liveTools: [OpenClawChatPendingToolCall] = []) -> [ChatToolActivityItem]
    {
        // Results normally merge into their calling assistant message. Keep
        // orphan results visible when the calling message is outside history.
        if message.isToolResult {
            let text = ChatMessageVisibleText.displayText(in: message, includeThinking: false)
            return [ChatToolActivityItem(
                id: message.toolCallId ?? message.content.first?.id ?? message.id.uuidString,
                name: message.toolName,
                arguments: nil,
                details: message.details,
                resultText: text,
                state: self.resultIsError(message.isError, text: text) ? .failed : .finished,
                liveDiffStat: nil,
                activity: message.activity?.first,
                activityPrepared: message.activity != nil,
                recordedExitCode: message.content.lazy.compactMap(\.exitCode).first)]
        }
        guard message.role.lowercased() == "assistant" || message.isNestedToolActivity else { return [] }
        return self.items(
            calls: message.content.filter(\.isToolCall),
            results: message.content.filter(\.isToolResult),
            recordedResults: message.presentationRecordedToolResults,
            activity: message.activity,
            liveTools: liveTools)
    }

    static func resultIsError(_ flag: Bool?, text: String?) -> Bool {
        if let flag { return flag }
        guard let text = text?.trimmingCharacters(in: .whitespacesAndNewlines) else { return false }
        if ["tool not found", "tool not found."].contains(text.lowercased()) { return true }
        guard text.utf16.count <= 20000, text.hasSuffix("}"), let result = self.jsonObject(text) else { return false }
        if let flag = result["isError"]?.boolValue ?? result["is_error"]?.boolValue { return flag }
        if let error = result["error"] {
            if let text = error.stringValue,
               !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return true }
            if error.boolValue == true || error.dictionaryValue != nil || error.arrayValue != nil { return true }
        }
        return ["error", "failed", "timeout"].contains(
            result["status"]?.stringValue?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? "")
    }

    static func items(
        calls: [OpenClawChatMessageContent],
        results: [OpenClawChatMessageContent],
        recordedResults: [OpenClawChatMessageContent] = [],
        activity: [OpenClawAgentActivityItem]? = nil,
        liveTools: [OpenClawChatPendingToolCall] = []) -> [ChatToolActivityItem]
    {
        var remainingResults = Array(results.enumerated())
        var items = calls.enumerated().map { index, call in
            let id = call.id ?? "call-\(index)"
            let resultIndex = call.id.flatMap { callID in
                remainingResults.firstIndex { _, result in result.id == callID }
            }
            let result = resultIndex.map { remainingResults.remove(at: $0).element }
            // Resolve status against the whole source envelope, but show a result's
            // details only at its own content position (possibly after narration).
            let outcome = result ?? recordedResults.first { $0.id != nil && $0.id == call.id }
            // History owns recorded inputs; live activity supplies status until
            // the result arrives, never replacing already-recorded arguments.
            let live = outcome == nil
                ? liveTools.first(where: { $0.id == call.id }).map(ChatToolActivityItem.init(live:)) : nil

            return ChatToolActivityItem(
                id: id,
                name: call.name ?? live?.name,
                arguments: call.arguments ?? live?.arguments,
                details: result?.details,
                resultText: result?.text,
                state: outcome
                    .map { Self.resultIsError($0.isError, text: $0.text) ? .failed : .finished } ??
                    live?.state ?? .unavailable,
                liveDiffStat: live?.liveDiffStat,
                activity: live?.activity ?? activity?.first { $0.toolCallId == id },
                activityPrepared: live == nil && activity != nil,
                recordedExitCode: outcome
                    .flatMap { $0.exitCode ?? OpenClawChatMessageContent.exitCode(in: $0.details) } ?? live?.exitCode,
                // Receipts whose result sits in another part of a split message.
                outcomeDetails: result == nil ? outcome?.details ?? live?.outcomeDetails : nil,
                outcomeText: result == nil ? outcome?.text ?? live?.outcomeText : nil,
                isLive: live != nil)
        }

        items.append(contentsOf: remainingResults.map { index, result in
            let id = result.id ?? "result-\(index)"
            return ChatToolActivityItem(
                id: id,
                name: result.name,
                arguments: nil,
                details: result.details,
                resultText: result.text,
                state: Self.resultIsError(result.isError, text: result.text) ? .failed : .finished,
                liveDiffStat: nil,
                activity: activity?.first { $0.toolCallId == id },
                activityPrepared: activity != nil,
                recordedExitCode: result.exitCode,
                // In a split envelope the call's own row reports this outcome.
                isResultFragment: !recordedResults.isEmpty)
        })
        return items
    }
}

struct ChatToolActivityRow: View, Equatable {
    let item: ChatToolActivityItem
    /// Every failure this row stands for, itself first, when it carries repeats (`ChatToolRepeats`).
    var attempts: [ChatToolActivityItem] = []

    var body: some View {
        // Compare the item before constructing the content: its initializer prepares
        // the diff, which unchanged siblings must not repeat on every tool update.
        ChatToolActivityRowContent(item: self.item, attempts: self.attempts)
    }
}

struct ChatToolActivityRowContent: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.openClawOpenChatSession) private var openChatSession
    @Environment(\.openClawToolRowContext) private var toolContext
    let item: ChatToolActivityItem
    let attempts: [ChatToolActivityItem]
    #if os(iOS)
    @Environment(\.openClawOpenToolSheet) private var openToolSheet
    #endif
    private let displayCall: (name: String?, args: AnyCodable?)
    private let resolvedDiff: (lines: [ChatToolDiffLine], stat: ChatToolDiffStat?)?
    @State private var expanded = false
    @State private var showsFullResult = false

    private static let disclosureWidth: CGFloat = 12
    private static let expandedLineLimit = 40

    private var display: ToolDisplaySummary {
        ToolDisplayRegistry.resolve(name: self.displayCall.name, args: self.displayCall.args)
    }

    /// A command's stated purpose belongs to inspection; the row shows what ran.
    private var inspectedPurpose: String? {
        self.item.commandPreview == nil ? nil : self.item.commandPurpose
    }

    private var isRepeated: Bool {
        self.attempts.count > 1
    }

    private var chatName: String? {
        #if os(iOS)
        self.item.addressedSessionKey.flatMap(self.toolContext.names.name(for:))
        #else
        nil
        #endif
    }

    private var title: String {
        self.item.rowTitle(chatName: self.chatName)
    }

    /// A failure is information inside a turn that went on, not an alarm: on iPhone it keeps the
    /// row's neutral ink and says how it ended in secondary text, like the web's muted outcome
    /// (ui/src/styles/chat/tool-cards.css:239-242).
    private var failureTint: Color {
        #if os(iOS)
        .secondary
        #else
        OpenClawChatTheme.danger
        #endif
    }

    private var failureTitleTint: Color {
        #if os(iOS)
        self.textColor
        #else
        OpenClawChatTheme.danger
        #endif
    }

    private var statusText: String? {
        self.item.trailingStatus(attempts: self.isRepeated ? self.attempts.count : 1)
    }

    private var detailLine: String? {
        if let command = self.item.commandPreview { return command }
        #if os(iOS)
        return nil // The complete operation, including its safe target, is already in the title.
        #else
        if self.item.sessionLaunch != nil { return nil }
        guard let detail = self.display.detailLine, !detail.isEmpty else { return nil }
        return detail
        #endif
    }

    /// A launched child opens through the shared session navigation instead of expanding its receipt.
    private var openableChildKey: String? {
        guard self.openChatSession != nil, !self.isRepeated else { return nil }
        #if os(iOS)
        // A launch that failed never started its chat; the row opens its reason instead.
        if self.item.sessionLaunch?.phase == .failed { return nil }
        #endif
        return self.item.sessionLaunch?.childKey
    }

    private var formattedResult: String {
        guard let resultText = self.item.resultText else { return "" }
        return ToolResultTextFormatter.format(text: resultText, toolName: self.displayCall.name)
    }

    private var expandable: Bool {
        self.isRepeated || self.openableChildKey == nil &&
            (self.resolvedDiff != nil || !self.formattedResult.isEmpty || self.inspectedPurpose != nil)
    }

    /// A failure opens to its reason in the receipt's own words, not the receipt's JSON.
    private var openedResult: String {
        #if os(iOS)
        if self.resolvedDiff == nil, let reason = self.item.failureReason { return reason }
        #endif
        return self.formattedResult
    }

    private var accessibilityValue: String {
        [self.statusText, self.detailLine].compactMap(\.self).joined(separator: ", ")
    }

    private var expandedLineCount: Int {
        self.resolvedDiff?.lines.count ?? self.openedResult.components(separatedBy: .newlines).count
    }

    private var isResultTruncated: Bool {
        self.expandedLineCount > Self.expandedLineLimit
    }

    private var expandedResult: String {
        guard self.isResultTruncated, !self.showsFullResult else { return self.openedResult }
        let lines = self.openedResult.components(separatedBy: .newlines)
        return lines.prefix(Self.expandedLineLimit - 1).joined(separator: "\n") + "\n…"
    }

    private var expandedDiffLines: [ChatToolDiffLine] {
        guard let lines = self.resolvedDiff?.lines else { return [] }
        guard self.isResultTruncated, !self.showsFullResult else { return lines }
        return Array(lines.prefix(Self.expandedLineLimit - 1)) + [
            ChatToolDiffLine(kind: .skip, text: ""),
        ]
    }

    private var displayedDiffStat: ChatToolDiffStat? {
        self.item.isPending ? self.item.liveDiffStat ?? self.resolvedDiff?.stat : self.resolvedDiff?.stat
    }

    init(item: ChatToolActivityItem, attempts: [ChatToolActivityItem]) {
        self.item = item
        self.attempts = attempts
        let displayCall = ToolDisplayRegistry.displayCall(name: item.name, args: item.arguments)
        self.displayCall = displayCall
        self.resolvedDiff = ChatToolDiff.resolveDiff(
            name: displayCall.name,
            arguments: displayCall.args,
            details: item.details,
            isError: item.isError)
    }

    var body: some View {
        #if os(iOS)
        Button {
            self.openToolSheet?(self.isRepeated ? self.attempts : [self.item])
        } label: {
            self.collapsedRow.frame(maxWidth: .infinity, minHeight: 44, alignment: .leading).contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .ignore)
        .accessibilityAddTraits(.isButton)
        .accessibilityLabel(self.title)
        .accessibilityValue(self.accessibilityValue)
        .accessibilityIdentifier("chat-tool-activity-\(self.item.id)")
        #else
        VStack(alignment: .leading, spacing: 4) {
            if let childKey = self.openableChildKey {
                Button {
                    self.openChatSession?.open(childKey)
                } label: {
                    self.collapsedRow
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(self.title)
                .accessibilityValue(self.accessibilityValue)
                .accessibilityHint("Opens the subagent’s chat")
                .accessibilityIdentifier("chat-tool-activity-\(self.item.id)")
            } else if self.expandable {
                Button {
                    withAnimation(self.reduceMotion ? .easeInOut(duration: 0.2) : .snappy(duration: 0.25)) {
                        self.expanded.toggle()
                    }
                } label: {
                    self.collapsedRow
                        .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityElement(children: .ignore)
                .accessibilityAddTraits(.isButton)
                .accessibilityLabel(self.title)
                .accessibilityValue(self.accessibilityValue)
                .accessibilityHint(self.isRepeated
                    ? (self.expanded ? "Hides each attempt" : "Shows each attempt")
                    : (self.expanded ? "Collapse tool result" : "Expand tool result"))
                .accessibilityIdentifier("chat-tool-activity-\(self.item.id)")
            } else {
                self.collapsedRow
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(self.title)
                    .accessibilityValue(self.accessibilityValue)
            }

            if self.expanded, self.expandable {
                VStack(alignment: .leading, spacing: 6) {
                    if self.isRepeated {
                        self.attemptRows
                    } else {
                        self.openedDetail
                    }
                }
                .padding(10)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background {
                    if !self.isDesktopLayout {
                        RoundedRectangle(cornerRadius: 10, style: .continuous)
                            .fill(OpenClawChatTheme.subtleCard)
                    }
                }
                .padding(.leading, self.isDesktopLayout ? 0 : 19)
                // Fade only: the panel sits under its own header row, which must not be overlapped.
                .transition(.opacity)
            }
        }
        .modifier(ChatWorkCardStyle())
        #endif
    }

    /// Each failure the row stands for, in order, with its own reason.
    private var attemptRows: some View {
        ForEach(Array(self.attempts.enumerated()), id: \.element.id) { index, attempt in
            HStack(alignment: .firstTextBaseline, spacing: 6) {
                self.failureMark
                Text(attempt.failureReason ?? String(localized: attempt.statusTitle))
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .lineLimit(4)
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("chat-tool-attempt-\(index)")
        }
    }

    /// The key a chat could not be named by, kept for inspection only.
    @ViewBuilder
    private var unnamedChatKey: some View {
        #if os(iOS)
        if let key = self.item.addressedSessionKey, self.chatName == nil {
            Text(verbatim: key)
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }
        #endif
    }

    private var failureMark: some View {
        Image(systemName: "exclamationmark.circle")
            .font(OpenClawChatTypography.caption)
            .imageScale(.small)
            .foregroundStyle(self.failureTint)
            .accessibilityHidden(true)
    }

    @ViewBuilder
    private var openedDetail: some View {
        if let purpose = self.inspectedPurpose {
            Text(purpose)
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
        }
        if self.resolvedDiff != nil {
            self.diffRows
            // The result text carries the outcome (success summary or the
            // error diagnostic); hiding it would misrepresent failed edits
            // as applied changes. Bounded so foreign harness output cannot
            // dwarf the diff.
            if !self.formattedResult.isEmpty {
                Text(self.formattedResult)
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
                    .lineLimit(Self.expandedLineLimit)
            }
        } else if !self.openedResult.isEmpty {
            Text(self.expandedResult)
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary)
                .textSelection(.enabled)
        }

        self.unnamedChatKey

        Text(self.item.statusTitle)
            .font(OpenClawChatTypography.caption)
            .foregroundStyle(self.item.isError ? self.failureTint : .secondary)

        if self.isResultTruncated {
            Button {
                self.showsFullResult.toggle()
            } label: {
                Text(
                    self.showsFullResult
                        ? String(localized: "Show less")
                        : String(
                            format: String(localized: "Show all %lld lines"),
                            Int64(self.expandedLineCount)))
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
            }
            .buttonStyle(.plain)
        }
    }

    private var collapsedRow: some View {
        HStack(alignment: self.collapsedAlignment, spacing: 7) {
            #if os(iOS)
            ChatToolRowLabel(asset: ChatToolIcon.asset(
                for: self.display.name, icon: self.display.icon, args: self.displayCall.args))
            {
                Text(verbatim: self.title)
                    .lineLimit(self.item.namesChatInTitle ? 1 : nil)
                    .truncationMode(.tail)
            }
            self.toolDetail
            #else
            Group {
                if self.item.isPending {
                    ProgressView()
                        .controlSize(.mini)
                } else if self.expandable {
                    Image(systemName: "chevron.right")
                        .font(.system(size: 9, weight: .semibold))
                        .foregroundStyle(.secondary)
                        .opacity(0.7)
                        .rotationEffect(.degrees(self.expanded ? 90 : 0))
                } else {
                    Color.clear
                }
            }
            .frame(width: Self.disclosureWidth, height: 12)

            ChatToolIcon.glyph(for: self.display.name, icon: self.display.icon, args: self.displayCall.args)
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(self.item.isError ? self.failureTint : Color.secondary)

            if self.isDesktopLayout {
                VStack(alignment: .leading, spacing: 3) {
                    self.toolTitle
                    self.toolDetail
                }
            } else {
                self.toolTitle
                self.toolDetail
            }
            #endif

            if let stat = self.displayedDiffStat {
                ChatDiffStatChips(stat: stat)
            }

            Spacer(minLength: 0)

            // Preserve the native collapsed cues when a local title replaces the Gateway warning;
            // a failure always says how it ended (web chat-tool-outcome-summary.solid.tsx:19-25).
            if self.isDesktopLayout || self.item.displayState == .unavailable || self.item.isError,
               let statusText = self.statusText
            {
                HStack(alignment: .firstTextBaseline, spacing: 3) {
                    #if os(iOS)
                    if self.item.isError { self.failureMark }
                    #endif
                    Text(verbatim: statusText)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(self.item.isError ? self.failureTint : .secondary)
                }
                .fixedSize()
            }
        }
        .padding(.vertical, 3)
    }

    private var collapsedAlignment: VerticalAlignment {
        #if os(iOS)
        .firstTextBaseline
        #else
        self.isDesktopLayout ? .firstTextBaseline : .center
        #endif
    }

    /// A single launch row's own button opens the child, so its title carries no link.
    private var toolTitle: some View {
        Text(self.title)
            .font(OpenClawChatTypography.footnoteSemiBold)
            .foregroundStyle(self.item.isError ? self.failureTitleTint : self.textColor)
            // At accessibility sizes the name wraps instead of losing its end beside the status.
            .lineLimit(self.dynamicTypeSize.isAccessibilitySize ? 3 : 1)
    }

    @ViewBuilder
    private var toolDetail: some View {
        if let detailLine = self.detailLine {
            Text(detailLine)
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .truncationMode(.middle)
        }
    }

    private var textColor: Color {
        self.isDesktopLayout
            ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
            : OpenClawChatTheme.assistantText
    }

    private var diffRows: some View {
        // The orthogonal nested scroll keeps long diff lines reachable without
        // competing with the transcript's vertical gesture.
        ScrollView(.horizontal, showsIndicators: false) {
            VStack(alignment: .leading, spacing: 0) {
                ForEach(self.expandedDiffLines.indices, id: \.self) { index in
                    self.diffRow(self.expandedDiffLines[index])
                }
            }
            .textSelection(.enabled)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private func diffRow(_ line: ChatToolDiffLine) -> some View {
        if line.kind == .file {
            Text(verbatim: String(line.text.unicodeScalars.prefix(2000)))
                .font(OpenClawChatTypography.mono(size: 11, relativeTo: .caption))
                .fontWeight(.semibold)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: true, vertical: false)
                .padding(.top, 6)
        } else if line.kind == .skip {
            Text("⋯")
                .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                .foregroundStyle(.secondary.opacity(0.6))
                .frame(maxWidth: .infinity, alignment: .center)
                .padding(.vertical, 2)
                // Reuses the existing localized "Collapsed" key so omitted
                // preview rows stay announced to assistive tech.
                .accessibilityLabel(Text("Collapsed"))
        } else {
            HStack(spacing: 6) {
                if let lineNo = line.lineNo {
                    Text(verbatim: "\(lineNo)")
                        .font(OpenClawChatTypography.mono(size: 10, relativeTo: .caption2))
                        .foregroundStyle(.secondary.opacity(0.6))
                        .frame(minWidth: 34, alignment: .trailing)
                }
                // Bound per-line render work; generated/minified payloads can put
                // megabytes on a single line.
                Text(verbatim: String(line.text.unicodeScalars.prefix(2000)))
                    .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
                    .foregroundStyle(self.diffTextColor(line.kind))
                    .fixedSize(horizontal: true, vertical: false)
            }
            .background(self.diffBackground(line.kind))
            // Color alone must not carry add/del semantics for assistive tech.
            .accessibilityElement(children: .ignore)
            .accessibilityLabel(Text(verbatim: Self.accessibilityText(for: line)))
        }
    }

    private static func accessibilityText(for line: ChatToolDiffLine) -> String {
        let lineNo = line.lineNo.map { "\($0) " } ?? ""
        return lineNo + self.accessibilityMarker(line.kind) + String(line.text.unicodeScalars.prefix(2000))
    }

    private static func accessibilityMarker(_ kind: ChatToolDiffLineKind) -> String {
        switch kind {
        case .add:
            "+ "
        case .del:
            "\u{2212} "
        case .ctx, .file, .skip:
            ""
        }
    }

    private func diffTextColor(_ kind: ChatToolDiffLineKind) -> Color {
        switch kind {
        case .add:
            OpenClawChatTheme.assistantText
        case .del, .ctx, .file, .skip:
            .secondary
        }
    }

    private func diffBackground(_ kind: ChatToolDiffLineKind) -> Color {
        switch kind {
        case .add:
            OpenClawChatTheme.success.opacity(0.14)
        case .del:
            OpenClawChatTheme.danger.opacity(0.12)
        case .ctx, .file, .skip:
            .clear
        }
    }
}

struct ChatWorkCardStyle: ViewModifier {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme

    func body(content: Content) -> some View {
        content
            .padding(self.isDesktopLayout ? 10 : 0)
            .background {
                if self.isDesktopLayout {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(.primary.opacity(self.colorScheme == .dark ? 0.035 : 0.025))
                }
            }
            .overlay {
                if self.isDesktopLayout {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(.primary.opacity(0.07), lineWidth: 1)
                }
            }
    }
}

struct ChatDiffStatChips: View {
    let stat: ChatToolDiffStat

    var body: some View {
        Group {
            Text(verbatim: "+\(self.stat.added)")
                .foregroundStyle(OpenClawChatTheme.success.opacity(0.9))
            Text(verbatim: "−\(self.stat.removed)")
                .foregroundStyle(OpenClawChatTheme.danger.opacity(0.9))
        }
        .font(OpenClawChatTypography.mono(size: 12, relativeTo: .footnote))
        .lineLimit(1)
    }
}

struct ChatToolActivityList: View {
    #if os(iOS)
    @Environment(\.openClawOpenToolSheet) private var openToolSheet
    #endif
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.openClawToolRowContext) private var toolContext
    let items: [ChatToolActivityItem]

    var body: some View {
        VStack(alignment: .leading, spacing: self.isDesktopLayout ? 6 : 2) {
            // A repeated failure is drawn in its first attempt's row.
            let shown = self.items.filter { !self.toolContext.repeats.absorbed.contains($0.id) }
            ForEach(Self.visibleRuns(shown), id: \.first) { run in
                if run.count > 1 {
                    #if os(iOS)
                    let items = run.map { shown[$0] }
                    self.groupButton(items, asset: "bot", title: String(ChatSessionLaunch.title(
                        items.compactMap(\.sessionLaunch), linksChildren: false).characters))
                    #else
                    ChatSessionLaunchGroupRow(launches: run.compactMap { shown[$0].sessionLaunch })
                    #endif
                } else {
                    ChatToolActivityRow(
                        item: shown[run[0]],
                        attempts: self.toolContext.repeats.attempts[shown[run[0]].id] ?? [])
                        .equatable()
                }
            }
            #if os(iOS)
            let quiet = shown.filter { !$0.isVisible }
            if quiet.count == 1, let item = quiet.first {
                ChatToolActivityRow(item: item).equatable()
            } else if !quiet.isEmpty {
                self.groupButton(quiet, asset: "wrench", title: ChatCompletedWorkSummary.headline(quiet))
            }
            #else
            let quiet = self.items.indices.filter { !self.items[$0].isVisible }
            if !quiet.isEmpty {
                DisclosureGroup {
                    ForEach(quiet, id: \.self) { index in
                        ChatToolActivityRow(item: self.items[index]).equatable()
                    }
                } label: {
                    Text("Tool details")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                }
                .tint(.secondary)
            }
            #endif
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    #if os(iOS)
    private func groupButton(_ items: [ChatToolActivityItem], asset: String, title: String) -> some View {
        Button { self.openToolSheet?(items) } label: {
            ChatToolRowLabel(asset: asset, disclosure: .zero) { Text(verbatim: title) }
                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityIdentifier("chat-tool-group")
    }
    #endif
}

extension ChatToolActivityList {
    /// Visible rows in order. Adjacent subagent launches that are running or succeeded share one
    /// line; a failed or interrupted launch keeps its own row and outcome
    /// (web chat-activity-projection.ts:265-296).
    static func visibleRuns(_ items: [ChatToolActivityItem]) -> [[Int]] {
        var runs: [[Int]] = []
        var previousCoalesces = false
        for index in items.indices where items[index].isVisible {
            let coalesces = items[index].sessionLaunch.map {
                $0.kind == .subagent && ($0.phase == .running || $0.phase == .succeeded)
            } ?? false
            if coalesces, previousCoalesces, let last = runs.indices.last {
                runs[last].append(index)
            } else {
                runs.append([index])
            }
            previousCoalesces = coalesces
        }
        return runs
    }
}

/// A compact summary with an action for each child that can be opened.
private struct ChatSessionLaunchGroupRow: View {
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.colorSchemeContrast) private var colorSchemeContrast
    @Environment(\.openClawOpenChatSession) private var openChatSession
    let launches: [ChatSessionLaunch]

    var body: some View {
        if let openChatSession, launches.contains(where: { $0.childKey != nil }),
           launches.contains(where: { $0.label == nil }) || self.launches.dropFirst(2).contains(where: {
               $0.childKey != nil
           })
        {
            DisclosureGroup {
                VStack(alignment: .leading, spacing: 6) {
                    ForEach(self.launches.indices, id: \.self) { index in
                        let launch = self.launches[index]
                        if let key = launch.childKey {
                            Button {
                                openChatSession.open(key)
                            } label: {
                                Text(launch.label ?? String(format: String(localized: "Agent %@"), String(index + 1)))
                            }
                            .buttonStyle(.plain)
                            .accessibilityHint("Opens the subagent’s chat")
                        }
                    }
                }
            } label: {
                #if os(iOS)
                self.title(linksChildren: false)
                #else
                self.summary(linksChildren: false)
                #endif
            }
            #if os(iOS)
            .disclosureGroupStyle(ChatInlineDisclosureStyle(header: .toolGroup))
            #endif
        } else {
            self.summary(linksChildren: openChatSession != nil)
        }
    }

    private func title(linksChildren: Bool) -> some View {
        Text(ChatSessionLaunch.title(self.launches, linksChildren: linksChildren))
            .environment(\.openURL, OpenURLAction { url in
                guard url.scheme == ChatSessionLaunch.linkScheme,
                      let index = Int(url.absoluteString.dropFirst(ChatSessionLaunch.linkScheme.count + 1)),
                      self.launches.indices.contains(index),
                      let key = self.launches[index].childKey,
                      let action = self.openChatSession
                else { return .systemAction }
                MainActor.assumeIsolated { action.open(key) }
                return .handled
            })
    }

    private func summary(linksChildren: Bool) -> some View {
        #if os(iOS)
        ChatToolRowLabel(asset: "bot") { self.title(linksChildren: linksChildren) }
            .padding(.vertical, 3)
        #else
        HStack(alignment: .firstTextBaseline, spacing: 7) {
            Color.clear
                .frame(width: 12, height: 12)
            ChatToolIcon.glyph(for: "sessions_spawn", icon: "bot")
                .font(.system(size: 12, weight: .medium))
                .foregroundStyle(Color.secondary)
            self.title(linksChildren: linksChildren)
                .font(OpenClawChatTypography.footnoteSemiBold)
                .foregroundStyle(self.isDesktopLayout
                    ? OpenClawChatTheme.desktopText(in: self.colorScheme, contrast: self.colorSchemeContrast)
                    : OpenClawChatTheme.assistantText)
            Spacer(minLength: 0)
        }
        .padding(.vertical, 3)
        .modifier(ChatWorkCardStyle())
        #endif
    }
}
