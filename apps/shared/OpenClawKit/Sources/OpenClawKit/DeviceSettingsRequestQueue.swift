@MainActor
public final class DeviceSettingsRequestQueue {
    private struct Operation {
        let run: @MainActor () async -> Void
        let cancel: (@MainActor () -> Void)?
    }

    private var generation = 0
    private var worker: Task<Void, Never>?
    private var active: Operation?
    private var pending: [Operation] = []

    public init() {}

    public func enqueue(
        _ operation: @escaping @MainActor () async -> Void,
        onCancel: (@MainActor () -> Void)? = nil)
    {
        self.pending.append(Operation(run: operation, cancel: onCancel))
        guard self.worker == nil else { return }
        let generation = self.generation
        self.worker = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.generation == generation, !self.pending.isEmpty {
                let operation = self.pending.removeFirst()
                self.active = operation
                await operation.run()
                guard self.generation == generation else { return }
                self.active = nil
            }
            if self.generation == generation { self.worker = nil }
        }
    }

    public func cancel() {
        self.generation += 1
        self.worker?.cancel()
        self.worker = nil
        let retired = self.pending
        let active = self.active
        self.pending.removeAll()
        self.active = nil
        // Permission prompts may ignore cancellation; retire their replies immediately.
        active?.cancel?()
        for operation in retired {
            operation.cancel?()
        }
    }
}
