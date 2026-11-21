import Foundation

enum ChatMediaPlaybackLoader {
    /// Eleven waits total 120 seconds. The initial request plus these retries
    /// gives transcoding time to finish without leaving a card pending forever.
    private static let retryDelays: [Duration] = [.seconds(1), .seconds(2), .seconds(4), .seconds(8)]
        + Array(repeating: .seconds(15), count: 7)
    typealias Load = @MainActor @Sendable () async throws -> OpenClawChatLoadedMedia?
    typealias Sleep = @MainActor @Sendable (Duration) async throws -> Void

    @MainActor
    static func load(
        request: Load,
        onPreparing: @MainActor @Sendable () -> Void,
        sleep: Sleep = { try await Task.sleep(for: $0) }) async throws -> OpenClawChatLoadedMedia?
    {
        var loaded = try await request()
        guard case .preparing = loaded else { return loaded }
        onPreparing()

        for delay in self.retryDelays {
            try Task.checkCancellation()
            try await sleep(delay)
            loaded = try await request()
            guard case .preparing = loaded else { return loaded }
            onPreparing()
        }
        return nil
    }
}
