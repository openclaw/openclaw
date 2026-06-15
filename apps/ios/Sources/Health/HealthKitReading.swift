import Foundation

// MARK: - HealthKitReading

/// Testable abstraction over the HealthKit reads the exporter needs. The production conformer
/// (`LiveHealthKitReader`) wraps `HKHealthStore` + `HKAnchoredObjectQuery`; tests inject a mock.
///
/// Implementations are responsible for:
///  - forcing units (count / bpm / ms / kcal / km),
///  - aggregating sleep category samples into minutes-per-night,
///  - sanitizing workouts (no metadata, no routes/GPS),
///  - persisting/advancing the anchor ONLY when told to.
protocol HealthKitReading: Sendable {
    /// Whether HealthKit data is available on this device at all.
    func isHealthDataAvailable() -> Bool

    /// Current read-authorization state, coarse-grained: `true` if the user has been asked and
    /// granted at least the requested set (HealthKit deliberately hides per-type read status).
    func hasRequestedAuthorization() -> Bool

    /// Requests read-only authorization for the exporter's types. Returns whether the request
    /// completed (NOT whether the user granted — HealthKit never reveals read grants directly).
    func requestAuthorization() async throws

    /// Reads everything new since the persisted anchor and returns the batch plus the NEW anchor
    /// token (opaque `Data`). The caller advances the anchor ONLY after a successful 2xx POST.
    func readNewSamples() async throws -> (batch: HealthExportBatch, newAnchor: Data?)
}

// MARK: - HealthExportAuthState

enum HealthExportAuthState: Equatable {
    case unavailable
    case notRequested
    case requested
}
