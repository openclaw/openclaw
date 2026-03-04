import Foundation

@MainActor
enum SimpleTaskSupport {
    static func start(task: inout Task<Void, Never>?, operation: @escaping @Sendable () async -> Void) {
        guard task == nil else { return }
        task = Task {
            await operation()
        }
    }

    static func stop(task: inout Task<Void, Never>?) {
        task?.cancel()
        task = nil
    }

    static func startDetachedLoop(
        task: inout Task<Void, Never>?,
        interval: TimeInterval,
        operation: @escaping @Sendable () async -> Void)
    {
        guard task == nil else { return }
        task = Task.detached {
            await operation()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(interval * 1_000_000_000))
                await operation()
            }
        }
    }
}
