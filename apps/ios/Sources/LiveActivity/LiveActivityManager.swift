import ActivityKit
import Foundation
import OpenClawKit
import OpenClawProtocol
import os

/// Manages the lifecycle of the OpenClaw Live Activity (Dynamic Island + Lock Screen).
///
/// The activity is **persistent**: it starts when the gateway connects and only ends
/// when the gateway disconnects. Between agent runs, the activity shows an idle
/// "Connected" state. After a run completes, it briefly shows "Done" then transitions
/// back to idle.
///
/// All public API is MainActor-isolated; the debounce timer fires on the main run loop.
@MainActor
final class LiveActivityManager {
    static let shared = LiveActivityManager()

    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "LiveActivity")

    private var currentActivity: Activity<OpenClawActivityAttributes>?
    private var activityStartDate: Date = .now

    // Debounce: buffer rapid updates and flush at most once per second.
    private var pendingContent: ActivityContent<OpenClawActivityAttributes.ContentState>?
    private var debounceTimer: Timer?
    private let debounceInterval: TimeInterval = 1.0

    // Timer that transitions from "Done"/"Error" back to idle after a delay.
    private var idleTransitionTimer: Timer?
    private let idleTransitionDelay: TimeInterval = 5.0

    // Running state for step tracking.
    private var stepCount: Int = 0
    private var currentToolLabel: String?
    private var currentToolIcon: String?
    private var previousToolLabel: String?
    private var latestStreamingText: String?
    /// Latched subject — set by on-device AI or first streaming text.
    private var subject: String?
    private var summaryTask: Task<Void, Never>?

    /// Whether an agent run is currently in progress.
    private var isRunning: Bool = false

    private init() {
        // End any stale activities from previous app launches.
        Task { @MainActor in
            self.endStaleActivities()
        }
    }

    // MARK: - Public API

    /// End all existing Live Activities except the one we're currently tracking.
    /// Prevents duplicate Dynamic Islands after app relaunches.
    private func endStaleActivities() {
        let stale = Activity<OpenClawActivityAttributes>.activities.filter { $0.id != currentActivity?.id }
        if !stale.isEmpty {
            logger.info("[LA] ending \(stale.count) stale activities")
        }
        for activity in stale {
            let finalState = OpenClawActivityAttributes.ContentState(
                subject: nil, statusText: "Ended",
                currentToolLabel: nil, currentToolIcon: nil, previousToolLabel: nil,
                toolStepCount: 0, streamingText: nil,
                isFinished: false, isError: false, isIdle: false, isDisconnected: false, isConnecting: false,
                startedAt: .now, endedAt: .now)
            Task { await activity.end(ActivityContent(state: finalState, staleDate: nil), dismissalPolicy: .immediate) }
        }
    }

    /// Start a persistent Live Activity in "Connecting" state.
    /// Called when the gateway begins connecting, before `onConnected` fires.
    func startActivity(agentName: String, sessionKey: String) {
        // End any stale activities before starting a new one.
        endStaleActivities()

        if currentActivity != nil {
            logger.info("[LA] activity already running, skipping start")
            return
        }

        let authInfo = ActivityAuthorizationInfo()
        logger.info("[LA] areActivitiesEnabled=\(authInfo.areActivitiesEnabled)")
        guard authInfo.areActivitiesEnabled else {
            logger.info("[LA] Live Activities not enabled — skipping")
            return
        }

        activityStartDate = .now
        resetRunState()

        let attributes = OpenClawActivityAttributes(
            agentName: agentName,
            sessionKey: sessionKey)
        let initialState = OpenClawActivityAttributes.ContentState(
            subject: nil,
            statusText: "Connecting...",
            currentToolLabel: nil,
            currentToolIcon: nil,
            previousToolLabel: nil,
            toolStepCount: 0,
            streamingText: nil,
            isFinished: false,
            isError: false,
            isIdle: false,
            isDisconnected: false,
            isConnecting: true,
            startedAt: activityStartDate)
        let content = ActivityContent(state: initialState, staleDate: nil)

        do {
            currentActivity = try Activity.request(
                attributes: attributes,
                content: content,
                pushType: nil)
            logger.info("Live Activity started (connecting) id=\(self.currentActivity?.id ?? "?")")
        } catch {
            logger.error("Failed to start Live Activity: \(error.localizedDescription, privacy: .public)")
        }
    }

    /// Gateway is attempting to connect — show "Connecting..." state.
    func handleConnecting() {
        guard let activity = currentActivity else { return }
        logger.info("[LA] handleConnecting — showing Connecting...")
        isRunning = false
        debounceTimer?.invalidate()
        debounceTimer = nil
        idleTransitionTimer?.invalidate()
        idleTransitionTimer = nil
        pendingContent = nil

        let connectingState = OpenClawActivityAttributes.ContentState(
            subject: nil,
            statusText: "Connecting...",
            currentToolLabel: nil,
            currentToolIcon: nil,
            previousToolLabel: nil,
            toolStepCount: 0,
            streamingText: nil,
            isFinished: false,
            isError: false,
            isIdle: false,
            isDisconnected: false,
            isConnecting: true,
            startedAt: activityStartDate)
        Task { await activity.update(ActivityContent(state: connectingState, staleDate: nil)) }
    }

    /// Begin a new agent run. Transitions from idle → active.
    /// - Parameter userMessage: The user's message (used for on-device AI title generation).
    func beginRun(userMessage: String? = nil) {
        guard currentActivity != nil else { return }
        idleTransitionTimer?.invalidate()
        idleTransitionTimer = nil
        isRunning = true
        resetRunState()

        // Fire off on-device AI title generation (iOS 26+).
        if let msg = userMessage, !msg.isEmpty {
            summaryTask = Task {
                let title = await Self.generateAITitle(for: [msg])
                guard !Task.isCancelled, self.currentActivity != nil else { return }
                if let title {
                    self.subject = title
                    self.flushImmediately(
                        statusText: self.currentToolLabel ?? "Thinking...")
                }
            }
        }

        flushImmediately(statusText: "Thinking...")
    }

    /// A tool started executing.
    func handleToolStart(name: String, args: [String: Any]?) {
        guard currentActivity != nil else { return }
        if !isRunning { beginRun() }
        previousToolLabel = currentToolLabel
        let classified = Self.classifyTool(name: name, args: args)
        currentToolLabel = classified.label
        currentToolIcon = classified.icon
        stepCount += 1
        logger.info("[LA] handleToolStart step=\(self.stepCount) label=\(classified.label, privacy: .public) icon=\(classified.icon, privacy: .public)")
        flushImmediately(statusText: classified.label)
    }

    /// A tool finished executing.
    func handleToolResult() {
        guard currentActivity != nil else { return }
        logger.info("[LA] handleToolResult prev=\(self.currentToolLabel ?? "nil", privacy: .public)")
        previousToolLabel = currentToolLabel
        currentToolLabel = nil
        currentToolIcon = nil
        flushImmediately(statusText: "Thinking...")
    }

    /// Streaming assistant text arrived.
    func handleStreamingText(_ text: String) {
        guard currentActivity != nil else { return }
        let truncated = text.count > 80 ? String(text.prefix(80)) + "..." : text
        latestStreamingText = truncated
        currentToolLabel = nil
        currentToolIcon = nil
        // Latch subject from streaming text only when long enough (≥10 chars).
        // Foundation Models title generation takes priority and overwrites this.
        if subject == nil, text.count >= 10 {
            let firstLine = Self.extractFirstSentence(from: text)
            if firstLine.count >= 4 {
                subject = firstLine
            }
        }
        scheduleUpdate(statusText: "Responding...")
    }

    /// Extract the first sentence or meaningful fragment (up to ~60 chars).
    private static func extractFirstSentence(from text: String) -> String {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "" }
        let separators = CharacterSet(charactersIn: ".!?\n")
        let parts = trimmed.components(separatedBy: separators)
        let first = (parts.first ?? trimmed).trimmingCharacters(in: .whitespacesAndNewlines)
        if first.count > 60 {
            return String(first.prefix(57)) + "..."
        }
        return first
    }

    /// The run completed successfully. Shows "Done" then transitions to idle.
    func handleRunFinished() {
        guard currentActivity != nil else { return }
        logger.info("[LA] handleRunFinished steps=\(self.stepCount) subject=\(self.subject ?? "nil", privacy: .public)")
        isRunning = false
        debounceTimer?.invalidate()
        debounceTimer = nil
        pendingContent = nil
        summaryTask?.cancel()
        summaryTask = nil

        let capturedActivity = currentActivity
        let capturedSubject = subject
        let capturedPrevTool = previousToolLabel
        let capturedSteps = stepCount
        let capturedStart = activityStartDate

        // Show "Done" immediately, then try Foundation Models for a nicer message.
        let doneState = OpenClawActivityAttributes.ContentState(
            subject: capturedSubject,
            statusText: "Done",
            currentToolLabel: nil,
            currentToolIcon: nil,
            previousToolLabel: capturedPrevTool,
            toolStepCount: capturedSteps,
            streamingText: nil,
            isFinished: true,
            isError: false,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            startedAt: capturedStart,
            endedAt: .now)
        Task { await capturedActivity?.update(ActivityContent(state: doneState, staleDate: nil)) }

        // Schedule transition back to idle immediately — don't wait for Foundation Models.
        scheduleIdleTransition()

        // Try to generate a nicer completion message in the background.
        if let title = capturedSubject {
            Task {
                if let completion = await Self.generateCompletionMessage(for: title) {
                    logger.info("[LA] completion message: \(completion, privacy: .public)")
                    var updated = doneState
                    updated.subject = completion
                    await capturedActivity?.update(ActivityContent(state: updated, staleDate: nil))
                }
            }
        }
    }

    /// The run was aborted or errored. Shows "Error" then transitions to idle.
    func handleRunError() {
        guard currentActivity != nil else { return }
        isRunning = false
        debounceTimer?.invalidate()
        debounceTimer = nil
        pendingContent = nil
        summaryTask?.cancel()
        summaryTask = nil

        let errorState = OpenClawActivityAttributes.ContentState(
            subject: subject,
            statusText: "Error",
            currentToolLabel: nil,
            currentToolIcon: nil,
            previousToolLabel: previousToolLabel,
            toolStepCount: stepCount,
            streamingText: nil,
            isFinished: false,
            isError: true,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            startedAt: activityStartDate,
            endedAt: .now)
        guard let activity = currentActivity else { return }
        Task { await activity.update(ActivityContent(state: errorState, staleDate: nil)) }

        // Schedule transition back to idle after a delay.
        scheduleIdleTransition()
    }

    /// Gateway disconnected — show red "Disconnected" but keep the activity alive.
    func handleDisconnect() {
        guard let activity = currentActivity else { return }
        logger.info("[LA] handleDisconnect — showing Disconnected")
        isRunning = false
        debounceTimer?.invalidate()
        debounceTimer = nil
        idleTransitionTimer?.invalidate()
        idleTransitionTimer = nil
        pendingContent = nil
        summaryTask?.cancel()
        summaryTask = nil
        resetRunState()

        let disconnectedState = OpenClawActivityAttributes.ContentState(
            subject: nil,
            statusText: "Disconnected",
            currentToolLabel: nil,
            currentToolIcon: nil,
            previousToolLabel: nil,
            toolStepCount: 0,
            streamingText: nil,
            isFinished: false,
            isError: false,
            isIdle: false,
            isDisconnected: true,
            isConnecting: false,
            startedAt: activityStartDate)
        Task { await activity.update(ActivityContent(state: disconnectedState, staleDate: nil)) }
    }

    /// Gateway reconnected — transition back to idle from disconnected.
    func handleReconnect() {
        guard currentActivity != nil else { return }
        logger.info("[LA] handleReconnect — transitioning to idle")
        transitionToIdle()
    }

    /// End the activity entirely (called only on explicit user action or app termination).
    func endActivity() {
        guard let activity = currentActivity else { return }
        logger.info("[LA] endActivity — removing Live Activity")
        debounceTimer?.invalidate()
        debounceTimer = nil
        idleTransitionTimer?.invalidate()
        idleTransitionTimer = nil
        pendingContent = nil
        currentActivity = nil
        summaryTask?.cancel()
        summaryTask = nil
        isRunning = false

        let capturedStart = activityStartDate

        Task {
            let finalState = OpenClawActivityAttributes.ContentState(
                subject: nil,
                statusText: "Disconnected",
                currentToolLabel: nil,
                currentToolIcon: nil,
                previousToolLabel: nil,
                toolStepCount: 0,
                streamingText: nil,
                isFinished: false,
                isError: false,
                isIdle: false,
                isDisconnected: true,
                isConnecting: false,
                startedAt: capturedStart,
                endedAt: .now)
            let content = ActivityContent(state: finalState, staleDate: nil)
            await activity.end(content, dismissalPolicy: .after(.now + 4))
        }
    }

    // MARK: - On-Device AI Helpers

    /// Generate a task title using on-device Foundation Models (iOS 26+).
    private static func generateAITitle(for messages: [String]) async -> String? {
        if #available(iOS 26.0, *) {
            return await TaskSummaryService.shared.generateTitle(for: messages)
        }
        return nil
    }

    /// Generate a completion message using on-device Foundation Models (iOS 26+).
    private static func generateCompletionMessage(for taskTitle: String) async -> String? {
        if #available(iOS 26.0, *) {
            return await TaskSummaryService.shared.generateCompletionMessage(for: taskTitle)
        }
        return nil
    }

    /// Whether a Live Activity is currently running.
    var isActive: Bool { currentActivity != nil }

    // MARK: - Gateway Event Dispatch

    /// Parse a gateway "agent" event payload and update the activity.
    /// If an activity is running but no run is in progress, auto-starts a run.
    func dispatchAgentEvent(_ payload: AnyCodable, agentName: String = "main", sessionKey: String = "main") {
        struct AgentEvt: Decodable {
            var stream: String
            var data: [String: AnyCodable]?
        }
        let decoded: AgentEvt
        do {
            decoded = try GatewayPayloadDecoding.decode(payload, as: AgentEvt.self)
        } catch {
            logger.error("[LA] DECODE FAIL agent: \(error.localizedDescription, privacy: .public)")
            return
        }

        logger.info("[LA] agent stream=\(decoded.stream, privacy: .public) isRunning=\(self.isRunning)")

        // If no activity is running at all, start the persistent activity.
        if currentActivity == nil {
            startActivity(agentName: agentName, sessionKey: sessionKey)
        }

        // If we're idle, begin a new run.
        if !isRunning {
            beginRun()
        }

        switch decoded.stream {
        case "tool":
            let phase = decoded.data?["phase"]?.value as? String
            let name = decoded.data?["name"]?.value as? String
            logger.info("[LA] tool phase=\(phase ?? "nil", privacy: .public) name=\(name ?? "nil", privacy: .public)")
            guard let phase else { return }
            if phase == "start" {
                let rawArgs = decoded.data?["args"]?.value as? [String: Any]
                logger.info("[LA] tool start name=\(name ?? "nil", privacy: .public) hasArgs=\(rawArgs != nil)")
                handleToolStart(name: name ?? "tool", args: rawArgs)
            } else if phase == "result" {
                handleToolResult()
            }
        case "assistant":
            if let text = decoded.data?["text"]?.value as? String {
                handleStreamingText(text)
            }
        default:
            break
        }
    }

    /// Parse a gateway "chat" event payload and update the activity.
    func dispatchChatEvent(_ payload: AnyCodable) {
        struct ChatEvt: Decodable {
            var state: String?
            var message: AnyCodable?
        }
        guard let decoded = try? GatewayPayloadDecoding.decode(payload, as: ChatEvt.self) else {
            logger.error("[LA] DECODE FAIL chat")
            return
        }
        logger.info("[LA] chat state=\(decoded.state ?? "nil", privacy: .public) hasMessage=\(decoded.message != nil)")

        // If the chat event includes the user's message, fire AI title generation.
        // message is OpenClawChatMessage shape: { role, content: [{type, text}] } or { role, content: "string" }
        let userText: String? = {
            guard let msgDict = decoded.message?.value as? [String: Any],
                  let role = msgDict["role"] as? String, role == "user" else { return nil }
            // content can be an array of {type, text, ...} or a plain string.
            if let contentArray = msgDict["content"] as? [[String: Any]] {
                return contentArray.first?["text"] as? String
            }
            return msgDict["content"] as? String
        }()
        logger.info("[LA] userText=\(userText ?? "nil", privacy: .public) subject=\(self.subject ?? "nil", privacy: .public)")
        if subject == nil, summaryTask == nil,
           let text = userText, !text.isEmpty
        {
            logger.info("[LA] firing AI title generation for: \(text.prefix(60), privacy: .public)")
            summaryTask = Task {
                let title = await Self.generateAITitle(for: [text])
                guard !Task.isCancelled, self.currentActivity != nil else { return }
                if let title {
                    self.subject = title
                    self.flushImmediately(
                        statusText: self.currentToolLabel ?? "Thinking...")
                }
            }
        }

        switch decoded.state {
        case "final":
            handleRunFinished()
        case "aborted", "error":
            handleRunError()
        default:
            break
        }
    }

    // MARK: - Tool Classification

    private struct ToolClassification {
        let label: String
        let icon: String
    }

    /// Classify a tool name + args into a friendly label and SF Symbol icon.
    private static func classifyTool(name: String, args: [String: Any]?) -> ToolClassification {
        let lowName = name.lowercased()

        // Bash / exec / shell commands — inspect the command string.
        if lowName == "bash" || lowName == "exec" || lowName.hasPrefix("shell") {
            guard let command = args?["command"] as? String else {
                return ToolClassification(label: "Running a command...", icon: "terminal")
            }
            if command.contains("curl") || command.contains("wget") || command.contains("http") {
                if let host = hostFromCommand(command) {
                    return ToolClassification(label: "Fetching \(host)...", icon: "arrow.down.circle")
                }
                return ToolClassification(label: "Fetching data...", icon: "arrow.down.circle")
            }
            if command.contains("git ") {
                return ToolClassification(label: "Running git...", icon: "terminal")
            }
            if command.hasPrefix("grep ") || command.hasPrefix("rg ") || command.hasPrefix("find ") {
                return ToolClassification(label: "Searching files...", icon: "magnifyingglass")
            }
            if command.hasPrefix("cat ") || command.hasPrefix("head ") || command.hasPrefix("tail ") {
                return ToolClassification(label: "Reading file...", icon: "doc")
            }
            if command.hasPrefix("ls") || command.hasPrefix("pwd") {
                return ToolClassification(label: "Checking files...", icon: "folder")
            }
            if command.hasPrefix("mkdir ") || command.hasPrefix("cp ") || command.hasPrefix("mv ") || command.hasPrefix("rm ") {
                return ToolClassification(label: "Managing files...", icon: "folder")
            }
            return ToolClassification(label: "Running a command...", icon: "terminal")
        }

        // Read / file read
        if lowName == "read" || lowName.hasPrefix("file_read") || lowName.hasPrefix("fs.read") {
            if let path = args?["file_path"] as? String ?? args?["path"] as? String {
                let filename = (path as NSString).lastPathComponent
                return ToolClassification(label: "Reading \(filename)...", icon: "doc")
            }
            return ToolClassification(label: "Reading file...", icon: "doc")
        }

        // Write / file write
        if lowName == "write" || lowName.hasPrefix("file_write") || lowName.hasPrefix("fs.write") {
            if let path = args?["file_path"] as? String ?? args?["path"] as? String {
                let filename = (path as NSString).lastPathComponent
                return ToolClassification(label: "Writing \(filename)...", icon: "doc.badge.plus")
            }
            return ToolClassification(label: "Writing file...", icon: "doc.badge.plus")
        }

        // Edit
        if lowName == "edit" {
            if let path = args?["file_path"] as? String ?? args?["path"] as? String {
                let filename = (path as NSString).lastPathComponent
                return ToolClassification(label: "Editing \(filename)...", icon: "pencil")
            }
            return ToolClassification(label: "Editing file...", icon: "pencil")
        }

        // Glob / file search
        if lowName == "glob" {
            if let pattern = args?["pattern"] as? String {
                return ToolClassification(label: "Finding \(pattern)...", icon: "magnifyingglass")
            }
            return ToolClassification(label: "Finding files...", icon: "magnifyingglass")
        }

        // Grep / content search
        if lowName == "grep" {
            if let pattern = args?["pattern"] as? String {
                let short = pattern.count > 20 ? String(pattern.prefix(17)) + "..." : pattern
                return ToolClassification(label: "Searching \"\(short)\"...", icon: "magnifyingglass")
            }
            return ToolClassification(label: "Searching code...", icon: "magnifyingglass")
        }

        // Web fetch
        if lowName == "webfetch" || lowName == "web_fetch" || lowName == "fetch" {
            if let url = args?["url"] as? String, let host = hostFromURL(url) {
                return ToolClassification(label: "Fetching \(host)...", icon: "globe")
            }
            return ToolClassification(label: "Fetching web page...", icon: "globe")
        }

        // Web search
        if lowName == "websearch" || lowName == "web_search" {
            if let query = args?["query"] as? String {
                let short = query.count > 25 ? String(query.prefix(22)) + "..." : query
                return ToolClassification(label: "Searching \"\(short)\"...", icon: "globe")
            }
            return ToolClassification(label: "Searching the web...", icon: "globe")
        }

        // Notebook edit
        if lowName == "notebookedit" || lowName == "notebook_edit" {
            return ToolClassification(label: "Editing notebook...", icon: "pencil")
        }

        // Task / agent
        if lowName == "task" {
            return ToolClassification(label: "Running sub-agent...", icon: "person.2")
        }

        // MCP tools (format: mcp__server__tool)
        if lowName.hasPrefix("mcp_") {
            let parts = name.split(separator: "_").filter { !$0.isEmpty }
            let toolPart = parts.count >= 3 ? String(parts.last!) : name
            return ToolClassification(label: "Using \(toolPart)...", icon: "puzzlepiece")
        }

        // Fallback
        return ToolClassification(label: "Using \(name)...", icon: "gearshape")
    }

    /// Extract hostname from a URL string.
    private static func hostFromURL(_ urlString: String) -> String? {
        guard let url = URL(string: urlString) else { return nil }
        return url.host
    }

    /// Extract hostname from a curl/wget command string.
    private static func hostFromCommand(_ command: String) -> String? {
        // Try to find a URL-like pattern in the command.
        let pattern = #"https?://([^/\s\"']+)"#
        guard let regex = try? NSRegularExpression(pattern: pattern),
              let match = regex.firstMatch(in: command, range: NSRange(command.startIndex..., in: command)),
              let range = Range(match.range(at: 1), in: command)
        else { return nil }
        return String(command[range])
    }

    // MARK: - Private

    /// Reset per-run state (tool tracking, streaming text, subject).
    private func resetRunState() {
        stepCount = 0
        currentToolLabel = nil
        currentToolIcon = nil
        previousToolLabel = nil
        latestStreamingText = nil
        subject = nil
        summaryTask?.cancel()
        summaryTask = nil
    }

    /// Schedule transition from Done/Error back to idle after a delay.
    private func scheduleIdleTransition() {
        idleTransitionTimer?.invalidate()
        logger.info("[LA] scheduling idle transition in \(self.idleTransitionDelay)s")
        idleTransitionTimer = Timer.scheduledTimer(
            withTimeInterval: idleTransitionDelay, repeats: false
        ) { [weak self] _ in
            Task { @MainActor in
                self?.transitionToIdle()
            }
        }
    }

    /// Transition the activity to idle/connected state.
    private func transitionToIdle() {
        logger.info("[LA] transitionToIdle")
        guard let activity = currentActivity else { return }
        idleTransitionTimer?.invalidate()
        idleTransitionTimer = nil
        resetRunState()

        let idleState = OpenClawActivityAttributes.ContentState(
            subject: nil,
            statusText: "Idle",
            currentToolLabel: nil,
            currentToolIcon: nil,
            previousToolLabel: nil,
            toolStepCount: 0,
            streamingText: nil,
            isFinished: false,
            isError: false,
            isIdle: true,
            isDisconnected: false,
            isConnecting: false,
            startedAt: activityStartDate)
        Task { await activity.update(ActivityContent(state: idleState, staleDate: nil)) }
    }

    /// Flush an update immediately — used for important state changes (tool start/result).
    private func flushImmediately(statusText: String) {
        debounceTimer?.invalidate()
        debounceTimer = nil
        pendingContent = nil
        let state = OpenClawActivityAttributes.ContentState(
            subject: subject,
            statusText: statusText,
            currentToolLabel: currentToolLabel,
            currentToolIcon: currentToolIcon,
            previousToolLabel: previousToolLabel,
            toolStepCount: stepCount,
            streamingText: latestStreamingText,
            isFinished: false,
            isError: false,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            startedAt: activityStartDate)
        guard let activity = currentActivity else { return }
        Task { await activity.update(ActivityContent(state: state, staleDate: nil)) }
    }

    /// Schedule a debounced update — used for rapid streaming text.
    private func scheduleUpdate(statusText: String) {
        let state = OpenClawActivityAttributes.ContentState(
            subject: subject,
            statusText: statusText,
            currentToolLabel: currentToolLabel,
            currentToolIcon: currentToolIcon,
            previousToolLabel: previousToolLabel,
            toolStepCount: stepCount,
            streamingText: latestStreamingText,
            isFinished: false,
            isError: false,
            isIdle: false,
            isDisconnected: false,
            isConnecting: false,
            startedAt: activityStartDate)
        pendingContent = ActivityContent(state: state, staleDate: nil)

        debounceTimer?.invalidate()
        debounceTimer = Timer.scheduledTimer(withTimeInterval: debounceInterval, repeats: false) { [weak self] _ in
            Task { @MainActor in
                self?.flushPendingUpdate()
            }
        }
    }

    private func flushPendingUpdate() {
        guard let activity = currentActivity, let content = pendingContent else { return }
        pendingContent = nil
        Task {
            await activity.update(content)
        }
    }
}
