import Foundation

@MainActor
final class GatewayHealthMonitor {
    struct Config {
        var intervalSeconds: Double
        var maxFailures: Int
    }

    private let config: Config
    private let sleep: @Sendable (UInt64) async -> Void
    private var task: Task<Void, Never>?

    init(
        config: Config = Config(intervalSeconds: 15, maxFailures: 3),
        sleep: @escaping @Sendable (UInt64) async -> Void = { nanoseconds in
            try? await Task.sleep(nanoseconds: nanoseconds)
        })
    {
        self.config = config
        self.sleep = sleep
    }

    func start(
        check: @escaping @Sendable () async throws -> Bool,
        onFailure: @escaping @Sendable (_ failureCount: Int) async -> Void)
    {
        self.stop()
        let config = self.config
        let sleep = self.sleep
        self.task = Task { @MainActor in
            var failures = 0
            while !Task.isCancelled {
                // The Gateway request owns its timeout; do not race a second deadline here.
                let ok = await (try? check()) ?? false
                guard !Task.isCancelled else { return }
                if ok {
                    failures = 0
                } else {
                    failures += 1
                    if failures >= config.maxFailures {
                        await onFailure(failures)
                        failures = 0
                    }
                }

                if Task.isCancelled { break }
                await sleep(UInt64(config.intervalSeconds * 1_000_000_000))
            }
        }
    }

    func stop() {
        self.task?.cancel()
        self.task = nil
    }
}
