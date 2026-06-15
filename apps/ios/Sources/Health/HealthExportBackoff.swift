import Foundation

// MARK: - HealthExportBackoff

/// Exponential backoff state for retryable (5xx / network) failures. Capped at ~24h and at a max
/// retry count so a permanently-down server doesn't churn forever. Persisted in UserDefaults
/// (no secrets here — only counters/timestamps).
enum HealthExportBackoff {
    private static let attemptKey = "health.export.backoff.attempt"
    private static let nextEligibleKey = "health.export.backoff.nextEligible"
    private static let lastErrorKey = "health.export.lastErrorText"

    /// Base delay, doubled per attempt: 1m, 2m, 4m, ... capped at `maxDelay`.
    static let baseDelay: TimeInterval = 60
    static let maxDelay: TimeInterval = 24 * 60 * 60
    static let maxAttempts = 12

    static func nextEligibleDate() -> Date? {
        let interval = UserDefaults.standard.double(forKey: self.nextEligibleKey)
        guard interval > 0 else { return nil }
        return Date(timeIntervalSince1970: interval)
    }

    static func isEligibleNow(_ now: Date = Date()) -> Bool {
        guard let next = self.nextEligibleDate() else { return true }
        return now >= next
    }

    static func currentAttempt() -> Int {
        UserDefaults.standard.integer(forKey: self.attemptKey)
    }

    static func hasExhaustedRetries() -> Bool {
        self.currentAttempt() >= self.maxAttempts
    }

    /// Records a retryable failure and schedules the next eligible time. Returns the delay used.
    @discardableResult
    static func recordFailure(now: Date = Date()) -> TimeInterval {
        let attempt = self.currentAttempt() + 1
        UserDefaults.standard.set(attempt, forKey: self.attemptKey)
        let exponent = Double(min(attempt - 1, 16))
        let delay = min(self.baseDelay * pow(2.0, exponent), self.maxDelay)
        UserDefaults.standard.set(now.addingTimeInterval(delay).timeIntervalSince1970, forKey: self.nextEligibleKey)
        return delay
    }

    /// Clears backoff after a success (or after the user fixes the config).
    static func reset() {
        UserDefaults.standard.removeObject(forKey: self.attemptKey)
        UserDefaults.standard.removeObject(forKey: self.nextEligibleKey)
    }

    static func setLastError(_ text: String?) {
        if let text {
            UserDefaults.standard.set(text, forKey: self.lastErrorKey)
        } else {
            UserDefaults.standard.removeObject(forKey: self.lastErrorKey)
        }
    }

    static func lastError() -> String? {
        UserDefaults.standard.string(forKey: self.lastErrorKey)
    }
}
