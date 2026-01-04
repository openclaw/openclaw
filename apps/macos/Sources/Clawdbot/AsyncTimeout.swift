import Foundation

enum AsyncTimeout {
    static func withTimeout<T: Sendable>(
        seconds: Double,
        onTimeout: @escaping @Sendable () -> Error,
        operation: @escaping @Sendable () async throws -> T) async throws -> T
    {
        let clamped = max(0, seconds)
        return try await withThrowingTaskGroup(of: T.self) { group in
            group.addTask { try await operation() }
            group.addTask {
                try await Task.sleep(nanoseconds: UInt64(clamped * 1_000_000_000))
                throw onTimeout()
            }
            let result = try await group.next()
            group.cancelAll()
            if let result { return result }
            throw onTimeout()
        }
    }
}
