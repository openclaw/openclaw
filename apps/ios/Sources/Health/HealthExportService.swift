import Foundation
import HealthKit
import Observation
import os

// MARK: - HealthExportStatus

enum HealthExportStatus: Equatable {
    case idle
    case exporting
    case success(uploaded: Int, at: Date)
    case nothingNew(at: Date)
    /// A 4xx — the user must fix token/URL; we will not retry automatically.
    case needsAttention(message: String)
    /// A 5xx / network failure — scheduled for backoff retry.
    case retrying(nextAttempt: Date?, message: String)
    case notConfigured
    case notAuthorized
}

// MARK: - HealthExportService

/// Central orchestrator for HealthKit → webhook export. `@MainActor @Observable` so SwiftUI can
/// bind to its `status`. The heavy lifting (HealthKit reads, networking) happens off the main
/// actor inside the injected collaborators.
///
/// Pipeline (export):
///   1. Resolve config (Keychain). If missing → `.notConfigured`.
///   2. If a pending (previously-failed) payload exists, retry THAT first.
///   3. Read new samples since the anchor (`HealthKitReading`).
///   4. Encode to Health Auto Export JSON.
///   5. POST. On 2xx: advance anchor + clear pending + reset backoff. On 4xx: stop (needsAttention).
///      On 5xx/network: persist pending payload + persist (do NOT advance) anchor + schedule backoff.
@MainActor
@Observable
final class HealthExportService {
    static let shared = HealthExportService()

    private(set) var status: HealthExportStatus = .idle
    private(set) var isAuthorized: Bool = false

    private let reader: HealthKitReading
    private let uploader: HealthWebhookUploading
    /// Resolves the validated webhook config. Defaults to the Keychain-backed store; injectable so
    /// the orchestrator can be unit-tested without depending on the test host's Keychain.
    private let configProvider: @MainActor () -> HealthWebhookConfig?
    private let logger = Logger(subsystem: "ai.openclaw.ios", category: "HealthExport")
    private var inFlight = false

    init(
        reader: HealthKitReading = LiveHealthKitReader(),
        uploader: HealthWebhookUploading = LiveHealthWebhookClient(),
        configProvider: @escaping @MainActor () -> HealthWebhookConfig? = { HealthExportConfigStore.load() })
    {
        self.reader = reader
        self.uploader = uploader
        self.configProvider = configProvider
        self.isAuthorized = reader.hasRequestedAuthorization()
        self.refreshStatusForConfig()
    }

    // MARK: Public API

    var isConfigured: Bool {
        self.configProvider() != nil
    }

    var isHealthAvailable: Bool {
        self.reader.isHealthDataAvailable()
    }

    /// Re-reads the coarse authorization flag (e.g. after returning from Settings).
    func isAuthorizedRefresh() {
        self.isAuthorized = self.reader.hasRequestedAuthorization()
    }

    /// Requests HealthKit read authorization, with graceful handling of denial.
    func requestAuthorization() async {
        guard self.reader.isHealthDataAvailable() else {
            self.status = .notAuthorized
            return
        }
        do {
            try await self.reader.requestAuthorization()
            self.isAuthorized = self.reader.hasRequestedAuthorization()
            self.refreshStatusForConfig()
        } catch {
            self.logger.error("HealthExport: auth request failed: \(error.localizedDescription, privacy: .public)")
            self.isAuthorized = false
            self.status = .notAuthorized
        }
    }

    /// Saves config and resets backoff (the user just fixed something).
    @discardableResult
    func saveConfiguration(token: String, urlString: String) -> Bool {
        let saved = HealthExportConfigStore.save(token: token, urlString: urlString)
        if saved {
            HealthExportBackoff.reset()
            HealthExportBackoff.setLastError(nil)
            self.refreshStatusForConfig()
        }
        return saved
    }

    func clearConfiguration() {
        HealthExportConfigStore.clear()
        HealthExportFileStore.clearPendingPayload()
        HealthExportBackoff.reset()
        self.status = .notConfigured
    }

    /// Manual "Export now": ignores the backoff window (the user explicitly asked).
    func exportNow() async {
        await self.runExport(force: true, trigger: "manual")
    }

    /// Reconciliation entry point: re-run the anchored read on app open / observer wake / BG task.
    /// Respects the backoff window unless `force` is set.
    func reconcile(trigger: String) async {
        await self.runExport(force: false, trigger: trigger)
    }

    // MARK: Export pipeline

