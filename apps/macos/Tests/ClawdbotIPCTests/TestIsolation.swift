import Foundation

actor TestIsolationLock {
    static let shared = TestIsolationLock()

    private var locked = false
    private var waiters: [CheckedContinuation<Void, Never>] = []

    private func lock() async {
        if !self.locked {
            self.locked = true
            return
        }
        await withCheckedContinuation { cont in
            self.waiters.append(cont)
        }
        // `unlock()` resumed us; lock is now held for this caller.
    }

    private func unlock() {
        if self.waiters.isEmpty {
            self.locked = false
            return
        }
        let next = self.waiters.removeFirst()
        next.resume()
    }

    func withLock<T: Sendable>(_ body: @Sendable () async throws -> T) async rethrows -> T {
        await self.lock()
        defer { self.unlock() }
        return try await body()
    }
}

enum TestIsolation {
    static func withIsolatedState<T: Sendable>(
        env: [String: String?] = [:],
        defaults: [String: Any?] = [:],
        _ body: @Sendable () async throws -> T) async rethrows -> T
    {
        try await TestIsolationLock.shared.withLock {
            var previousEnv: [String: String?] = [:]
            for (key, value) in env {
                previousEnv[key] = getenv(key).map { String(cString: $0) }
                if let value {
                    setenv(key, value, 1)
                } else {
                    unsetenv(key)
                }
            }

            let userDefaults = UserDefaults.standard
            var previousDefaults: [String: Any?] = [:]
            for (key, value) in defaults {
                previousDefaults[key] = userDefaults.object(forKey: key)
                if let value {
                    userDefaults.set(value, forKey: key)
                } else {
                    userDefaults.removeObject(forKey: key)
                }
            }

            defer {
                for (key, value) in previousDefaults {
                    if let value {
                        userDefaults.set(value, forKey: key)
                    } else {
                        userDefaults.removeObject(forKey: key)
                    }
                }
                for (key, value) in previousEnv {
                    if let value {
                        setenv(key, value, 1)
                    } else {
                        unsetenv(key)
                    }
                }
            }

            return try await body()
        }
    }

    static func withEnvValues<T: Sendable>(
        _ values: [String: String?],
        _ body: @Sendable () async throws -> T) async rethrows -> T
    {
        try await Self.withIsolatedState(env: values, defaults: [:], body)
    }

    static func withUserDefaultsValues<T: Sendable>(
        _ values: [String: Any?],
        _ body: @Sendable () async throws -> T) async rethrows -> T
    {
        try await Self.withIsolatedState(env: [:], defaults: values, body)
    }

    static func tempConfigPath() -> String {
        FileManager.default.temporaryDirectory
            .appendingPathComponent("clawdbot-test-config-\(UUID().uuidString).json")
            .path
    }
}
