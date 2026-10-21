import Foundation

@MainActor
final class DelayedActionGate {
    typealias Sleeper = @Sendable (Duration) async throws -> Void

    private let sleeper: Sleeper
    private var task: Task<Void, Never>?

    init(sleeper: @escaping Sleeper = { try await Task.sleep(for: $0) }) {
        self.sleeper = sleeper
    }

    @discardableResult
    func schedule(
        after duration: Duration,
        action: @escaping @MainActor () -> Void) -> Task<Void, Never>
    {
        self.task?.cancel()
        let sleeper = self.sleeper
        let task = Task { @MainActor in
            do {
                try await sleeper(duration)
            } catch {
                return
            }
            guard !Task.isCancelled else { return }
            action()
        }
        self.task = task
        return task
    }

    func cancel() {
        self.task?.cancel()
        self.task = nil
    }
}
