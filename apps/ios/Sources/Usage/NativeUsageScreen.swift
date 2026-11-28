import OpenClawKit
import SwiftUI

struct NativeUsageScreen: View {
    enum Period: Int, CaseIterable, Identifiable {
        case week = 7, month = 30, quarter = 90, year = 365, custom = 0
        var id: Self {
            self
        }

        var title: LocalizedStringKey {
            switch self {
            case .week: "Last 7 days"
            case .month: "Last 30 days"
            case .quarter: "Last 90 days"
            case .year: "Last year"
            case .custom: "Custom range"
            }
        }
    }

    struct Agent: Identifiable { let id: String }

    @Environment(NodeAppModel.self) private var appModel
    @State private var report: NativeUsageReport?
    @State private var loadedQuery: NativeUsageQuery?
    @State private var loadedDates: ClosedRange<Date>?
    @State private var plans: NativeUsagePlans?
    @State private var reportError: String?
    @State private var plansFailed = false
    @State private var plansRefreshing = false
    @State private var reportRequest = UUID()
    @State private var planRequest = UUID()
    @State private var refresh = 0
    @State private var agent: Agent?
    @State private var showDashboard = false
    @State private var editingDates = false
    @State private var period: Period
    @State private var customStart: Date
    @State private var customEnd: Date
    let headerSidebarAction: OpenClawSidebarHeaderAction?
    let agentID: String?

    init(
        headerSidebarAction: OpenClawSidebarHeaderAction? = nil,
        agentID: String? = nil,
        period: Period = .month,
        start: Date? = nil,
        end: Date = .now)
    {
        self.headerSidebarAction = headerSidebarAction
        self.agentID = agentID
        self._period = State(initialValue: period)
        self._customStart = State(initialValue: start ?? Self.start(of: period, end: end))
        self._customEnd = State(initialValue: end)
    }

    static func start(of period: Period, end: Date) -> Date {
        Calendar.current.date(byAdding: .day, value: 1 - max(period.rawValue, 1), to: end) ?? end
    }

    private var dates: ClosedRange<Date> {
        if self.period == .custom { return min(self.customStart, self.customEnd)...self.customEnd }
        let end = Calendar.current.startOfDay(for: .now)
        return Self.start(of: self.period, end: end)...end
    }

    private var query: NativeUsageQuery {
        NativeUsageQuery(start: self.dates.lowerBound, end: self.dates.upperBound, agentID: self.agentID)
    }

