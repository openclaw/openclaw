import Foundation

/// One readiness wait belongs to the native window, even when its document controller changes.
@MainActor
final class DashboardDocumentLoad {
    private var result: Result<Void, Error>?
    private var continuation: CheckedContinuation<Void, Error>?

    func wait() async throws {
        try await withTaskCancellationHandler {
            try Task.checkCancellation()
            try await withCheckedThrowingContinuation { continuation in
                if let result {
                    continuation.resume(with: result)
                } else {
                    self.continuation = continuation
                }
            }
        } onCancel: {
            Task { @MainActor in self.finish(.failure(CancellationError())) }
        }
    }

    func finish(_ result: Result<Void, Error>) {
        guard self.result == nil else { return }
        self.result = result
        self.continuation?.resume(with: result)
        self.continuation = nil
    }
}
