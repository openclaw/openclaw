import Foundation
import OpenClawKit

/// Live plan-checklist state: full-snapshot semantics scoped to the owning run.
extension OpenClawChatViewModel {
    func applyPlanSnapshot(runId: String, data: [String: AnyCodable]) {
        let steps = OpenClawChatPlanStep.parseSteps(data["steps"])
        guard !steps.isEmpty else {
            self.clearPlan(for: runId)
            return
        }
        let explanation = (data["explanation"]?.value as? String)?
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let normalizedExplanation = explanation?.isEmpty == false ? explanation : nil
        guard planRunId != runId ||
            planSteps != steps ||
            planExplanation != normalizedExplanation
        else {
            return
        }
        planRunId = runId
        planSteps = steps
        planExplanation = normalizedExplanation
        markTimelineChanged()
    }

    func clearPlan(for runId: String? = nil) {
        if let runId, planRunId != runId {
            return
        }
        guard planRunId != nil || !planSteps.isEmpty || planExplanation != nil else { return }
        planRunId = nil
        planSteps = []
        planExplanation = nil
        markTimelineChanged()
    }
}

/// Session-run activity indicator: shares the run-progress surface with the
/// plan checklist (both gate on an active run without a chat snapshot).
extension OpenClawChatViewModel {
    func updateActiveSessionRunWithoutChatSnapshot(_ active: Bool) {
        guard self.hasActiveSessionRunWithoutChatSnapshot != active else { return }
        self.hasActiveSessionRunWithoutChatSnapshot = active
        if active {
            self.armActiveSessionRunIndicatorTimeout()
        } else {
            self.activeSessionRunIndicatorTimeoutTask?.cancel()
            self.activeSessionRunIndicatorTimeoutTask = nil
        }
        self.markTimelineChanged()
    }

    private func armActiveSessionRunIndicatorTimeout() {
        self.activeSessionRunIndicatorTimeoutTask?.cancel()
        let timeoutMs = self.pendingRunWaitTimeoutMs
        self.activeSessionRunIndicatorTimeoutTask = Task { [weak self] in
            do {
                try await Task.sleep(nanoseconds: timeoutMs * 1_000_000)
            } catch {
                return
            }
            await MainActor.run {
                self?.updateActiveSessionRunWithoutChatSnapshot(false)
            }
        }
    }

    func clearActiveSessionRunIndicatorIfLatestUserAnswered() {
        guard self.hasActiveSessionRunWithoutChatSnapshot,
              !Self.hasUnansweredLatestUser(in: self.messages)
        else { return }
        self.updateActiveSessionRunWithoutChatSnapshot(false)
    }
}