    var body: some View {
        List {
            if self.connected {
                if self.agentID == nil { self.planLimits }
                NativeUsagePeriodControl(
                    period: self.$period,
                    displayedDates: self.loadedDates ?? self.dates,
                    isUpdating: self.report != nil && self.loadedQuery != self.query && self.reportError == nil)
                { self.editingDates = true }
                if let report {
                    let updating = self.loadedQuery != self.query
                    if let reportError {
                        Text(verbatim: reportError).font(OpenClawType.footnote).foregroundStyle(.secondary)
                        if updating {
                            Button { self.refresh += 1 } label: { Text("Try again").font(OpenClawType.body) }
                        }
                    }
                    NativeUsageAnalytics(report: report, showsAgents: self.agentID == nil) { id in
                        self.agent = Agent(id: id)
                    }
                    .disabled(updating)
                } else if let reportError {
                    Section {
                        Text("Couldn’t load usage").font(OpenClawType.headline)
                        Text(verbatim: reportError).font(OpenClawType.footnote).foregroundStyle(.secondary)
                        Button { self.refresh += 1 } label: { Text("Try again").font(OpenClawType.body) }
                    }
                } else {
                    ProgressView { Text("Loading usage…").font(OpenClawType.subhead) }
                }

                if self.agentID == nil, self.appModel.hasOperatorAdminScope {
                    Section {
                        Button { self.showDashboard = true } label: {
                            Label { Text("Full report in web app").font(OpenClawType.body) }
                                icon: { Image(systemName: "globe") }
                        }
                    }
                }
            } else {
                ContentUnavailableView {
                    Label { Text("Gateway disconnected").font(OpenClawType.title3) }
                        icon: { Image(systemName: "wifi.slash") }
                } description: { Text("Connect to OpenClaw to see usage.").font(OpenClawType.body) }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(self.agentID ?? String(localized: "Usage"))
        .toolbar {
            if let headerSidebarAction {
                OpenClawSidebarToolbarItem(action: headerSidebarAction, placement: .topBarLeading)
            }
        }
        .task(id: ReportKey(query: self.query, connected: self.connected, refresh: self.refresh)) {
            await self.loadReport()
        }
        .task(id: PlanKey(connected: self.connected, refresh: self.refresh)) { await self.loadPlans() }
        .refreshable {
            async let report: Void = self.loadReport()
            async let plans: Void = self.loadPlans()
            _ = await (report, plans)
        }
        .sheet(isPresented: self.$editingDates) {
            NativeUsageCustomDates(dates: self.dates) { dates in
                self.customStart = dates.lowerBound
                self.customEnd = dates.upperBound
                self.period = .custom
            }
        }
        .sheet(item: self.$agent) { agent in
            NavigationStack {
                NativeUsageScreen(
                    agentID: agent.id,
                    period: self.period,
                    start: self.dates.lowerBound,
                    end: self.dates.upperBound)
                    .toolbar {
                        ToolbarItem(placement: .confirmationAction) {
                            Button { self.agent = nil } label: { Text("Done").font(OpenClawType.subheadSemiBold) }
                        }
                    }
            }
            .presentationDragIndicator(.visible)
        }
        .sheet(isPresented: self.$showDashboard) {
            DashboardPageScreen(
                path: DashboardRouteMap.usagePagePath,
                title: String(localized: "Usage"),
                onClose: { self.showDashboard = false })
        }
    }

    @ViewBuilder private var planLimits: some View {
        if let plans, !plans.providers.isEmpty {
            Section {
                ForEach(Array(plans.providers.enumerated()), id: \.offset) { _, provider in
                    VStack(alignment: .leading, spacing: 8) {
                        LabeledContent {
                            if let plan = provider.plan {
                                Text(String(format: String(localized: "Plan: %@"), plan))
                                    .font(OpenClawType.footnote).foregroundStyle(.secondary)
                            }
                        } label: { Text(verbatim: provider.displayName).font(OpenClawType.headline) }
                        if let summary = provider.summary { Text(verbatim: summary).font(OpenClawType.subhead) }
                        if let error = provider
                            .error
                        {
                            Text(verbatim: error).font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.warn)
                        }
                        ForEach(Array(provider.windows.enumerated()), id: \.offset) { _, window in
                            self.quotaWindow(window)
                        }
                        ForEach(Array((provider.billing ?? []).enumerated()), id: \.offset) { _, entry in
                            if let value = entry.value {
                                LabeledContent {
                                    Text(verbatim: value).font(OpenClawType.subheadMedium)
                                } label: {
                                    if let label = entry.label {
                                        Text(verbatim: label).font(OpenClawType.subhead)
                                    } else {
                                        switch entry.type {
                                        case "balance": Text("Balance").font(OpenClawType.subhead)
                                        case "spend": Text("Spend").font(OpenClawType.subhead)
                                        default: Text("Budget").font(OpenClawType.subhead)
                                        }
                                    }
                                }
                            }
                        }
                    }.padding(.vertical, 4)
                }
            } header: { Text("Plan limits").font(OpenClawType.subheadSemiBold) }
                footer: { Text("Current limits don’t change with the date range.").font(OpenClawType.caption) }
        }
        if self.plansFailed || self.plansRefreshing {
            Text(self.plansFailed ? "Couldn’t load plan limits." : "Updating plan limits…")
                .font(OpenClawType.footnote).foregroundStyle(.secondary)
        }
    }

    private func quotaWindow(_ window: NativeUsagePlans.Window) -> some View {
        let left = min(1, max(0, 1 - window.usedPercent / 100))
        let tone = left <= 0.10 ? OpenClawBrand.danger : left <= 0.25 ? OpenClawBrand.warn : Color.primary
        return HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 2) {
                Text(verbatim: [window.groupLabel, window.label].compactMap(\.self).joined(separator: " · "))
                    .font(OpenClawType.subhead)
                if let reset = window.resetAt, reset / 1000 > Date.now.timeIntervalSince1970 {
                    Text(String(
                        format: String(localized: "Resets %@"),
                        Date(timeIntervalSince1970: reset / 1000).formatted(date: .abbreviated, time: .shortened)))
                        .font(OpenClawType.caption).foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 6)
            ZStack {
                Circle().stroke(tone.opacity(0.18), lineWidth: 3)
                Circle().trim(from: 0, to: left).stroke(tone, style: StrokeStyle(lineWidth: 3, lineCap: .round))
                    .rotationEffect(.degrees(-90))
            }.frame(width: 22, height: 22).accessibilityHidden(true)
            Text(String(format: String(localized: "%@ left"), left.formatted(.percent.precision(.fractionLength(0)))))
                .font(OpenClawType.subheadMedium).foregroundStyle(tone).monospacedDigit()
        }.accessibilityElement(children: .combine)
    }

