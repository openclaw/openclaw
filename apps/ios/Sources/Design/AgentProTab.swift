import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct AgentProTab: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var overview: AgentOverviewSnapshot?
    @State private var overviewErrorText: String?
    @State private var overviewLoading: Bool = false
    @State private var overviewRefreshNonce: Int = 0
    @State private var skillFilter: String = ""
    @State private var skillStatusFilter: SkillStatusFilter = .all
    @State private var skillMutationBusyKeys: Set<String> = []
    @State private var skillMutationErrorText: String?
    @State private var skillMutationStatusText: String?
    @State private var skillConfigBusyKeys: Set<String> = []
    @State private var skillConfigMessages: [String: SkillEditorMessage] = [:]
    @State private var skillAPIKeyDrafts: [String: String] = [:]
    @State private var skillEditorSelection: SkillEditorSelection?
    @State private var clawHubQuery: String = ""
    @State private var clawHubResults: [ClawHubSearchResultLite] = []
    @State private var clawHubLoading: Bool = false
    @State private var clawHubErrorText: String?
    @State private var clawHubInstallSlug: String?
    @State private var cronActionBusyIDs: Set<String> = []
    @State private var cronActionStatusText: String?

    private enum AgentRoute: Hashable {
        case skills
        case nodes
        case cron
        case usage
        case dreaming
    }

    private enum SkillStatusFilter: String, CaseIterable, Identifiable {
        case all
        case enabled
        case off
        case setup
        case blocked

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .all: "All"
            case .enabled: "Enabled"
            case .off: "Off"
            case .setup: "Setup"
            case .blocked: "Blocked"
            }
        }
    }

    private struct SkillEditorSelection: Identifiable {
        let id: String
    }

    private struct SkillEditorMessage {
        let kind: Kind
        let text: String

        enum Kind {
            case success
            case error
        }
    }

    var body: some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 18) {
                        self.agentsSection
                        self.operationsSection
                        self.capabilitySection
                        self.dreamingSection
                        self.cronSection
                    }
                    .padding(.vertical, 18)
                }
                .refreshable {
                    await self.refreshOverview(force: true)
                }
                .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
            }
            .navigationTitle("Agent")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: AgentRoute.self) { route in
                self.destination(for: route)
            }
        }
        .task(id: self.overviewTaskID) {
            await self.refreshOverview(force: false)
        }
        .sheet(item: self.$skillEditorSelection) { selection in
            if let skill = self.skillByKey(selection.id) {
                self.skillEditorSheet(skill)
            } else {
                self.missingSkillEditorSheet
            }
        }
    }

    private var agentsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(
                title: "Agents",
                actionTitle: self.overviewLoading ? "Loading" : "Refresh",
                action: {
                    self.overviewRefreshNonce += 1
                })
            ProCard(padding: 0) {
                if self.appModel.gatewayAgents.isEmpty {
                    self.emptyAgentsRow
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(self.sortedAgents.enumerated()), id: \.element.id) { index, agent in
                            Button {
                                self.appModel.setSelectedAgentId(agent.id)
                            } label: {
                                self.agentRow(agent)
                            }
                            .buttonStyle(.plain)
                            if index < self.sortedAgents.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var operationsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Live Operations")
            LazyVGrid(columns: [GridItem(.flexible()), GridItem(.flexible())], spacing: 10) {
                self.metricTile(
                    icon: "sparkles",
                    title: "Skills",
                    value: self.skillsValue,
                    detail: self.skillsDetail,
                    color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                    route: .skills)
                self.metricTile(
                    icon: "externaldrive.connected.to.line.below",
                    title: "Instances",
                    value: self.instancesValue,
                    detail: self.instancesDetail,
                    color: self.instancesColor,
                    route: .nodes)
                self.metricTile(
                    icon: "clock.arrow.circlepath",
                    title: "Cron",
                    value: self.cronValue,
                    detail: self.cronDetail,
                    color: self.cronColor,
                    route: .cron)
                self.metricTile(
                    icon: "chart.line.uptrend.xyaxis",
                    title: "Usage",
                    value: self.usageValue,
                    detail: self.usageDetail,
                    color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                    route: .usage)
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)

            if let overviewErrorText {
                Text(overviewErrorText)
                    .font(.caption)
                    .foregroundStyle(OpenClawBrand.warn)
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
            }
        }
    }

    private var capabilitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Capabilities")
            ProCard {
                VStack(spacing: 0) {
                    NavigationLink(value: AgentRoute.skills) {
                        self.agentMenuRow(
                            icon: "bolt",
                            title: "Skills",
                            detail: self.skillsDetail,
                            value: self.skillsValue,
                            color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                            showsChevron: true)
                    }
                    .buttonStyle(.plain)
                    Divider().padding(.leading, 60)
                    NavigationLink(value: AgentRoute.nodes) {
                        self.agentMenuRow(
                            icon: "display",
                            title: "Nodes",
                            detail: self.instancesDetail,
                            value: self.instancesValue,
                            color: self.instancesColor,
                            showsChevron: true)
                    }
                    .buttonStyle(.plain)
                    Divider().padding(.leading, 60)
                    NavigationLink(value: AgentRoute.usage) {
                        self.agentMenuRow(
                            icon: "chart.line.uptrend.xyaxis",
                            title: "Usage",
                            detail: self.usageDetail,
                            value: self.usageValue,
                            color: self.gatewayConnected ? OpenClawBrand.accent : .secondary,
                            showsChevron: true)
                    }
                    .buttonStyle(.plain)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var dreamingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Dreaming")
            ProCard {
                NavigationLink(value: AgentRoute.dreaming) {
                    self.agentMenuRow(
                        icon: "moon",
                        title: "Dreaming",
                        detail: self.dreamingDetail,
                        value: self.dreamingValue,
                        color: self.dreamingColor,
                        showsChevron: true)
                }
                .buttonStyle(.plain)
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var cronSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Scheduled Work")
            ProCard(padding: 0) {
                let jobs = self.recentCronJobs
                if jobs.isEmpty {
                    NavigationLink(value: AgentRoute.cron) {
                        self.emptyCronRow
                            .padding(14)
                    }
                    .buttonStyle(.plain)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(jobs.enumerated()), id: \.element.id) { index, job in
                            NavigationLink(value: AgentRoute.cron) {
                                self.cronJobRow(job)
                            }
                            .buttonStyle(.plain)
                            if index < jobs.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var emptyAgentsRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "person.2.slash", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.gatewayConnected ? "No agents reported" : "Agents unavailable")
                    .font(.subheadline.weight(.semibold))
                Text(self.gatewayConnected
                    ? "The connected gateway did not return an agent list."
                    : "Connect a gateway to load the live agent roster.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private func agentRow(_ agent: AgentSummary) -> some View {
        let isActive = agent.id == self.activeAgentID
        return HStack(spacing: 12) {
            ProIconBadge(
                systemName: isActive ? "person.fill.checkmark" : "person",
                color: isActive ? OpenClawBrand.accent : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.agentName(for: agent))
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.agentDetail(for: agent))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(isActive ? "active" : "ready")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(isActive ? OpenClawBrand.accent : .secondary)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private func agentMenuRow(
        icon: String,
        title: String,
        detail: String,
        value: String,
        color: Color,
        showsChevron: Bool = false) -> some View
    {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: color)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(value)
                .font(.caption2.weight(.semibold))
                .foregroundStyle(color)
                .lineLimit(1)
            if showsChevron {
                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.vertical, 10)
    }

    private func metricTile(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color,
        route: AgentRoute? = nil) -> some View
    {
        Group {
            if let route {
                NavigationLink(value: route) {
                    self.metricTileContent(
                        icon: icon,
                        title: title,
                        value: value,
                        detail: detail,
                        color: color,
                        showsChevron: true)
                }
                .buttonStyle(.plain)
            } else {
                self.metricTileContent(
                    icon: icon,
                    title: title,
                    value: value,
                    detail: detail,
                    color: color,
                    showsChevron: false)
            }
        }
    }

    private func metricTileContent(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color,
        showsChevron: Bool) -> some View
    {
        ProCard(padding: 12) {
            VStack(alignment: .leading, spacing: 10) {
                HStack {
                    ProIconBadge(systemName: icon, color: color)
                    Spacer()
                    ProValuePill(value: value, color: color)
                    if showsChevron {
                        Image(systemName: "chevron.right")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(title)
                        .font(.caption.weight(.semibold))
                    Text(detail)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                        .multilineTextAlignment(.leading)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var emptyCronRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "clock.badge.questionmark", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.gatewayConnected ? "No scheduled jobs" : "Cron unavailable")
                    .font(.subheadline.weight(.semibold))
                Text(self.gatewayConnected
                    ? "The gateway has no visible cron jobs."
                    : "Connect a gateway to load scheduled work.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    private func cronJobRow(_ job: CronJob) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(
                systemName: job.enabled ? "clock.arrow.circlepath" : "pause.circle",
                color: job.enabled ? OpenClawBrand.accent : .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(job.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.cronJobDetail(job))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            Text(self.cronJobState(job))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(job.enabled ? OpenClawBrand.accent : .secondary)
                .lineLimit(1)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private var sortedAgents: [AgentSummary] {
        self.appModel.gatewayAgents.sorted { lhs, rhs in
            if lhs.id == self.activeAgentID { return true }
            if rhs.id == self.activeAgentID { return false }
            return self.agentName(for: lhs)
                .localizedCaseInsensitiveCompare(self.agentName(for: rhs)) == .orderedAscending
        }
    }

    private var activeAgentID: String {
        self.normalized(self.appModel.selectedAgentId)
            ?? self.normalized(self.appModel.gatewayDefaultAgentId)
            ?? "main"
    }

    private var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var overviewTaskID: String {
        [
            self.gatewayConnected ? "connected" : "offline",
            self.appModel.isOperatorGatewayConnected ? "operator" : "no-operator",
            self.activeAgentID,
            self.scenePhase == .active ? "active" : "inactive",
            "\(self.overviewRefreshNonce)",
        ].joined(separator: ":")
    }

    private var skillsValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let skills = self.overview?.skills else {
            return self.overviewLoading ? "..." : "live"
        }
        return "\(skills.enabledCount)/\(skills.totalCount)"
    }

    private var skillsDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load skills." }
        guard let skills = self.overview?.skills else {
            return self.overviewLoading ? "Loading skill status." : "Skill status is available from the gateway."
        }
        if skills.blockedCount > 0 {
            return "\(skills.enabledCount) enabled, \(skills.blockedCount) blocked"
        }
        if skills.missingRequirementCount > 0 {
            return "\(skills.enabledCount) enabled, \(skills.missingRequirementCount) need setup"
        }
        return "\(skills.enabledCount) enabled, \(skills.totalCount) installed"
    }

    private var instancesValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let count = self.overview?.presence.count else {
            return self.overviewLoading ? "..." : "live"
        }
        return "\(count)"
    }

    private var instancesDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load instances." }
        guard let presence = self.overview?.presence else {
            return self.overviewLoading ? "Loading instance presence." : "Instance presence is available."
        }
        let labels = presence.prefix(2).compactMap(self.presenceLabel)
        if labels.isEmpty {
            return "No live instances reported."
        }
        return labels.joined(separator: ", ")
    }

    private var instancesColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return (self.overview?.presence.isEmpty == false) ? OpenClawBrand.accent : .secondary
    }

    private var cronValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let cronStatus = self.overview?.cronStatus else {
            return self.overviewLoading ? "..." : "live"
        }
        return cronStatus.enabled ? "\(cronStatus.jobs)" : "off"
    }

    private var cronDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load cron." }
        guard let cronStatus = self.overview?.cronStatus else {
            return self.overviewLoading ? "Loading cron status." : "Cron status is available."
        }
        if let nextWakeAtMs = cronStatus.nextwakeatms {
            return "Next wake \(Self.relativeTime(fromMilliseconds: nextWakeAtMs))"
        }
        return cronStatus.enabled ? "Scheduler enabled" : "Scheduler disabled"
    }

    private var cronColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return self.overview?.cronStatus?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    private var usageValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let usage = self.overview?.usage else {
            return self.overviewLoading ? "..." : "7d"
        }
        if let cost = usage.totalCost {
            return Self.currency(cost)
        }
        if let tokens = usage.totalTokens, tokens > 0 {
            return Self.compactNumber(tokens)
        }
        return "7d"
    }

    private var usageDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load usage." }
        guard let usage = self.overview?.usage else {
            return self.overviewLoading ? "Loading recent usage." : "Recent usage is available."
        }
        if let tokens = usage.totalTokens, tokens > 0 {
            return "\(Self.compactNumber(tokens)) tokens in \(usage.days ?? 7)d"
        }
        return "No token usage reported for \(usage.days ?? 7)d."
    }

    private var dreamingValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let dreaming = self.overview?.dreaming else {
            return self.overviewLoading ? "..." : "live"
        }
        return dreaming.enabled ? "on" : "off"
    }

    private var dreamingDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load dreaming." }
        guard let dreaming = self.overview?.dreaming else {
            return self.overviewLoading ? "Loading dreaming status." : "Background memory status is available."
        }
        if let nextRunAtMs = dreaming.nextRunAtMs {
            return "Next cycle \(Self.relativeTime(fromMilliseconds: nextRunAtMs))"
        }
        return "\(dreaming.totalSignalCount ?? 0) signals, \(dreaming.promotedToday ?? 0) promoted today"
    }

    private var dreamingColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return self.overview?.dreaming?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    private var recentCronJobs: [CronJob] {
        (self.overview?.cronJobs ?? [])
            .sorted { lhs, rhs in
                let lhsNext = AgentProValueReader.intValue(lhs.state["nextRunAtMs"])
                let rhsNext = AgentProValueReader.intValue(rhs.state["nextRunAtMs"])
                switch (lhsNext, rhsNext) {
                case let (lhsNext?, rhsNext?): return lhsNext < rhsNext
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return lhs.updatedatms > rhs.updatedatms
                }
            }
            .prefix(4)
            .map(\.self)
    }
}

