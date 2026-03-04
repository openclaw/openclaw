import Foundation

public final class ContinuationResumeGate: @unchecked Sendable {
    private let lock = NSLock()
    private var resumed = false

    public init() {}

    public func claim() -> Bool {
        self.lock.lock()
        defer { self.lock.unlock() }
        if self.resumed { return false }
        self.resumed = true
        return true
    }
}

public enum ThrowingContinuationSupport {
    public static func resumeVoid(_ continuation: CheckedContinuation<Void, Error>, error: Error?) {
        if let error {
            continuation.resume(throwing: error)
        } else {
            continuation.resume(returning: ())
        }
    }
}
