import Foundation
import os

// MARK: - HealthExportDateFormatter

/// Renders dates as `"yyyy-MM-dd HH:mm:ss Z"` in UTC, matching the Health Auto Export schema
/// that the webhook validates and then normalizes to UTC. Locale is `en_US_POSIX` so month/day
/// formatting is stable regardless of device locale.
enum HealthExportDateFormatter {
    static let shared: DateFormatter = {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(identifier: "UTC")
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss Z"
        return formatter
    }()

    static func string(from date: Date) -> String {
        self.shared.string(from: date)
    }
}

// MARK: - Wire structs (Health Auto Export schema)

private struct HealthWireQty: Encodable {
    let qty: Double
    let units: String
}

private struct HealthWireMetricPoint: Encodable {
    let qty: Double
    let date: String
}

private struct HealthWireMetric: Encodable {
    let name: String
    let units: String
    let data: [HealthWireMetricPoint]
}

private struct HealthWireWorkout: Encodable {
    let id: String
    let name: String
    let start: String
    let end: String
    let duration: Double
    let distance: HealthWireQty?
    let activeEnergyBurned: HealthWireQty?
}

private struct HealthWireData: Encodable {
    let metrics: [HealthWireMetric]
    let workouts: [HealthWireWorkout]
}

private struct HealthWireRoot: Encodable {
    let data: HealthWireData
}

// MARK: - HealthExportPayloadEncoder

enum HealthExportPayloadEncoder {
    /// Encodes a reconciled batch into the Health Auto Export JSON body the webhook expects.
    /// Returns `nil` if the batch is empty (nothing to send).
    static func encode(_ batch: HealthExportBatch) -> Data? {
        guard !batch.isEmpty else { return nil }

        var metrics: [HealthWireMetric] = []

        // Quantity metrics, in a deterministic order for stable output / testing.
        for kind in HealthSampleKind.allCases {
            guard let samples = batch.metrics[kind], !samples.isEmpty else { continue }
            metrics.append(HealthWireMetric(
                name: kind.metricName,
                units: kind.unitsLabel,
                data: samples.map { HealthWireMetricPoint(qty: $0.quantity, date: $0.date) }))
        }

        // Sleep is exported as a derived numeric metric (minutes asleep), never the raw category.
        if !batch.sleepMinutes.isEmpty {
            metrics.append(HealthWireMetric(
                name: "SleepMinutes",
                units: "min",
                data: batch.sleepMinutes.map { HealthWireMetricPoint(qty: $0.quantity, date: $0.date) }))
        }

        let workouts = batch.workouts.map { workout in
            HealthWireWorkout(
                id: workout.id,
                name: workout.name,
                start: workout.start,
                end: workout.end,
                duration: workout.duration,
                distance: workout.distanceKm.map { HealthWireQty(qty: $0, units: "km") },
                activeEnergyBurned: workout.activeEnergyKcal.map { HealthWireQty(qty: $0, units: "kcal") })
        }

        let root = HealthWireRoot(data: HealthWireData(metrics: metrics, workouts: workouts))
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        do {
            return try encoder.encode(root)
        } catch {
            // Encoding a fixed Encodable graph should never fail; log and degrade to nil rather
            // than crash. The error text is the encoder's own description (no health values).
            let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")
            logger.error("HealthExport: payload encode failed: \(error.localizedDescription, privacy: .private)")
            return nil
        }
    }
}
