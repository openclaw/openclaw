import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    @ViewBuilder
    func destination(for route: AgentRoute) -> some View {
        switch route {
        case .agents:
            self.agentsDestination
        case .skills:
            self.skillsDestination
        case .instances:
            self.instancesDestination
        case .cron:
            self.cronDestination
        case .usage:
            self.usageDestination
        case .dreaming:
            self.dreamingDestination
        }
    }

    var agentsDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.rosterHeader
                    self.agentFilters
                    self.agentsSection
                }
                .padding(.vertical, 18)
            }
            .refreshable {
                await self.refreshOverview(force: true)
            }
            .safeAreaPadding(.bottom, OpenClawProMetric.bottomScrollInset)
        }
        .navigationTitle("Agents")
        .navigationBarTitleDisplayMode(.inline)
    }

    var skillsDestination: some View {
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

    var instancesDestination: some View {
        AgentProNodesDestination(
            headerLeadingAction: self.directHeaderLeadingAction(for: .instances),
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

    var cronDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.directHeader(
                        for: .cron,
                        title: "Cron Jobs",
                        subtitle: self.cronDetail)
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

    var usageDestination: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: 16) {
                    self.directHeader(
                        for: .usage,
                        title: "Usage",
                        subtitle: self.usageDetail)
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

    var dreamingDestination: some View {
        AgentProDreamingDestination(
            headerLeadingAction: self.directHeaderLeadingAction(for: .dreaming),
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

    @ViewBuilder
    func directHeader(for route: AgentRoute, title: String, subtitle: String) -> some View {
        if let headerLeadingAction = self.directHeaderLeadingAction(for: route) {
            OpenClawAdaptiveHeaderRow(
                title: title,
                subtitle: subtitle,
                titleFont: .title3.weight(.semibold),
                subtitleFont: .callout)
            {
                OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)
            } accessory: {
                EmptyView()
            }
            .padding(.horizontal, OpenClawProMetric.pagePadding)
        }
    }

    func directHeaderLeadingAction(for route: AgentRoute) -> OpenClawSidebarHeaderAction? {
        self.directRoute == route ? self.headerLeadingAction : nil
    }

    func detailSummaryCard(
        icon: String,
        title: String,
        value: String,
        detail: String,
        color: Color) -> some View
    {
        ProCard(radius: AgentLayout.cardRadius) {
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
}
