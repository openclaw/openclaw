import Foundation
import Observation
import OpenClawKit
import OSLog

@MainActor
@Observable
final class CronJobsStore {
    static let shared = CronJobsStore()

    private struct Snapshot {
        let source: GatewayConnection.ServerLease?
        let summary: CronJobsSummary
    }

    private var cachedSnapshot: Snapshot?
    var summary: CronJobsSummary {
        guard let snapshot = self.cachedSnapshot else { return .empty }
        // A closed menu misses retirement receipts. Revalidate the cached owner
        // before reopening can expose rows from the previous Gateway.
        if let lease = snapshot.source {
            guard lease.endpointRevision == self.gateway.selectedEndpointRevision,
                  self.gateway.serverLeaseMatchesCurrentRoute(lease) else { return .empty }
        }
        return snapshot.summary
    }

    private let logger = Logger(subsystem: "ai.openclaw", category: "cron.ui")
    private var refreshTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?
    private let gateway: GatewayConnection
    // Cron events keep the open menu current; polling only repairs missed updates.
    private let interval: TimeInterval = 600
    private let isPreview: Bool

    init(gateway: GatewayConnection = .shared, isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self.gateway = gateway
        self.isPreview = isPreview
    }

    func start() {
        guard !self.isPreview, self.eventTask == nil else { return }
        self.eventTask = Task { [weak self, gateway] in
            for await delivery in await gateway.subscribe() {
                guard !Task.isCancelled, let self else { return }
                self.handle(delivery: delivery)
            }
        }
        SimpleTaskSupport.startDetachedLoop(task: &self.pollTask, interval: self.interval) { [weak self] in
            await self?.refreshJobs()
        }
    }

    func stop() {
        SimpleTaskSupport.stop(task: &self.refreshTask)
        SimpleTaskSupport.stop(task: &self.eventTask)
        SimpleTaskSupport.stop(task: &self.pollTask)
    }

    func refreshJobs() async {
        guard !Task.isCancelled else { return }
        let task = self.scheduleRefresh(delayMs: 0)
        await withTaskCancellationHandler {
            await task.value
        } onCancel: {
            // A newer refresh may already own the store; cancel only this caller's task.
            task.cancel()
        }
    }

    private func loadJobs() async {
        guard !Task.isCancelled else { return }
        let sourceRevision = self.gateway.selectedEndpointRevision

        var requestLease: GatewayConnection.ServerLease?
        do {
            let lease = try await self.gateway.acquireServerLease()
            requestLease = lease
            guard !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            self.adoptSource(lease)
            let summary = try await self.gateway.cronSummary(ifCurrentServerLease: lease)
            guard !Task.isCancelled, self.gateway.serverLeaseMatchesCurrentState(lease) else { return }
            self.cachedSnapshot = Snapshot(source: lease, summary: summary)
        } catch {
            guard !Task.isCancelled,
                  requestLease.map(self.gateway.serverLeaseMatchesCurrentState) ??
                  (self.gateway.selectedEndpointRevision == sourceRevision)
            else { return }
            self.logger.error("cron.list failed \(error.localizedDescription, privacy: .public)")
        }
    }

    private func handle(delivery: GatewayConnection.PushDelivery) {
        guard let push = delivery.push else {
            guard self.cachedSnapshot?.source == delivery.serverLease else { return }
            SimpleTaskSupport.stop(task: &self.refreshTask)
            self.cachedSnapshot = nil
            return
        }
        guard delivery.isCurrent else { return }
        if self.cachedSnapshot?.source != delivery.serverLease {
            self.adoptSource(delivery.serverLease)
            self.scheduleRefresh(delayMs: 0)
        }
        switch push {
        case let .event(event) where event.event == "cron":
            self.scheduleRefresh()
        case .seqGap:
            self.scheduleRefresh()
        default:
            break
        }
    }

    @discardableResult
    private func scheduleRefresh(delayMs: Int = 250) -> Task<Void, Never> {
        let previousTask = self.refreshTask
        previousTask?.cancel()
        let task = Task { [weak self] in
            // Even a canceled debounce must drain its predecessor before a replacement can refresh.
            await previousTask?.value
            guard await SimpleTaskSupport.waitForNextOperation(interval: TimeInterval(delayMs) / 1000) else { return }
            await self?.loadJobs()
        }
        self.refreshTask = task
        return task
    }

    private func adoptSource(_ lease: GatewayConnection.ServerLease) {
        guard self.cachedSnapshot?.source != lease else { return }
        self.cachedSnapshot = Snapshot(source: lease, summary: .empty)
    }
}

#if DEBUG
extension CronJobsStore {
    /// Synthetic menu fixtures keep screenshot capture independent of a live Gateway.
    func seedDebugFixtureJobs() {
        let now = Int(Date().timeIntervalSince1970 * 1000)
        func job(_ id: String, _ name: String, nextInMinutes: Int) -> CronJob {
            CronJob(
                id: id,
                name: name,
                enabled: true,
                state: .init(nextRunAtMs: now + nextInMinutes * 60000))
        }
        let jobs = [
            job("fixture-1", "Morning Brief", nextInMinutes: 13),
            job("fixture-2", "Inbox Sweep With A Deliberately Long Name", nextInMinutes: 180),
            job("fixture-3", "Weekly Digest", nextInMinutes: 720),
        ]
        self.cachedSnapshot = Snapshot(source: nil, summary: .init(total: jobs.count, jobs: jobs))
    }
}
#endif
