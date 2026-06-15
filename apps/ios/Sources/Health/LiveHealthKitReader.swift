import Foundation
import HealthKit
import os

// MARK: - LiveHealthKitReader

/// Production `HealthKitReading` over `HKHealthStore`. READ-ONLY: only `toShare: []` is ever passed
/// to `requestAuthorization`, so the app can never write to HealthKit.
///
/// Sample reads use `HKAnchoredObjectQuery` for incremental export. The anchor is loaded from /
/// persisted to `HealthExportFileStore` (encrypted file) — but the anchor is only ADVANCED by the
/// orchestrator after a successful POST, so a failed upload re-reads the same window next time.
final class LiveHealthKitReader: HealthKitReading, @unchecked Sendable {
    private let store = HKHealthStore()
    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")

    // MARK: Types

    /// Quantity types the exporter reads, paired with their forced unit.
    private static func quantityType(for kind: HealthSampleKind) -> (HKQuantityType, HKUnit)? {
        switch kind {
        case .stepCount:
            (HKQuantityType(.stepCount), HKUnit.count())
        case .heartRate:
            // Forced to count/min; emitted as "bpm" in the payload.
            (HKQuantityType(.heartRate), HKUnit.count().unitDivided(by: .minute()))
        case .heartRateVariabilitySDNN:
            (HKQuantityType(.heartRateVariabilitySDNN), HKUnit.secondUnit(with: .milli))
        case .activeEnergyBurned:
            (HKQuantityType(.activeEnergyBurned), HKUnit.kilocalorie())
        case .basalEnergyBurned:
            (HKQuantityType(.basalEnergyBurned), HKUnit.kilocalorie())
        case .distanceWalkingRunning:
            (HKQuantityType(.distanceWalkingRunning), HKUnit.meterUnit(with: .kilo))
        }
    }

    private static var sleepType: HKCategoryType {
        HKCategoryType(.sleepAnalysis)
    }

    private static var workoutType: HKWorkoutType {
        HKWorkoutType.workoutType()
    }

    /// The full read set passed to authorization (and used to build per-type anchored queries).
    private static func readTypes() -> Set<HKObjectType> {
        var types: Set<HKObjectType> = []
        for kind in HealthSampleKind.allCases {
            if let (quantityType, _) = self.quantityType(for: kind) {
                types.insert(quantityType)
            }
        }
        types.insert(self.sleepType)
        types.insert(self.workoutType)
        return types
    }

    // MARK: HealthKitReading

    func isHealthDataAvailable() -> Bool {
        HKHealthStore.isHealthDataAvailable()
    }

    func hasRequestedAuthorization() -> Bool {
        guard self.isHealthDataAvailable() else { return false }
        // HealthKit hides read grants; `authorizationStatus` for a read-only type returns
        // `.notDetermined` until the user has been prompted. Treat "any type past notDetermined"
        // as "requested". We never claim a specific type is readable.
        return Self.readTypes().contains { type in
            self.store.authorizationStatus(for: type) != .notDetermined
        }
    }

    func requestAuthorization() async throws {
        guard self.isHealthDataAvailable() else {
            throw HealthExportError.healthDataUnavailable
        }
        // READ-ONLY: toShare is empty. This app never writes HealthKit data.
        try await self.store.requestAuthorization(toShare: [], read: Self.readTypes())
    }

    func readNewSamples() async throws -> (batch: HealthExportBatch, newAnchor: Data?) {
        guard self.isHealthDataAvailable() else {
            throw HealthExportError.healthDataUnavailable
        }

        let previousAnchor = Self.decodeAnchor(HealthExportFileStore.loadAnchorData())

        var combined = previousAnchor
        var metricSamples: [HealthSampleKind: [HealthMetricSample]] = [:]
        for kind in HealthSampleKind.allCases {
            let result = try await self.readQuantity(kind: kind, anchor: previousAnchor.value(for: kind))
            metricSamples[kind] = result.samples
            if let anchor = result.newAnchor { combined.setValue(anchor, for: kind) }
        }

        let sleep = try await self.readSleepMinutes(anchor: previousAnchor.sleep)
        let workouts = try await self.readWorkouts(anchor: previousAnchor.workouts)
        if let anchor = sleep.newAnchor { combined.sleep = anchor }
        if let anchor = workouts.newAnchor { combined.workouts = anchor }

        let batch = HealthExportBatch(
            metrics: metricSamples,
            sleepMinutes: sleep.samples,
            workouts: workouts.samples)

        return (batch, Self.encodeAnchor(combined))
    }

    // MARK: Quantity reads

    private func readQuantity(
        kind: HealthSampleKind,
        anchor: HKQueryAnchor?) async throws -> (samples: [HealthMetricSample], newAnchor: HKQueryAnchor?)
    {
        guard let (quantityType, unit) = Self.quantityType(for: kind) else {
            return ([], nil)
        }
        let result = try await self.runAnchoredQuery(sampleType: quantityType, anchor: anchor)
        let samples: [HealthMetricSample] = result.samples.compactMap { sample in
            guard let quantitySample = sample as? HKQuantitySample else { return nil }
            // Force the unit explicitly — never use HealthKit's preferred/regional unit.
            let value = quantitySample.quantity.doubleValue(for: unit)
            return HealthMetricSample(
                quantity: value,
                date: HealthExportDateFormatter.string(from: quantitySample.endDate))
        }
        return (samples, result.newAnchor)
    }

    // MARK: Sleep reads (HKCategorySample → minutes asleep per night)

