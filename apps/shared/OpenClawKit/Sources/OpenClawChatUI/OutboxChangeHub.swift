import Foundation

final class OutboxChangeHub: @unchecked Sendable {
    private let lock = NSLock()
    private var continuations: [UUID: AsyncStream<OpenClawChatOutboxChange>.Continuation] = [:]

    func stream() -> AsyncStream<OpenClawChatOutboxChange> {
        let id = UUID()
        let pair = AsyncStream<OpenClawChatOutboxChange>.makeStream()
        self.lock.lock()
        self.continuations[id] = pair.continuation
        self.lock.unlock()
        pair.continuation.onTermination = { [weak self] _ in
            self?.remove(id)
        }
        return pair.stream
    }

    func yield(_ change: OpenClawChatOutboxChange) {
        self.lock.lock()
        let continuations = Array(self.continuations.values)
        self.lock.unlock()
        for continuation in continuations {
            continuation.yield(change)
        }
    }

    func finish() {
        self.lock.lock()
        let continuations = Array(self.continuations.values)
        self.continuations.removeAll()
        self.lock.unlock()
        for continuation in continuations {
            continuation.finish()
        }
    }

    private func remove(_ id: UUID) {
        self.lock.lock()
        self.continuations.removeValue(forKey: id)
        self.lock.unlock()
    }
}
