import Foundation

/// Retains one trailing invalidation while a sidebar load is in flight.
@MainActor
public final class OpenClawChatSessionRefreshCoordinator {
    private(set) var task: Task<Void, Never>?
    private var pending: (@MainActor () -> Void)?
    private var waiting = false

    public init() {}

    isolated deinit { self.task?.cancel() }

    public func scheduleLoad(
        isLoading: Bool,
        coalescing: Bool = false,
        debounce: Duration = .zero,
        sleep: @escaping @MainActor (Duration) async throws -> Void = { try await Task.sleep(for: $0) },
        load: @escaping @MainActor () async -> Void)
    {
        if coalescing, isLoading {
            self.pending = { [weak self] in
                self?.scheduleLoad(isLoading: false, debounce: debounce, sleep: sleep, load: load)
            }
            return
        }
        if coalescing, self.waiting { return }
        self.task?.cancel()
        self.waiting = debounce > .zero
        self.task = Task { [weak self] in
            do {
                if debounce > .zero { try await sleep(debounce) }
            } catch {
                if !Task.isCancelled { self?.waiting = false }
                return
            }
            guard !Task.isCancelled else { return }
            self?.waiting = false
            await load()
        }
    }

    public func finishLoad() {
        guard let load = self.pending else { return }
        self.pending = nil
        load()
    }

    public func cancel() {
        self.task?.cancel()
        self.task = nil
        self.pending = nil
        self.waiting = false
    }
}
