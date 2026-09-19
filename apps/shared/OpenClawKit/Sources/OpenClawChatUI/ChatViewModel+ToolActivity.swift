import Foundation
import OpenClawKit

public typealias OpenClawChatToolActivityHandler = @MainActor @Sendable (
    _ id: String,
    _ name: String,
    _ isActive: Bool,
    _ sessionKey: String) -> Void

extension OpenClawChatViewModel {
    public var pendingToolCalls: [OpenClawChatPendingToolCall] {
        self.toolActivities.filter { !$0.isComplete }
    }

    public func endPendingToolActivities() {
        self.turnToolCallsById = [:]
    }

    func handleAgentActivityItem(_ evt: OpenClawAgentEventPayload) {
        guard evt.data["kind"]?.value as? String != "preamble",
              let activity = try? ChatPayloadDecoding.decode(
                  AnyCodable(evt.data), as: OpenClawAgentActivityItem.self),
              activity.suppressChannelProgress != true
        else { return }
        let toolCallId = activity.toolCallId ?? activity.itemId
        var pending = self.turnToolCallsById[toolCallId] ?? OpenClawChatPendingToolCall(
            toolCallId: toolCallId,
            name: activity.name ?? activity.title,
            args: nil,
            startedAt: evt.ts.map(Double.init),
            isError: nil,
            diffStat: nil)
        pending.activity = activity
        pending.isComplete = activity.phase == "end"
        self.turnToolCallsById[toolCallId] = pending
    }

    func prepareToolActivities(
        from previous: [String: OpenClawChatPendingToolCall]) -> [OpenClawChatPendingToolCall]
    {
        let priorActive = previous.filter { !$0.value.isComplete && $0.value.activity?.isVisible != false }
        let currentActive = self.turnToolCallsById.filter {
            !$0.value.isComplete && $0.value.activity?.isVisible != false
        }
        for (id, call) in priorActive where currentActive[id] == nil {
            self.onToolActivity?(id, call.name, false, self.sessionKey)
        }
        for (id, call) in currentActive where priorActive[id] == nil {
            self.onToolActivity?(id, call.name, true, self.sessionKey)
        }
        return self.turnToolCallsById.values.sorted {
            if $0.isComplete != $1.isComplete { return !$0.isComplete }
            return ($0.startedAt ?? 0) < ($1.startedAt ?? 0)
        }
    }
}