    private struct ReportKey: Equatable {
        let query: NativeUsageQuery
        let connected: Bool
        let refresh: Int
    }

    private struct PlanKey: Equatable { let connected: Bool
        let refresh: Int
    }

    private var connected: Bool {
        #if DEBUG
        if NativeUsagePreview.isEnabled { return true }
        #endif
        return self.appModel.isOperatorGatewayConnected
    }

    private func requestReport(_ query: NativeUsageQuery) async throws -> Data {
        #if DEBUG
        if NativeUsagePreview.isEnabled { return try NativeUsagePreview.report(query) }
        #endif
        let data = try JSONEncoder().encode(query)
        guard let params = String(bytes: data, encoding: .utf8)
        else { throw CocoaError(.fileReadInapplicableStringEncoding) }
        return try await self.appModel.operatorSession.request(
            method: "sessions.usage",
            paramsJSON: params,
            timeoutSeconds: 30)
    }

    private func requestPlans() async throws -> Data {
        #if DEBUG
        if NativeUsagePreview.isEnabled { return Data(NativeUsagePreview.plans.utf8) }
        #endif
        return try await self.appModel.operatorSession.request(
            method: "usage.status",
            paramsJSON: "{}",
            timeoutSeconds: 30)
    }

    private func loadReport() async {
        let request = UUID()
        self.reportRequest = request
        guard self.connected else {
            self.report = nil
            self.loadedQuery = nil
            self.loadedDates = nil
            return
        }
        let dates = self.dates
        let query = self.query
        self.reportError = nil
        do {
            let data = try await self.requestReport(query)
            let result = try await GatewayPayloadDecoding.decode(NativeUsageReport.self, from: data)
            try Task.checkCancellation()
            guard self.query == query, self.reportRequest == request else { return }
            self.report = result
            self.loadedQuery = query
            self.loadedDates = dates
        } catch {
            guard !Task.isCancelled, self.query == query, self.reportRequest == request else { return }
            self.reportError = error.localizedDescription
        }
    }

    private func loadPlans() async {
        let request = UUID()
        self.planRequest = request
        guard self.connected, self.agentID == nil else {
            self.plans = nil
            self.plansFailed = false
            self.plansRefreshing = false
            return
        }
        do {
            for attempt in 0..<3 {
                let data = try await self.requestPlans()
                let result = try await GatewayPayloadDecoding.decode(NativeUsagePlans.self, from: data)
                try Task.checkCancellation()
                guard self.planRequest == request else { return }
                self.plansFailed = false
                self.plansRefreshing = result.refreshing == true
                if !self.plansRefreshing {
                    self.plans = result
                    return
                }
                if attempt < 2 { try await Task.sleep(for: .seconds(2 * (attempt + 1))) }
            }
            self.plansRefreshing = false
            self.plansFailed = true
        } catch {
            guard !Task.isCancelled, self.planRequest == request else { return }
            self.plansRefreshing = false
            self.plansFailed = true
        }
    }
}