extension AgentProTab {
    @ViewBuilder
    private func destination(for route: AgentRoute) -> some View {
        switch route {
        case .skills:
            self.skillsDestination
        case .nodes:
            self.nodesDestination
        case .cron:
            self.cronDestination
        case .usage:
            self.usageDestination
        case .dreaming:
            self.dreamingDestination
        }
    }

    private var skillsDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.detailSummaryCard(
                        icon: "sparkles",
                        title: "Skills",
                        value: self.skillsValue,
                        detail: self.skillsDetail,
                        color: self.gatewayConnected ? OpenClawBrand.accent : .secondary)
                    self.skillsPolicyControls
                    self.skillsFilterField
                    self.clawHubSearchCard
                    self.skillsList
                }
                .padding(.vertical, 18)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Skills")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var nodesDestination: some View {
        AgentProNodesDestination(
            overview: self.overview,
            gatewayConnected: self.gatewayConnected,
            agentCount: self.appModel.gatewayAgents.count,
            instancesValue: self.instancesValue,
            instancesDetail: self.instancesDetail,
            instancesColor: self.instancesColor,
            refresh: {
                await self.refreshOverview(force: true)
            })
    }

    private var cronDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.detailSummaryCard(
                        icon: "clock.arrow.circlepath",
                        title: "Cron Jobs",
                        value: self.cronValue,
                        detail: self.cronDetail,
                        color: self.cronColor)
                    self.cronStatusCard
                    self.cronJobsList(limit: nil)
                }
                .padding(.vertical, 18)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Cron Jobs")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var usageDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.detailSummaryCard(
                        icon: "chart.line.uptrend.xyaxis",
                        title: "Usage",
                        value: self.usageValue,
                        detail: self.usageDetail,
                        color: self.gatewayConnected ? OpenClawBrand.accent : .secondary)
                    self.usageTotalsCard
                    self.usageDailyList
                }
                .padding(.vertical, 18)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Usage")
        .navigationBarTitleDisplayMode(.inline)
    }

    private var dreamingDestination: some View {
        AgentProDreamingDestination(
            overview: self.overview,
            gatewayConnected: self.gatewayConnected,
            overviewLoading: self.overviewLoading,
            dreamingValue: self.dreamingValue,
            dreamingDetail: self.dreamingDetail,
            dreamingColor: self.dreamingColor,
            refresh: {
                await self.refreshOverview(force: true)
            })
    }

    private func detailSummaryCard(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color) -> some View
    {
        ProCard {
            HStack(spacing: 12) {
                ProIconBadge(systemName: icon, color: color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(title)
                        .font(.headline)
                    Text(detail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer(minLength: 8)
                ProValuePill(value: value, color: color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var skillsPolicyControls: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .firstTextBaseline) {
                    VStack(alignment: .leading, spacing: 3) {
                        Text(self.activeAgentName)
                            .font(.headline)
                        Text(self.skillPolicySummary)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    ProValuePill(
                        value: self.agentSkillFilter == nil ? "all" : "\(self.agentSkillFilter?.count ?? 0)",
                        color: OpenClawBrand.accent)
                }

                HStack(spacing: 8) {
                    Button("Enable All") {
                        Task { await self.enableAllSkills() }
                    }
                    .disabled(self.skillMutationBusy)

                    Button("Disable All", role: .destructive) {
                        Task { await self.disableAllSkills() }
                    }
                    .disabled(self.skillMutationBusy)

                    Button("Reset") {
                        Task { await self.resetSkillPolicy() }
                    }
                    .disabled(self.skillMutationBusy || self.agentSkillFilter == nil)
                }
                .buttonStyle(.bordered)
                .controlSize(.small)

                if let skillMutationStatusText {
                    Text(skillMutationStatusText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.accent)
                }
                if let skillMutationErrorText {
                    Text(skillMutationErrorText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var skillsFilterField: some View {
        ProCard(padding: 10) {
            VStack(alignment: .leading, spacing: 10) {
                HStack(spacing: 10) {
                    Image(systemName: "magnifyingglass")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    TextField("Search skills", text: self.$skillFilter)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                        .font(.subheadline)
                    if !self.skillFilter.isEmpty {
                        Button {
                            self.skillFilter = ""
                        } label: {
                            Image(systemName: "xmark.circle.fill")
                                .foregroundStyle(.secondary)
                        }
                        .buttonStyle(.plain)
                    }
                }
                Picker("Status", selection: self.$skillStatusFilter) {
                    ForEach(SkillStatusFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .controlSize(.small)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var clawHubSearchCard: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack(spacing: 10) {
                    ProIconBadge(systemName: "square.and.arrow.down", color: OpenClawBrand.accent)
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Install Skills")
                            .font(.headline)
                        Text("Search ClawHub and install into this workspace.")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    Spacer(minLength: 8)
                    Button {
                        Task { await self.searchClawHubSkills() }
                    } label: {
                        Image(systemName: "magnifyingglass")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(self.clawHubLoading || !self.gatewayConnected)
                    .accessibilityLabel("Search ClawHub")
                }

                TextField("Search ClawHub", text: self.$clawHubQuery)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.subheadline)
                    .submitLabel(.search)
                    .onSubmit {
                        Task { await self.searchClawHubSkills() }
                    }

                if self.clawHubLoading {
                    ProgressView()
                        .controlSize(.small)
                }
                if let clawHubErrorText {
                    Text(clawHubErrorText)
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                }
                if !self.clawHubResults.isEmpty {
                    VStack(spacing: 0) {
                        let results = Array(self.clawHubResults.prefix(8))
                        ForEach(Array(results.enumerated()), id: \.element.slug) { index, result in
                            self.clawHubResultRow(result)
                            if index < results.count - 1 {
                                Divider().padding(.leading, 42)
                            }
                        }
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func clawHubResultRow(_ result: ClawHubSearchResultLite) -> some View {
        let installing = self.clawHubInstallSlug == result.slug
        return HStack(alignment: .top, spacing: 10) {
            ProIconBadge(systemName: "sparkles", color: OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(result.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(result.summary ?? result.slug)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            Button {
                Task { await self.installClawHubSkill(result) }
            } label: {
                Image(systemName: installing ? "hourglass" : "square.and.arrow.down")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .disabled(installing || !self.skillConfigBusyKeys.isEmpty)
            .accessibilityLabel("Install \(result.displayName)")
        }
        .padding(.vertical, 10)
    }

    private var skillsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Installed Skills")
            ProCard(padding: 0) {
                let skills = self.filteredSkills
                if skills.isEmpty {
                    self.emptyDetailRow(
                        icon: "sparkles",
                        title: self.gatewayConnected ? "No skills found" : "Skills unavailable",
                        detail: self.gatewayConnected
                            ? "Try a different search or refresh from the gateway."
                            : "Connect a gateway to load workspace skills.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(skills.enumerated()), id: \.element.name) { index, skill in
                            self.skillRow(skill)
                            if index < skills.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var activeAgentName: String {
        if let agent = self.appModel.gatewayAgents.first(where: { $0.id == self.activeAgentID }) {
            return self.agentName(for: agent)
        }
        return self.activeAgentID
    }

    private var agentSkillFilter: Set<String>? {
        self.overview?.agentSkillFilter.map { Set($0) }
    }

    private var skillPolicySummary: String {
        guard self.gatewayConnected else { return "Connect a gateway to edit skills." }
        guard let filter = self.agentSkillFilter else {
            return "All available skills are allowed for this agent."
        }
        if filter.isEmpty {
            return "No skills are allowed for this agent."
        }
        return "\(filter.count) skills are allowed for this agent."
    }

    private var skillMutationBusy: Bool {
        !self.skillMutationBusyKeys.isEmpty
    }

    private var filteredSkills: [SkillStatusEntryLite] {
        let skills = self.overview?.skills?.skills ?? []
        let filter = self.skillFilter.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return skills
            .filter { skill in
                self.matchesSkillStatusFilter(skill)
            }
            .filter { skill in
                guard !filter.isEmpty else { return true }
                return [
                    skill.name,
                    skill.description,
                    skill.source,
                ].compactMap(\.self)
                    .joined(separator: " ")
                    .lowercased()
                    .contains(filter)
            }
            .sorted(by: self.sortSkills)
    }

    private func matchesSkillStatusFilter(_ skill: SkillStatusEntryLite) -> Bool {
        switch self.skillStatusFilter {
        case .all:
            true
        case .enabled:
            self.skillStatus(skill).text == "enabled"
        case .off:
            !self.isSkillAllowed(skill) || skill.blockedByAgentFilter == true
        case .setup:
            skill.hasMissingRequirements
        case .blocked:
            skill.blockedByAllowlist == true
        }
    }

    private func sortSkills(_ lhs: SkillStatusEntryLite, _ rhs: SkillStatusEntryLite) -> Bool {
        let lhsEnabled = self.isSkillAllowed(lhs)
        let rhsEnabled = self.isSkillAllowed(rhs)
        if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    private func skillRow(_ skill: SkillStatusEntryLite) -> some View {
        let status = self.skillStatus(skill)
        let busy = self.skillMutationBusyKeys.contains(skill.name)
        return HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.isSkillAllowed(skill) ? "checkmark.circle" : "nosign", color: status.color)
            VStack(alignment: .leading, spacing: 4) {
                Text(skill.displayName)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.normalized(skill.description) ?? self.normalized(skill.source) ?? "Workspace skill")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                if let missing = skill.missingSummary {
                    Text("Missing: \(missing)")
                        .font(.caption2)
                        .foregroundStyle(OpenClawBrand.warn)
                        .lineLimit(1)
                }
                if let install = skill.installSummary {
                    Text("Setup: \(install)")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                self.skillToggle(skill, title: status.text)
                HStack(spacing: 6) {
                    if self.canInstallSkillRequirements(skill) {
                        Button {
                            Task { await self.installSkillRequirements(skill) }
                        } label: {
                            Image(systemName: "wrench.and.screwdriver")
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                        .disabled(self.isSkillConfigBusy(skill))
                        .accessibilityLabel("Set up \(skill.displayName)")
                    }
                    Button {
                        self.openSkillEditor(skill)
                    } label: {
                        Image(systemName: "slider.horizontal.3")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.mini)
                    .accessibilityLabel("Edit \(skill.displayName)")
                }
                Text(busy ? "saving" : status.text)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(status.color)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private func skillToggle(_ skill: SkillStatusEntryLite, title: String) -> some View {
        Toggle(
            title,
            isOn: Binding(
                get: { self.isSkillAllowed(skill) },
                set: { enabled in
                    Task { await self.setSkillAllowed(skill, enabled: enabled) }
                }))
                .labelsHidden()
                .disabled(self.skillMutationBusy)
                .toggleStyle(.switch)
                .controlSize(.mini)
    }

    private func isSkillAllowed(_ skill: SkillStatusEntryLite) -> Bool {
        guard let filter = self.agentSkillFilter else { return true }
        return filter.contains(skill.name)
    }

    private func isSkillConfigBusy(_ skill: SkillStatusEntryLite) -> Bool {
        self.skillConfigBusyKeys.contains(skill.effectiveSkillKey)
            || self.clawHubInstallSlug != nil
    }

    private func canInstallSkillRequirements(_ skill: SkillStatusEntryLite) -> Bool {
        skill.install?.first?.id?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && !skill.missingBins.isEmpty
    }

    private func skillByKey(_ key: String) -> SkillStatusEntryLite? {
        (self.overview?.skills?.skills ?? []).first { skill in
            skill.effectiveSkillKey == key || skill.name == key
        }
    }

    private func openSkillEditor(_ skill: SkillStatusEntryLite) {
        self.skillEditorSelection = SkillEditorSelection(id: skill.effectiveSkillKey)
    }

    private func skillAPIKeyBinding(for skill: SkillStatusEntryLite) -> Binding<String> {
        Binding(
            get: { self.skillAPIKeyDrafts[skill.effectiveSkillKey] ?? "" },
            set: { self.skillAPIKeyDrafts[skill.effectiveSkillKey] = $0 })
    }

    private var missingSkillEditorSheet: some View {
        NavigationStack {
            ContentUnavailableView("Skill unavailable", systemImage: "sparkles")
                .navigationTitle("Skill")
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Close") {
                            self.skillEditorSelection = nil
                        }
                    }
                }
        }
    }

    private func skillEditorSheet(_ skill: SkillStatusEntryLite) -> some View {
        NavigationStack {
            ZStack {
                OpenClawProBackground()
                ScrollView {
                    VStack(alignment: .leading, spacing: 16) {
                        self.skillEditorHeader(skill)
                        self.skillEditorControls(skill)
                        self.skillEditorSetup(skill)
                        self.skillEditorMetadata(skill)
                    }
                    .padding(.vertical, 18)
                }
            }
            .navigationTitle(skill.displayName)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Close") {
                        self.skillEditorSelection = nil
                    }
                }
            }
        }
    }

    private func skillEditorHeader(_ skill: SkillStatusEntryLite) -> some View {
        let status = self.skillStatus(skill)
        return ProCard {
            HStack(spacing: 12) {
                ProIconBadge(
                    systemName: skill.isGloballyEnabled ? "checkmark.circle" : "pause.circle",
                    color: status.color)
                VStack(alignment: .leading, spacing: 3) {
                    Text(skill.displayName)
                        .font(.headline)
                    Text(self.normalized(skill.description) ?? self.normalized(skill.source) ?? "Workspace skill")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)
                }
                Spacer(minLength: 8)
                ProValuePill(value: status.text, color: status.color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func skillEditorControls(_ skill: SkillStatusEntryLite) -> some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                Toggle(
                    "Enabled globally",
                    isOn: Binding(
                        get: { skill.isGloballyEnabled },
                        set: { enabled in
                            Task { await self.updateSkillGlobalEnabled(skill, enabled: enabled) }
                        }))
                        .disabled(self.isSkillConfigBusy(skill))

                if let primaryEnv = skill.primaryEnv, !primaryEnv.isEmpty {
                    VStack(alignment: .leading, spacing: 8) {
                        Text("API key")
                            .font(.subheadline.weight(.semibold))
                        SecureField(primaryEnv, text: self.skillAPIKeyBinding(for: skill))
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                        Button {
                            Task { await self.saveSkillAPIKey(skill) }
                        } label: {
                            Label("Save key", systemImage: "key")
                        }
                        .buttonStyle(.borderedProminent)
                        .controlSize(.small)
                        .disabled(self.isSkillConfigBusy(skill))
                        if let homepage = skill.homepageURL {
                            Link("Get key", destination: homepage)
                                .font(.caption)
                        }
                    }
                }

                if let message = self.skillConfigMessages[skill.effectiveSkillKey] {
                    Text(message.text)
                        .font(.caption2)
                        .foregroundStyle(message.kind == .success ? OpenClawBrand.accent : OpenClawBrand.warn)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func skillEditorSetup(_ skill: SkillStatusEntryLite) -> some View {
        ProCard {
            VStack(alignment: .leading, spacing: 10) {
                Text("Setup")
                    .font(.headline)
                if let missing = skill.missingSummary {
                    Text("Missing: \(missing)")
                        .font(.caption)
                        .foregroundStyle(OpenClawBrand.warn)
                } else {
                    Text("No missing requirements reported.")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let install = skill.install?.first {
                    Button {
                        Task { await self.installSkillRequirements(skill) }
                    } label: {
                        Label(install.label, systemImage: "wrench.and.screwdriver")
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.small)
                    .disabled(self.isSkillConfigBusy(skill) || install.id == nil)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private func skillEditorMetadata(_ skill: SkillStatusEntryLite) -> some View {
        ProCard {
            VStack(alignment: .leading, spacing: 8) {
                self.detailMetric(label: "Key", value: skill.effectiveSkillKey)
                self.detailMetric(label: "Source", value: self.normalized(skill.source) ?? "unknown")
                if let filePath = self.normalized(skill.filePath) {
                    Text(filePath)
                        .font(.caption2.monospaced())
                        .foregroundStyle(.secondary)
                        .textSelection(.enabled)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    @MainActor
    private func setSkillAllowed(_ skill: SkillStatusEntryLite, enabled: Bool) async {
        let allNames = self.allSkillNames
        guard !allNames.isEmpty else { return }
        let base = self.agentSkillFilter ?? Set(allNames)
        var next = base
        if enabled {
            next.insert(skill.name)
        } else {
            next.remove(skill.name)
        }
        await self.patchAgentSkills(Array(next).sorted(), busyKey: skill.name)
    }

    @MainActor
    private func enableAllSkills() async {
        let allNames = self.allSkillNames
        guard !allNames.isEmpty else { return }
        await self.patchAgentSkills(allNames, busyKey: "__all__")
    }

    @MainActor
    private func disableAllSkills() async {
        await self.patchAgentSkills([], busyKey: "__all__")
    }

    @MainActor
    private func resetSkillPolicy() async {
        await self.patchAgentSkills(nil, busyKey: "__all__")
    }

    private var allSkillNames: [String] {
        (self.overview?.skills?.skills ?? [])
            .map(\.name)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted()
    }

    @MainActor
    private func patchAgentSkills(_ skills: [String]?, busyKey: String) async {
        guard self.gatewayConnected else { return }
        self.skillMutationBusyKeys.insert(busyKey)
        self.skillMutationErrorText = nil
        self.skillMutationStatusText = nil
        defer { self.skillMutationBusyKeys.remove(busyKey) }

        do {
            let config = try await self.requestConfigSnapshot()
            guard let baseHash = self.normalized(config.hash) else {
                throw SkillMutationError.missingConfigHash
            }
            if skills == nil,
               config.agentConfig(id: self.activeAgentID) == nil
            {
                self.skillMutationStatusText = "This agent already inherits the default skill policy."
                return
            }

            let raw = try Self.agentSkillsPatchRaw(agentId: self.activeAgentID, skills: skills)
            let params = ConfigPatchParams(raw: raw, baseHash: baseHash)
            let data = try JSONEncoder().encode(params)
            guard let json = String(data: data, encoding: .utf8) else {
                throw SkillMutationError.invalidPatchPayload
            }
            _ = try await self.appModel.operatorSession.request(
                method: "config.patch",
                paramsJSON: json,
                timeoutSeconds: 20)
            self.skillMutationStatusText = skills == nil ? "Skill policy reset." : "Skill policy saved."
            await self.appModel.refreshGatewayOverviewIfConnected()
            await self.refreshOverview(force: true)
        } catch {
            self.skillMutationErrorText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    private func updateSkillGlobalEnabled(_ skill: SkillStatusEntryLite, enabled: Bool) async {
        await self.runSkillConfigMutation(skill) {
            let params = SkillUpdateParams(skillKey: skill.effectiveSkillKey, enabled: enabled)
            _ = try await self.requestGateway(method: "skills.update", params: params, timeoutSeconds: 20)
            return enabled ? "Skill enabled." : "Skill disabled."
        }
    }

    @MainActor
    private func saveSkillAPIKey(_ skill: SkillStatusEntryLite) async {
        await self.runSkillConfigMutation(skill) {
            let apiKey = self.skillAPIKeyDrafts[skill.effectiveSkillKey] ?? ""
            let params = SkillUpdateParams(skillKey: skill.effectiveSkillKey, apiKey: apiKey)
            _ = try await self.requestGateway(method: "skills.update", params: params, timeoutSeconds: 20)
            self.skillAPIKeyDrafts[skill.effectiveSkillKey] = ""
            return apiKey.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                ? "API key cleared."
                : "API key saved."
        }
    }

    @MainActor
    private func installSkillRequirements(_ skill: SkillStatusEntryLite) async {
        guard let installId = skill.install?.first?.id?.trimmingCharacters(in: .whitespacesAndNewlines),
              !installId.isEmpty
        else { return }
        await self.runSkillConfigMutation(skill) {
            let params = SkillInstallParams(name: skill.name, installId: installId, timeoutMs: 120_000)
            let data = try await self.requestGateway(
                method: "skills.install",
                params: params,
                timeoutSeconds: 125)
            return (try? JSONDecoder().decode(SkillInstallResultLite.self, from: data).message) ?? "Installed."
        }
    }

    @MainActor
    private func installClawHubSkill(_ result: ClawHubSearchResultLite) async {
        guard self.gatewayConnected else { return }
        self.clawHubInstallSlug = result.slug
        self.clawHubErrorText = nil
        defer { self.clawHubInstallSlug = nil }
        do {
            let params = ClawHubInstallParams(slug: result.slug)
            _ = try await self.requestGateway(method: "skills.install", params: params, timeoutSeconds: 125)
            await self.appModel.refreshGatewayOverviewIfConnected()
            await self.refreshOverview(force: true)
        } catch {
            self.clawHubErrorText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    private func searchClawHubSkills() async {
        guard self.gatewayConnected else { return }
        self.clawHubLoading = true
        self.clawHubErrorText = nil
        defer { self.clawHubLoading = false }
        do {
            let query = self.clawHubQuery.trimmingCharacters(in: .whitespacesAndNewlines)
            let params = ClawHubSearchParams(query: query.isEmpty ? nil : query, limit: 20)
            let data = try await self.requestGateway(method: "skills.search", params: params, timeoutSeconds: 20)
            self.clawHubResults = try JSONDecoder().decode(ClawHubSearchResponseLite.self, from: data).results
        } catch {
            self.clawHubErrorText = Self.skillMutationMessage(error)
        }
    }

    @MainActor
    private func runSkillConfigMutation(
        _ skill: SkillStatusEntryLite,
        action: () async throws -> String) async
    {
        let key = skill.effectiveSkillKey
        self.skillConfigBusyKeys.insert(key)
        self.skillConfigMessages[key] = nil
        defer { self.skillConfigBusyKeys.remove(key) }

        do {
            let message = try await action()
            self.skillConfigMessages[key] = SkillEditorMessage(kind: .success, text: message)
            await self.appModel.refreshGatewayOverviewIfConnected()
            await self.refreshOverview(force: true)
        } catch {
            self.skillConfigMessages[key] = SkillEditorMessage(
                kind: .error,
                text: Self.skillMutationMessage(error))
        }
    }

    private func requestGateway(
        method: String,
        params: some Encodable,
        timeoutSeconds: Int) async throws -> Data
    {
        let data = try JSONEncoder().encode(params)
        guard let json = String(data: data, encoding: .utf8) else {
            throw SkillMutationError.invalidPatchPayload
        }
        return try await self.appModel.operatorSession.request(
            method: method,
            paramsJSON: json,
            timeoutSeconds: timeoutSeconds)
    }

    private func requestConfigSnapshot() async throws -> ConfigSnapshotLite {
        let data = try await self.appModel.operatorSession.request(
            method: "config.get",
            paramsJSON: "{}",
            timeoutSeconds: 12)
        return try JSONDecoder().decode(ConfigSnapshotLite.self, from: data)
    }

    private static func agentSkillsPatchRaw(agentId: String, skills: [String]?) throws -> String {
        let skillValue: Any = skills ?? NSNull()
        let patch: [String: Any] = [
            "agents": [
                "list": [
                    [
                        "id": agentId,
                        "skills": skillValue,
                    ],
                ],
            ],
        ]
        let data = try JSONSerialization.data(withJSONObject: patch, options: [.sortedKeys])
        guard let raw = String(data: data, encoding: .utf8) else {
            throw SkillMutationError.invalidPatchPayload
        }
        return raw
    }

    private static func skillMutationMessage(_ error: Error) -> String {
        if let gatewayError = error as? GatewayResponseError {
            let lower = gatewayError.message.lowercased()
            if lower.contains("operator.admin") || lower.contains("unauthorized") {
                return "This gateway connection cannot edit config yet. Reconnect with admin scope."
            }
            return gatewayError.message
        }
        return error.localizedDescription
    }

    private func skillStatus(_ skill: SkillStatusEntryLite) -> (text: String, color: Color) {
        if !self.isSkillAllowed(skill) {
            return ("off", .secondary)
        }
        if skill.blockedByAllowlist == true {
            return ("blocked", .secondary)
        }
        if skill.blockedByAgentFilter == true {
            return ("off", .secondary)
        }
        if skill.disabled == true {
            return ("disabled", .secondary)
        }
        if skill.hasMissingRequirements {
            return ("setup", OpenClawBrand.warn)
        }
        return ("enabled", OpenClawBrand.accent)
    }

    private var cronStatusCard: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Scheduler")
                        .font(.headline)
                    Spacer()
                    ProValuePill(
                        value: self.overview?.cronStatus?.enabled == true ? "on" : "off",
                        color: self.cronColor)
                }
                HStack(spacing: 10) {
                    let jobCount = self.overview?.cronStatus?.jobs
                        ?? self.overview?.cronJobs.count
                        ?? 0
                    self.detailMetric(label: "Jobs", value: "\(jobCount)")
                    self.detailMetric(label: "Next", value: self.cronNextRunLabel)
                }
                if let cronActionStatusText {
                    Text(cronActionStatusText)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var cronNextRunLabel: String {
        guard let nextWakeAtMs = self.overview?.cronStatus?.nextwakeatms else { return "none" }
        return Self.relativeTime(fromMilliseconds: nextWakeAtMs)
    }

    private func cronJobsList(limit: Int?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Jobs")
            ProCard(padding: 0) {
                let jobs = self.sortedCronJobs
                let visible = limit.map { Array(jobs.prefix($0)) } ?? jobs
                if visible.isEmpty {
                    self.emptyCronRow
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(visible.enumerated()), id: \.element.id) { index, job in
                            self.cronJobDetailRow(job)
                            if index < visible.count - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private var sortedCronJobs: [CronJob] {
        (self.overview?.cronJobs ?? [])
            .sorted { lhs, rhs in
                let lhsNext = AgentProValueReader.intValue(lhs.state["nextRunAtMs"])
                let rhsNext = AgentProValueReader.intValue(rhs.state["nextRunAtMs"])
                switch (lhsNext, rhsNext) {
                case let (lhsNext?, rhsNext?): return lhsNext < rhsNext
                case (_?, nil): return true
                case (nil, _?): return false
                case (nil, nil): return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
                }
            }
    }

    private func cronJobDetailRow(_ job: CronJob) -> some View {
        let busy = self.cronActionBusyIDs.contains(job.id)
        return HStack(alignment: .top, spacing: 12) {
            ProIconBadge(
                systemName: job.enabled ? "clock.arrow.circlepath" : "pause.circle",
                color: job.enabled ? OpenClawBrand.accent : .secondary)
            VStack(alignment: .leading, spacing: 4) {
                Text(job.name)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.cronJobDetail(job))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(self.cronScheduleSummary(job))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    Button {
                        Task { await self.runCronJob(job) }
                    } label: {
                        Label("Run", systemImage: "play.fill")
                    }
                    .disabled(busy || !self.gatewayConnected)

                    Button {
                        Task { await self.setCronJob(job, enabled: !job.enabled) }
                    } label: {
                        Label(job.enabled ? "Pause" : "Enable", systemImage: job.enabled ? "pause.fill" : "checkmark")
                    }
                    .disabled(busy || !self.gatewayConnected)
                }
                .buttonStyle(.bordered)
                .controlSize(.mini)
            }
            Spacer(minLength: 8)
            if busy {
                ProgressView()
                    .progressViewStyle(.circular)
                    .controlSize(.small)
            } else {
                Text(self.cronJobState(job))
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(job.enabled ? OpenClawBrand.accent : .secondary)
                    .lineLimit(1)
            }
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    @MainActor
    private func runCronJob(_ job: CronJob) async {
        await self.runCronAction(job, success: "Queued \(job.name).") {
            let params = CronRunParams(id: job.id, mode: "force")
            _ = try await self.requestGateway(method: "cron.run", params: params, timeoutSeconds: 20)
        }
    }

    @MainActor
    private func setCronJob(_ job: CronJob, enabled: Bool) async {
        await self.runCronAction(job, success: enabled ? "Enabled \(job.name)." : "Paused \(job.name).") {
            let params = CronUpdateParams(id: job.id, patch: CronUpdatePatch(enabled: enabled))
            _ = try await self.requestGateway(method: "cron.update", params: params, timeoutSeconds: 20)
        }
    }

    @MainActor
    private func runCronAction(
        _ job: CronJob,
        success: String,
        action: () async throws -> Void) async
    {
        guard self.gatewayConnected else { return }
        self.cronActionBusyIDs.insert(job.id)
        self.cronActionStatusText = nil
        defer { self.cronActionBusyIDs.remove(job.id) }
        do {
            try await action()
            self.cronActionStatusText = success
            await self.refreshOverview(force: true)
        } catch {
            self.cronActionStatusText = Self.skillMutationMessage(error)
        }
    }

    private func cronScheduleSummary(_ job: CronJob) -> String {
        guard let schedule = job.schedule.value as? [String: AnyCodable] else { return "Schedule configured" }
        if let expr = Self.stringValue(schedule["expr"]) {
            return "Cron \(expr)"
        }
        if let everyMs = AgentProValueReader.intValue(schedule["everyMs"]) {
            return "Every \(Self.duration(milliseconds: everyMs))"
        }
        if let kind = Self.stringValue(schedule["kind"]) {
            return kind
        }
        return "Schedule configured"
    }

    private var usageTotalsCard: some View {
        ProCard {
            VStack(alignment: .leading, spacing: 12) {
                HStack {
                    Text("Totals")
                        .font(.headline)
                    Spacer()
                    ProValuePill(value: "\(self.overview?.usage?.days ?? 31)d", color: OpenClawBrand.accent)
                }
                HStack(spacing: 10) {
                    self.detailMetric(label: "Cost", value: self.usageValue)
                    self.detailMetric(label: "Tokens", value: self.usageTokenValue)
                    self.detailMetric(label: "Cache", value: self.usageCacheValue)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var usageTokenValue: String {
        guard let tokens = self.overview?.usage?.totalTokens else { return "0" }
        return Self.compactNumber(tokens)
    }

    private var usageCacheValue: String {
        guard let cacheStatus = self.normalized(self.overview?.usage?.cacheStatus?["status"]?.value as? String) else {
            return "n/a"
        }
        return cacheStatus
    }

    private var usageDailyList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Daily")
            ProCard(padding: 0) {
                let days = self.overview?.usage?.daily ?? []
                if days.isEmpty {
                    self.emptyDetailRow(
                        icon: "chart.bar",
                        title: "No daily usage yet",
                        detail: "The gateway returned totals without daily session cost rows.")
                        .padding(14)
                } else {
                    VStack(spacing: 0) {
                        ForEach(Array(days.prefix(14).enumerated()), id: \.element.date) { index, day in
                            self.usageDayRow(day)
                            if index < min(days.count, 14) - 1 {
                                Divider().padding(.leading, 60)
                            }
                        }
                    }
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    private func usageDayRow(_ day: CostUsageDailyEntryLite) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "calendar", color: OpenClawBrand.accent)
            VStack(alignment: .leading, spacing: 3) {
                Text(day.date)
                    .font(.subheadline.weight(.semibold))
                Text("\(Self.compactNumber(day.totalTokens ?? 0)) tokens")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            Text(Self.currency(day.totalCost ?? 0))
                .font(.caption2.weight(.semibold))
                .foregroundStyle(OpenClawBrand.accent)
        }
        .padding(.vertical, 10)
        .padding(.horizontal, 14)
    }

    private func detailMetric(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 3) {
            Text(label)
                .font(.caption2.weight(.medium))
                .foregroundStyle(.secondary)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(10)
        .background(Color.primary.opacity(0.055), in: RoundedRectangle(cornerRadius: 10, style: .continuous))
    }

    private func emptyDetailRow(icon: String, title: String, detail: String) -> some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: icon, color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(title)
                    .font(.subheadline.weight(.semibold))
                Text(detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
        }
    }

    private func agentName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    private func agentDetail(for agent: AgentSummary) -> String {
        let parts = [
            self.normalized(agent.workspace),
            self.modelLabel(for: agent),
            agent.id == self.appModel.gatewayDefaultAgentId ? "default" : nil,
        ].compactMap(\.self)
        return parts.isEmpty ? agent.id : parts.joined(separator: " • ")
    }

    private func modelLabel(for agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["name", "id", "model"] {
            if let value = model[key]?.value as? String,
               let normalized = self.normalized(value)
            {
                return normalized
            }
        }
        return nil
    }

    private func presenceLabel(_ entry: PresenceEntry) -> String? {
        self.normalized(entry.host)
            ?? self.normalized(entry.devicefamily)
            ?? self.normalized(entry.platform)
            ?? self.normalized(entry.mode)
    }

    private func cronJobDetail(_ job: CronJob) -> String {
        if let nextRunAtMs = AgentProValueReader.intValue(job.state["nextRunAtMs"]) {
            return "Next \(Self.relativeTime(fromMilliseconds: nextRunAtMs))"
        }
        if let description = self.normalized(job.description) {
            return description
        }
        if let agentId = self.normalized(job.agentid) {
            return agentId
        }
        return job.id
    }

    private func cronJobState(_ job: CronJob) -> String {
        if !job.enabled {
            return "paused"
        }
        if let status = Self.stringValue(job.state["lastStatus"]) ?? Self.stringValue(job.state["lastRunStatus"]) {
            return status
        }
        return "enabled"
    }

    @MainActor
    private func refreshOverview(force: Bool) async {
        guard self.scenePhase == .active else { return }
        guard self.appModel.isOperatorGatewayConnected else {
            self.overview = nil
            self.overviewErrorText = nil
            self.overviewLoading = false
            return
        }
        if self.overviewLoading, force == false {
            return
        }

        self.overviewLoading = true
        self.overviewErrorText = nil
        defer { self.overviewLoading = false }

        let activeAgentID = self.activeAgentID
        let skillsParams = Self.agentScopedParams(agentId: activeAgentID)
        async let skills = self.requestOptional(
            SkillStatusReportLite.self,
            method: "skills.status",
            paramsJSON: skillsParams)
        async let config = self.requestOptional(ConfigSnapshotLite.self, method: "config.get")
        async let presence = self.requestOptional([PresenceEntry].self, method: "system-presence")
        async let cronStatus = self.requestOptional(CronStatusLite.self, method: "cron.status")
        async let cronJobs = self.requestOptional(
            CronJobsListLite.self,
            method: "cron.list",
            paramsJSON: "{\"includeDisabled\":true,\"limit\":8,\"sortBy\":\"nextRunAtMs\",\"sortDir\":\"asc\"}",
            timeoutSeconds: 12)
        async let dreaming = self.requestOptional(DreamingStatusEnvelope.self, method: "doctor.memory.status")
        async let dreamDiary = self.requestOptional(DreamDiaryLite.self, method: "doctor.memory.dreamDiary")
        async let usage = self.requestOptional(
            CostUsageSummaryLite.self,
            method: "usage.cost",
            paramsJSON: "{\"days\":31}",
            timeoutSeconds: 12)

        let loadedSkills = await skills
        let loadedConfig = await config
        let loadedPresence = await presence
        let loadedCronStatus = await cronStatus
        let loadedCronJobs = await cronJobs
        let loadedDreaming = await dreaming
        let loadedDreamDiary = await dreamDiary
        let loadedUsage = await usage
        let snapshot = AgentOverviewSnapshot(
            skills: loadedSkills,
            presence: loadedPresence ?? [],
            cronStatus: loadedCronStatus,
            cronJobs: loadedCronJobs?.jobs ?? [],
            dreaming: loadedDreaming?.dreaming,
            dreamDiary: loadedDreamDiary,
            usage: loadedUsage,
            activeAgentId: activeAgentID,
            agentSkillFilter: loadedSkills?.agentSkillFilter
                ?? loadedConfig?.effectiveSkillFilter(agentId: activeAgentID),
            loadedAt: Date())

        if snapshot.hasAnyLiveData {
            self.overview = snapshot
        } else {
            self.overview = snapshot
            self.overviewErrorText = "Live overview could not load yet."
        }
    }

    private func requestOptional<T: Decodable>(
        _ type: T.Type,
        method: String,
        paramsJSON: String = "{}",
        timeoutSeconds: Int = 8) async -> T?
    {
        do {
            let data = try await self.appModel.operatorSession.request(
                method: method,
                paramsJSON: paramsJSON,
                timeoutSeconds: timeoutSeconds)
            return try JSONDecoder().decode(T.self, from: data)
        } catch {
            return nil
        }
    }

    private func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func stringValue(_ value: AnyCodable?) -> String? {
        guard let string = value?.value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    private static func relativeTime(fromMilliseconds milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    private static func compactNumber(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName))
    }

    private static func currency(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
    }

    private static func duration(milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    private static func agentScopedParams(agentId: String) -> String {
        guard let data = try? JSONEncoder().encode(["agentId": agentId]),
              let json = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return json
    }
}

private enum AgentProValueReader {
    static func intValue(_ value: AnyCodable?) -> Int? {
        switch value?.value {
        case let int as Int: int
        case let double as Double where double.isFinite: Int(double)
        case let string as String: Int(string)
        default: nil
        }
    }

    static func doubleValue(_ value: AnyCodable?) -> Double? {
        switch value?.value {
        case let double as Double where double.isFinite: double
        case let int as Int: Double(int)
        case let string as String: Double(string)
        default: nil
        }
    }
}

struct AgentOverviewSnapshot {
    fileprivate let skills: SkillStatusReportLite?
    let presence: [PresenceEntry]
    fileprivate let cronStatus: CronStatusLite?
    let cronJobs: [CronJob]
    let dreaming: DreamingStatusLite?
    let dreamDiary: DreamDiaryLite?
    fileprivate let usage: CostUsageSummaryLite?
    let activeAgentId: String
    let agentSkillFilter: [String]?
    let loadedAt: Date

    var hasAnyLiveData: Bool {
        self.skills != nil
            || !self.presence.isEmpty
            || self.cronStatus != nil
            || !self.cronJobs.isEmpty
            || self.dreaming != nil
            || self.dreamDiary != nil
            || self.usage != nil
    }
}

private struct SkillStatusReportLite: Decodable {
    let workspaceDir: String?
    let managedSkillsDir: String?
    let agentId: String?
    let agentSkillFilter: [String]?
    let skills: [SkillStatusEntryLite]

    var totalCount: Int {
        self.skills.count
    }

    var enabledCount: Int {
        self.skills.count {
            $0.isEnabled
        }
    }

    var blockedCount: Int {
        self.skills.count {
            $0.blockedByAllowlist == true || $0.blockedByAgentFilter == true
        }
    }

    var missingRequirementCount: Int {
        self.skills.count {
            $0.hasMissingRequirements
        }
    }
}

private struct SkillStatusEntryLite: Decodable {
    let name: String
    let description: String?
    let source: String?
    let filePath: String?
    let skillKey: String?
    let primaryEnv: String?
    let emoji: String?
    let homepage: String?
    let disabled: Bool?
    let blockedByAllowlist: Bool?
    let blockedByAgentFilter: Bool?
    let missing: SkillStatusMissingLite?
    let install: [SkillInstallOptionLite]?

    var displayName: String {
        if let emoji, !emoji.isEmpty {
            return "\(emoji) \(self.name)"
        }
        return self.name
    }

    var effectiveSkillKey: String {
        let trimmed = (self.skillKey ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? self.name : trimmed
    }

    var isGloballyEnabled: Bool {
        self.disabled != true
    }

    var isEnabled: Bool {
        self.disabled != true
            && self.blockedByAllowlist != true
            && self.blockedByAgentFilter != true
    }

    var hasMissingRequirements: Bool {
        guard let missing else { return false }
        return !missing.bins.isEmpty
            || !missing.env.isEmpty
            || !missing.config.isEmpty
            || !missing.os.isEmpty
    }

    var missingSummary: String? {
        guard let missing else { return nil }
        let values = [
            missing.bins,
            missing.env,
            missing.config,
            missing.os,
        ].flatMap(\.self)
        return values.isEmpty ? nil : values.prefix(3).joined(separator: ", ")
    }

    var installSummary: String? {
        guard let option = self.install?.first else { return nil }
        return option.label
    }

    var missingBins: [String] {
        self.missing?.bins ?? []
    }

    var homepageURL: URL? {
        guard let homepage else { return nil }
        return URL(string: homepage)
    }
}

private struct SkillInstallOptionLite: Decodable {
    let id: String?
    let kind: String?
    let label: String
    let bins: [String]?
}

private struct SkillUpdateParams: Encodable {
    let skillKey: String
    var enabled: Bool?
    var apiKey: String?
}

private struct SkillInstallParams: Encodable {
    let name: String
    let installId: String
    let timeoutMs: Int
}

private struct SkillInstallResultLite: Decodable {
    let message: String?
}

private struct ClawHubSearchParams: Encodable {
    let query: String?
    let limit: Int
}

private struct ClawHubSearchResponseLite: Decodable {
    let results: [ClawHubSearchResultLite]
}

private struct ClawHubSearchResultLite: Decodable {
    let slug: String
    let displayName: String
    let summary: String?
    let version: String?
}

private struct ClawHubInstallParams: Encodable {
    let source = "clawhub"
    let slug: String
}

private struct CronRunParams: Encodable {
    let id: String
    let mode: String
}

private struct CronUpdatePatch: Encodable {
    let enabled: Bool
}

private struct CronUpdateParams: Encodable {
    let id: String
    let patch: CronUpdatePatch
}

private struct SkillStatusMissingLite: Decodable {
    let bins: [String]
    let env: [String]
    let config: [String]
    let os: [String]
}

private struct CronStatusLite: Decodable {
    let enabled: Bool
    let jobs: Int
    let nextwakeatms: Int?

    private enum CodingKeys: String, CodingKey {
        case enabled
        case jobs
        case nextwakeatms = "nextWakeAtMs"
    }
}

private struct CronJobsListLite: Decodable {
    let jobs: [CronJob]
    let total: Int?
}

struct DreamingStatusEnvelope: Decodable {
    let dreaming: DreamingStatusLite?
}

struct DreamingStatusLite: Decodable {
    let enabled: Bool
    let shortTermCount: Int?
    let totalSignalCount: Int?
    let promotedToday: Int?
    let storeError: String?
    let shortTermEntries: [DreamingEntryLite]?
    let signalEntries: [DreamingEntryLite]?
    let promotedEntries: [DreamingEntryLite]?
    let phases: [String: DreamingPhaseStatusLite]?

    var nextRunAtMs: Int? {
        self.phases?.values
            .compactMap(\.nextRunAtMs)
            .min()
    }
}

struct DreamingEntryLite: Decodable, Identifiable {
    let key: String
    let path: String
    let startLine: Int
    let endLine: Int
    let snippet: String
    let recallCount: Int
    let dailyCount: Int
    let groundedCount: Int
    let totalSignalCount: Int
    let lightHits: Int
    let remHits: Int
    let phaseHitCount: Int
    let promotedAt: String?
    let lastRecalledAt: String?

    var id: String {
        "\(self.key):\(self.path):\(self.startLine):\(self.endLine)"
    }
}

struct DreamDiaryLite: Decodable {
    let agentId: String
    let found: Bool
    let path: String
    let content: String?
    let updatedAtMs: Int?
}

struct DreamingPhaseStatusLite: Decodable {
    let enabled: Bool?
    let cron: String?
    let managedCronPresent: Bool?
    let nextRunAtMs: Int?
}

struct DreamingPhaseRow: Identifiable {
    let id: String
    let title: String
    let status: DreamingPhaseStatusLite
}

private struct ConfigSnapshotLite: Decodable {
    let hash: String?
    let config: ConfigRootLite?

    func agentConfig(id: String) -> AgentConfigLite? {
        self.config?.agents?.list?.first { $0.id == id }
    }

    func effectiveSkillFilter(agentId: String) -> [String]? {
        if let agentSkills = self.agentConfig(id: agentId)?.skills {
            return agentSkills
        }
        return self.config?.agents?.defaults?.skills
    }
}

private struct ConfigRootLite: Decodable {
    let agents: AgentsConfigLite?
}

private struct AgentsConfigLite: Decodable {
    let defaults: AgentDefaultsConfigLite?
    let list: [AgentConfigLite]?
}

private struct AgentDefaultsConfigLite: Decodable {
    let skills: [String]?
}

private struct AgentConfigLite: Decodable {
    let id: String
    let skills: [String]?
}

private struct ConfigPatchParams: Encodable {
    let raw: String
    let baseHash: String
}

private enum SkillMutationError: LocalizedError {
    case missingConfigHash
    case invalidPatchPayload

    var errorDescription: String? {
        switch self {
        case .missingConfigHash:
            "Config hash missing; refresh and retry."
        case .invalidPatchPayload:
            "Could not encode the skill config update."
        }
    }
}

private struct CostUsageSummaryLite: Decodable {
    let updatedAt: Int?
    let days: Int?
    let daily: [CostUsageDailyEntryLite]?
    let totals: [String: AnyCodable]?
    let cacheStatus: [String: AnyCodable]?

    var totalCost: Double? {
        AgentProValueReader.doubleValue(self.totals?["totalCost"])
    }

    var totalTokens: Int? {
        AgentProValueReader.intValue(self.totals?["totalTokens"])
    }
}

private struct CostUsageDailyEntryLite: Decodable {
    let date: String
    let totalTokens: Int?
    let totalCost: Double?
}