    private func runExport(force: Bool, trigger: String) async {
        guard !self.inFlight else { return }
        self.inFlight = true
        defer { self.inFlight = false }

        guard let config = self.configProvider() else {
            self.status = .notConfigured
            return
        }

        guard self.reader.isHealthDataAvailable() else {
            self.status = .notAuthorized
            return
        }

        // Honor backoff unless this is a forced (manual) or the window has elapsed.
        if !force, !HealthExportBackoff.isEligibleNow() {
            self.status = .retrying(
                nextAttempt: HealthExportBackoff.nextEligibleDate(),
                message: HealthExportBackoff.lastError() ?? "Waiting to retry")
            return
        }

        self.status = .exporting
        self.logger.info("HealthExport: export start trigger=\(trigger, privacy: .public) force=\(force)")

        // 1. Retry a previously-deferred payload first, if any. Advance the anchor to the one saved
        //    alongside that payload so a successful retry moves the anchor exactly once — otherwise
        //    the fresh read below would re-read and re-upload the same window.
        if let pending = HealthExportFileStore.loadPendingPayload() {
            let pendingAnchor = HealthExportFileStore.loadPendingAnchor()
            let retried = await self.upload(body: pending, config: config, advanceAnchor: pendingAnchor)
            switch retried {
            case .success:
                // upload() already advanced the anchor (to pendingAnchor) and cleared the pending
                // sidecar; fall through to read any samples after that anchor.
                break
            case .stop:
                return
            case .deferred:
                return
            }
        }

        // 2. Read new samples since the anchor.
        let readResult: (batch: HealthExportBatch, newAnchor: Data?)
        do {
            readResult = try await self.reader.readNewSamples()
        } catch {
            self.logger.error("HealthExport: read failed: \(error.localizedDescription, privacy: .public)")
            self.status = .notAuthorized
            return
        }

        guard !readResult.batch.isEmpty, let body = HealthExportPayloadEncoder.encode(readResult.batch) else {
            HealthExportBackoff.reset()
            HealthExportBackoff.setLastError(nil)
            self.status = .nothingNew(at: Date())
            return
        }

        let count = self.sampleCount(in: readResult.batch)
        let outcome = await self.upload(body: body, config: config, advanceAnchor: readResult.newAnchor)
        switch outcome {
        case .success:
            self.status = .success(uploaded: count, at: Date())
        case .stop:
            break
        case .deferred:
            break
        }
    }

    private enum UploadOutcome {
        case success
        /// 4xx: stop, surface to user, no auto-retry.
        case stop
        /// 5xx/network: deferred for backoff retry.
        case deferred
    }

    /// Posts a body. On 2xx, advances the anchor (if provided) and clears backoff. On 4xx, stops.
    /// On 5xx/network, persists the body as pending + schedules backoff and (crucially) does NOT
    /// advance the anchor, so the same window is re-read until it succeeds.
    private func upload(body: Data, config: HealthWebhookConfig, advanceAnchor: Data?) async -> UploadOutcome {
        do {
            try await self.uploader.post(body: body, config: config)
            // 2xx — only now do we advance the anchor.
            if let advanceAnchor {
                HealthExportFileStore.saveAnchorData(advanceAnchor)
            }
            HealthExportFileStore.clearPendingPayload()
            HealthExportBackoff.reset()
            HealthExportBackoff.setLastError(nil)
            return .success
        } catch let HealthExportError.clientError(status) {
            // 4xx — do not retry in a loop. Persist nothing; keep the anchor where it was.
            let message = self.clientErrorMessage(status: status)
            HealthExportBackoff.setLastError(message)
            self.status = .needsAttention(message: message)
            self.logger.error("HealthExport: client error \(status, privacy: .public) — stopping")
            return .stop
        } catch {
            // 5xx / network — defer. Persist the body AND the anchor it corresponds to, so a later
            // retry advances the anchor exactly once on success (no duplicate upload of this window).
            // The live anchor still stays put until that retry succeeds.
            HealthExportFileStore.savePendingPayload(body, anchor: advanceAnchor)
            let message = self.retryableErrorMessage(error)
            let delay = HealthExportBackoff.recordFailure()
            HealthExportBackoff.setLastError(message)
            if HealthExportBackoff.hasExhaustedRetries() {
                self.status = .needsAttention(message: "Export keeps failing. \(message)")
            } else {
                self.status = .retrying(
                    nextAttempt: HealthExportBackoff.nextEligibleDate(),
                    message: message)
            }
            self.logger.info("HealthExport: deferred, next retry in \(Int(delay), privacy: .public)s")
            return .deferred
        }
    }

    // MARK: Helpers

    private func sampleCount(in batch: HealthExportBatch) -> Int {
        let metricCount = batch.metrics.values.reduce(0) { $0 + $1.count }
        return metricCount + batch.sleepMinutes.count + batch.workouts.count
    }

    private func clientErrorMessage(status: Int) -> String {
        switch status {
        case 401, 403: "Webhook rejected the token (\(status)). Check your token."
        case 422: "Webhook rejected the data shape (422). Check the URL."
        default: "Webhook returned \(status). Check your token and URL."
        }
    }

    private func retryableErrorMessage(_ error: Error) -> String {
        if case let HealthExportError.serverOrNetwork(status) = error, let status {
            return "Server error \(status). Will retry."
        }
        return "Network unavailable. Will retry."
    }

    private func refreshStatusForConfig() {
        guard self.isConfigured else {
            self.status = .notConfigured
            return
        }
        if !self.reader.isHealthDataAvailable() {
            self.status = .notAuthorized
            return
        }
        if let message = HealthExportBackoff.lastError(), !HealthExportBackoff.isEligibleNow() {
            self.status = .retrying(nextAttempt: HealthExportBackoff.nextEligibleDate(), message: message)
            return
        }
        self.status = .idle
    }
}
