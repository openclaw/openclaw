import BackgroundTasks
import Foundation
import HealthKit
import os

// MARK: - HealthExportBackgroundTask

/// Registers and drives the `BGProcessingTask` that exports HealthKit data in the background, plus
/// the `HKObserverQuery` + `enableBackgroundDelivery` best-effort wake. Both ultimately call
/// `HealthExportService.reconcile(...)`.
@MainActor
enum HealthExportBackgroundTask {
    static let identifier = "ai.openclaw.ios.healthexport"
    private static let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")
    private static var observerQueries: [HKObserverQuery] = []
    private static let observerStore = HKHealthStore()

    /// Call once from `application(_:didFinishLaunchingWithOptions:)`.
    static func register() {
        BGTaskScheduler.shared.register(forTaskWithIdentifier: self.identifier, using: nil) { task in
            guard let processingTask = task as? BGProcessingTask else {
                task.setTaskCompleted(success: false)
                return
            }
            MainActor.assumeIsolated {
                self.handle(task: processingTask)
            }
        }
    }

    /// Schedules the next background processing run. Best-effort; iOS decides actual timing.
    static func schedule(afterSeconds delay: TimeInterval = 30 * 60) {
        // Only schedule when Health Export is enabled + configured. Without this guard the
        // BGProcessingTask is submitted on every launch/background (and re-armed in `handle`)
        // even for users who never opted in. Gating here covers both call sites.
        guard HealthExportConfigStore.isConfigured() else {
            self.logger.info("HealthExport: schedule skipped — not configured")
            return
        }
        let request = BGProcessingTaskRequest(identifier: self.identifier)
        request.requiresNetworkConnectivity = true
        request.requiresExternalPower = false
        request.earliestBeginDate = Date().addingTimeInterval(max(60, delay))
        do {
            try BGTaskScheduler.shared.submit(request)
            self.logger.info("HealthExport: scheduled BGProcessingTask in \(Int(delay), privacy: .public)s")
        } catch {
            self.logger.error("HealthExport: BG schedule failed: \(error.localizedDescription, privacy: .public)")
        }
    }

    private static func handle(task: BGProcessingTask) {
        // Always reschedule so export keeps running periodically.
        self.schedule()

        let work = Task { @MainActor in
            await HealthExportService.shared.reconcile(trigger: "bg_processing")
            return true
        }
        task.expirationHandler = {
            work.cancel()
        }
        Task { @MainActor in
            let ok = await work.value
            task.setTaskCompleted(success: ok)
            self.logger.info("HealthExport: BGProcessingTask finished ok=\(ok, privacy: .public)")
        }
    }

    // MARK: Observer query (best-effort background delivery)

    /// Starts an `HKObserverQuery` per read type + enables background delivery. On a wake, runs a
    /// reconciliation. Safe to call multiple times (idempotent: clears existing observers first).
    static func startObserving() {
        guard HKHealthStore.isHealthDataAvailable() else { return }
        guard HealthExportConfigStore.isConfigured() else { return }
        self.stopObserving()

        for sampleType in self.observedSampleTypes() {
            let query = HKObserverQuery(sampleType: sampleType, predicate: nil) { _, completion, error in
                if let error {
                    Self.logger.info("HealthExport: observer error: \(error.localizedDescription, privacy: .public)")
                }
                // Acknowledge the HealthKit notification immediately (required so iOS doesn't
                // throttle background delivery), then run the export independently.
                completion()
                if error == nil {
                    Task { @MainActor in
                        await HealthExportService.shared.reconcile(trigger: "hk_observer")
                    }
                }
            }
            self.observerStore.execute(query)
            self.observerQueries.append(query)

            self.observerStore.enableBackgroundDelivery(for: sampleType, frequency: .hourly) { success, error in
                if let error {
                    let message = error.localizedDescription
                    Self.logger.info("HealthExport: bg delivery enable failed: \(message, privacy: .public)")
                } else {
                    Self.logger.info("HealthExport: bg delivery enabled success=\(success, privacy: .public)")
                }
            }
        }
    }

    static func stopObserving() {
        for query in self.observerQueries {
            self.observerStore.stop(query)
        }
        self.observerQueries.removeAll()
    }

    private static func observedSampleTypes() -> [HKSampleType] {
        var types: [HKSampleType] = []
        // Quantity types
        types.append(HKQuantityType(.stepCount))
        types.append(HKQuantityType(.heartRate))
        types.append(HKQuantityType(.heartRateVariabilitySDNN))
        types.append(HKQuantityType(.activeEnergyBurned))
        types.append(HKQuantityType(.basalEnergyBurned))
        types.append(HKQuantityType(.distanceWalkingRunning))
        // Category + workout
        types.append(HKCategoryType(.sleepAnalysis))
        types.append(HKWorkoutType.workoutType())
        return types
    }
}
