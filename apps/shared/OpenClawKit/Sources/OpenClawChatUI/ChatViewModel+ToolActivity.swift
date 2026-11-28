import Foundation
import OpenClawKit

public typealias OpenClawChatToolActivityHandler = @MainActor @Sendable (
    _ id: String,
    _ name: String,
    _ isActive: Bool,
    _ sessionKey: String) -> Void

extension OpenClawChatViewModel {
    func clearStreamingActivity() {
        self.cliAssistantStream = nil
        self.runStartup = nil
        self.turnToolCallsById = [:]
        self.updateStreamingAssistantText(nil)
    }

    public var pendingToolCalls: [OpenClawChatPendingToolCall] {
        self.toolActivities.filter { !$0.isComplete }
    }

    public func endPendingToolActivities() {
        self.turnToolCallsById = [:]
    }

    static func applyActivityItem(
        _ evt: OpenClawAgentEventPayload,
        to calls: inout [String: OpenClawChatPendingToolCall])
    {
        guard evt.data["kind"]?.value as? String != "preamble",
              let activity = try? GatewayPayloadDecoding.decode(
                  AnyCodable(evt.data), as: OpenClawAgentActivityItem.self),
              activity.kind != "answer_candidate",
              activity.suppressChannelProgress != true
        else { return }
        let toolCallId = activity.toolCallId ?? activity.itemId
        var pending = calls[toolCallId] ?? OpenClawChatPendingToolCall(
            toolCallId: toolCallId,
            name: activity.name ?? activity.title,
            args: nil,
            startedAt: evt.ts.map(Double.init),
            isError: nil,
            diffStat: nil)
        pending.runID = evt.runId
        pending.activity = activity
        pending.isComplete = activity.phase == "end"
        calls[toolCallId] = pending
    }

    func applyToolEvent(_ evt: OpenClawAgentEventPayload, to calls: inout [String: OpenClawChatPendingToolCall]) {
        guard let phase = evt.data["phase"]?.value as? String else { return }
        guard let name = evt.data["name"]?.value as? String else { return }
        guard let toolCallId = evt.data["toolCallId"]?.value as? String else { return }
        if phase == "start" {
            self.updateActiveSessionRunWithoutChatSnapshot(false)
            let args = evt.data["args"]
            calls[toolCallId] = OpenClawChatPendingToolCall(
                toolCallId: toolCallId,
                name: name,
                args: args,
                startedAt: evt.ts.map(Double.init) ?? Date().timeIntervalSince1970 * 1000,
                isError: nil,
                diffStat: nil,
                activity: calls[toolCallId]?.activity,
                runID: evt.runId)
        } else if phase == "input_delta",
                  var pending = calls[toolCallId],
                  let diff = evt.data["diff"]?.dictionaryValue,
                  let added = diff["added"]?.intValue,
                  let removed = diff["removed"]?.intValue,
                  added >= 0,
                  removed >= 0
        {
            pending.diffStat = ChatToolDiffStat(added: added, removed: removed)
            calls[toolCallId] = pending
        } else if phase == "result" {
            guard var pending = calls[toolCallId] else { return }
            #if !os(iOS)
            if pending.activity == nil {
                calls[toolCallId] = nil
                return
            }
            #endif
            // On iPhone the open timeline keeps completed steps until history supplies their receipts.
            pending.isComplete = true
            pending.result = evt.data["result"]
            pending.isError = evt.data["isError"]?.boolValue ?? pending.result?.dictionaryValue?["isError"]?
                .boolValue ?? pending
                .isError
            calls[toolCallId] = pending
        }
    }

    #if os(iOS)
    func restoreToolActivities(from events: [OpenClawAgentEventPayload]) {
        // Apply the final snapshot state once: completed historical calls must not restart Live Activities.
        var calls = self.turnToolCallsById
        for event in events
            where event.stream == "tool" || event.data["kind"]?.stringValue == "tool" && event.stream == "item"
        {
            guard let id = event.data["toolCallId"]?.stringValue ?? event.data["itemId"]?.stringValue else { continue }
            if let known = self.turnToolCallsById[id] {
                // A warm refresh can settle a live call, but cannot replay its start or discard richer live data.
                let phase = event.data["phase"]?.stringValue
                guard known.runID == event.runId,
                      (event.stream == "tool" && phase == "result" && !known.isComplete) ||
                      (event.stream == "item" && phase == "end" && known.activity?.phase != "end") else { continue }
            }
            if event.stream == "tool" {
                self.applyToolEvent(event, to: &calls)
            } else {
                Self.applyActivityItem(event, to: &calls)
            }
        }
        self.turnToolCallsById = calls
    }
    #endif

    func prepareToolActivities(
        from previous: [String: OpenClawChatPendingToolCall]) -> [OpenClawChatPendingToolCall]
    {
        let priorActive = previous.filter { !$0.value.isComplete && $0.value.activity?.isVisible != false }
        let currentActive = self.turnToolCallsById.filter {
            !$0.value.isComplete && $0.value.activity?.isVisible != false
        }
        for (id, call) in priorActive where currentActive[id] == nil {
            let name = ToolDisplayRegistry.displayCall(name: call.name, args: call.args).name ?? call.name
            self.onToolActivity?(id, name, false, self.sessionKey)
        }
        for (id, call) in currentActive where priorActive[id] == nil {
            if !self.isApplyingRunSnapshot { self.sealCLIAssistantText(before: call) }
            let name = ToolDisplayRegistry.displayCall(name: call.name, args: call.args).name ?? call.name
            self.onToolActivity?(id, name, true, self.sessionKey)
        }
        return self.turnToolCallsById.values.sorted {
            if $0.isComplete != $1.isComplete { return !$0.isComplete }
            return ($0.startedAt ?? 0) < ($1.startedAt ?? 0)
        }
    }
}
