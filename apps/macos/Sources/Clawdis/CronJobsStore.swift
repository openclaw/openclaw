import ClawdisProtocol
import Foundation
import OSLog

@MainActor
final class CronJobsStore: ObservableObject {
    static let shared = CronJobsStore()

    @Published var jobs: [CronJob] = []
    @Published var selectedJobId: String?
    @Published var runEntries: [CronRunLogEntry] = []

    @Published var isLoadingJobs = false
    @Published var isLoadingRuns = false
    @Published var lastError: String?
    @Published var statusMessage: String?

    private let logger = Logger(subsystem: "com.steipete.clawdis", category: "cron.ui")
    private var refreshTask: Task<Void, Never>?
    private var runsTask: Task<Void, Never>?
    private var eventTask: Task<Void, Never>?
    private var pollTask: Task<Void, Never>?

    private let interval: TimeInterval = 30
    private let isPreview: Bool

    init(isPreview: Bool = ProcessInfo.processInfo.isPreview) {
        self.isPreview = isPreview
    }

    func start() {
        guard !self.isPreview else { return }
        guard self.eventTask == nil else { return }
        self.startGatewaySubscription()
        self.pollTask = Task.detached { [weak self] in
            guard let self else { return }
            await self.refreshJobs()
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: UInt64(self.interval * 1_000_000_000))
                await self.refreshJobs()
            }
        }
    }

    func stop() {
        self.refreshTask?.cancel()
        self.refreshTask = nil
        self.runsTask?.cancel()
        self.runsTask = nil
        self.eventTask?.cancel()
        self.eventTask = nil
        self.pollTask?.cancel()
        self.pollTask = nil
    }

    func refreshJobs() async {
        guard !self.isLoadingJobs else { return }
        self.isLoadingJobs = true
        self.lastError = nil
        self.statusMessage = nil
        defer { self.isLoadingJobs = false }

        do {
            let data = try await self.request(
                method: "cron.list",
                params: ["includeDisabled": true])
            let res = try JSONDecoder().decode(CronListResponse.self, from: data)
            self.jobs = res.jobs
            if self.jobs.isEmpty {
                self.statusMessage = "No cron jobs yet."
            }
        } catch {
            self.logger.error("cron.list failed \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }

    func refreshRuns(jobId: String, limit: Int = 200) async {
        guard !self.isLoadingRuns else { return }
        self.isLoadingRuns = true
        defer { self.isLoadingRuns = false }

        do {
            let data = try await self.request(
                method: "cron.runs",
                params: ["id": jobId, "limit": limit])
            let res = try JSONDecoder().decode(CronRunsResponse.self, from: data)
            self.runEntries = res.entries
        } catch {
            self.logger.error("cron.runs failed \(error.localizedDescription, privacy: .public)")
            self.lastError = error.localizedDescription
        }
    }

    func runJob(id: String, force: Bool = true) async {
        do {
            _ = try await self.request(
                method: "cron.run",
                params: ["id": id, "mode": force ? "force" : "due"],
                timeoutMs: 20_000)
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func removeJob(id: String) async {
        do {
            _ = try await self.request(method: "cron.remove", params: ["id": id])
            await self.refreshJobs()
            if self.selectedJobId == id {
                self.selectedJobId = nil
                self.runEntries = []
            }
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func setJobEnabled(id: String, enabled: Bool) async {
        do {
            _ = try await self.request(
                method: "cron.update",
                params: ["id": id, "patch": ["enabled": enabled]])
            await self.refreshJobs()
        } catch {
            self.lastError = error.localizedDescription
        }
    }

    func upsertJob(
        id: String?,
        payload: [String: Any]) async throws
    {
        if let id {
            _ = try await self.request(method: "cron.update", params: ["id": id, "patch": payload])
        } else {
            _ = try await self.request(method: "cron.add", params: payload)
        }
        await self.refreshJobs()
    }

    // MARK: - Gateway events

    private func startGatewaySubscription() {
        self.eventTask?.cancel()
        self.eventTask = Task { [weak self] in
            guard let self else { return }
            let stream = await GatewayConnection.shared.subscribe()
            for await push in stream {
                if Task.isCancelled { return }
                await MainActor.run { [weak self] in
                    self?.handle(push: push)
                }
            }
        }
    }

    private func handle(push: GatewayPush) {
        switch push {
        case let .event(evt) where evt.event == "cron":
            guard let payload = evt.payload else { return }
            if let cronEvt = try? GatewayPayloadDecoding.decode(payload, as: CronEvent.self) {
                self.handle(cronEvent: cronEvt)
            }
        case .seqGap:
            self.scheduleRefresh()
        default:
            break
        }
    }

    private func handle(cronEvent evt: CronEvent) {
        // Keep UI in sync with the gateway scheduler.
        self.scheduleRefresh(delayMs: 250)
        if evt.action == "finished", let selected = self.selectedJobId, selected == evt.jobId {
            self.scheduleRunsRefresh(jobId: selected, delayMs: 200)
        }
    }

    private func scheduleRefresh(delayMs: Int = 250) {
        self.refreshTask?.cancel()
        self.refreshTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            await self.refreshJobs()
        }
    }

    private func scheduleRunsRefresh(jobId: String, delayMs: Int = 200) {
        self.runsTask?.cancel()
        self.runsTask = Task { [weak self] in
            guard let self else { return }
            try? await Task.sleep(nanoseconds: UInt64(delayMs) * 1_000_000)
            await self.refreshRuns(jobId: jobId)
        }
    }

    // MARK: - RPC

    private func request(
        method: String,
        params: [String: Any]?,
        timeoutMs: Double? = nil) async throws -> Data
    {
        let rawParams = params?.reduce(into: [String: AnyCodable]()) { $0[$1.key] = AnyCodable($1.value) }
        return try await GatewayConnection.shared.request(method: method, params: rawParams, timeoutMs: timeoutMs)
    }
}

