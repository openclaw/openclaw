import Foundation

// MARK: - HealthSampleKind

/// Quantity sample kinds the exporter reads. Each maps to a forced HealthKit unit so the
/// webhook (Health Auto Export schema) receives stable, region-independent units.
enum HealthSampleKind: String, CaseIterable {
    case stepCount
    case heartRate
    case heartRateVariabilitySDNN
    case activeEnergyBurned
    case basalEnergyBurned
    case distanceWalkingRunning

    /// Metric `name` emitted in the webhook payload (Health Auto Export naming).
    var metricName: String {
        switch self {
        case .stepCount: "step_count"
        case .heartRate: "heart_rate"
        case .heartRateVariabilitySDNN: "heart_rate_variability"
        case .activeEnergyBurned: "active_energy"
        case .basalEnergyBurned: "basal_energy_burned"
        case .distanceWalkingRunning: "walking_running_distance"
        }
    }

    /// Units string emitted in the payload. Forced explicitly so HealthKit's regional
    /// preferences (e.g. miles vs km) can never change what the webhook validates.
    var unitsLabel: String {
        switch self {
        case .stepCount: "count"
        case .heartRate: "bpm"
        case .heartRateVariabilitySDNN: "ms"
        case .activeEnergyBurned, .basalEnergyBurned: "kcal"
        case .distanceWalkingRunning: "km"
        }
    }
}

// MARK: - HealthMetricSample

/// One read sample, already converted to the forced unit and timestamped in UTC.
struct HealthMetricSample: Equatable {
    var quantity: Double
    /// `"yyyy-MM-dd HH:mm:ss Z"` rendered in UTC.
    var date: String
}

// MARK: - HealthWorkoutSample

/// Sanitized workout: no metadata, no GPS routes — only the fields the webhook accepts.
struct HealthWorkoutSample: Equatable {
    var id: String
    var name: String
    /// `"yyyy-MM-dd HH:mm:ss Z"` UTC.
    var start: String
    /// `"yyyy-MM-dd HH:mm:ss Z"` UTC.
    var end: String
    /// Duration in seconds.
    var duration: Double
    /// Distance in km, when available.
    var distanceKm: Double?
    /// Active energy burned in kcal, when available.
    var activeEnergyKcal: Double?
}

// MARK: - HealthExportBatch

/// A reconciled batch of new samples since the last anchor, ready to POST.
struct HealthExportBatch: Equatable {
    var metrics: [HealthSampleKind: [HealthMetricSample]]
    /// `name="SleepMinutes" units="min"` derived metric: minutes asleep per night.
    var sleepMinutes: [HealthMetricSample]
    var workouts: [HealthWorkoutSample]

    var isEmpty: Bool {
        self.workouts.isEmpty
            && self.sleepMinutes.isEmpty
            && self.metrics.values.allSatisfy(\.isEmpty)
    }

    static let empty = HealthExportBatch(metrics: [:], sleepMinutes: [], workouts: [])
}

// MARK: - HealthExportError

enum HealthExportError: Error, Equatable {
    /// HealthKit is not available on this device (e.g. iPad without paired data store).
    case healthDataUnavailable
    /// User has not granted read authorization for the requested types.
    case notAuthorized
    /// Webhook URL failed validation (must be https + a `.ts.net` host).
    case invalidWebhookURL
    /// Token or URL not yet configured by the user.
    case notConfigured
    /// Server returned a 4xx — stop and surface to the user, do not retry in a loop.
    case clientError(status: Int)
    /// Server returned a 5xx or the network failed — eligible for backoff retry.
    case serverOrNetwork(status: Int?)
    /// Encoding the payload failed.
    case encodingFailed
}
