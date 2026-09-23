import AppKit
import OpenClawKit
import Testing

extension AppKitTestSupport {
    static func performWindowTransition(
        _ window: NSWindow,
        notification: Notification.Name,
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
        let observed = try await AsyncTimeout.withTimeout(
            seconds: 10,
            onTimeout: {
                NSError(
                    domain: "AppKitWindowTransitionTests",
                    code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "The window did not emit \(notification.rawValue)"])
            },
            operation: {
                var iterator = events.stream.makeAsyncIterator()
                return await iterator.next() != nil
            })
        try #require(observed)
        // Native window ordering continues after the transition notification.
        // Assert the settled result after its main-queue completion work can run.
        await withCheckedContinuation { continuation in
            DispatchQueue.main.async { continuation.resume() }
        }
    }
}
