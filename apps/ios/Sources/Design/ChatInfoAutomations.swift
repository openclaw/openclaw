import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Compact cron.list carries timings but intentionally omits event commands and full job payloads.
struct ChatInfoAutomation: Decodable, Identifiable, Sendable {
    struct Schedule: Decodable, Sendable {
        let kind: String
        var expr: String?
        var at: String?
        var everyMs: Int?
    }

    let id: String
    let name: String
    var displayName: String?
    let enabled: Bool
    var schedule: Schedule?
    var scheduleKind: String?
    var lastRunStatus: String?

    func timing(_ formatter: ChatInfoAutomationSchedule) -> String? {
        switch self.schedule?.kind ?? self.scheduleKind {
        case "cron": self.schedule?.expr.map(formatter.cron)
        case "every": self.schedule?.everyMs.map(formatter.every)
        case "at": self.schedule?.at.map(formatter.at)
        case "event": String(localized: "On event")
        case "on-exit": String(localized: "On exit")
        case "stream": String(localized: "Stream")
        default: nil
        }
    }

    /// Only an exception earns a word; an active automation shows none.
    var status: String? {
        if self.lastRunStatus == "error" { return String(localized: "Run failed") }
        if !self.enabled { return String(localized: "Paused") }
        return nil
    }

    var detailQuery: [URLQueryItem] {
        [URLQueryItem(name: "job", value: self.id)]
    }
}

extension ChatInfoVisit {
    static func automationQuery(for target: OpenClawChatSessionTarget, isProfile: Bool) -> CronListParams? {
        guard let agent = target.agentID?.trimmedNonEmpty else { return nil }
        return CronListParams(
            sessionkey: isProfile ? nil : target.sessionKey,
            sessionagentid: isProfile ? nil : agent,
            includedisabled: true,
            limit: isProfile ? 3 : 2,
            agentid: isProfile ? agent : nil,
            compact: true)
    }

    @MainActor func loadAutomations(in app: NodeAppModel) async -> ChatInfoRead<[ChatInfoAutomation]> {
        guard let query = Self.automationQuery(for: self.catalogTarget, isProfile: self.isProfile)
        else { return .failed }
        if app.isLocalChatFixtureEnabled {
            return await ScreenshotFixtureMode.infoRead("automations") { ScreenshotFixtureMode.infoAutomations(query) }
        }
        struct Page: Decodable { let jobs: [ChatInfoAutomation]
            let total: Int
        }
        guard let gatewayID = self.catalogGatewayID,
              let route = await app.operatorSession.currentRoute(ifGatewayID: gatewayID),
              let bytes = try? JSONEncoder().encode(query), let json = String(bytes: bytes, encoding: .utf8),
              let data = try? await app.operatorSession.request(
                  method: "cron.list",
                  paramsJSON: json,
                  ifCurrentRoute: route),
              let page = try? await GatewayPayloadDecoding.decode(Page.self, from: data),
              page.jobs.count == min(page.total, query.limit ?? 0) else { return .failed }
        return .loaded(page.jobs)
    }
}

struct ChatInfoAutomations: View {
    let visit: ChatInfoVisit
    @Environment(NodeAppModel.self) private var app
    @State private var automations: ChatInfoRead<[ChatInfoAutomation]> = .loading
    @State private var attempt = 0
    @State private var detail: ChatInfoAutomation?
    @Environment(\.dynamicTypeSize) private var typeSize

    private func discovery(_ state: ChatInfoDiscoveryRow.State) -> some View {
        ChatInfoDiscoveryRow(
            symbol: RootTabs.SidebarDestination.cron.systemImage,
            title: String(localized: "No automations yet"),
            detail: String(localized: "Ask the agent to do something on a schedule"),
            failure: String(localized: "Couldn’t load automations"),
            state: state)
        {
            self.automations = .loading
            self.attempt += 1
        }
    }

    var body: some View {
        Group {
            switch self.automations {
            case .loading: self.discovery(.loading)
            case .failed: self.discovery(.failed)
            case let .loaded(jobs) where jobs.isEmpty: self.discovery(.empty)
            case let .loaded(jobs):
                VStack(spacing: 0) {
                    ForEach(jobs) { job in
                        if job.id != jobs.first?.id { Divider().padding(.leading, 52) }
                        Button { self.detail = job } label: {
                            self.row(job)
                        }.buttonStyle(.plain).accessibilityIdentifier("chat-info-automation-" + job.id)
                    }
                }
            }
        }
        .task(id: self.attempt) {
            let automations = await self.visit.loadAutomations(in: self.app)
            if !Task.isCancelled { self.automations = self.automations.replaced(by: automations) }
        }
        .sheet(item: self.$detail) { job in
            if SettingsHubScreen.usesDashboard(
                isOperatorConnected: self.app.isOperatorGatewayConnected,
                hasOperatorAdminScope: self.app.hasOperatorAdminScope,
                isDemoMode: self.app.isAppleReviewDemoModeEnabled,
                isScreenshotMode: ProcessInfo.processInfo.arguments
                    .contains("--openclaw-screenshot-mode")),
                self.visit.catalogGatewayID == self.app.chatTranscriptCacheGatewayID
            {
                DashboardPageScreen(
                    path: DashboardRouteMap.cronJobsPagePath,
                    title: job.displayName ?? job.name,
                    queryItems: job.detailQuery,
                    onClose: { self.detail = nil })
            } else {
                Text("Couldn’t open this automation").font(OpenClawType.body)
                    .foregroundStyle(OpenClawBrand.textSecondary).presentationDetents([.medium])
            }
        }
    }

    private func row(_ job: ChatInfoAutomation) -> some View {
        HStack(spacing: 14) {
            Image(systemName: RootTabs.SidebarDestination.cron.systemImage).font(OpenClawType.body)
                .foregroundStyle(OpenClawBrand.textSecondary).frame(width: 22).accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 1) {
                Text(verbatim: job.displayName ?? job.name).font(OpenClawType.body)
                if let timing = job.timing(ChatInfoAutomationSchedule()) {
                    Text(verbatim: timing).font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.textSecondary)
                }
                if self.typeSize.isAccessibilitySize { self.status(job) }
            }
            .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 0)
            if !self.typeSize.isAccessibilitySize { self.status(job).padding(.trailing, 6) }
            Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                .foregroundStyle(OpenClawBrand.textTertiary).accessibilityHidden(true)
        }
        .padding(.horizontal, 16).padding(.vertical, 12).contentShape(Rectangle())
    }

    @ViewBuilder private func status(_ job: ChatInfoAutomation) -> some View {
        if let status = job.status {
            Text(verbatim: status).font(OpenClawType.footnote)
                .foregroundStyle(job.lastRunStatus == "error" ? OpenClawBrand.warn : OpenClawBrand.textSecondary)
        }
    }
}
