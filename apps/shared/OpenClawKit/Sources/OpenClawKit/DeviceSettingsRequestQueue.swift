import Foundation

@MainActor
public final class DeviceSettingsRequestQueue {
    public typealias Completion = @MainActor () async -> Void

    private struct Operation {
        let run: @MainActor () async -> Completion?
        let cancel: (@MainActor () -> Void)?
    }

    private var generation = 0
    private var worker: Task<Void, Never>?
    private var active: Operation?
    private var pending: [Operation] = []
    private var completions: [UUID: (task: Task<Void, Never>, cancel: (@MainActor () -> Void)?)] = [:]

    public init() {}

    public func enqueue(
        _ operation: @escaping @MainActor () async -> Void,
        onCancel: (@MainActor () -> Void)? = nil)
    {
        self.enqueueAdmission({
            await operation()
            return nil
        }, onCancel: onCancel)
    }

    /// Serialize validation/admission; retain the returned reply completion without
    /// blocking later admissions. The ordinary enqueue method still waits for all work.
    public func enqueueAdmission(
        _ admission: @escaping @MainActor () async -> Completion?,
        onCancel: (@MainActor () -> Void)? = nil)
    {
        self.pending.append(Operation(run: admission, cancel: onCancel))
        guard self.worker == nil else { return }
        let generation = self.generation
        self.worker = Task { [weak self] in
            guard let self else { return }
            while !Task.isCancelled, self.generation == generation, !self.pending.isEmpty {
                let operation = self.pending.removeFirst()
                self.active = operation
                let completion = await operation.run()
                guard self.generation == generation else { return }
                if let completion {
                    // Admission stays FIFO, but an already-admitted operation must not
                    // prevent a later intent from reaching its mutation owner.
                    let id = UUID()
                    let task = Task { [weak self] in
                        guard !Task.isCancelled else { return }
                        await completion()
                        self?.completions[id] = nil
                    }
                    self.completions[id] = (task, operation.cancel)
                }
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
        let completions = self.completions.values
        self.completions.removeAll()
        self.pending.removeAll()
        self.active = nil
        // Permission prompts may ignore cancellation; retire their replies immediately.
        active?.cancel?()
        for operation in retired {
            operation.cancel?()
        }
        for completion in completions {
            completion.task.cancel()
            completion.cancel?()
        }
    }
}
