/// Tracks the logical Talk call, not individual turns or transport connections.
public struct TalkChimeLifecycle: Sendable {
    public enum Cue: String, Sendable {
        case wake
        case bye
        case follow
    }

    private var reachedReady = false

    private var replyPending = false

    public init() {}

    public mutating func replyFinished(isRealtime: Bool) {
        self.replyPending = self.reachedReady && !isRealtime
    }

    public mutating func resumedListening(isRealtime: Bool, enabled: Bool) -> Cue? {
        defer { self.replyPending = false }
        guard self.reachedReady, self.replyPending, !isRealtime, enabled else { return nil }
        return .follow
    }

    public mutating func ready(enabled: Bool) -> Cue? {
        guard !self.reachedReady else { return nil }
        self.reachedReady = true
        return enabled ? .wake : nil
    }

    public mutating func end(clean: Bool, enabled: Bool) -> Cue? {
        defer {
            self.reachedReady = false
            self.replyPending = false
        }
        return self.reachedReady && clean && enabled ? .bye : nil
    }
}
