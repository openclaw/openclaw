import Foundation
import Observation
import OpenClawChatUI
import OpenClawProtocol

struct ChatSessionRosterSnapshot: Sendable {
    let sessions: [OpenClawChatSessionEntry]
    let isCached: Bool
}

extension NodeAppModel {
    func loadChatSessionRoster(
        limit: Int,
        archived: Bool = false,
        allowCachedFallback: Bool = true) async throws -> ChatSessionRosterSnapshot
    {
        guard self.isLocalChatFixtureEnabled || self.isOperatorGatewayConnected else {
            guard allowCachedFallback else { throw URLError(.notConnectedToInternet) }
            return await ChatSessionRosterSnapshot(
                sessions: archived ? [] : self.loadCachedChatSessions(),
                isCached: true)
        }

        do {
            let response = try await self.makeChatTransport().listSessions(limit: limit, archived: archived)
            if !archived {
                self.reconcileChatSessionReadState(response.sessions)
                await self.storeCachedChatSessions(response.sessions)
            }
            return ChatSessionRosterSnapshot(sessions: response.sessions, isCached: false)
        } catch {
            guard allowCachedFallback, !archived else { throw error }
            let cached = await self.loadCachedChatSessions()
            guard !cached.isEmpty else { throw error }
            return ChatSessionRosterSnapshot(sessions: cached, isCached: true)
        }
    }
}

@MainActor
@Observable
final class RootSidebarModel {
    static let sessionLimit = 200

    struct TokenUsageSummary: Equatable {
        let total: Int?
        let isPartial: Bool
    }

    private(set) var sessions: [OpenClawChatSessionEntry] = []
    private(set) var usage: CostUsageSummaryLite?
    private(set) var cronJobs: [CronJob] = []
    private(set) var isRefreshing = false
    private(set) var sessionErrorText: String?
    private var rosterGeneration = 0
    private var dashboardGeneration = 0

    var failedCronJobCount: Int {
        self.cronJobs.count { Self.isFailedCronJob($0) }
    }

    var overdueCronJobCount: Int {
        let threshold = Int(Date().timeIntervalSince1970 * 1000) - 300_000
        return self.cronJobs.count { job in
            job.enabled && (job.nextrunatms.map { $0 < threshold } ?? false)
        }
    }

    var hasCronAttention: Bool {
        self.failedCronJobCount > 0 || self.overdueCronJobCount > 0
    }

    func sections(
        query: String,
        currentSessionKey: String,
        mainSessionKey: String,
        activeAgentID: String?) -> [ChatSessionSidebarModel.Section]
    {
        ChatSessionSidebarModel.sections(
            sessions: self.sessions,
            currentSessionKey: currentSessionKey,
            mainSessionKey: mainSessionKey,
            activeAgentID: activeAgentID,
            query: query)
    }

    func refresh(appModel: NodeAppModel) async {
        self.rosterGeneration &+= 1
        let rosterGeneration = self.rosterGeneration
        self.dashboardGeneration &+= 1
        let dashboardGeneration = self.dashboardGeneration
        self.isRefreshing = true
        defer {
            if rosterGeneration == self.rosterGeneration {
                self.isRefreshing = false
            }
        }

        async let roster = self.loadRoster(appModel: appModel)
        async let dashboard = self.loadDashboard(appModel: appModel)
        let loadedRoster = await roster
        guard !Task.isCancelled else { return }
        if rosterGeneration == self.rosterGeneration {
            switch loadedRoster {
            case let .success(loadedRoster):
                self.sessions = loadedRoster.sessions
                self.sessionErrorText = nil
            case let .failure(message):
                self.sessionErrorText = message
            case .cancelled:
                return
            }
            self.isRefreshing = false
        }

        let loadedDashboard = await dashboard
        guard !Task.isCancelled, dashboardGeneration == self.dashboardGeneration else { return }
        self.usage = loadedDashboard.usage
        self.cronJobs = loadedDashboard.cronJobs
    }

    func refreshSessions(appModel: NodeAppModel) async {
        self.rosterGeneration &+= 1
        let rosterGeneration = self.rosterGeneration
        self.isRefreshing = true
        defer {
            if rosterGeneration == self.rosterGeneration {
                self.isRefreshing = false
            }
        }

        let loadedRoster = await self.loadRoster(appModel: appModel, allowCachedFallback: false)
        guard !Task.isCancelled, rosterGeneration == self.rosterGeneration else { return }
        switch loadedRoster {
        case let .success(roster):
            self.sessions = roster.sessions
            self.sessionErrorText = nil
        case let .failure(message):
            self.sessionErrorText = message
        case .cancelled:
            return
        }
    }

    func reportSessionError(_ error: any Error) {
        self.sessionErrorText = error.localizedDescription
    }

    static func tokenUsageSummary(for sessions: [OpenClawChatSessionEntry]) -> TokenUsageSummary {
        let knownTotals = sessions.compactMap(\.totalTokens)
        return TokenUsageSummary(
            total: knownTotals.isEmpty ? nil : knownTotals.reduce(0, +),
            isPartial: knownTotals.count < sessions.count || sessions.contains { $0.totalTokensFresh == false })
    }

    private func loadRoster(
        appModel: NodeAppModel,
        allowCachedFallback: Bool = true) async -> RosterLoadResult
    {
        do {
            return try await .success(appModel.loadChatSessionRoster(
                limit: Self.sessionLimit,
                allowCachedFallback: allowCachedFallback))
        } catch is CancellationError {
            return .cancelled
        } catch {
            return .failure(error.localizedDescription)
        }
    }

    private func loadDashboard(appModel: NodeAppModel) async -> DashboardSnapshot {
        guard appModel.isOperatorGatewayConnected else {
            return DashboardSnapshot(usage: nil, cronJobs: [])
        }
        async let usage = self.request(
            CostUsageSummaryLite.self,
            appModel: appModel,
            method: "usage.cost",
            paramsJSON: "{\"days\":31}")
        async let cron = self.request(
            CronJobsListLite.self,
            appModel: appModel,
            method: "cron.list",
            paramsJSON: "{\"includeDisabled\":true,\"limit\":200,\"offset\":0,\"sortBy\":\"name\",\"sortDir\":\"asc\"}")
        let loadedUsage = await usage
        let loadedCron = await cron
        return DashboardSnapshot(usage: loadedUsage, cronJobs: loadedCron?.jobs ?? [])
    }

    private func request<T: Decodable>(
        _ type: T.Type,
        appModel: NodeAppModel,
        method: String,
        paramsJSON: String) async -> T?
    {
        do {
            let data = try await appModel.operatorSession.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: 12)
            return try JSONDecoder().decode(type, from: data)
        } catch {
            return nil
        }
    }

    private static func isFailedCronJob(_ job: CronJob) -> Bool {
        let status = (job.lastrunstatus?.value as? String)?.lowercased()
        // This failure vocabulary mirrors the web sidebar-attention contract in ui/src/components/sidebar-attention.ts.
        return ["error", "failed", "timeout", "timed_out"].contains(status)
    }

    private struct DashboardSnapshot {
        let usage: CostUsageSummaryLite?
        let cronJobs: [CronJob]
    }

    private enum RosterLoadResult {
        case success(ChatSessionRosterSnapshot)
        case failure(String)
        case cancelled
    }
}
