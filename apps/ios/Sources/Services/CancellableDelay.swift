import Foundation

enum CancellableDelay {
    static func wait(for duration: Duration) async -> Bool {
        do {
            try await Task.sleep(for: duration)
        } catch {
            return false
        }
        return !Task.isCancelled
    }
}
