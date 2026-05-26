import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct AgentProTab: View {
    @Environment(NodeAppModel.self) var appModel
    @Environment(\.colorScheme) var colorScheme
    @Environment(\.scenePhase) var scenePhase
    @State var overview: AgentOverviewSnapshot?
    @State var overviewErrorText: String?
    @State var overviewLoading: Bool = false
    @State var overviewRefreshNonce: Int = 0
    @State var agentRosterFilter: AgentRosterFilter = .all
    @State var agentSearchPresented = false
    @State var agentSearchText = ""
    @State var skillFilter: String = ""
    @State var skillStatusFilter: SkillStatusFilter = .all
    @State var skillMutationBusyKeys: Set<String> = []
    @State var skillMutationErrorText: String?
    @State var skillMutationStatusText: String?
    @State var skillConfigBusyKeys: Set<String> = []
    @State var skillConfigMessages: [String: SkillEditorMessage] = [:]
    @State var skillAPIKeyDrafts: [String: String] = [:]
    @State var skillEditorSelection: SkillEditorSelection?
    @State var clawHubQuery: String = ""
    @State var clawHubResults: [ClawHubSearchResultLite] = []
    @State var clawHubLoading: Bool = false
    @State var clawHubErrorText: String?
    @State var clawHubInstallSlug: String?
    @State var cronActionBusyIDs: Set<String> = []
    @State var cronActionStatusText: String?

    enum AgentRoute: Hashable {
        case skills
        case nodes
        case cron
        case usage
        case dreaming
    }

    enum SkillStatusFilter: String, CaseIterable, Identifiable {
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

    enum AgentRosterFilter: String, CaseIterable, Identifiable {
        case all
        case online
        case busy
        case idle

        var id: Self {
            self
        }

        var title: String {
            switch self {
            case .all: "All"
            case .online: "Online"
            case .busy: "Busy"
            case .idle: "Idle"
            }
        }
    }

    enum AgentLayout {
        static let cardRadius: CGFloat = 12
        static let filterHeight: CGFloat = 34
        static let rowMinHeight: CGFloat = 104
        static let metricTileHeight: CGFloat = 94
        static let actionButtonSize: CGFloat = 34
    }

    enum AgentRosterState: Equatable {
        case online
        case busy
        case idle

        var title: String {
            switch self {
            case .online: "Online"
            case .busy: "Busy"
            case .idle: "Idle"
            }
        }

        var color: Color {
            switch self {
            case .online: OpenClawBrand.ok
            case .busy: OpenClawBrand.warn
            case .idle: Color(red: 0 / 255.0, green: 122 / 255.0, blue: 255 / 255.0)
            }
        }
    }

    struct SkillEditorSelection: Identifiable {
        let id: String
    }

    struct SkillEditorMessage {
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
                        self.rosterHeader
                        self.agentFilters
                        self.agentsSection
                        self.operationsSection
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
            .navigationBarHidden(true)
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

    var rosterHeader: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 3) {
                    Text("Agents")
                        .font(.system(size: 28, weight: .bold))
                    Text("\(self.sortedAgents.count) total")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 8)

                HStack(spacing: 10) {
                    self.headerIconButton(
                        systemName: "magnifyingglass",
                        label: "Search agents",
                        action: {
                            withAnimation(.snappy(duration: 0.18)) {
                                self.agentSearchPresented.toggle()
                            }
                        })
                    self.headerIconButton(
                        systemName: "arrow.clockwise",
                        label: self.overviewLoading ? "Refreshing agents" : "Refresh agents",
                        action: {
                            self.overviewRefreshNonce += 1
                        })
                }
                .padding(.top, 2)
            }

            if self.agentSearchPresented {
                TextField("Search agents", text: self.$agentSearchText)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                    .font(.subheadline)
                    .padding(.horizontal, 12)
                    .frame(height: 38)
                    .background {
                        Capsule()
                            .fill(self.searchFieldFill)
                            .overlay {
                                Capsule().strokeBorder(self.searchFieldStroke, lineWidth: 1)
                            }
                    }
                    .transition(.move(edge: .top).combined(with: .opacity))
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
        .padding(.top, 6)
    }

    var agentFilters: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(AgentRosterFilter.allCases) { filter in
                    Button {
                        withAnimation(.snappy(duration: 0.18)) {
                            self.agentRosterFilter = filter
                        }
                    } label: {
                        Text(filter.title)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(self.agentRosterFilter == filter ? .primary : .secondary)
                            .padding(.horizontal, 15)
                            .frame(height: AgentLayout.filterHeight)
                            .background {
                                Capsule()
                                    .fill(self.agentRosterFilter == filter
                                        ? Color.primary.opacity(0.13)
                                        : Color.primary.opacity(0.055))
                            }
                            .overlay {
                                Capsule()
                                    .strokeBorder(Color.primary.opacity(self.agentRosterFilter == filter ? 0.22 : 0.06))
                            }
                    }
                    .buttonStyle(.plain)
                }

                if self.agentFiltersActive {
                    self.headerIconButton(
                        systemName: "xmark",
                        label: "Clear filters",
                        action: {
                            self.agentRosterFilter = .all
                            self.agentSearchText = ""
                        })
                        .frame(width: AgentLayout.filterHeight, height: AgentLayout.filterHeight)
                }
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    var agentFiltersActive: Bool {
        self.agentRosterFilter != .all
            || !self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    var agentsSection: some View {
        ProCard(padding: 0, radius: AgentLayout.cardRadius) {
            if self.filteredAgents.isEmpty {
                self.emptyAgentsRow
                    .padding(14)
            } else {
                VStack(spacing: 0) {
                    ForEach(Array(self.filteredAgents.enumerated()), id: \.element.id) { index, agent in
                        self.agentRow(agent)
                        if index < self.filteredAgents.count - 1 {
                            Divider().padding(.leading, 76)
                        }
                    }
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    var operationsSection: some View {
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

    var dreamingSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Dreaming")
            ProCard(radius: AgentLayout.cardRadius) {
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

    var cronSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Scheduled Work")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
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

    var emptyAgentsRow: some View {
        HStack(spacing: 12) {
            ProIconBadge(systemName: "person.2.slash", color: .secondary)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.emptyAgentsTitle)
                    .font(.subheadline.weight(.semibold))
                Text(self.emptyAgentsDetail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Spacer()
        }
    }

    func agentRow(_ agent: AgentSummary) -> some View {
        let isActive = agent.id == self.activeAgentID
        let state = self.agentRosterState(for: agent)
        return HStack(alignment: .top, spacing: 12) {
            self.agentAvatar(agent, state: state)

            VStack(alignment: .leading, spacing: 8) {
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 6) {
                        Text(self.agentName(for: agent))
                            .font(.subheadline.weight(.semibold))
                            .lineLimit(1)

                        HStack(spacing: 4) {
                            Circle()
                                .fill(state.color)
                                .frame(width: 6, height: 6)
                            Text(state.title)
                                .font(.caption2.weight(.semibold))
                        }
                        .foregroundStyle(state.color)
                        .lineLimit(1)
                    }

                    Text(self.agentDetail(for: agent))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                HStack(spacing: 0) {
                    self.agentMetric(label: "Sessions", value: self.agentSessionSummary(agent))
                    Divider()
                        .frame(height: 24)
                        .padding(.horizontal, 12)
                    self.agentMetric(label: "Runtime", value: self.agentRuntimeSummary(agent))
                }
            }
            .layoutPriority(1)

            Button {
                self.appModel.setSelectedAgentId(agent.id)
            } label: {
                Image(systemName: isActive ? "checkmark" : "arrow.right")
                    .font(.caption.weight(.bold))
            }
            .buttonStyle(.plain)
            .foregroundStyle(isActive ? OpenClawBrand.accent : .primary)
            .frame(width: AgentLayout.actionButtonSize, height: AgentLayout.actionButtonSize)
            .background {
                Circle()
                    .fill(self.iconButtonFill)
                    .overlay {
                        Circle().strokeBorder(self.iconButtonStroke, lineWidth: 1)
                    }
            }
            .accessibilityLabel(isActive ? "Active agent" : "Make active agent")
        }
        .padding(.vertical, 14)
        .padding(.horizontal, 13)
        .frame(minHeight: AgentLayout.rowMinHeight, alignment: .center)
        .contentShape(Rectangle())
        .onTapGesture {
            self.appModel.setSelectedAgentId(agent.id)
        }
    }

    func headerIconButton(
        systemName: String,
        label: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Image(systemName: systemName)
                .font(.subheadline.weight(.semibold))
                .frame(width: AgentLayout.filterHeight, height: AgentLayout.filterHeight)
                .background {
                    Circle()
                        .fill(self.iconButtonFill)
                        .overlay {
                            Circle().strokeBorder(self.iconButtonStroke, lineWidth: 1)
                        }
                }
        }
        .buttonStyle(.plain)
        .accessibilityLabel(label)
    }

    func agentAvatar(_ agent: AgentSummary, state: AgentRosterState) -> some View {
        ZStack(alignment: .bottomTrailing) {
            Text(self.agentBadge(for: agent))
                .font(.system(size: self.agentBadge(for: agent).count > 2 ? 14 : 18, weight: .bold, design: .rounded))
                .foregroundStyle(.white)
                .minimumScaleFactor(0.62)
                .lineLimit(1)
                .frame(width: 48, height: 48)
                .background(
                    Circle()
                        .fill(
                            LinearGradient(
                                colors: [
                                    self.agentTint(for: agent, state: state),
                                    Color.primary.opacity(0.38),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing)))
                .overlay(Circle().strokeBorder(Color.white.opacity(0.18), lineWidth: 1))

            Circle()
                .fill(state.color)
                .frame(width: 10, height: 10)
                .overlay(Circle().strokeBorder(Color.primary.opacity(0.15), lineWidth: 1))
        }
    }

    func agentMetric(label: String, value: String) -> some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(value)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(1)
                .minimumScaleFactor(0.74)
        }
        .frame(minWidth: 60, alignment: .leading)
    }

    func agentMenuRow(
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

    func metricTile(
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

    func metricTileContent(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color,
        showsChevron: Bool) -> some View
    {
        ProCard(padding: 12, radius: AgentLayout.cardRadius) {
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
            .frame(height: AgentLayout.metricTileHeight, alignment: .topLeading)
        }
    }

    var emptyCronRow: some View {
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

    func cronJobRow(_ job: CronJob) -> some View {
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

    var sortedAgents: [AgentSummary] {
        self.appModel.gatewayAgents.sorted { lhs, rhs in
            if lhs.id == self.activeAgentID { return true }
            if rhs.id == self.activeAgentID { return false }
            return self.agentName(for: lhs)
                .localizedCaseInsensitiveCompare(self.agentName(for: rhs)) == .orderedAscending
        }
    }

    var filteredAgents: [AgentSummary] {
        let query = self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines)
        return self.sortedAgents.filter { agent in
            let matchesFilter: Bool = switch self.agentRosterFilter {
            case .all:
                true
            case .online:
                self.agentRosterState(for: agent) == .online
            case .busy:
                self.agentRosterState(for: agent) == .busy
            case .idle:
                self.agentRosterState(for: agent) == .idle
            }

            guard matchesFilter else { return false }
            guard !query.isEmpty else { return true }
            let haystack = [
                self.agentName(for: agent),
                agent.id,
                self.normalized(agent.workspace),
                self.modelLabel(for: agent),
            ]
                .compactMap(\.self)
                .joined(separator: " ")
            return haystack.localizedCaseInsensitiveContains(query)
        }
    }

    var activeAgentID: String {
        self.normalized(self.appModel.selectedAgentId)
            ?? self.normalized(self.appModel.gatewayDefaultAgentId)
            ?? "main"
    }

    var gatewayConnected: Bool {
        GatewayStatusBuilder.build(appModel: self.appModel) == .connected
    }

    private var searchFieldFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.045) : Color.white.opacity(0.78)
    }

    private var searchFieldStroke: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.11) : Color.black.opacity(0.07)
    }

    private var iconButtonFill: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.065) : Color.white.opacity(0.78)
    }

    private var iconButtonStroke: Color {
        self.colorScheme == .dark ? Color.white.opacity(0.14) : Color.black.opacity(0.07)
    }

    var emptyAgentsTitle: String {
        if !self.gatewayConnected { return "Agents unavailable" }
        if !self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "No matches" }
        if self.agentRosterFilter != .all { return "No \(self.agentRosterFilter.title.lowercased()) agents" }
        return "No agents reported"
    }

    var emptyAgentsDetail: String {
        if !self.gatewayConnected { return "Connect a gateway to load the live agent roster." }
        if !self.agentSearchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "Try another search or clear the agent filters."
        }
        if self.agentRosterFilter != .all { return "Clear the filter to view the full roster." }
        return "The connected gateway did not return an agent list."
    }

    var overviewTaskID: String {
        [
            self.gatewayConnected ? "connected" : "offline",
            self.appModel.isOperatorGatewayConnected ? "operator" : "no-operator",
            self.activeAgentID,
            self.scenePhase == .active ? "active" : "inactive",
            "\(self.overviewRefreshNonce)",
        ].joined(separator: ":")
    }

    var skillsValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let skills = self.overview?.skills else {
            return self.overviewLoading ? "..." : "live"
        }
        return "\(skills.enabledCount)/\(skills.totalCount)"
    }

    var skillsDetail: String {
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

    var instancesValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let count = self.overview?.presence.count else {
            return self.overviewLoading ? "..." : "live"
        }
        return "\(count)"
    }

    var instancesDetail: String {
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

    var instancesColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return (self.overview?.presence.isEmpty == false) ? OpenClawBrand.accent : .secondary
    }

    var cronValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let cronStatus = self.overview?.cronStatus else {
            return self.overviewLoading ? "..." : "live"
        }
        return cronStatus.enabled ? "\(cronStatus.jobs)" : "off"
    }

    var cronDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load cron." }
        guard let cronStatus = self.overview?.cronStatus else {
            return self.overviewLoading ? "Loading cron status." : "Cron status is available."
        }
        if let nextWakeAtMs = cronStatus.nextwakeatms {
            return "Next wake \(Self.relativeTime(fromMilliseconds: nextWakeAtMs))"
        }
        return cronStatus.enabled ? "Scheduler enabled" : "Scheduler disabled"
    }

    var cronColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return self.overview?.cronStatus?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    var usageValue: String {
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

    var usageDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load usage." }
        guard let usage = self.overview?.usage else {
            return self.overviewLoading ? "Loading recent usage." : "Recent usage is available."
        }
        if let tokens = usage.totalTokens, tokens > 0 {
            return "\(Self.compactNumber(tokens)) tokens in \(usage.days ?? 7)d"
        }
        return "No token usage reported for \(usage.days ?? 7)d."
    }

    var dreamingValue: String {
        guard self.gatewayConnected else { return "offline" }
        guard let dreaming = self.overview?.dreaming else {
            return self.overviewLoading ? "..." : "live"
        }
        return dreaming.enabled ? "on" : "off"
    }

    var dreamingDetail: String {
        guard self.gatewayConnected else { return "Connect a gateway to load dreaming." }
        guard let dreaming = self.overview?.dreaming else {
            return self.overviewLoading ? "Loading dreaming status." : "Background memory status is available."
        }
        if let nextRunAtMs = dreaming.nextRunAtMs {
            return "Next cycle \(Self.relativeTime(fromMilliseconds: nextRunAtMs))"
        }
        return "\(dreaming.totalSignalCount ?? 0) signals, \(dreaming.promotedToday ?? 0) promoted today"
    }

    var dreamingColor: Color {
        guard self.gatewayConnected else { return .secondary }
        return self.overview?.dreaming?.enabled == true ? OpenClawBrand.accent : .secondary
    }

    var recentCronJobs: [CronJob] {
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

enum AgentProValueReader {
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
    let skills: SkillStatusReportLite?
    let presence: [PresenceEntry]
    let cronStatus: CronStatusLite?
    let cronJobs: [CronJob]
    let dreaming: DreamingStatusLite?
    let dreamDiary: DreamDiaryLite?
    let usage: CostUsageSummaryLite?
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

struct SkillStatusReportLite: Decodable {
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

struct SkillStatusEntryLite: Decodable {
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

struct SkillInstallOptionLite: Decodable {
    let id: String?
    let kind: String?
    let label: String
    let bins: [String]?
}

struct SkillUpdateParams: Encodable {
    let skillKey: String
    var enabled: Bool?
    var apiKey: String?
}

struct SkillInstallParams: Encodable {
    let name: String
    let installId: String
    let timeoutMs: Int
}

struct SkillInstallResultLite: Decodable {
    let message: String?
}

struct ClawHubSearchParams: Encodable {
    let query: String?
    let limit: Int
}

struct ClawHubSearchResponseLite: Decodable {
    let results: [ClawHubSearchResultLite]
}

struct ClawHubSearchResultLite: Decodable {
    let slug: String
    let displayName: String
    let summary: String?
    let version: String?
}

struct ClawHubInstallParams: Encodable {
    let source = "clawhub"
    let slug: String
}

struct CronRunParams: Encodable {
    let id: String
    let mode: String
}

struct CronUpdatePatch: Encodable {
    let enabled: Bool
}

struct CronUpdateParams: Encodable {
    let id: String
    let patch: CronUpdatePatch
}

struct SkillStatusMissingLite: Decodable {
    let bins: [String]
    let env: [String]
    let config: [String]
    let os: [String]
}

struct CronStatusLite: Decodable {
    let enabled: Bool
    let jobs: Int
    let nextwakeatms: Int?

    enum CodingKeys: String, CodingKey {
        case enabled
        case jobs
        case nextwakeatms = "nextWakeAtMs"
    }
}

struct CronJobsListLite: Decodable {
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

struct ConfigSnapshotLite: Decodable {
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

struct ConfigRootLite: Decodable {
    let agents: AgentsConfigLite?
}

struct AgentsConfigLite: Decodable {
    let defaults: AgentDefaultsConfigLite?
    let list: [AgentConfigLite]?
}

struct AgentDefaultsConfigLite: Decodable {
    let skills: [String]?
}

struct AgentConfigLite: Decodable {
    let id: String
    let skills: [String]?
}

struct ConfigPatchParams: Encodable {
    let raw: String
    let baseHash: String
}

enum SkillMutationError: LocalizedError {
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

struct CostUsageSummaryLite: Decodable {
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

struct CostUsageDailyEntryLite: Decodable {
    let date: String
    let totalTokens: Int?
    let totalCost: Double?
}
