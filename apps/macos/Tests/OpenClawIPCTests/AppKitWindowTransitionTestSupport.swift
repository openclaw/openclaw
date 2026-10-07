import AppKit
import Testing

extension AppKitTestSupport {
    static func performWindowTransition(
        _ window: NSWindow,
        notification: Notification.Name,
        sourceLocation: SourceLocation = #_sourceLocation,
        action: @MainActor () async throws -> Void) async throws
    {
        let events = AsyncStream<Void>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let observer = NotificationCenter.default.addObserver(
            forName: notification, object: window, queue: nil)
        { _ in events.continuation.yield(()) }
        defer {
            NotificationCenter.default.removeObserver(observer)
            events.continuation.finish()
        }
        try await action()
        var iterator = events.stream.makeAsyncIterator()
        let observed = await iterator.next() != nil
        guard observed, !Task.isCancelled else {
            Issue.record("Still waiting for window \(notification.rawValue)", sourceLocation: sourceLocation)
            throw CancellationError()
        }
        try #require(observed)
        // Native window ordering continues after the transition notification.
        // Assert the settled result after its main-queue completion work can run.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}