    private func readSleepMinutes(
        anchor: HKQueryAnchor?) async throws -> (samples: [HealthMetricSample], newAnchor: HKQueryAnchor?)
    {
        let result = try await self.runAnchoredQuery(sampleType: Self.sleepType, anchor: anchor)
        let categorySamples = result.samples.compactMap { $0 as? HKCategorySample }
        let aggregated = HealthSleepAggregator.minutesAsleepPerNight(from: categorySamples)
        return (aggregated, result.newAnchor)
    }

    // MARK: Workout reads (sanitized)

    private func readWorkouts(
        anchor: HKQueryAnchor?) async throws -> (samples: [HealthWorkoutSample], newAnchor: HKQueryAnchor?)
    {
        let result = try await self.runAnchoredQuery(sampleType: Self.workoutType, anchor: anchor)
        let workouts = result.samples.compactMap { $0 as? HKWorkout }
        let sanitized = workouts.map { self.sanitize(workout: $0) }
        return (sanitized, result.newAnchor)
    }

    /// Builds a sanitized workout sample. NO `workout.metadata`, NO route/GPS — only id, activity
    /// name, start/end, duration, and distance/energy via `statistics(for:)`.
    private func sanitize(workout: HKWorkout) -> HealthWorkoutSample {
        let distanceKm = self.workoutStatisticKilometers(workout: workout)
        let energyKcal = self.workoutStatisticKilocalories(workout: workout)
        return HealthWorkoutSample(
            id: workout.uuid.uuidString,
            name: HealthWorkoutActivityName.label(for: workout.workoutActivityType),
            start: HealthExportDateFormatter.string(from: workout.startDate),
            end: HealthExportDateFormatter.string(from: workout.endDate),
            duration: workout.duration,
            distanceKm: distanceKm,
            activeEnergyKcal: energyKcal)
    }

    private func workoutStatisticKilometers(workout: HKWorkout) -> Double? {
        let type = HKQuantityType(.distanceWalkingRunning)
        if let quantity = workout.statistics(for: type)?.sumQuantity() {
            return quantity.doubleValue(for: .meterUnit(with: .kilo))
        }
        // Fall back to cycling distance for non-walking workouts.
        let cyclingType = HKQuantityType(.distanceCycling)
        if let quantity = workout.statistics(for: cyclingType)?.sumQuantity() {
            return quantity.doubleValue(for: .meterUnit(with: .kilo))
        }
        // Fall back to swimming distance so pool/open-water workouts have a distance.
        let swimmingType = HKQuantityType(.distanceSwimming)
        if let quantity = workout.statistics(for: swimmingType)?.sumQuantity() {
            return quantity.doubleValue(for: .meterUnit(with: .kilo))
        }
        return nil
    }

    private func workoutStatisticKilocalories(workout: HKWorkout) -> Double? {
        let type = HKQuantityType(.activeEnergyBurned)
        guard let quantity = workout.statistics(for: type)?.sumQuantity() else { return nil }
        return quantity.doubleValue(for: .kilocalorie())
    }

    // MARK: Anchored query runner

    private func runAnchoredQuery(
        sampleType: HKSampleType,
        anchor: HKQueryAnchor?) async throws -> (samples: [HKSample], newAnchor: HKQueryAnchor?)
    {
        try await withCheckedThrowingContinuation { continuation in
            let query = HKAnchoredObjectQuery(
                type: sampleType,
                predicate: nil,
                anchor: anchor,
                limit: HKObjectQueryNoLimit)
            { _, samples, _, newAnchor, error in
                if let error {
                    continuation.resume(throwing: error)
                    return
                }
                continuation.resume(returning: (samples ?? [], newAnchor))
            }
            self.store.execute(query)
        }
    }

    // MARK: Anchor (de)serialization

    /// Per-type anchors keyed by sample stream so each stream advances independently.
    private struct CombinedAnchor {
        var quantity: [String: HKQueryAnchor] = [:]
        var sleep: HKQueryAnchor?
        var workouts: HKQueryAnchor?

        func value(for kind: HealthSampleKind) -> HKQueryAnchor? {
            self.quantity[kind.rawValue]
        }

        mutating func setValue(_ anchor: HKQueryAnchor, for kind: HealthSampleKind) {
            self.quantity[kind.rawValue] = anchor
        }
    }

    private static func decodeAnchor(_ data: Data?) -> CombinedAnchor {
        guard let data,
              let dict = try? NSKeyedUnarchiver.unarchivedDictionary(
                  ofKeyClass: NSString.self,
                  objectClass: HKQueryAnchor.self,
                  from: data)
        else {
            return CombinedAnchor()
        }
        var combined = CombinedAnchor()
        for (key, anchor) in dict {
            let stringKey = key as String
            if stringKey == "__sleep__" {
                combined.sleep = anchor
            } else if stringKey == "__workouts__" {
                combined.workouts = anchor
            } else {
                combined.quantity[stringKey] = anchor
            }
        }
        return combined
    }

    private static func encodeAnchor(_ combined: CombinedAnchor) -> Data? {
        var dict: [NSString: HKQueryAnchor] = [:]
        for (key, anchor) in combined.quantity {
            dict[key as NSString] = anchor
        }
        if let sleep = combined.sleep { dict["__sleep__"] = sleep }
        if let workouts = combined.workouts { dict["__workouts__"] = workouts }
        guard !dict.isEmpty else { return nil }
        return try? NSKeyedArchiver.archivedData(withRootObject: dict, requiringSecureCoding: true)
    }
}
