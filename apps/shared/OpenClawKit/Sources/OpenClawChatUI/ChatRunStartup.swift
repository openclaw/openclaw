import Foundation

/// What a run is doing before its first output, and whether it has got past that.
/// Mirrors the Control UI's `reconcileChatRunStartup` so both clients show the same line.
struct ChatRunStartup: Equatable {
    enum State: Equatable {
        case status(String, retrying: Bool)
        case activity
    }

    let runID: String
    var state: State
    /// The agent event sequence. Live status and replayed history share it; chat deltas do not carry it.
    var seq: Int?

    var status: String? {
        if case let .status(text, _) = self.state { return text }
        return nil
    }

    var isRetrying: Bool {
        if case .status(_, retrying: true) = self.state { return true }
        return false
    }

    /// Applies `next` unless it is older than what is already known. A reconnect replays earlier events,
    /// and without this an old phase would come back after the run had moved on.
    static func reconciled(current: ChatRunStartup?, next: ChatRunStartup) -> ChatRunStartup {
        guard let current, current.runID == next.runID else { return next }
        // Once the run has produced something, only a retry can put a status back.
        if case let .status(_, retrying) = next.state, !retrying, current.state == .activity { return current }
        if let known = current.seq {
            if let seq = next.seq {
                if seq <= known { return current }
            } else if next.status != nil {
                return current
            }
        }
        // Chat deltas use a different counter; keep the agent sequence so an older replayed status
        // cannot return after this activity.
        if next.state == .activity, next.seq == nil, current.seq != nil {
            return ChatRunStartup(runID: next.runID, state: .activity, seq: current.seq)
        }
        return next
    }

    /// The Control UI's wording for the Gateway's startup phases (`chat.startupStatus.*`).
    static func state(phase: String?, retry: OpenClawChatEventPayload.Retry?) -> State? {
        if let retry {
            let text = String(format: String(localized: "Retrying… %lld/%lld"), retry.attempt, retry.maxAttempts)
            return .status(text, retrying: true)
        }
        let text: String? = switch phase {
        case "waiting_for_state": String(localized: "Temporarily busy—retrying…")
        case "preparing_workspace": String(localized: "Preparing workspace…")
        case "naming_worktree": String(localized: "Naming worktree…")
        case "creating_worktree": String(localized: "Creating worktree…")
        case "running_setup": String(localized: "Running setup…")
        case "provisioning_environment": String(localized: "Provisioning environment…")
        case "preparing_context": String(localized: "Preparing this turn…")
        case "memory_flushing": String(localized: "Saving conversation memory…")
        case "starting_model": String(localized: "Waiting for a response…")
        default: nil
        }
        return text.map { .status($0, retrying: false) }
    }
}
