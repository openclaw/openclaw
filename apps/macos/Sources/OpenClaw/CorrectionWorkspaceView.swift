import AppKit
import Foundation
import Observation
import OpenClawKit
import SwiftUI

struct CorrectionWorkspaceView: View {
    @Bindable var state: AppState
    private let pairingPrompter = NodePairingApprovalPrompter.shared
    private let devicePairingPrompter = DevicePairingApprovalPrompter.shared
    private let agentEventStore = AgentEventStore.shared
    private let syntheticTrialRunner = CorrectionSyntheticTrialRunner.shared
    private let healthStore = HealthStore.shared
    private let heartbeatStore = HeartbeatStore.shared
    private let activityStore = WorkActivityStore.shared
    private let controlChannel = ControlChannel.shared
    @State private var selectedIssueID: CorrectionWorkspaceIssue.ID?
    @State private var attentionFilter: CorrectionWorkspaceAttentionFilter = .all
    @State private var sortMode: CorrectionWorkspaceSortMode = .urgency
    @State private var searchText = ""
    @State private var casebookSnapshot: OpenClawKit.CorrectionCasebookSnapshot =
        OpenClawKit.CorrectionCasebookStore.load()
    @State private var sessionIdentitySnapshot: SessionIdentitySnapshot = .empty
    @State private var pendingDispatch: CorrectionWorkspaceDispatchConfirmation?
    @State private var researchInFlightCaseKeys: Set<String> = []
    @State private var interfaceBreath = false

    private var allIssues: [CorrectionWorkspaceIssue] {
        CorrectionWorkspaceIssueBuilder.build(
            state: self.state,
            healthStore: self.healthStore,
            heartbeatStore: self.heartbeatStore,
            activityStore: self.activityStore,
            agentEventStore: self.agentEventStore,
            controlChannel: self.controlChannel,
            pairingPrompter: self.pairingPrompter,
            devicePairingPrompter: self.devicePairingPrompter,
            sessionIdentities: self.sessionIdentitySnapshot,
            casebook: self.casebookSnapshot)
    }

    private var actionableIssues: [CorrectionWorkspaceIssue] {
        self.allIssues.filter { $0.severity != .healthy }
    }

    private var trimmedSearchText: String {
        self.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private var filteredIssues: [CorrectionWorkspaceIssue] {
        self.actionableIssues.filter { issue in
            guard self.attentionFilter.matches(issue) else { return false }
            guard !self.trimmedSearchText.isEmpty else { return true }
            return issue.searchBlob.localizedCaseInsensitiveContains(self.trimmedSearchText)
        }
    }

    private var visibleIssues: [CorrectionWorkspaceIssue] {
        CorrectionWorkspaceSortMode.sorted(self.filteredIssues, by: self.sortMode)
    }

    private var selectedIssue: CorrectionWorkspaceIssue? {
        if let selectedIssueID {
            return self.visibleIssues.first(where: { $0.id == selectedIssueID })
                ?? self.actionableIssues.first(where: { $0.id == selectedIssueID })
        }
        return self.visibleIssues.first
    }

    private var summary: CorrectionWorkspaceSummary {
        CorrectionWorkspaceSummary(
            issues: self.allIssues,
            casebook: self.casebookSnapshot,
            runnerSummary: self.syntheticTrialRunner.lastRunSummary,
            batchProgress: self.syntheticTrialRunner.batchProgress,
            currentPlan: self.syntheticTrialRunner.currentPlan)
    }

    private var pendingSyntheticRunCount: Int {
        CorrectionSyntheticTrialRunner.pendingRunCount(casebook: self.casebookSnapshot)
    }

    var body: some View {
        ZStack {
            CorrectionWorkspaceAmbientBackdrop()

            ScrollViewReader { scrollProxy in
                GeometryReader { proxy in
                    ScrollView {
                        VStack(spacing: 18) {
                            Color.clear
                                .frame(height: 1)
                                .id("correction-top-anchor")

                            self.heroPanel
                            self.compactControlDeck
                            self.workspaceStage(for: proxy.size.width)
                        }
                        .padding(.horizontal, max(18, min(34, proxy.size.width * 0.028)))
                        .padding(.vertical, 22)
                        .frame(maxWidth: .infinity)
                    }
                    .scrollIndicators(.hidden)
                    .coordinateSpace(name: "correction-workspace-scroll")
                    .onAppear {
                        DispatchQueue.main.async {
                            scrollProxy.scrollTo("correction-top-anchor", anchor: .top)
                        }
                    }
                }
            }
        }
        .task {
            await self.refreshSignals()
            self.syncSelection()
        }
        .onAppear {
            self.startInterfaceBreathing()
        }
        .sheet(item: self.$pendingDispatch) { dispatch in
            CorrectionWorkspaceDispatchSheet(
                confirmation: dispatch,
                onCancel: {
                    self.pendingDispatch = nil
                },
                onConfirm: {
                    self.pendingDispatch = nil
                    Task { await self.performDispatch(dispatch) }
                })
        }
        .onChange(of: self.attentionFilter) { _, _ in
            self.syncSelection()
        }
        .onChange(of: self.searchText) { _, _ in
            self.syncSelection()
        }
        .onChange(of: self.sortMode) { _, _ in
            self.syncSelection()
        }
        .animation(.spring(response: 0.42, dampingFraction: 0.86), value: self.selectedIssueID)
        .animation(.easeInOut(duration: 0.22), value: self.attentionFilter)
    }

    private var heroPanel: some View {
        AppleGlassParallaxHero(
            coordinateSpace: "correction-workspace-scroll",
            height: 228,
            cornerRadius: 40,
            accent: self.heroAccent,
            secondaryAccent: self.secondaryHeroAccent)
        {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 30) {
                    self.heroCopyColumn
                    self.heroOrbCluster
                }
                .frame(maxWidth: .infinity, alignment: .leading)

                VStack(alignment: .leading, spacing: 16) {
                    self.heroOrbCluster
                        .frame(maxWidth: .infinity, alignment: .trailing)
                    self.heroCopyColumn
                }
            }
        }
        .modifier(CorrectionWorkspaceParallaxModifier(depth: 10))
    }

    private var compactControlDeck: some View {
        VStack(alignment: .leading, spacing: 14) {
            ViewThatFits(in: .horizontal) {
                HStack(alignment: .center, spacing: 12) {
                    self.deckFilterControls
                    Spacer(minLength: 8)
                    self.deckActionControls
                }

                VStack(alignment: .leading, spacing: 10) {
                    self.deckFilterControls
                    self.deckActionControls
                }
            }

            self.compactStatusRail
        }
        .padding(14)
        .background(CorrectionWorkspacePanelBackground(tint: Color(red: 0.89, green: 0.94, blue: 1.00)))
    }

    @ViewBuilder
    private func workspaceStage(for width: CGFloat) -> some View {
        if width < 1100 {
            VStack(spacing: 14) {
                self.attentionColumn
                self.detailColumn
                    .frame(minHeight: 540)
            }
        } else {
            HStack(alignment: .top, spacing: 14) {
                self.attentionColumn
                    .frame(width: min(max(width * 0.30, 304), 360))

                self.detailColumn
                    .frame(minWidth: 0, maxWidth: .infinity, minHeight: 640)
            }
        }
    }

    private var heroSignalLine: String {
        if let selectedIssue {
            return selectedIssue.title
        }
        return self.summary.focusLine
    }

    private var heroMetricValue: String {
        if self.summary.criticalCount > 0 {
            return "\(self.summary.criticalCount)"
        }
        return "\(self.summary.activeCount)"
    }

    private var heroMetricLabel: String {
        self.summary.criticalCount > 0 ? "critical" : "live"
    }

    private var heroAccent: Color {
        self.summary.criticalCount > 0
            ? Color(red: 0.96, green: 0.59, blue: 0.31)
            : Color(red: 0.45, green: 0.72, blue: 0.98)
    }

    private var secondaryHeroAccent: Color {
        self.summary.criticalCount > 0
            ? Color(red: 0.99, green: 0.77, blue: 0.55)
            : Color(red: 0.61, green: 0.88, blue: 0.84)
    }

    private var summaryHeadline: String {
        if self.summary.activeCount == 0 {
            return "All seats are stable"
        }

        if self.summary.criticalCount > 0 {
            let seatLabel = self.summary.criticalCount == 1 ? "seat" : "seats"
            let verb = self.summary.criticalCount == 1 ? "needs" : "need"
            return "\(self.summary.criticalCount) \(seatLabel) \(verb) action now"
        }

        let activeSeatLabel = self.summary.activeCount == 1 ? "seat" : "seats"
        let watchVerb = self.summary.activeCount == 1 ? "is" : "are"
        return "\(self.summary.activeCount) \(activeSeatLabel) \(watchVerb) under active watch"
    }

    private var summarySupportLine: String {
        if let selectedIssue {
            return selectedIssue.title
        }

        if self.summary.activeCount == 0 {
            return "No active correction loop."
        }

        return "Verify first. Dispatch after proof."
    }

    private func shortFilterTitle(for filter: CorrectionWorkspaceAttentionFilter) -> String {
        switch filter {
        case .all:
            "All"
        case .critical:
            "Hot"
        case .watch:
            "Watch"
        }
    }

    private var scopeSummaryTitle: String {
        guard !self.actionableIssues.isEmpty else { return "No live seats" }
        return "\(self.visibleIssues.count) of \(self.actionableIssues.count) seats"
    }

    private var scopeSummaryDetail: String {
        guard !self.actionableIssues.isEmpty else { return "Quiet" }
        var components = [self.sortMode.title]
        if self.attentionFilter != .all {
            components.append(self.shortFilterTitle(for: self.attentionFilter))
        }
        if !self.trimmedSearchText.isEmpty {
            components.append("“\(String(self.trimmedSearchText.prefix(18)))”")
        }
        return components.joined(separator: " · ")
    }

    private var focusSummaryTitle: String {
        self.selectedIssue?.seat ?? "Choose a seat"
    }

    private var focusSummaryDetail: String {
        if let selectedIssue {
            return selectedIssue.rowSupportLine
        }
        return "Pick one live case."
    }

    private var nextStepSummaryTitle: String {
        self.selectedIssue?.primaryActionDisplayTitle ?? "No recommended action yet"
    }

    private var nextStepSummaryDetail: String {
        self.selectedIssue?.primaryActionGuidance
            ?? "Select a seat to surface the next move."
    }

    private var canResetScope: Bool {
        self.attentionFilter != .all || !self.trimmedSearchText.isEmpty
    }

    private var resetScopeButtonTitle: String {
        if self.attentionFilter != .all && !self.trimmedSearchText.isEmpty {
            return "Clear filters"
        }
        if !self.trimmedSearchText.isEmpty {
            return "Clear search"
        }
        return "Show all"
    }

    private func resetScope() {
        withAnimation(.spring(response: 0.32, dampingFraction: 0.88)) {
            self.attentionFilter = .all
            self.searchText = ""
        }
        self.syncSelection()
    }

    private var compactStatusRail: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 0) {
                self.compactStatusTile(
                    title: "Scope",
                    value: self.scopeSummaryTitle,
                    detail: self.scopeSummaryDetail,
                    systemImage: "line.3.horizontal.decrease.circle",
                    tint: Color(red: 0.43, green: 0.69, blue: 0.96))

                self.compactStatusDivider

                self.compactStatusTile(
                    title: "Focus",
                    value: self.focusSummaryTitle,
                    detail: self.focusSummaryDetail,
                    systemImage: self.selectedIssue?.severity.systemImage ?? "scope",
                    tint: self.selectedIssue?.severity.color ?? Color(red: 0.43, green: 0.69, blue: 0.96))

                self.compactStatusDivider

                self.compactStatusTile(
                    title: "Next step",
                    value: self.nextStepSummaryTitle,
                    detail: self.nextStepSummaryDetail,
                    systemImage: self.selectedIssue?.primaryActionDisplaySystemImage ?? "paperplane",
                    tint: Color(red: 0.97, green: 0.63, blue: 0.37))

                if self.canResetScope {
                    self.compactStatusDivider
                    self.compactResetButton
                }
            }
            .padding(4)
            .background(self.compactStatusRailBackground)

            VStack(spacing: 0) {
                self.compactStatusTile(
                    title: "Scope",
                    value: self.scopeSummaryTitle,
                    detail: self.scopeSummaryDetail,
                    systemImage: "line.3.horizontal.decrease.circle",
                    tint: Color(red: 0.43, green: 0.69, blue: 0.96))

                Divider()
                    .overlay(Color.white.opacity(0.18))

                self.compactStatusTile(
                    title: "Focus",
                    value: self.focusSummaryTitle,
                    detail: self.focusSummaryDetail,
                    systemImage: self.selectedIssue?.severity.systemImage ?? "scope",
                    tint: self.selectedIssue?.severity.color ?? Color(red: 0.43, green: 0.69, blue: 0.96))

                Divider()
                    .overlay(Color.white.opacity(0.18))

                self.compactStatusTile(
                    title: "Next step",
                    value: self.nextStepSummaryTitle,
                    detail: self.nextStepSummaryDetail,
                    systemImage: self.selectedIssue?.primaryActionDisplaySystemImage ?? "paperplane",
                    tint: Color(red: 0.97, green: 0.63, blue: 0.37))

                if self.canResetScope {
                    Divider()
                        .overlay(Color.white.opacity(0.18))
                    self.compactResetButton
                }
            }
            .background(self.compactStatusRailBackground)
        }
    }

    private var compactStatusRailBackground: some View {
        RoundedRectangle(cornerRadius: 24, style: .continuous)
            .fill(Color.white.opacity(0.18))
            .overlay(
                RoundedRectangle(cornerRadius: 24, style: .continuous)
                    .strokeBorder(Color.white.opacity(0.20), lineWidth: 0.8))
    }

    private var compactStatusDivider: some View {
        Rectangle()
            .fill(Color.white.opacity(0.18))
            .frame(width: 1)
            .padding(.vertical, 10)
    }

    private var compactResetButton: some View {
        Button {
            self.resetScope()
        } label: {
            Label("Reset", systemImage: "line.3.horizontal.decrease.circle.badge.xmark")
                .lineLimit(1)
        }
        .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle())
        .padding(.horizontal, 10)
    }

    private func compactStatusTile(
        title: String,
        value: String,
        detail: String,
        systemImage: String,
        tint: Color) -> some View
    {
        HStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(tint.opacity(0.14))
                    .frame(width: 34, height: 34)

                Image(systemName: systemImage)
                    .font(.system(size: 13, weight: .semibold))
                    .foregroundStyle(tint)
            }

            VStack(alignment: .leading, spacing: 3) {
                Text(title.uppercased())
                    .font(.system(size: 10, weight: .bold, design: .rounded))
                    .tracking(0.8)
                    .foregroundStyle(tint.opacity(0.90))
                Text(value)
                    .font(.system(size: 14, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                    .lineLimit(1)
                    .fixedSize(horizontal: false, vertical: true)
                Text(detail)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: false, vertical: true)
            }

            Spacer(minLength: 0)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
    }

    private func heroPulsePill(symbol: String, value: String, label: String) -> some View {
        HStack(spacing: 7) {
            Image(systemName: symbol)
                .font(.system(size: 11, weight: .semibold))
            Text(value)
                .font(.caption.weight(.bold))
            Text(label)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.34), in: Capsule(style: .continuous))
    }

    private func heroWorkflowPill(number: String, title: String) -> some View {
        HStack(spacing: 8) {
            Text(number)
                .font(.caption.weight(.bold))
                .foregroundStyle(self.heroAccent)
                .frame(width: 20, height: 20)
                .background(Color.white.opacity(0.70), in: Circle())

            Text(title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.34), in: Capsule(style: .continuous))
    }

    private var heroCopyColumn: some View {
        VStack(alignment: .leading, spacing: 14) {
            Label("Cases", systemImage: "scope")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)

            Text(self.summaryHeadline)
                .font(.system(size: 32, weight: .semibold, design: .rounded))
                .tracking(-0.8)
                .lineLimit(2)
                .frame(maxWidth: 470, alignment: .leading)

            Text(self.summarySupportLine)
                .font(.system(size: 14, weight: .medium, design: .rounded))
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .frame(maxWidth: 320, alignment: .leading)

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    self.heroSignalPill(
                        text: "\(self.summary.activeCount) live",
                        systemImage: "bolt.fill",
                        tint: Color(red: 0.48, green: 0.73, blue: 0.97))
                    self.heroSignalPill(
                        text: self.summary.criticalCount > 0 ? "\(self.summary.criticalCount) hot" : "\(self.summary.watchCount) watch",
                        systemImage: self.summary.criticalCount > 0 ? "flame.fill" : "eye.fill",
                        tint: self.heroAccent)
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        self.heroSignalPill(
                            text: "\(self.summary.activeCount) live",
                            systemImage: "bolt.fill",
                            tint: Color(red: 0.48, green: 0.73, blue: 0.97))
                        self.heroSignalPill(
                            text: self.summary.criticalCount > 0 ? "\(self.summary.criticalCount) hot" : "\(self.summary.watchCount) watch",
                            systemImage: self.summary.criticalCount > 0 ? "flame.fill" : "eye.fill",
                            tint: self.heroAccent)
                    }
                }
            }
        }
        .frame(maxWidth: 490, alignment: .leading)
    }

    private var heroOrbCluster: some View {
        ZStack(alignment: .bottomTrailing) {
            ZStack {
                Circle()
                    .fill(self.heroAccent.opacity(0.16))
                    .frame(width: 174, height: 174)
                    .blur(radius: 18)

                Circle()
                    .fill(Color.white.opacity(0.20))
                    .frame(width: 156, height: 156)

                Circle()
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.62),
                                self.secondaryHeroAccent.opacity(0.36),
                                self.heroAccent.opacity(0.16),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
                    .frame(width: 142, height: 142)
                    .overlay(
                        Circle()
                            .strokeBorder(Color.white.opacity(0.48), lineWidth: 0.8))
                    .shadow(color: self.heroAccent.opacity(0.12), radius: 24, y: 14)

                Circle()
                    .strokeBorder(Color.white.opacity(0.24), lineWidth: 10)
                    .frame(width: 160, height: 160)
                    .blur(radius: 2)

                Circle()
                    .fill(Color.white.opacity(0.42))
                    .frame(width: 54, height: 54)
                    .blur(radius: 10)
                    .offset(x: self.interfaceBreath ? -22 : 12, y: self.interfaceBreath ? -24 : -38)
            }
            .frame(width: 184, height: 184)

            VStack(alignment: .trailing, spacing: 10) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(self.heroMetricValue)
                        .font(.system(size: 42, weight: .semibold, design: .rounded))
                        .contentTransition(.numericText())
                    Text(self.heroMetricLabel)
                        .font(.caption2.weight(.bold))
                        .textCase(.uppercase)
                        .tracking(0.7)
                        .foregroundStyle(.secondary)
                }
                .padding(.horizontal, 16)
                .padding(.vertical, 12)
                .background(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(
                            LinearGradient(
                                colors: [
                                    Color.white.opacity(0.66),
                                    self.heroAccent.opacity(0.10),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing))
                )
                .overlay(
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.34), lineWidth: 0.8))
                .shadow(color: self.heroAccent.opacity(0.12), radius: 18, y: 10)

                self.heroSignalPill(
                    text: self.heroOrbStateText,
                    systemImage: self.heroOrbStateSymbol,
                    tint: self.heroOrbStateTint)
            }
            .offset(x: 14, y: 12)
        }
        .frame(width: 234, height: 188)
    }

    private var heroOrbStateText: String {
        if self.summary.criticalCount > 0 { return "Critical" }
        if self.summary.watchCount > 0 { return "Observe" }
        return "Stable"
    }

    private var heroOrbStateSymbol: String {
        if self.summary.criticalCount > 0 { return "flame.fill" }
        if self.summary.watchCount > 0 { return "eye.fill" }
        return "checkmark.circle.fill"
    }

    private var heroOrbStateTint: Color {
        if self.summary.criticalCount > 0 { return self.heroAccent }
        if self.summary.watchCount > 0 { return Color(red: 0.48, green: 0.73, blue: 0.97) }
        return Color(red: 0.45, green: 0.75, blue: 0.56)
    }

    private func heroSignalPill(text: String, systemImage: String, tint: Color) -> some View {
        HStack(spacing: 8) {
            Image(systemName: systemImage)
                .font(.system(size: 11, weight: .semibold))
                .foregroundStyle(tint)
            Text(text)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.primary)
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(Color.white.opacity(0.42), in: Capsule(style: .continuous))
        .overlay(
            Capsule(style: .continuous)
                .strokeBorder(Color.white.opacity(0.30), lineWidth: 0.8))
    }

    private var deckFilterControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                self.attentionFilterControl
                    .frame(width: 188)
                self.searchControl
                    .frame(width: 228)
                self.sortControl
            }

            VStack(alignment: .leading, spacing: 10) {
                self.attentionFilterControl
                HStack(spacing: 10) {
                    self.searchControl
                    self.sortControl
                }
            }
        }
    }

    private var deckActionControls: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 8) {
                if self.pendingSyntheticRunCount > 0 {
                    self.trialsButton
                }
                self.primaryActionButton
                self.refreshButton
                self.settingsButton
            }

            VStack(alignment: .leading, spacing: 8) {
                self.primaryActionButton
                HStack(spacing: 8) {
                    if self.pendingSyntheticRunCount > 0 {
                        self.trialsButton
                    }
                    self.refreshButton
                    self.settingsButton
                }
            }
        }
    }

    private var attentionFilterControl: some View {
        Picker("Attention", selection: self.$attentionFilter) {
            ForEach(CorrectionWorkspaceAttentionFilter.allCases) { filter in
                Text(self.shortFilterTitle(for: filter))
                    .tag(filter)
            }
        }
        .labelsHidden()
        .pickerStyle(.segmented)
    }

    private var searchControl: some View {
        HStack(spacing: 8) {
            Image(systemName: "magnifyingglass")
                .font(.system(size: 12, weight: .semibold))
                .foregroundStyle(.secondary)
            TextField("Search", text: self.$searchText)
                .textFieldStyle(.plain)
            if !self.searchText.isEmpty {
                Button {
                    self.searchText = ""
                } label: {
                    Image(systemName: "xmark.circle.fill")
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(.secondary)
                }
                .buttonStyle(.plain)
                .help("Clear search")
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 11)
        .background(Color.white.opacity(0.40), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var sortControl: some View {
        CorrectionWorkspaceSortMenu(sortMode: self.$sortMode)
            .padding(.horizontal, 14)
            .padding(.vertical, 11)
            .background(Color.white.opacity(0.40), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var trialsButton: some View {
        Button {
            self.requestSyntheticValidation()
        } label: {
            Label("Trials", systemImage: self.syntheticTrialRunner.isRunning ? "hourglass" : "stethoscope")
                .lineLimit(1)
        }
        .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle(prominent: true))
        .disabled(self.syntheticTrialRunner.isRunning)
        .fixedSize(horizontal: true, vertical: false)
    }

    private var primaryActionButton: some View {
        Button {
            if let selectedIssue {
                self.requestAction(selectedIssue.primaryAction, issue: selectedIssue)
            }
        } label: {
            Label(
                self.selectedIssue?.primaryActionDisplayTitle ?? "Chat",
                systemImage: self.selectedIssue?.primaryActionDisplaySystemImage ?? "bubble.left.and.bubble.right")
            .lineLimit(1)
        }
        .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle(prominent: self.selectedIssue != nil))
        .disabled(self.selectedIssue == nil)
        .help("Run the recommended action for the selected case")
        .fixedSize(horizontal: true, vertical: false)
    }

    private var refreshButton: some View {
        Button {
            Task { await self.refreshSignals() }
        } label: {
            Image(systemName: "arrow.clockwise")
        }
        .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle())
        .help("Refresh live signals")
    }

    private var settingsButton: some View {
        Button {
            self.open(tab: .general)
        } label: {
            Image(systemName: "slider.horizontal.3")
        }
        .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle())
        .help("Open settings")
    }

    private func heroStatCard(value: String, label: String, tint: Color) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(value)
                .font(.system(size: 25, weight: .semibold, design: .rounded))
                .contentTransition(.numericText())
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(width: 86, alignment: .leading)
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(Color.white.opacity(0.44)))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(tint.opacity(0.30), lineWidth: 0.9))
    }

    private func startInterfaceBreathing() {
        guard !self.interfaceBreath else { return }
        withAnimation(.easeInOut(duration: 3.8).repeatForever(autoreverses: true)) {
            self.interfaceBreath = true
        }
    }

    private var summaryStrip: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Summary")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(self.summary.headline)
                    .font(.system(size: 28, weight: .semibold, design: .rounded))
                    .lineLimit(2)
                Text(self.summary.evidenceLine)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            HStack(spacing: 10) {
                self.metricChip(value: self.summary.activeCount, label: "Live")
                self.metricChip(value: self.summary.criticalCount, label: "Critical")
                self.metricChip(value: self.summary.watchCount, label: "Watch")
            }
        }
        .padding(18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var controlStrip: some View {
        HStack(spacing: 12) {
            Picker("Attention", selection: self.$attentionFilter) {
                ForEach(CorrectionWorkspaceAttentionFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 240)

            TextField("Search diagnosis or evidence", text: self.$searchText)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 240, maxWidth: 340)

            Spacer(minLength: 0)

            Button {
                Task { await self.refreshSignals() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
                    .labelStyle(.titleAndIcon)
            }
            .help("Refresh live signals")

            if let nextSyntheticRun = self.casebookSnapshot.nextSyntheticTrialRun() {
                Button {
                    self.requestSyntheticValidation()
                } label: {
                    HStack(spacing: 6) {
                        Image(systemName: self.syntheticTrialRunner.isRunning ? "hourglass" : "stethoscope")
                        Text(self.pendingSyntheticRunCount > 1 ? "Run \(self.pendingSyntheticRunCount)" : "Validate")
                            .fontWeight(.semibold)
                    }
                }
                .help(
                    self.pendingSyntheticRunCount > 1
                        ? "Run all \(self.pendingSyntheticRunCount) pending synthetic validation rounds. " +
                            "Next: \(nextSyntheticRun.templateLabel) round \(nextSyntheticRun.iteration) on \(nextSyntheticRun.syntheticBotLabel)."
                        : "Run \(nextSyntheticRun.templateLabel) round \(nextSyntheticRun.iteration) " +
                            "on \(nextSyntheticRun.syntheticBotLabel).")
                .disabled(self.syntheticTrialRunner.isRunning)
            }

            Button {
                self.requestAction(.openChat, issue: self.selectedIssue)
            } label: {
                Label("Open Chat", systemImage: "bubble.left.and.bubble.right")
                    .labelStyle(.titleAndIcon)
            }
            .help("Open agent chat")

            Button {
                self.open(tab: .general)
            } label: {
                Label("Settings", systemImage: "gearshape")
                    .labelStyle(.titleAndIcon)
            }
            .help("Open settings")
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var sidebarList: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Seats Needing Attention")
                    .font(.headline)
                Spacer()
                Text("\(self.filteredIssues.count)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            List(self.filteredIssues, id: \.id, selection: self.$selectedIssueID) { issue in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(issue.seat)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(issue.severity.title)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(issue.severity.color)
                    }
                    Text(issue.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(issue.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(.vertical, 6)
                .tag(issue.id)
            }
            .listStyle(.sidebar)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var simpleDetailColumn: some View {
        ScrollView {
            if let selectedIssue {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Detail / Intervention")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(selectedIssue.title)
                                .font(.system(size: 26, weight: .semibold, design: .rounded))
                                .lineLimit(2)
                            Text(selectedIssue.subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(selectedIssue.severity.title)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(selectedIssue.severity.color)
                    }

                    self.detailSection(title: "Prescription") {
                        Text(selectedIssue.prescription)
                            .font(.body)
                    }

                    if let roleAssessment = selectedIssue.professionalRoleAssessment {
                        self.detailSection(title: "Professional Role Contract") {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(roleAssessment.contract.title)
                                    .font(.headline)
                                Text(roleAssessment.contract.summary)
                                    .font(.body)
                                Text(roleAssessment.contract.mission)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                                Text(roleAssessment.contract.sourceLabel)
                                    .font(.caption)
                                    .foregroundStyle(.secondary)

                                if !roleAssessment.contract.behavioralConstitution.isEmpty {
                                    Divider()
                                    ForEach(roleAssessment.contract.behavioralConstitution.prefix(3), id: \.self) { line in
                                        Text("• \(line)")
                                            .font(.body)
                                    }
                                }

                                if !roleAssessment.contract.evidenceObligations.isEmpty {
                                    Divider()
                                    Text("Evidence obligations")
                                        .font(.subheadline.weight(.semibold))
                                    ForEach(roleAssessment.contract.evidenceObligations.prefix(3), id: \.self) { line in
                                        Text("• \(line)")
                                            .font(.body)
                                    }
                                }
                            }
                        }
                    }

                    if let roleAssessment = selectedIssue.professionalRoleAssessment {
                        self.detailSection(title: "Role Drift Assist") {
                            VStack(alignment: .leading, spacing: 10) {
                                Text(roleAssessment.drift.title)
                                    .font(.headline)
                                Text(roleAssessment.drift.detail)
                                    .font(.body)
                                ForEach(roleAssessment.drift.highlights.prefix(4), id: \.self) { line in
                                    Text("• \(line)")
                                        .font(.body)
                                }
                            }
                        }
                    }

                    self.detailSection(title: "Evidence Chain") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(selectedIssue.evidence, id: \.self) { line in
                                Text("• \(line)")
                                    .font(.body)
                            }
                        }
                    }

                    if !selectedIssue.history.isEmpty {
                        self.detailSection(title: "Case History") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(selectedIssue.history, id: \.self) { line in
                                    Text("• \(line)")
                                        .font(.body)
                                }
                            }
                        }
                    }

                    self.detailSection(title: "Intervention") {
                        HStack(spacing: 10) {
                            Button {
                                self.requestAction(selectedIssue.primaryAction, issue: selectedIssue)
                            } label: {
                                Label(selectedIssue.primaryAction.title, systemImage: selectedIssue.primaryAction.systemImage)
                            }
                            .buttonStyle(.borderedProminent)

                            if let secondaryAction = selectedIssue.secondaryAction {
                                Button {
                                    self.requestAction(secondaryAction, issue: selectedIssue)
                                } label: {
                                    Label(secondaryAction.title, systemImage: secondaryAction.systemImage)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            } else {
                ContentUnavailableView(
                    "No intervention selected",
                    systemImage: "cross.case",
                    description: Text("Choose a case on the left to inspect diagnosis, evidence, and treatment."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func metricChip(value: Int, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(value)")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private var attentionColumn: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Watchlist")
                        .font(.system(size: 21, weight: .semibold, design: .rounded))
                    Text(
                        self.selectedIssue?.seat
                            ?? (self.visibleIssues.isEmpty ? "Quiet" : self.sortMode.title))
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer()
                Text("\(self.visibleIssues.count)")
                    .font(.system(size: 26, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 8)
                    .background(Color.white.opacity(0.45), in: Capsule(style: .continuous))
            }

            if self.visibleIssues.isEmpty {
                self.watchlistEmptyState
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ScrollView {
                    LazyVStack(spacing: 10) {
                        ForEach(self.visibleIssues) { issue in
                            Button {
                                self.selectedIssueID = issue.id
                            } label: {
                                CorrectionWorkspaceIssueRow(
                                    issue: issue,
                                    isSelected: issue.id == self.selectedIssueID)
                            }
                            .buttonStyle(.plain)
                            .contentShape(RoundedRectangle(cornerRadius: 24, style: .continuous))
                            .scrollTransition(axis: .vertical) { content, phase in
                                content
                                    .scaleEffect(phase.isIdentity ? 1 : 0.985)
                                    .opacity(phase.isIdentity ? 1 : 0.76)
                                    .offset(y: phase.value * 16)
                            }
                        }
                    }
                    .padding(.top, 4)
                }
                .scrollIndicators(.hidden)
            }
        }
        .padding(18)
        .background(CorrectionWorkspacePanelBackground(tint: Color(red: 0.83, green: 0.90, blue: 1.00)))
    }

    private var watchlistEmptyState: some View {
        VStack(spacing: 14) {
            ZStack {
                Circle()
                    .fill(Color(red: 0.46, green: 0.75, blue: 0.58).opacity(0.14))
                    .frame(width: 68, height: 68)

                Image(systemName: "checkmark.circle.fill")
                    .font(.system(size: 26, weight: .semibold))
                    .foregroundStyle(Color(red: 0.46, green: 0.75, blue: 0.58))
            }

            VStack(spacing: 4) {
                Text("Quiet")
                    .font(.system(size: 22, weight: .semibold, design: .rounded))
                Text("No live cases")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, minHeight: 240)
        .background(
            RoundedRectangle(cornerRadius: 26, style: .continuous)
                .fill(Color.white.opacity(0.18))
                .overlay(
                    RoundedRectangle(cornerRadius: 26, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.16), lineWidth: 0.8)))
    }

    private var detailColumn: some View {
        VStack(alignment: .leading, spacing: 0) {
            if let selectedIssue {
                CorrectionWorkspaceDetail(
                    issue: selectedIssue,
                    canvasEnabled: self.state.canvasEnabled,
                    isResearching: self.researchInFlightCaseKeys.contains(self.researchCacheKey(for: selectedIssue)),
                    refreshResearch: selectedIssue.tracksCasebook && selectedIssue.severity != .healthy
                        ? {
                            Task { await self.ensureExternalResearchIfNeeded(for: selectedIssue, force: true) }
                        }
                        : nil,
                    runAction: { action in
                        self.requestAction(action, issue: selectedIssue)
                    })
            } else {
                ContentUnavailableView(
                    "No intervention selected",
                    systemImage: "cross.case",
                    description: Text("Choose a case on the left to inspect diagnosis, evidence, and treatment."))
                .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(18)
        .background(CorrectionWorkspacePanelBackground(tint: Color(red: 0.90, green: 0.94, blue: 1.00)))
    }

    private func syncSelection() {
        guard !self.visibleIssues.isEmpty else {
            self.selectedIssueID = nil
            return
        }
        if let selectedIssueID,
           self.visibleIssues.contains(where: { $0.id == selectedIssueID })
        {
            return
        }
        self.selectedIssueID = self.visibleIssues.first?.id
    }

    private func refreshSignals() async {
        await self.healthStore.refresh(onDemand: true)
        if self.controlChannel.state == .disconnected {
            await self.controlChannel.refreshEndpoint(reason: "correction-workspace-refresh")
        }
        if let sessionIdentitySnapshot = await SessionIdentityStore.loadSnapshot(limit: 200) {
            self.sessionIdentitySnapshot = sessionIdentitySnapshot
        }
        self.syncCasebook()
    }

    private func syncCasebook() {
        let inputs = self.allIssues
            .filter(\.tracksCasebook)
            .map(\.caseInput)
        self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.syncActiveCases(inputs)
    }

    @MainActor
    private func ensureExternalResearchIfNeeded(for issue: CorrectionWorkspaceIssue?, force: Bool = false) async {
        guard let issue,
              issue.tracksCasebook,
              issue.severity != .healthy
        else {
            return
        }

        let caseKey = self.researchCacheKey(for: issue)
        guard !self.researchInFlightCaseKeys.contains(caseKey) else {
            return
        }

        let query = self.externalResearchQuery(for: issue)
        guard force || self.shouldRefreshExternalResearch(for: issue, query: query) else {
            return
        }

        self.researchInFlightCaseKeys.insert(caseKey)
        defer { self.researchInFlightCaseKeys.remove(caseKey) }

        do {
            let result = try await CorrectionWebResearchStore.shared.research(query: query)
            self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.recordExternalResearch(
                subjectID: issue.subjectID,
                diagnosisID: issue.diagnosisID,
                query: result.query,
                summary: result.summary,
                items: result.items)
        } catch {
            let retainedItems =
                issue.runtimeEvidence?.externalResearchQuery?.localizedCaseInsensitiveCompare(query) == .orderedSame
                ? issue.runtimeEvidence?.externalResearchItems ?? []
                : []
            let retainedLine = retainedItems.isEmpty ? "" : " The last successful findings were retained."
            self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.recordExternalResearch(
                subjectID: issue.subjectID,
                diagnosisID: issue.diagnosisID,
                query: query,
                summary: "Web research refresh failed: \(error.localizedDescription).\(retainedLine)",
                items: retainedItems)
        }

        self.syncSelection()
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    private func requestAction(_ action: CorrectionWorkspaceAction, issue: CorrectionWorkspaceIssue? = nil) {
        if let confirmation = self.confirmation(for: action, issue: issue) {
            self.pendingDispatch = confirmation
            return
        }

        Task { await self.runAction(action, issue: issue) }
    }

    private func confirmation(
        for action: CorrectionWorkspaceAction,
        issue: CorrectionWorkspaceIssue?) -> CorrectionWorkspaceDispatchConfirmation?
    {
        switch action {
        case .refreshSignals, .openSettings, .openCanvas:
            return nil
        case .openChat:
            guard let issue,
                  issue.tracksCasebook,
                  issue.severity != .healthy,
                  let payload = self.interventionDispatchPrompt(for: issue)
            else {
                return nil
            }
            return CorrectionWorkspaceDispatchConfirmation(
                title: "Confirm intervention dispatch",
                systemImage: "paperplane",
                destinationTitle: issue.seat,
                destinationDetail: self.dispatchDestinationDetail(for: issue),
                payloadTitle: "What will be sent",
                payloadPreview: payload,
                confirmLabel: "Send intervention",
                command: .workspace(action: action, issue: issue))
        case let .recordOutcome(_, _, outcome):
            guard let issue else { return nil }
            let payload = [
                "Bot medical record update",
                "Seat: \(issue.seat)",
                "Diagnosis: \(issue.diagnosisLabel)",
                "Outcome: \(outcome.title)",
                "This will close the current recorded round in the casebook.",
            ].joined(separator: "\n")
            return CorrectionWorkspaceDispatchConfirmation(
                title: "Confirm casebook update",
                systemImage: action.systemImage,
                destinationTitle: "Bot medical record",
                destinationDetail: issue.seat,
                payloadTitle: "What will be recorded",
                payloadPreview: payload,
                confirmLabel: action.title,
                command: .workspace(action: action, issue: issue))
        }
    }

    private func requestSyntheticValidation() {
        guard let confirmation = self.syntheticValidationConfirmation() else {
            Task { await self.runSyntheticValidation() }
            return
        }
        self.pendingDispatch = confirmation
    }

    private func syntheticValidationConfirmation() -> CorrectionWorkspaceDispatchConfirmation? {
        guard let plan = self.casebookSnapshot.nextSyntheticTrialRun() else { return nil }
        let destinationTitle = self.pendingSyntheticRunCount > 1 ? "Synthetic validation queue" : plan.syntheticBotLabel
        let destinationDetail = self.pendingSyntheticRunCount > 1
            ? "\(self.pendingSyntheticRunCount) queued randomized run(s) will execute sequentially."
            : plan.profileSummary
        let payloadPreview: String
        if let context = CorrectionSyntheticTrialRunner.context(templateID: plan.templateID, casebook: self.casebookSnapshot) {
            let prompt = CorrectionSyntheticTrialRunner.buildPrompt(plan: plan, context: context)
            if self.pendingSyntheticRunCount > 1 {
                payloadPreview = """
                First queued validation prompt:

                \(prompt)

                Remaining queued runs will use the matching casebook-derived prompt for each template and iteration, then write pass/fail back into the casebook.
                """
            } else {
                payloadPreview = prompt
            }
        } else {
            payloadPreview = [
                "Template: \(plan.templateLabel)",
                "Round: \(plan.iteration)",
                "Synthetic bot: \(plan.syntheticBotLabel)",
                plan.profileSummary,
                "The app will derive the validation prompt from the current casebook evidence, wait for the reply, score the result, and record it into the casebook.",
            ].joined(separator: "\n")
        }

        return CorrectionWorkspaceDispatchConfirmation(
            title: self.pendingSyntheticRunCount > 1 ? "Confirm validation queue" : "Confirm synthetic validation",
            systemImage: "stethoscope",
            destinationTitle: destinationTitle,
            destinationDetail: destinationDetail,
            payloadTitle: self.pendingSyntheticRunCount > 1 ? "First queued prompt" : "Validation prompt",
            payloadPreview: payloadPreview,
            confirmLabel: self.pendingSyntheticRunCount > 1 ? "Run queue" : "Run trial",
            command: .syntheticValidation)
    }

    private func performDispatch(_ confirmation: CorrectionWorkspaceDispatchConfirmation) async {
        switch confirmation.command {
        case let .workspace(action, issue):
            await self.runAction(action, issue: issue)
        case .syntheticValidation:
            await self.runSyntheticValidation()
        }
    }

    private func runAction(_ action: CorrectionWorkspaceAction, issue: CorrectionWorkspaceIssue? = nil) async {
        switch action {
        case .refreshSignals:
            await self.refreshSignals()
        case .openChat:
            await self.openInterventionChat(issue: issue)
        case let .openSettings(tab):
            await MainActor.run {
                self.open(tab: tab)
            }
        case .openCanvas:
            guard self.state.canvasEnabled else { return }
            let sessionKey = await GatewayConnection.shared.mainSessionKey()
            _ = try? await MainActor.run {
                try CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
            }
        case let .recordOutcome(subjectID, diagnosisID, outcome):
            self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.recordOutcome(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                outcome: outcome)
            self.syncSelection()
        }
    }

    private func openInterventionChat(issue: CorrectionWorkspaceIssue?) async {
        let sessionKey: String
        if let dispatchSessionKey = issue?.dispatchSessionKey?.nonEmpty {
            sessionKey = dispatchSessionKey
        } else {
            sessionKey = await WebChatManager.shared.preferredSessionKey()
        }

        if let issue,
           let payload = self.interventionDispatchPrompt(for: issue)
        {
            do {
                _ = try await GatewayConnection.shared.chatSend(
                    sessionKey: sessionKey,
                    message: payload,
                    thinking: "medium",
                    idempotencyKey: UUID().uuidString.lowercased(),
                    attachments: [],
                    timeoutMs: 45_000)
                self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.recordInterventionDispatch(
                    subjectID: issue.subjectID,
                    diagnosisID: issue.diagnosisID,
                    summary: self.interventionDispatchSummary(for: issue))
                self.syncSelection()
            } catch {
                SessionActions.presentError(title: "Intervention dispatch failed", error: error)
            }
        }

        await MainActor.run {
            WebChatManager.shared.show(sessionKey: sessionKey, mode: .chat)
        }
    }

    private func interventionDispatchPrompt(for issue: CorrectionWorkspaceIssue) -> String? {
        guard issue.tracksCasebook, issue.severity != .healthy else {
            return nil
        }

        var lines: [String] = [
            "Correction dispatch for \(issue.seat).",
            "",
            "Diagnosis: \(issue.diagnosisLabel)",
            "Observed state: \(issue.title)",
            "Required intervention: \(issue.prescription)",
        ]

        if let likelyRootCause = issue.likelyRootCause?.nonEmpty {
            lines.append("Likely root cause: \(likelyRootCause)")
        }
        if let casebookGuidance = issue.casebookGuidance {
            lines.append("Casebook guidance: \(casebookGuidance.title). \(casebookGuidance.detail)")
        }
        if let runtimeTruth = issue.runtimeTruth {
            lines.append("Runtime truth: \(runtimeTruth.title). \(runtimeTruth.detail)")
        }
        if let templateValidation = issue.templateValidation {
            lines.append("Template validation: \(templateValidation.title). \(templateValidation.detail)")
        }
        if let roleAssessment = issue.professionalRoleAssessment {
            lines.append("Professional role contract: \(roleAssessment.contract.title). \(roleAssessment.contract.summary)")
            lines.append("Role drift assist: \(roleAssessment.drift.title). \(roleAssessment.drift.detail)")
        }

        lines.append("")
        lines.append("Evidence chain:")
        for line in issue.evidence.prefix(5) {
            lines.append("- \(line)")
        }

        if !issue.history.isEmpty {
            lines.append("")
            lines.append("Recorded history:")
            for line in issue.history.prefix(3) {
                lines.append("- \(line)")
            }
        }

        if let similarCases = issue.similarCases {
            lines.append("")
            lines.append("Similar cases / research:")
            lines.append("- \(similarCases.detail)")
            for line in similarCases.highlights.prefix(3) {
                lines.append("- \(line)")
            }
        }

        if let roleAssessment = issue.professionalRoleAssessment {
            lines.append("")
            lines.append("Professional role obligations:")
            for line in roleAssessment.contract.behavioralConstitution.prefix(2) {
                lines.append("- \(line)")
            }
            for line in roleAssessment.contract.evidenceObligations.prefix(2) {
                lines.append("- \(line)")
            }
            for line in roleAssessment.drift.highlights.prefix(2) {
                lines.append("- \(line)")
            }
        }

        if let externalResearchItems = issue.runtimeEvidence?.externalResearchItems,
           !externalResearchItems.isEmpty
        {
            lines.append("")
            lines.append("External web findings:")
            for item in externalResearchItems.prefix(3) {
                let snippet = item.snippet.nonEmpty.map { " \($0)" } ?? ""
                lines.append("- \(item.title) (\(item.source)): \(item.url)\(snippet)")
            }
        }

        lines.append("")
        lines.append("Apply the correction now and reply with one concise intervention note that:")
        lines.append("1. Names the failure mode precisely.")
        lines.append("2. Uses the evidence instead of generic reassurance.")
        lines.append("3. States the concrete corrective action you are taking.")
        lines.append("4. Ends with one verifiable checkpoint or artifact.")

        return lines.joined(separator: "\n")
    }

    private func interventionDispatchSummary(for issue: CorrectionWorkspaceIssue) -> String {
        let remedy = issue.remedyTemplateLabel?.nonEmpty ?? issue.remedyTemplateID?.nonEmpty ?? "manual intervention"
        return "\(remedy): \(issue.prescription)"
    }

    private func dispatchDestinationDetail(for issue: CorrectionWorkspaceIssue) -> String {
        if let dispatchSessionKey = issue.dispatchSessionKey?.nonEmpty {
            return "Session \(dispatchSessionKey)"
        }
        return "Preferred live chat lane"
    }

    private func runNextSyntheticTrial() async {
        do {
            guard let result = try await self.syntheticTrialRunner.runNext(casebook: self.casebookSnapshot) else {
                return
            }
            self.casebookSnapshot = result.snapshot
            self.syncSelection()
        } catch {
            SessionActions.presentError(title: "Synthetic validation failed", error: error)
        }
    }

    private func runSyntheticValidation() async {
        if self.pendingSyntheticRunCount > 1 {
            await self.runSyntheticQueue()
        } else {
            await self.runNextSyntheticTrial()
        }
    }

    private func runSyntheticQueue() async {
        do {
            guard let result = try await self.syntheticTrialRunner.runPending(casebook: self.casebookSnapshot) else {
                return
            }
            self.casebookSnapshot = result.snapshot
            self.syncSelection()
        } catch {
            SessionActions.presentError(title: "Synthetic validation queue failed", error: error)
        }
    }

    private func researchCacheKey(for issue: CorrectionWorkspaceIssue) -> String {
        "\(issue.subjectID)|\(issue.diagnosisID)|\(issue.observationFingerprint)"
    }

    private func shouldRefreshExternalResearch(for issue: CorrectionWorkspaceIssue, query: String) -> Bool {
        guard !query.isEmpty else { return false }

        let currentEvidence = issue.runtimeEvidence
        guard let fetchedAtMs = currentEvidence?.externalResearchFetchedAtMs else {
            return true
        }

        if currentEvidence?.externalResearchQuery?.localizedCaseInsensitiveCompare(query) != .orderedSame {
            return true
        }

        let fetchedAt = Date(timeIntervalSince1970: Double(fetchedAtMs) / 1000)
        let age = Date().timeIntervalSince(fetchedAt)
        let hasItems = currentEvidence?.externalResearchItems.isEmpty == false
        let retryInterval: TimeInterval = hasItems ? 12 * 60 * 60 : 30 * 60
        return age >= retryInterval
    }

    private func externalResearchQuery(for issue: CorrectionWorkspaceIssue) -> String {
        var phrases = ["llm agent bot"]
        if let diagnosis = Self.searchQueryFragment(issue.diagnosisLabel) {
            phrases.append(diagnosis)
        }
        if let rootCause = Self.searchQueryFragment(issue.likelyRootCause) {
            phrases.append(rootCause)
        }
        if let evidenceLine = Self.searchQueryFragment(issue.evidence.first) {
            phrases.append(evidenceLine)
        }

        let diagnosisID = issue.diagnosisID.lowercased()
        if diagnosisID.contains("stall") {
            phrases.append("stalled no output task completion verified artifact")
        }
        if diagnosisID.contains("halluc") {
            phrases.append("hallucination fabricated answer citation")
        }
        if diagnosisID.contains("evidence") || diagnosisID.contains("artifact") {
            phrases.append("delivery proof missing artifact")
        }
        if diagnosisID.contains("control") || diagnosisID.contains("gateway") {
            phrases.append("agent control channel reliability")
        }
        if diagnosisID.contains("heartbeat") {
            phrases.append("watchdog heartbeat missing monitoring")
        }
        if diagnosisID.contains("pairing") {
            phrases.append("tool access blocked approval")
        }

        let uniquePhrases = Self.uniqueOrdered(phrases)
        let query = uniquePhrases.joined(separator: " ")
        if query.count <= 220 {
            return query
        }
        let cutoff = query.index(query.startIndex, offsetBy: 220)
        return String(query[..<cutoff]).trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private static func uniqueOrdered(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        var ordered: [String] = []
        for value in values {
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty else { continue }
            let key = normalized.lowercased()
            if seen.insert(key).inserted {
                ordered.append(normalized)
            }
        }
        return ordered
    }

    private static func searchQueryFragment(_ value: String?) -> String? {
        guard let value = value?.nonEmpty else { return nil }
        let cleaned = value
            .replacingOccurrences(of: #"[^[:alnum:]\s]+"#, with: " ", options: .regularExpression)
            .split(whereSeparator: \.isWhitespace)
            .prefix(10)
            .joined(separator: " ")
        return cleaned.nonEmpty
    }
}

struct CorrectionWorkspaceStableView: View {
    @Bindable var state: AppState

    private let healthStore = HealthStore.shared
    private let heartbeatStore = HeartbeatStore.shared
    private let activityStore = WorkActivityStore.shared
    private let controlChannel = ControlChannel.shared
    private let pairingPrompter = NodePairingApprovalPrompter.shared
    private let devicePairingPrompter = DevicePairingApprovalPrompter.shared
    private let agentEventStore = AgentEventStore.shared
    private let syntheticTrialRunner = CorrectionSyntheticTrialRunner.shared

    @State private var allIssues: [CorrectionWorkspaceIssue] = []
    @State private var selectedIssueID: CorrectionWorkspaceIssue.ID?
    @State private var attentionFilter: CorrectionWorkspaceAttentionFilter = .all
    @State private var searchText = ""
    @State private var casebookSnapshot: OpenClawKit.CorrectionCasebookSnapshot =
        OpenClawKit.CorrectionCasebookStore.load()
    @State private var sessionIdentitySnapshot: SessionIdentitySnapshot = .empty

    private var filteredIssues: [CorrectionWorkspaceIssue] {
        self.allIssues.filter { issue in
            guard self.attentionFilter.matches(issue) else { return false }
            let query = self.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { return true }
            return issue.searchBlob.localizedCaseInsensitiveContains(query)
        }
    }

    private var selectedIssue: CorrectionWorkspaceIssue? {
        if let selectedIssueID {
            return self.filteredIssues.first(where: { $0.id == selectedIssueID })
                ?? self.allIssues.first(where: { $0.id == selectedIssueID })
        }
        return self.filteredIssues.first
    }

    private var summary: CorrectionWorkspaceSummary {
        CorrectionWorkspaceSummary(
            issues: self.allIssues,
            casebook: self.casebookSnapshot,
            runnerSummary: self.syntheticTrialRunner.lastRunSummary,
            batchProgress: self.syntheticTrialRunner.batchProgress,
            currentPlan: self.syntheticTrialRunner.currentPlan)
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.summaryStrip
            self.controlStrip
            HSplitView {
                self.sidebarList
                    .frame(minWidth: 300, idealWidth: 340, maxWidth: 380, maxHeight: .infinity)
                self.detailColumn
                    .frame(minWidth: 560, maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .background(Color(nsColor: .windowBackgroundColor))
        .task {
            await self.refresh()
        }
        .onChange(of: self.attentionFilter) { _, _ in
            self.syncSelection()
        }
        .onChange(of: self.searchText) { _, _ in
            self.syncSelection()
        }
    }

    private var summaryStrip: some View {
        HStack(alignment: .top, spacing: 16) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Summary")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(self.summary.headline)
                    .font(.system(size: 28, weight: .semibold, design: .rounded))
                    .lineLimit(2)
                Text(self.summary.evidenceLine)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                Text(self.summary.focusLine)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            HStack(spacing: 10) {
                self.metricChip(value: self.summary.activeCount, label: "Live")
                self.metricChip(value: self.summary.criticalCount, label: "Critical")
                self.metricChip(value: self.summary.watchCount, label: "Watch")
            }
        }
        .padding(18)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))
    }

    private var controlStrip: some View {
        HStack(spacing: 12) {
            Picker("Attention", selection: self.$attentionFilter) {
                ForEach(CorrectionWorkspaceAttentionFilter.allCases) { filter in
                    Text(filter.title).tag(filter)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 240)

            TextField("Search diagnosis or evidence", text: self.$searchText)
                .textFieldStyle(.roundedBorder)
                .frame(minWidth: 240, maxWidth: 340)

            Spacer(minLength: 0)

            Button {
                Task { await self.refresh() }
            } label: {
                Label("Refresh", systemImage: "arrow.clockwise")
            }
            .buttonStyle(.bordered)

            Button {
                Task { await self.openInterventionChat(for: self.selectedIssue) }
            } label: {
                Label("Open Chat", systemImage: "bubble.left.and.bubble.right")
            }
            .buttonStyle(.borderedProminent)
            .disabled(self.selectedIssue == nil)

            Button {
                self.open(tab: .general)
            } label: {
                Label("Settings", systemImage: "gearshape")
            }
            .buttonStyle(.bordered)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var sidebarList: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Seats Needing Attention")
                    .font(.headline)
                Spacer()
                Text("\(self.filteredIssues.count)")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
            }

            List(self.filteredIssues, id: \.id, selection: self.$selectedIssueID) { issue in
                VStack(alignment: .leading, spacing: 6) {
                    HStack {
                        Text(issue.seat)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer()
                        Text(issue.severity.title)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(issue.severity.color)
                    }
                    Text(issue.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                        .lineLimit(2)
                    Text(issue.subtitle)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                .padding(.vertical, 6)
                .tag(issue.id)
            }
            .listStyle(.sidebar)
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private var detailColumn: some View {
        ScrollView {
            if let selectedIssue {
                VStack(alignment: .leading, spacing: 18) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Detail / Intervention")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(selectedIssue.title)
                                .font(.system(size: 26, weight: .semibold, design: .rounded))
                                .lineLimit(2)
                            Text(selectedIssue.subtitle)
                                .font(.subheadline)
                                .foregroundStyle(.secondary)
                        }
                        Spacer()
                        Text(selectedIssue.severity.title)
                            .font(.caption.weight(.bold))
                            .foregroundStyle(selectedIssue.severity.color)
                    }

                    self.detailSection(title: "Prescription") {
                        Text(selectedIssue.prescription)
                            .font(.body)
                    }

                    self.detailSection(title: "Evidence Chain") {
                        VStack(alignment: .leading, spacing: 8) {
                            ForEach(selectedIssue.evidence, id: \.self) { line in
                                Text("• \(line)")
                                    .font(.body)
                            }
                        }
                    }

                    if !selectedIssue.history.isEmpty {
                        self.detailSection(title: "Case History") {
                            VStack(alignment: .leading, spacing: 8) {
                                ForEach(selectedIssue.history, id: \.self) { line in
                                    Text("• \(line)")
                                        .font(.body)
                                }
                            }
                        }
                    }

                    self.detailSection(title: "Intervention") {
                        HStack(spacing: 10) {
                            Button {
                                Task { await self.runAction(selectedIssue.primaryAction, issue: selectedIssue) }
                            } label: {
                                Label(selectedIssue.primaryAction.title, systemImage: selectedIssue.primaryAction.systemImage)
                            }
                            .buttonStyle(.borderedProminent)

                            if let secondaryAction = selectedIssue.secondaryAction {
                                Button {
                                    Task { await self.runAction(secondaryAction, issue: selectedIssue) }
                                } label: {
                                    Label(secondaryAction.title, systemImage: secondaryAction.systemImage)
                                }
                                .buttonStyle(.bordered)
                            }
                        }
                    }
                }
            } else {
                ContentUnavailableView(
                    "No intervention selected",
                    systemImage: "cross.case",
                    description: Text("Choose a case on the left to inspect diagnosis, evidence, and treatment."))
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .padding(16)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }

    private func metricChip(value: Int, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(value)")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func syncSelection() {
        guard !self.filteredIssues.isEmpty else {
            self.selectedIssueID = nil
            return
        }
        if let selectedIssueID,
           self.filteredIssues.contains(where: { $0.id == selectedIssueID })
        {
            return
        }
        self.selectedIssueID = self.filteredIssues.first?.id
    }

    private func rebuildIssues() {
        let initialIssues = CorrectionWorkspaceIssueBuilder.build(
            state: self.state,
            healthStore: self.healthStore,
            heartbeatStore: self.heartbeatStore,
            activityStore: self.activityStore,
            agentEventStore: self.agentEventStore,
            controlChannel: self.controlChannel,
            pairingPrompter: self.pairingPrompter,
            devicePairingPrompter: self.devicePairingPrompter,
            sessionIdentities: self.sessionIdentitySnapshot,
            casebook: self.casebookSnapshot)
        self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.syncActiveCases(
            initialIssues.filter(\.tracksCasebook).map(\.caseInput))
        self.allIssues = CorrectionWorkspaceIssueBuilder.build(
            state: self.state,
            healthStore: self.healthStore,
            heartbeatStore: self.heartbeatStore,
            activityStore: self.activityStore,
            agentEventStore: self.agentEventStore,
            controlChannel: self.controlChannel,
            pairingPrompter: self.pairingPrompter,
            devicePairingPrompter: self.devicePairingPrompter,
            sessionIdentities: self.sessionIdentitySnapshot,
            casebook: self.casebookSnapshot)
        self.syncSelection()
    }

    private func refresh() async {
        await self.healthStore.refresh(onDemand: true)
        if self.controlChannel.state == .disconnected {
            await self.controlChannel.refreshEndpoint(reason: "correction-workspace-refresh")
        }
        if let sessionIdentitySnapshot = await SessionIdentityStore.loadSnapshot(limit: 200) {
            self.sessionIdentitySnapshot = sessionIdentitySnapshot
        }
        self.rebuildIssues()
    }

    private func open(tab: SettingsTab) {
        SettingsTabRouter.request(tab)
        SettingsWindowOpener.shared.open()
        DispatchQueue.main.async {
            NotificationCenter.default.post(name: .openclawSelectSettingsTab, object: tab)
        }
    }

    private func runAction(_ action: CorrectionWorkspaceAction, issue: CorrectionWorkspaceIssue?) async {
        switch action {
        case .refreshSignals:
            await self.refresh()
        case .openChat:
            await self.openInterventionChat(for: issue)
        case let .openSettings(tab):
            await MainActor.run {
                self.open(tab: tab)
            }
        case .openCanvas:
            guard self.state.canvasEnabled else { return }
            let sessionKey = await GatewayConnection.shared.mainSessionKey()
            _ = try? await MainActor.run {
                try CanvasManager.shared.show(sessionKey: sessionKey, path: nil)
            }
        case let .recordOutcome(subjectID, diagnosisID, outcome):
            self.casebookSnapshot = OpenClawKit.CorrectionCasebookStore.recordOutcome(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                outcome: outcome)
            self.rebuildIssues()
        }
    }

    private func openInterventionChat(for issue: CorrectionWorkspaceIssue?) async {
        let sessionKey: String
        if let dispatchSessionKey = issue?.dispatchSessionKey?.nonEmpty {
            sessionKey = dispatchSessionKey
        } else {
            sessionKey = await WebChatManager.shared.preferredSessionKey()
        }
        await MainActor.run {
            WebChatManager.shared.show(sessionKey: sessionKey, mode: .chat)
        }
    }
}

struct CorrectionWorkspacePreviewView: View {
    @Bindable var state: AppState

    private let healthStore = HealthStore.shared
    private let heartbeatStore = HeartbeatStore.shared
    private let activityStore = WorkActivityStore.shared
    private let controlChannel = ControlChannel.shared
    private let pairingPrompter = NodePairingApprovalPrompter.shared
    private let devicePairingPrompter = DevicePairingApprovalPrompter.shared
    private let agentEventStore = AgentEventStore.shared

    @State private var selectedIssueID: CorrectionWorkspaceIssue.ID?
    @State private var attentionFilter: CorrectionWorkspaceAttentionFilter = .all
    @State private var searchText = ""

    private var casebookSnapshot: OpenClawKit.CorrectionCasebookSnapshot {
        OpenClawKit.CorrectionCasebookStore.load()
    }

    private var allIssues: [CorrectionWorkspaceIssue] {
        CorrectionWorkspaceIssueBuilder.build(
            state: self.state,
            healthStore: self.healthStore,
            heartbeatStore: self.heartbeatStore,
            activityStore: self.activityStore,
            agentEventStore: self.agentEventStore,
            controlChannel: self.controlChannel,
            pairingPrompter: self.pairingPrompter,
            devicePairingPrompter: self.devicePairingPrompter,
            sessionIdentities: .empty,
            casebook: self.casebookSnapshot)
    }

    private var filteredIssues: [CorrectionWorkspaceIssue] {
        self.allIssues.filter { issue in
            guard self.attentionFilter.matches(issue) else { return false }
            let query = self.searchText.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !query.isEmpty else { return true }
            return issue.searchBlob.localizedCaseInsensitiveContains(query)
        }
    }

    private var selectedIssue: CorrectionWorkspaceIssue? {
        if let selectedIssueID {
            return self.filteredIssues.first(where: { $0.id == selectedIssueID })
                ?? self.allIssues.first(where: { $0.id == selectedIssueID })
        }
        return self.filteredIssues.first
    }

    private var summary: CorrectionWorkspaceSummary {
        CorrectionWorkspaceSummary(
            issues: self.allIssues,
            casebook: self.casebookSnapshot,
            runnerSummary: nil,
            batchProgress: nil,
            currentPlan: nil)
    }

    private var selectionFingerprint: String {
        self.filteredIssues.map(\.id).joined(separator: "|")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            HStack(alignment: .top, spacing: 16) {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Summary")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(self.summary.headline)
                        .font(.system(size: 28, weight: .semibold, design: .rounded))
                        .lineLimit(2)
                    Text(self.summary.evidenceLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }
                Spacer(minLength: 0)
                HStack(spacing: 10) {
                    self.metricChip(value: self.summary.activeCount, label: "Live")
                    self.metricChip(value: self.summary.criticalCount, label: "Critical")
                    self.metricChip(value: self.summary.watchCount, label: "Watch")
                }
            }
            .padding(18)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 20, style: .continuous))

            HStack(spacing: 12) {
                Picker("Attention", selection: self.$attentionFilter) {
                    ForEach(CorrectionWorkspaceAttentionFilter.allCases) { filter in
                        Text(filter.title).tag(filter)
                    }
                }
                .pickerStyle(.segmented)
                .frame(width: 240)

                TextField("Search diagnosis or evidence", text: self.$searchText)
                    .textFieldStyle(.roundedBorder)
                    .frame(minWidth: 240, maxWidth: 340)

                Spacer(minLength: 0)

                Button {
                    let sessionKey = WebChatManager.shared.preferredSessionKeyImmediate()
                    WebChatManager.shared.show(sessionKey: sessionKey, mode: .chat)
                    WebChatManager.shared.warmPreferredSessionKey()
                } label: {
                    Label("Open Chat", systemImage: "bubble.left.and.bubble.right")
                }
                .buttonStyle(.borderedProminent)

                Button {
                    SettingsTabRouter.request(.general)
                    SettingsWindowOpener.shared.open()
                } label: {
                    Label("Settings", systemImage: "gearshape")
                }
                .buttonStyle(.bordered)
            }
            .padding(16)
            .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            HSplitView {
                VStack(alignment: .leading, spacing: 12) {
                    HStack {
                        Text("Seats Needing Attention")
                            .font(.headline)
                        Spacer()
                        Text("\(self.filteredIssues.count)")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }

                    List(self.filteredIssues, id: \.id, selection: self.$selectedIssueID) { issue in
                        VStack(alignment: .leading, spacing: 6) {
                            HStack {
                                Text(issue.seat)
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Text(issue.severity.title)
                                    .font(.caption2.weight(.bold))
                                    .foregroundStyle(issue.severity.color)
                            }
                            Text(issue.title)
                                .font(.body.weight(.semibold))
                                .foregroundStyle(.primary)
                                .lineLimit(2)
                            Text(issue.subtitle)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }
                        .padding(.vertical, 6)
                        .tag(issue.id)
                    }
                    .listStyle(.sidebar)
                }
                .padding(16)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(minWidth: 300, idealWidth: 340, maxWidth: 380, maxHeight: .infinity)

                ScrollView {
                    if let selectedIssue {
                        VStack(alignment: .leading, spacing: 18) {
                            VStack(alignment: .leading, spacing: 6) {
                                Text("Detail / Intervention")
                                    .font(.caption.weight(.semibold))
                                    .foregroundStyle(.secondary)
                                Text(selectedIssue.title)
                                    .font(.system(size: 26, weight: .semibold, design: .rounded))
                                    .lineLimit(2)
                                Text(selectedIssue.subtitle)
                                    .font(.subheadline)
                                    .foregroundStyle(.secondary)
                            }

                            self.detailSection(title: "Prescription") {
                                Text(selectedIssue.prescription)
                            }

                            self.detailSection(title: "Evidence Chain") {
                                VStack(alignment: .leading, spacing: 8) {
                                    ForEach(selectedIssue.evidence, id: \.self) { line in
                                        Text("• \(line)")
                                    }
                                }
                            }

                            if !selectedIssue.history.isEmpty {
                                self.detailSection(title: "Case History") {
                                    VStack(alignment: .leading, spacing: 8) {
                                        ForEach(selectedIssue.history, id: \.self) { line in
                                            Text("• \(line)")
                                        }
                                    }
                                }
                            }
                        }
                    } else {
                        ContentUnavailableView(
                            "No intervention selected",
                            systemImage: "cross.case",
                            description: Text("Choose a case on the left to inspect diagnosis, evidence, and treatment."))
                            .frame(maxWidth: .infinity, maxHeight: .infinity)
                    }
                }
                .padding(16)
                .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
                .frame(minWidth: 560, maxWidth: .infinity, maxHeight: .infinity)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
        .padding(20)
        .background(Color(nsColor: .windowBackgroundColor))
        .onAppear {
            self.syncSelection()
        }
        .onChange(of: self.attentionFilter) { _, _ in
            self.syncSelection()
        }
        .onChange(of: self.searchText) { _, _ in
            self.syncSelection()
        }
        .onChange(of: self.selectionFingerprint) { _, _ in
            self.syncSelection()
        }
    }

    private func metricChip(value: Int, label: String) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("\(value)")
                .font(.system(size: 24, weight: .semibold, design: .rounded))
            Text(label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
        .background(Color.secondary.opacity(0.08), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func detailSection<Content: View>(title: String, @ViewBuilder content: () -> Content) -> some View {
        VStack(alignment: .leading, spacing: 10) {
            Text(title)
                .font(.headline)
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(Color.secondary.opacity(0.06), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
    }

    private func syncSelection() {
        guard !self.filteredIssues.isEmpty else {
            self.selectedIssueID = nil
            return
        }
        if let selectedIssueID,
           self.filteredIssues.contains(where: { $0.id == selectedIssueID })
        {
            return
        }
        self.selectedIssueID = self.filteredIssues.first?.id
    }
}

private enum CorrectionWorkspaceAttentionFilter: String, CaseIterable, Identifiable {
    case all
    case critical
    case watch

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .all: "All"
        case .critical: "Critical"
        case .watch: "Watch"
        }
    }

    func matches(_ issue: CorrectionWorkspaceIssue) -> Bool {
        switch self {
        case .all:
            issue.severity != .healthy
        case .critical:
            issue.severity == .critical
        case .watch:
            issue.severity == .watch || issue.severity == .warning
        }
    }
}

enum CorrectionWorkspaceSortMode: String, CaseIterable, Identifiable {
    case urgency
    case seat
    case diagnosis

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .urgency:
            "Urgency"
        case .seat:
            "Seat"
        case .diagnosis:
            "Diagnosis"
        }
    }

    var systemImage: String {
        switch self {
        case .urgency:
            "exclamationmark.triangle"
        case .seat:
            "square.grid.2x2"
        case .diagnosis:
            "text.magnifyingglass"
        }
    }

    static func sorted(_ issues: [CorrectionWorkspaceIssue], by mode: Self) -> [CorrectionWorkspaceIssue] {
        issues.sorted { lhs, rhs in
            switch mode {
            case .urgency:
                let severityCompare = Self.severityRank(lhs.severity) - Self.severityRank(rhs.severity)
                if severityCompare != 0 {
                    return severityCompare < 0
                }
                if lhs.tracksCasebook != rhs.tracksCasebook {
                    return lhs.tracksCasebook && !rhs.tracksCasebook
                }
                let evidenceCompare = lhs.evidence.count - rhs.evidence.count
                if evidenceCompare != 0 {
                    return evidenceCompare > 0
                }
                return Self.localizedAscending(lhs.seat, rhs.seat, fallbackLeft: lhs.title, fallbackRight: rhs.title)
            case .seat:
                if lhs.seat.localizedCaseInsensitiveCompare(rhs.seat) != .orderedSame {
                    return lhs.seat.localizedCaseInsensitiveCompare(rhs.seat) == .orderedAscending
                }
                let severityCompare = Self.severityRank(lhs.severity) - Self.severityRank(rhs.severity)
                if severityCompare != 0 {
                    return severityCompare < 0
                }
                return lhs.title.localizedCaseInsensitiveCompare(rhs.title) == .orderedAscending
            case .diagnosis:
                if lhs.diagnosisLabel.localizedCaseInsensitiveCompare(rhs.diagnosisLabel) != .orderedSame {
                    return lhs.diagnosisLabel.localizedCaseInsensitiveCompare(rhs.diagnosisLabel) == .orderedAscending
                }
                let severityCompare = Self.severityRank(lhs.severity) - Self.severityRank(rhs.severity)
                if severityCompare != 0 {
                    return severityCompare < 0
                }
                return lhs.seat.localizedCaseInsensitiveCompare(rhs.seat) == .orderedAscending
            }
        }
    }

    private static func severityRank(_ severity: CorrectionWorkspaceIssue.Severity) -> Int {
        switch severity {
        case .critical:
            0
        case .warning:
            1
        case .watch:
            2
        case .healthy:
            3
        }
    }

    private static func localizedAscending(
        _ left: String,
        _ right: String,
        fallbackLeft: String,
        fallbackRight: String) -> Bool
    {
        let primary = left.localizedCaseInsensitiveCompare(right)
        if primary != .orderedSame {
            return primary == .orderedAscending
        }
        return fallbackLeft.localizedCaseInsensitiveCompare(fallbackRight) == .orderedAscending
    }
}

struct CorrectionWorkspaceSortMenu: View {
    @Binding var sortMode: CorrectionWorkspaceSortMode

    var body: some View {
        Menu {
            Picker("Sort by", selection: self.$sortMode) {
                ForEach(CorrectionWorkspaceSortMode.allCases) { mode in
                    Label(mode.title, systemImage: mode.systemImage)
                        .tag(mode)
                }
            }
        } label: {
            Label(self.sortMode.title, systemImage: "arrow.up.arrow.down")
                .labelStyle(.titleAndIcon)
        }
        .menuStyle(.borderlessButton)
        .fixedSize()
        .accessibilityLabel("Sort cases")
        .accessibilityValue(self.sortMode.title)
        .help("Sort seats needing attention by \(self.sortMode.title.lowercased()).")
    }
}

enum CorrectionWorkspaceAction: Hashable {
    case refreshSignals
    case openChat
    case openSettings(SettingsTab)
    case openCanvas
    case recordOutcome(subjectID: String, diagnosisID: String, outcome: OpenClawKit.CorrectionOutcome)

    var title: String {
        switch self {
        case .refreshSignals: "Refresh signals"
        case .openChat: "Open intervention chat"
        case .openSettings: "Review settings"
        case .openCanvas: "Open evidence canvas"
        case let .recordOutcome(_, _, outcome):
            "Mark \(outcome.title.lowercased())"
        }
    }

    var systemImage: String {
        switch self {
        case .refreshSignals: "arrow.clockwise"
        case .openChat: "bubble.left.and.bubble.right"
        case .openSettings: "gearshape"
        case .openCanvas: "rectangle.inset.filled.on.rectangle"
        case let .recordOutcome(_, _, outcome):
            switch outcome {
            case .resolved: "checkmark.circle"
            case .failed: "xmark.circle"
            case .superseded: "arrow.triangle.branch"
            }
        }
    }
}

struct CorrectionWorkspaceStatusSnapshot: Hashable {
    let title: String
    let detail: String
    let systemImage: String
}

struct CorrectionWorkspaceProgressSnapshot: Hashable {
    let title: String
    let detail: String
    let highlights: [String]
    let systemImage: String
}

struct CorrectionWorkspaceResearchSnapshot: Hashable {
    let title: String
    let detail: String
    let highlights: [String]
    let sources: [CorrectionWorkspaceResearchSourceSnapshot]
    let systemImage: String
}

struct CorrectionWorkspaceLoopStageSnapshot: Hashable, Identifiable {
    enum State: Hashable {
        case complete
        case active
        case pending
        case inactive

        var title: String {
            switch self {
            case .complete: "Done"
            case .active: "Live"
            case .pending: "Next"
            case .inactive: "Manual"
            }
        }

        var tint: Color {
            switch self {
            case .complete:
                Color(red: 0.41, green: 0.74, blue: 0.56)
            case .active:
                Color(red: 0.47, green: 0.73, blue: 0.97)
            case .pending:
                Color(red: 0.96, green: 0.68, blue: 0.31)
            case .inactive:
                .secondary
            }
        }

        var fillOpacity: Double {
            switch self {
            case .complete: 0.20
            case .active: 0.18
            case .pending: 0.16
            case .inactive: 0.10
            }
        }
    }

    var id: String { self.title }

    let title: String
    let detail: String
    let systemImage: String
    let state: State
}

struct CorrectionWorkspaceClosureSnapshot: Hashable {
    let headline: String
    let detail: String
    let stages: [CorrectionWorkspaceLoopStageSnapshot]
}

struct CorrectionWorkspaceResearchSourceSnapshot: Hashable, Identifiable {
    var id: String { self.url }

    let title: String
    let source: String
    let snippet: String?
    let url: String
}

private struct CorrectionWorkspaceDispatchConfirmation: Identifiable {
    enum Command {
        case workspace(action: CorrectionWorkspaceAction, issue: CorrectionWorkspaceIssue?)
        case syntheticValidation
    }

    let id = UUID()
    let title: String
    let systemImage: String
    let destinationTitle: String
    let destinationDetail: String?
    let payloadTitle: String
    let payloadPreview: String
    let confirmLabel: String
    let command: Command
}

struct CorrectionWorkspaceIssue: Identifiable, Hashable {
    enum Severity: String {
        case healthy
        case watch
        case warning
        case critical

        var title: String {
            switch self {
            case .healthy: "Stable"
            case .watch: "Observe"
            case .warning: "Attention"
            case .critical: "Critical"
            }
        }

        var systemImage: String {
            switch self {
            case .healthy: "checkmark.circle.fill"
            case .watch: "eye.circle.fill"
            case .warning: "exclamationmark.triangle.fill"
            case .critical: "cross.case.fill"
            }
        }

        var color: Color {
            switch self {
            case .healthy: .green
            case .watch: .blue
            case .warning: .orange
            case .critical: .red
            }
        }
    }

    let id: String
    let subjectID: String
    let subjectRole: String
    let seat: String
    let title: String
    let subtitle: String
    let diagnosisID: String
    let diagnosisLabel: String
    let diagnosis: String
    let prescription: String
    let evidence: [String]
    let history: [String]
    let severity: Severity
    let remedyTemplateID: String?
    let remedyTemplateLabel: String?
    let likelyRootCause: String?
    let casebookGuidance: CorrectionWorkspaceStatusSnapshot?
    let runtimeTruth: CorrectionWorkspaceStatusSnapshot?
    let templateValidation: CorrectionWorkspaceStatusSnapshot?
    let interventionProgress: CorrectionWorkspaceProgressSnapshot?
    let similarCases: CorrectionWorkspaceResearchSnapshot?
    let professionalRoleAssessment: ProfessionalRoleAssessment?
    let runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?
    let observationFingerprint: String
    let tracksCasebook: Bool
    let dispatchSessionKey: String?
    let primaryAction: CorrectionWorkspaceAction
    let secondaryAction: CorrectionWorkspaceAction?

    init(
        id: String,
        subjectID: String? = nil,
        subjectRole: String = "system",
        seat: String,
        title: String,
        subtitle: String,
        diagnosisID: String? = nil,
        diagnosisLabel: String? = nil,
        diagnosis: String,
        prescription: String,
        evidence: [String],
        history: [String],
        severity: Severity,
        remedyTemplateID: String? = nil,
        remedyTemplateLabel: String? = nil,
        likelyRootCause: String? = nil,
        casebookGuidance: CorrectionWorkspaceStatusSnapshot? = nil,
        runtimeTruth: CorrectionWorkspaceStatusSnapshot? = nil,
        templateValidation: CorrectionWorkspaceStatusSnapshot? = nil,
        interventionProgress: CorrectionWorkspaceProgressSnapshot? = nil,
        similarCases: CorrectionWorkspaceResearchSnapshot? = nil,
        professionalRoleAssessment: ProfessionalRoleAssessment? = nil,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence? = nil,
        observationFingerprint: String? = nil,
        tracksCasebook: Bool = true,
        dispatchSessionKey: String? = nil,
        primaryAction: CorrectionWorkspaceAction,
        secondaryAction: CorrectionWorkspaceAction?)
    {
        self.id = id
        self.subjectID = subjectID ?? id
        self.subjectRole = subjectRole
        self.seat = seat
        self.title = title
        self.subtitle = subtitle
        self.diagnosisID = diagnosisID ?? id
        self.diagnosisLabel = diagnosisLabel ?? title
        self.diagnosis = diagnosis
        self.prescription = prescription
        self.evidence = evidence
        self.history = history
        self.severity = severity
        self.remedyTemplateID = remedyTemplateID
        self.remedyTemplateLabel = remedyTemplateLabel
        self.likelyRootCause = likelyRootCause
        self.casebookGuidance = casebookGuidance
        self.runtimeTruth = runtimeTruth
        self.templateValidation = templateValidation
        self.interventionProgress = interventionProgress
        self.similarCases = similarCases
        self.professionalRoleAssessment = professionalRoleAssessment
        self.runtimeEvidence = runtimeEvidence
        self.observationFingerprint = observationFingerprint
            ?? ([id, title, subtitle, diagnosis] + evidence).joined(separator: "\n")
        self.tracksCasebook = tracksCasebook
        self.dispatchSessionKey = dispatchSessionKey
        self.primaryAction = primaryAction
        self.secondaryAction = secondaryAction
    }

    var searchBlob: String {
        let statusLines = [
            self.casebookGuidance?.title,
            self.casebookGuidance?.detail,
            self.runtimeTruth?.title,
            self.runtimeTruth?.detail,
            self.templateValidation?.title,
            self.templateValidation?.detail,
            self.interventionProgress?.title,
            self.interventionProgress?.detail,
            self.similarCases?.title,
            self.similarCases?.detail,
            self.professionalRoleAssessment?.contract.title,
            self.professionalRoleAssessment?.contract.summary,
            self.professionalRoleAssessment?.drift.title,
            self.professionalRoleAssessment?.drift.detail,
            self.runtimeEvidence?.assistantOutputSummary,
            self.runtimeEvidence?.externalResearchQuery,
            self.runtimeEvidence?.externalResearchSummary,
        ].compactMap { $0 } + (self.interventionProgress?.highlights ?? []) + (self.similarCases?.highlights ?? [])
            + (self.professionalRoleAssessment?.contract.behavioralConstitution ?? [])
            + (self.professionalRoleAssessment?.contract.evidenceObligations ?? [])
            + (self.professionalRoleAssessment?.drift.highlights ?? [])
            + (self.runtimeEvidence?.externalResearchItems.flatMap { [$0.title, $0.source, $0.snippet] } ?? [])
        return ([self.seat, self.title, self.subtitle, self.diagnosis, self.prescription] + self.evidence + self.history + statusLines)
            .joined(separator: " ")
    }

    var rowSupportLine: String {
        if let roleAssessment = self.professionalRoleAssessment {
            return "\(roleAssessment.contract.title): \(roleAssessment.drift.title)"
        }
        if let progressTitle = self.interventionProgress?.title.nonEmpty {
            return progressTitle
        }
        if let runtimeTitle = self.runtimeTruth?.title.nonEmpty {
            return runtimeTitle
        }
        if let casebookTitle = self.casebookGuidance?.title.nonEmpty {
            return casebookTitle
        }
        return self.subtitle
    }

    var rowRoleBadgeTitle: String? {
        self.professionalRoleAssessment?.contract.title.nonEmpty
    }

    var primaryActionDisplayTitle: String {
        self.displayTitle(for: self.primaryAction)
    }

    var primaryActionDisplaySystemImage: String {
        self.displaySystemImage(for: self.primaryAction)
    }

    var primaryActionGuidance: String {
        self.guidance(for: self.primaryAction)
    }

    func displayTitle(for action: CorrectionWorkspaceAction) -> String {
        switch action {
        case .openChat where self.tracksCasebook && self.severity != .healthy:
            "Send fix"
        case .openChat:
            "Open chat"
        case .refreshSignals:
            "Refresh signals"
        case .openSettings:
            "Open settings"
        case .openCanvas:
            "Open canvas"
        case let .recordOutcome(_, _, outcome):
            outcome.title
        }
    }

    func displaySystemImage(for action: CorrectionWorkspaceAction) -> String {
        switch action {
        case .openChat where self.tracksCasebook && self.severity != .healthy:
            "paperplane.fill"
        default:
            action.systemImage
        }
    }

    func guidance(for action: CorrectionWorkspaceAction) -> String {
        switch action {
        case .openChat where self.tracksCasebook && self.severity != .healthy:
            "Open the live lane and send an evidence-backed correction for this seat."
        case .openChat:
            "Jump into the live lane so you can steer this seat directly."
        case .refreshSignals:
            "Pull a fresh supervision reading before deciding whether this case is still live."
        case .openSettings:
            "Review the required runtime setting before trying to close this loop."
        case .openCanvas:
            "Inspect the evidence canvas before you confirm the next move."
        case let .recordOutcome(_, _, outcome):
            switch outcome {
            case .resolved:
                "Record that the latest treatment cleared the diagnosis and close the round."
            case .failed:
                "Record that the current treatment failed so the case remains visible."
            case .superseded:
                "Record that a newer treatment replaced this round."
            }
        }
    }

    var closureSnapshot: CorrectionWorkspaceClosureSnapshot {
        let evidenceStage = CorrectionWorkspaceLoopStageSnapshot(
            title: "Evidence",
            detail: self.evidence.isEmpty
                ? "Need concrete observed proof."
                : "\(self.evidence.count) supporting signal(s) are attached.",
            systemImage: "waveform.path.ecg",
            state: self.evidence.isEmpty ? .pending : .complete)

        let diagnosisStage = CorrectionWorkspaceLoopStageSnapshot(
            title: "Diagnosis",
            detail: self.diagnosis.nonEmpty ?? self.title,
            systemImage: "stethoscope",
            state: self.diagnosis.nonEmpty == nil ? .pending : .complete)

        let prescriptionStage = CorrectionWorkspaceLoopStageSnapshot(
            title: "Prescription",
            detail: self.prescription.nonEmpty ?? "A concrete next step still needs to be written.",
            systemImage: "paperplane",
            state: self.prescription.nonEmpty == nil ? .pending : .complete)

        let verificationStage = self.verificationLoopStage
        let learningStage = self.learningLoopStage(verificationState: verificationStage.state)
        let stages = [evidenceStage, diagnosisStage, prescriptionStage, verificationStage, learningStage]

        let headline: String
        let detail: String
        switch verificationStage.state {
        case .complete:
            if learningStage.state == .complete {
                headline = "Loop has fresh proof and a recorded trail"
                detail = learningStage.detail
            } else {
                headline = "Verification landed; keep the casebook in sync"
                detail = learningStage.detail
            }
        case .active:
            headline = "Loop is waiting on fresh post-treatment proof"
            detail = verificationStage.detail
        case .pending:
            headline = self.tracksCasebook ? "Prescription is ready; verification is next" : "Manual follow-through is still required"
            detail = verificationStage.detail
        case .inactive:
            headline = "Manual verification is still required"
            detail = verificationStage.detail
        }

        return CorrectionWorkspaceClosureSnapshot(
            headline: headline,
            detail: detail,
            stages: stages)
    }

    var caseInput: OpenClawKit.CorrectionCaseInput {
        OpenClawKit.CorrectionCaseInput(
            subjectID: self.subjectID,
            subjectLabel: self.seat,
            role: self.subjectRole,
            diagnosisID: self.diagnosisID,
            diagnosisLabel: self.diagnosisLabel,
            severity: self.severity.rawValue,
            summary: self.subtitle,
            evidence: self.evidence,
            prescriptionLine: self.prescription,
            remedyTemplateID: self.remedyTemplateID,
            remedyTemplateLabel: self.remedyTemplateLabel,
            likelyRootCause: self.likelyRootCause,
            runtimeEvidence: self.runtimeEvidence,
            fingerprint: self.observationFingerprint)
    }

    func updating(
        history: [String]? = nil,
        remedyTemplateID: String? = nil,
        remedyTemplateLabel: String? = nil,
        likelyRootCause: String? = nil,
        casebookGuidance: CorrectionWorkspaceStatusSnapshot? = nil,
        runtimeTruth: CorrectionWorkspaceStatusSnapshot? = nil,
        templateValidation: CorrectionWorkspaceStatusSnapshot? = nil,
        interventionProgress: CorrectionWorkspaceProgressSnapshot? = nil,
        similarCases: CorrectionWorkspaceResearchSnapshot? = nil,
        professionalRoleAssessment: ProfessionalRoleAssessment? = nil,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence? = nil) -> Self
    {
        Self(
            id: self.id,
            subjectID: self.subjectID,
            subjectRole: self.subjectRole,
            seat: self.seat,
            title: self.title,
            subtitle: self.subtitle,
            diagnosisID: self.diagnosisID,
            diagnosisLabel: self.diagnosisLabel,
            diagnosis: self.diagnosis,
            prescription: self.prescription,
            evidence: self.evidence,
            history: history ?? self.history,
            severity: self.severity,
            remedyTemplateID: remedyTemplateID ?? self.remedyTemplateID,
            remedyTemplateLabel: remedyTemplateLabel ?? self.remedyTemplateLabel,
            likelyRootCause: likelyRootCause ?? self.likelyRootCause,
            casebookGuidance: casebookGuidance ?? self.casebookGuidance,
            runtimeTruth: runtimeTruth ?? self.runtimeTruth,
            templateValidation: templateValidation ?? self.templateValidation,
            interventionProgress: interventionProgress ?? self.interventionProgress,
            similarCases: similarCases ?? self.similarCases,
            professionalRoleAssessment: professionalRoleAssessment ?? self.professionalRoleAssessment,
            runtimeEvidence: runtimeEvidence ?? self.runtimeEvidence,
            observationFingerprint: self.observationFingerprint,
            tracksCasebook: self.tracksCasebook,
            dispatchSessionKey: self.dispatchSessionKey,
            primaryAction: self.primaryAction,
            secondaryAction: self.secondaryAction)
    }

    func refreshingProfessionalRoleAssessment() -> Self {
        self.updating(professionalRoleAssessment: ProfessionalRoleCorrection.assessment(for: self))
    }

    private var verificationLoopStage: CorrectionWorkspaceLoopStageSnapshot {
        if let progress = self.interventionProgress {
            let lowerTitle = progress.title.lowercased()
            let isFreshProof =
                lowerTitle.contains("fresh artifact observed")
                || lowerTitle.contains("fresh output observed")
            return CorrectionWorkspaceLoopStageSnapshot(
                title: "Verify",
                detail: progress.detail,
                systemImage: isFreshProof ? "checklist" : progress.systemImage,
                state: isFreshProof ? .complete : .active)
        }

        if let runtimeTruth = self.runtimeTruth {
            return CorrectionWorkspaceLoopStageSnapshot(
                title: "Verify",
                detail: runtimeTruth.detail,
                systemImage: runtimeTruth.systemImage,
                state: .active)
        }

        if let assistantSummary = self.runtimeEvidence?.assistantOutputSummary?.nonEmpty {
            return CorrectionWorkspaceLoopStageSnapshot(
                title: "Verify",
                detail: assistantSummary,
                systemImage: "waveform.path.ecg",
                state: .active)
        }

        return CorrectionWorkspaceLoopStageSnapshot(
            title: "Verify",
            detail: self.tracksCasebook
                ? "Wait for a post-treatment runtime signal before closing the round."
                : "This issue is not auto-tracked, so proof still needs a manual follow-through pass.",
            systemImage: self.tracksCasebook ? "hourglass" : "hand.raised",
            state: self.tracksCasebook ? .pending : .inactive)
    }

    private func learningLoopStage(
        verificationState: CorrectionWorkspaceLoopStageSnapshot.State) -> CorrectionWorkspaceLoopStageSnapshot
    {
        guard self.tracksCasebook else {
            return CorrectionWorkspaceLoopStageSnapshot(
                title: "Casebook",
                detail: "Casebook linkage is off for this issue, so learning has to be carried manually.",
                systemImage: "book.closed",
                state: .inactive)
        }

        let detail: String
        if let casebookDetail = self.casebookGuidance?.detail.nonEmpty {
            detail = casebookDetail
        } else if !self.history.isEmpty {
            detail = "\(self.history.count) prior recorded round(s) are already available for comparison."
        } else {
            detail = "This active round is already linked to the casebook and will write back after verification."
        }

        let state: CorrectionWorkspaceLoopStageSnapshot.State
        switch verificationState {
        case .complete:
            state = .complete
        case .active, .pending:
            state = .active
        case .inactive:
            state = .pending
        }

        return CorrectionWorkspaceLoopStageSnapshot(
            title: "Casebook",
            detail: detail,
            systemImage: "books.vertical",
            state: state)
    }
}

private struct CorrectionWorkspaceSummary {
    let activeCount: Int
    let criticalCount: Int
    let watchCount: Int
    let headline: String
    let evidenceLine: String
    let focusLine: String
    let templateLine: String
    let validationLine: String?

    init(
        issues: [CorrectionWorkspaceIssue],
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        runnerSummary: String?,
        batchProgress: CorrectionSyntheticTrialRunner.BatchProgress?,
        currentPlan: CorrectionSyntheticTrialExecutionPlan?)
    {
        self.activeCount = issues.count(where: { $0.severity != .healthy })
        self.criticalCount = issues.count(where: { $0.severity == .critical })
        self.watchCount = issues.count(where: { $0.severity == .watch || $0.severity == .warning })
        let lead = issues.first(where: { $0.severity == .critical }) ?? issues.first
        self.headline = lead?.title ?? "No active correction cases"
        self.evidenceLine = lead?.diagnosis ?? "Live evidence chain is quiet and no urgent intervention is selected."
        self.focusLine = lead?.prescription ?? "Keep observing evidence, not just vibes."
        let templateSummary = casebook.templatePortfolioSummary()
        let syntheticSummary = casebook.syntheticTrialSummary()
        let nextSyntheticRun = casebook.nextSyntheticTrialRun()
        switch syntheticSummary.stage {
        case .universalReady:
            let botLine = syntheticSummary.syntheticBotLabel.map { " on \($0)" } ?? ""
            self.templateLine = "\(syntheticSummary.universalTemplateIDs.count) template(s) cleared all synthetic randomized bot trials\(botLine)."
        case .blocked:
            let botLine = syntheticSummary.syntheticBotLabel.map { " on \($0)" } ?? ""
            self.templateLine = "\(syntheticSummary.failedTemplateIDs.count) candidate template(s) hit synthetic trial failures\(botLine). Universal promotion is blocked until those remedies are corrected or replaced."
        case .validating:
            let botLine = syntheticSummary.syntheticBotLabel.map { " on \($0)" } ?? ""
            let nextLine = nextSyntheticRun.map {
                " Next run: \($0.templateLabel) round \($0.iteration) on \($0.syntheticBotLabel)."
            } ?? ""
            self.templateLine = "\(templateSummary.candidateTemplateCount) candidate backup template(s) are in synthetic validation\(botLine). \(syntheticSummary.completedRunCount)/\(syntheticSummary.plannedRunCount) randomized trial(s) are complete.\(nextLine)"
        case .staged:
            if templateSummary.readyForSyntheticTrials {
                let botLine = syntheticSummary.syntheticBotLabel.map { " with \($0)" } ?? ""
                let nextLine = nextSyntheticRun.map {
                    " Next run: \($0.templateLabel) round \($0.iteration)."
                } ?? ""
                self.templateLine = "\(templateSummary.candidateTemplateCount) candidate backup template(s) are ready. Synthetic randomized bot trials are staged\(botLine) with \(syntheticSummary.plannedRunCount) planned run(s).\(nextLine)"
            } else if templateSummary.candidateTemplateCount > 0 {
                let missing = max(0, 3 - templateSummary.candidateTemplateCount)
                self.templateLine = "\(templateSummary.candidateTemplateCount) candidate backup template(s) are ready. \(missing) more candidate template(s) are needed before synthetic randomized bot trials can begin."
            } else {
                self.templateLine = "No candidate backup templates are ready yet. Remedies are still being validated across different bots."
            }
        case .awaitingCandidates:
            if templateSummary.candidateTemplateCount > 0 {
                let missing = max(0, 3 - templateSummary.candidateTemplateCount)
                self.templateLine = "\(templateSummary.candidateTemplateCount) candidate backup template(s) are ready. \(missing) more candidate template(s) are needed before synthetic randomized bot trials can begin."
            } else {
                self.templateLine = "No candidate backup templates are ready yet. Remedies are still being validated across different bots."
            }
        }
        if let batchProgress {
            self.validationLine = CorrectionSyntheticTrialRunner.queueProgressLine(
                progress: batchProgress,
                currentPlan: currentPlan)
        } else {
            self.validationLine = runnerSummary
        }
    }
}

private struct CorrectionWorkspaceAmbientBackdrop: View {
    @State private var drifting = false

    var body: some View {
        GeometryReader { proxy in
            ZStack {
                LinearGradient(
                    colors: [
                        Color(red: 0.97, green: 0.95, blue: 0.91),
                        Color(red: 0.95, green: 0.96, blue: 0.95),
                        Color(red: 0.90, green: 0.94, blue: 0.98),
                    ],
                    startPoint: .topLeading,
                    endPoint: .bottomTrailing)

                self.blob(
                    color: Color(red: 0.99, green: 0.82, blue: 0.60).opacity(0.26),
                    size: CGSize(width: proxy.size.width * 0.40, height: proxy.size.width * 0.30),
                    offset: self.drifting ? CGSize(width: -122, height: -106) : CGSize(width: -72, height: -176))

                self.blob(
                    color: Color.white.opacity(0.32),
                    size: CGSize(width: proxy.size.width * 0.34, height: proxy.size.width * 0.24),
                    offset: self.drifting ? CGSize(width: 22, height: -74) : CGSize(width: -18, height: -116))

                self.blob(
                    color: Color(red: 0.76, green: 0.87, blue: 0.96).opacity(0.28),
                    size: CGSize(width: proxy.size.width * 0.42, height: proxy.size.width * 0.28),
                    offset: self.drifting ? CGSize(width: 168, height: 86) : CGSize(width: 132, height: 148))

                Rectangle()
                    .fill(.ultraThinMaterial)
                    .opacity(0.22)
            }
            .ignoresSafeArea()
        }
        .task {
            withAnimation(.easeInOut(duration: 12.0).repeatForever(autoreverses: true)) {
                self.drifting.toggle()
            }
        }
    }

    private func blob(color: Color, size: CGSize, offset: CGSize) -> some View {
        Ellipse()
            .fill(color)
            .frame(width: size.width, height: size.height)
            .blur(radius: 58)
            .offset(offset)
    }
}

private struct CorrectionWorkspacePanelBackground: View {
    let tint: Color

    var body: some View {
        RoundedRectangle(cornerRadius: 28, style: .continuous)
            .fill(Color.white.opacity(0.26))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.18),
                                self.tint.opacity(0.10),
                                Color(red: 0.86, green: 0.91, blue: 0.98).opacity(0.06),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing)))
            .overlay(
                RoundedRectangle(cornerRadius: 28, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.28),
                                Color.white.opacity(0.05),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing),
                        lineWidth: 0.8))
            .shadow(color: Color(red: 0.54, green: 0.67, blue: 0.82).opacity(0.08), radius: 18, y: 12)
            .shadow(color: .white.opacity(0.10), radius: 6, y: -2)
    }
}

private struct CorrectionWorkspaceCapsuleButtonStyle: ButtonStyle {
    var prominent = false

    func makeBody(configuration: Configuration) -> some View {
        configuration.label
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.prominent ? Color.white : Color.primary)
            .padding(.horizontal, 14)
            .padding(.vertical, 10)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        self.prominent
                            ? LinearGradient(
                                colors: [
                                    Color(red: 0.36, green: 0.61, blue: 0.93).opacity(configuration.isPressed ? 0.74 : 0.92),
                                    Color(red: 0.53, green: 0.79, blue: 0.93).opacity(configuration.isPressed ? 0.66 : 0.84),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing)
                            : LinearGradient(
                                colors: [
                                    Color.white.opacity(configuration.isPressed ? 0.62 : 0.50),
                                    Color(red: 0.86, green: 0.91, blue: 0.98).opacity(configuration.isPressed ? 0.24 : 0.16),
                                ],
                                startPoint: .topLeading,
                                endPoint: .bottomTrailing))
                    )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.white.opacity(self.prominent ? 0.30 : 0.50), lineWidth: 0.9))
            .shadow(color: Color(red: 0.43, green: 0.57, blue: 0.72).opacity(self.prominent ? 0.18 : 0.08), radius: self.prominent ? 20 : 12, y: 8)
            .scaleEffect(configuration.isPressed ? 0.982 : 1)
            .animation(.easeOut(duration: 0.16), value: configuration.isPressed)
    }
}

private struct CorrectionWorkspaceParallaxModifier: ViewModifier {
    let depth: CGFloat

    func body(content: Content) -> some View {
        if #available(macOS 14.0, *) {
            content.scrollTransition(axis: .vertical) { view, phase in
                view
                    .scaleEffect(phase.isIdentity ? 1 : 0.985)
                    .opacity(phase.isIdentity ? 1 : 0.86)
                    .offset(y: phase.value * self.depth)
            }
        } else {
            content
        }
    }
}

private struct CorrectionWorkspaceHeader: View {
    let summary: CorrectionWorkspaceSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 18) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        Circle()
                            .fill(Color(nsColor: .controlAccentColor))
                            .frame(width: 8, height: 8)
                        Text("Cases")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }

                    Text(self.summary.headline)
                        .font(.system(size: 32, weight: .semibold, design: .rounded))
                        .lineLimit(2)

                    Text(self.summary.evidenceLine)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                CorrectionWorkspaceMetric(value: "\(self.summary.activeCount)", label: "Live")
                CorrectionWorkspaceMetric(value: "\(self.summary.criticalCount)", label: "Critical")
                CorrectionWorkspaceMetric(value: "\(self.summary.watchCount)", label: "Watch")
            }

            HStack(spacing: 10) {
                CorrectionWorkspaceSignalBand(
                    title: "Focus",
                    detail: self.summary.focusLine,
                    systemImage: "scope")
                CorrectionWorkspaceSignalBand(
                    title: "Templates",
                    detail: self.summary.templateLine,
                    systemImage: "cross.case")
                if let validationLine = self.summary.validationLine {
                    CorrectionWorkspaceSignalBand(
                        title: "Trials",
                        detail: validationLine,
                        systemImage: "stethoscope")
                }
            }
        }
        .padding(22)
        .background(CorrectionWorkspacePanelBackground(tint: Color(red: 0.87, green: 0.93, blue: 1.00)))
    }
}

private struct CorrectionWorkspaceMetric: View {
    let value: String
    let label: String

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.value)
                .font(.system(size: 30, weight: .semibold, design: .rounded))
            Text(self.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 14)
        .padding(.vertical, 12)
        .background(Color.white.opacity(0.42), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct CorrectionWorkspaceSignalBand: View {
    let title: String
    let detail: String
    let systemImage: String

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(self.title, systemImage: self.systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(self.detail)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 18, style: .continuous))
    }
}

private struct CorrectionWorkspaceMiniBadge: View {
    let text: String
    let systemImage: String

    var body: some View {
        Label(self.text, systemImage: self.systemImage)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background(Color.white.opacity(0.42), in: Capsule(style: .continuous))
    }
}

private struct CorrectionWorkspaceIssueRow: View {
    let issue: CorrectionWorkspaceIssue
    let isSelected: Bool

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            ZStack {
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(self.issue.severity.color.opacity(self.isSelected ? 0.22 : 0.12))
                    .frame(width: 44, height: 44)

                Image(systemName: self.issue.severity.systemImage)
                    .foregroundStyle(self.issue.severity.color)
                    .font(.system(size: 17, weight: .semibold))
            }

            VStack(alignment: .leading, spacing: 8) {
                HStack(spacing: 8) {
                    Text(self.issue.seat)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)

                    Spacer(minLength: 0)

                    Text(self.issue.severity.title)
                        .font(.caption2.weight(.bold))
                        .foregroundStyle(self.issue.severity.color)
                        .padding(.horizontal, 8)
                        .padding(.vertical, 4)
                        .background(self.issue.severity.color.opacity(0.12), in: Capsule(style: .continuous))
                }

                Text(self.issue.title)
                    .font(.system(size: 15, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                    .lineLimit(2)

                Text(self.issue.rowSupportLine)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: false, vertical: true)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        self.badgeRow
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            CorrectionWorkspaceMiniBadge(
                                text: "\(self.issue.evidence.count) proof",
                                systemImage: "waveform.path.ecg")
                        }

                        HStack(spacing: 8) {
                            if let roleTitle = self.issue.rowRoleBadgeTitle {
                                CorrectionWorkspaceMiniBadge(
                                    text: roleTitle,
                                    systemImage: "person.text.rectangle")
                            }
                            if self.issue.tracksCasebook {
                                CorrectionWorkspaceMiniBadge(
                                    text: "Casebook",
                                    systemImage: "bolt.horizontal.fill")
                            }
                        }
                    }
                }
            }
        }
        .padding(14)
        .background(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .fill(
                    LinearGradient(
                        colors: self.isSelected
                            ? [
                                Color.white.opacity(0.76),
                                self.issue.severity.color.opacity(0.08),
                            ]
                            : [
                                Color.white.opacity(0.24),
                                Color.white.opacity(0.18),
                            ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing)))
        .overlay(
            RoundedRectangle(cornerRadius: 24, style: .continuous)
                .strokeBorder(
                    self.isSelected ? self.issue.severity.color.opacity(0.28) : Color.white.opacity(0.20),
                    lineWidth: self.isSelected ? 1.0 : 0.8))
        .shadow(color: .black.opacity(self.isSelected ? 0.08 : 0.025), radius: self.isSelected ? 18 : 8, y: 10)
        .scaleEffect(self.isSelected ? 1 : 0.996)
    }

    @ViewBuilder
    private var badgeRow: some View {
        CorrectionWorkspaceMiniBadge(
            text: "\(self.issue.evidence.count) proof",
            systemImage: "waveform.path.ecg")
        if let roleTitle = self.issue.rowRoleBadgeTitle {
            CorrectionWorkspaceMiniBadge(
                text: roleTitle,
                systemImage: "person.text.rectangle")
        } else if self.issue.tracksCasebook {
            CorrectionWorkspaceMiniBadge(
                text: "Casebook",
                systemImage: "bolt.horizontal.fill")
        }
        Spacer(minLength: 0)
    }
}

private struct CorrectionWorkspaceDetailHero: View {
    let issue: CorrectionWorkspaceIssue
    let canvasEnabled: Bool
    let runAction: (CorrectionWorkspaceAction) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 14) {
                ZStack {
                    RoundedRectangle(cornerRadius: 24, style: .continuous)
                        .fill(self.issue.severity.color.opacity(0.16))
                        .frame(width: 58, height: 58)

                    Image(systemName: self.issue.severity.systemImage)
                        .foregroundStyle(self.issue.severity.color)
                        .font(.system(size: 22, weight: .semibold))
                }

                VStack(alignment: .leading, spacing: 8) {
                    HStack(spacing: 8) {
                        Label("Detail", systemImage: "cross.case.fill")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        CorrectionWorkspaceMiniBadge(text: self.issue.seat, systemImage: "person.crop.square")
                        CorrectionWorkspaceMiniBadge(text: self.issue.severity.title, systemImage: "sparkle")
                    }

                    Text(self.issue.title)
                        .font(.system(size: 30, weight: .semibold, design: .rounded))
                        .lineLimit(2)

                    Text(self.issue.diagnosis)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)
            }

            VStack(alignment: .leading, spacing: 8) {
                Text("Intervention")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(self.issue.prescription)
                    .font(.system(size: 18, weight: .semibold, design: .rounded))
                    .foregroundStyle(.primary)
                    .lineLimit(2)
            }
            .padding(16)
            .background(Color.white.opacity(0.40), in: RoundedRectangle(cornerRadius: 22, style: .continuous))

            ViewThatFits(in: .horizontal) {
                HStack(spacing: 10) {
                    self.contextTile(
                        title: "Loop gate",
                        value: self.issue.closureSnapshot.headline,
                        detail: self.issue.closureSnapshot.detail,
                        systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                        tint: self.issue.severity.color)

                    self.contextTile(
                        title: "Next step",
                        value: self.issue.primaryActionDisplayTitle,
                        detail: self.issue.primaryActionGuidance,
                        systemImage: self.issue.primaryActionDisplaySystemImage,
                        tint: Color(red: 0.42, green: 0.69, blue: 0.96))
                }

                VStack(spacing: 10) {
                    self.contextTile(
                        title: "Loop gate",
                        value: self.issue.closureSnapshot.headline,
                        detail: self.issue.closureSnapshot.detail,
                        systemImage: "arrow.trianglehead.2.clockwise.rotate.90",
                        tint: self.issue.severity.color)

                    self.contextTile(
                        title: "Next step",
                        value: self.issue.primaryActionDisplayTitle,
                        detail: self.issue.primaryActionGuidance,
                        systemImage: self.issue.primaryActionDisplaySystemImage,
                        tint: Color(red: 0.42, green: 0.69, blue: 0.96))
                }
            }

            HStack(spacing: 8) {
                CorrectionWorkspaceMiniBadge(text: "\(self.issue.evidence.count) evidence", systemImage: "waveform.path.ecg")
                if !self.issue.history.isEmpty {
                    CorrectionWorkspaceMiniBadge(text: "\(self.issue.history.count) history", systemImage: "clock.arrow.circlepath")
                }
                if self.issue.tracksCasebook {
                    CorrectionWorkspaceMiniBadge(text: "Live case", systemImage: "bolt.horizontal.fill")
                }
                Spacer(minLength: 0)
            }

            HStack(spacing: 10) {
                Button {
                    self.runAction(self.issue.primaryAction)
                } label: {
                    Label(self.actionTitle(self.issue.primaryAction), systemImage: self.actionSystemImage(self.issue.primaryAction))
                }
                .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle(prominent: true))

                if let secondaryAction = self.issue.secondaryAction {
                    Button {
                        self.runAction(secondaryAction)
                    } label: {
                        Label(self.actionTitle(secondaryAction), systemImage: self.actionSystemImage(secondaryAction))
                    }
                    .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle())
                }

                if self.canvasEnabled {
                    Button {
                        self.runAction(.openCanvas)
                    } label: {
                        Label("Canvas", systemImage: "rectangle.inset.filled.on.rectangle")
                    }
                    .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle())
                }
            }
        }
        .padding(22)
        .background(CorrectionWorkspacePanelBackground(tint: self.issue.severity.color.opacity(0.20)))
        .modifier(CorrectionWorkspaceParallaxModifier(depth: 12))
    }

    private func actionTitle(_ action: CorrectionWorkspaceAction) -> String {
        self.issue.displayTitle(for: action)
    }

    private func actionSystemImage(_ action: CorrectionWorkspaceAction) -> String {
        self.issue.displaySystemImage(for: action)
    }

    private func contextTile(
        title: String,
        value: String,
        detail: String,
        systemImage: String,
        tint: Color) -> some View
    {
        VStack(alignment: .leading, spacing: 8) {
            Label(title, systemImage: systemImage)
                .font(.caption.weight(.semibold))
                .foregroundStyle(tint)
            Text(value)
                .font(.subheadline.weight(.semibold))
                .foregroundStyle(.primary)
                .lineLimit(2)
                .fixedSize(horizontal: false, vertical: true)
            Text(detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(14)
        .background(Color.white.opacity(0.30), in: RoundedRectangle(cornerRadius: 20, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 20, style: .continuous)
                .stroke(tint.opacity(0.18), lineWidth: 0.9))
    }
}

private struct CorrectionWorkspaceDetail: View {
    let issue: CorrectionWorkspaceIssue
    let canvasEnabled: Bool
    let isResearching: Bool
    let refreshResearch: (() -> Void)?
    let runAction: (CorrectionWorkspaceAction) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                CorrectionWorkspaceDetailHero(
                    issue: self.issue,
                    canvasEnabled: self.canvasEnabled,
                    runAction: self.runAction)

                CorrectionWorkspaceClosureSection(
                    closure: self.issue.closureSnapshot)

                LazyVGrid(
                    columns: [GridItem(.adaptive(minimum: 250), spacing: 10, alignment: .top)],
                    alignment: .leading,
                    spacing: 10)
                {
                    CorrectionWorkspaceSection(
                        title: "Diagnosis",
                        content: self.issue.diagnosis,
                        systemImage: "stethoscope")

                    CorrectionWorkspaceSection(
                        title: "Intervention",
                        content: self.issue.prescription,
                        systemImage: "paperplane")

                    if let likelyRootCause = self.issue.likelyRootCause, !likelyRootCause.isEmpty {
                        CorrectionWorkspaceSection(
                            title: "Root Cause",
                            content: likelyRootCause,
                            systemImage: "point.3.connected.trianglepath.dotted")
                    }

                    if let roleAssessment = self.issue.professionalRoleAssessment {
                        CorrectionWorkspaceSection(
                            title: "Role",
                            content: "\(roleAssessment.contract.summary) \(roleAssessment.drift.detail)",
                            systemImage: "person.text.rectangle")
                    }

                    if let casebookGuidance = self.issue.casebookGuidance {
                        CorrectionWorkspaceStatusSection(
                            title: "Casebook",
                            status: casebookGuidance)
                    }

                    if let runtimeTruth = self.issue.runtimeTruth {
                        CorrectionWorkspaceStatusSection(
                            title: "Runtime",
                            status: runtimeTruth)
                    }

                    if let templateValidation = self.issue.templateValidation {
                        CorrectionWorkspaceStatusSection(
                            title: "Templates",
                            status: templateValidation)
                    }

                    if let interventionProgress = self.issue.interventionProgress {
                        CorrectionWorkspaceProgressSection(
                            title: "Progress",
                            progress: interventionProgress)
                    }

                    if let similarCases = self.issue.similarCases {
                        CorrectionWorkspaceResearchSection(
                            title: "Research",
                            research: similarCases,
                            isLoading: self.isResearching,
                            onRefresh: self.refreshResearch)
                    }
                }

                if !self.issue.evidence.isEmpty {
                    CorrectionWorkspaceListSection(
                        title: "Evidence",
                        items: self.issue.evidence)
                }

                if !self.issue.history.isEmpty {
                    CorrectionWorkspaceListSection(
                        title: "History",
                        items: self.issue.history)
                }

                if let roleAssessment = self.issue.professionalRoleAssessment {
                    CorrectionWorkspaceListSection(
                        title: "Role obligations",
                        items: roleAssessment.contract.behavioralConstitution
                            + roleAssessment.contract.evidenceObligations
                            + roleAssessment.drift.highlights)
                }
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.vertical, 2)
        }
        .scrollIndicators(.hidden)
    }

    private func actionTitle(_ action: CorrectionWorkspaceAction) -> String {
        switch action {
        case .openChat where self.issue.tracksCasebook && self.issue.severity != .healthy:
            "Send intervention"
        default:
            action.title
        }
    }

    private func actionSystemImage(_ action: CorrectionWorkspaceAction) -> String {
        switch action {
        case .openChat where self.issue.tracksCasebook && self.issue.severity != .healthy:
            "paperplane"
        default:
            action.systemImage
        }
    }
}

private struct CorrectionWorkspaceProgressSection: View {
    let title: String
    let progress: CorrectionWorkspaceProgressSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(self.title, systemImage: self.progress.systemImage)
                .font(.headline)
            Text(self.progress.detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
            if !self.progress.highlights.isEmpty {
                Divider()
                ForEach(self.progress.highlights.prefix(2), id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 6))
                            .foregroundStyle(.secondary)
                            .padding(.top, 6)
                        Text(item)
                            .font(.callout)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct CorrectionWorkspaceResearchSection: View {
    let title: String
    let research: CorrectionWorkspaceResearchSnapshot
    let isLoading: Bool
    let onRefresh: (() -> Void)?
    @State private var showsSources = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                Label(self.title, systemImage: self.research.systemImage)
                    .font(.headline)
                Spacer(minLength: 0)
                if let onRefresh {
                    Button {
                        onRefresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(CorrectionWorkspaceCapsuleButtonStyle())
                    .controlSize(.small)
                    .disabled(self.isLoading)
                }
            }
            Text(self.research.detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(4)
                .fixedSize(horizontal: false, vertical: true)
            if self.isLoading {
                Label("Refreshing external research", systemImage: "arrow.triangle.2.circlepath")
                    .font(.caption.weight(.medium))
                    .foregroundStyle(.secondary)
            }
            ForEach(self.research.highlights.prefix(1), id: \.self) { item in
                HStack(alignment: .top, spacing: 8) {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 6))
                        .foregroundStyle(.secondary)
                        .padding(.top, 6)
                    Text(item)
                        .font(.callout)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            if !self.research.sources.isEmpty {
                DisclosureGroup(isExpanded: self.$showsSources) {
                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(self.research.sources) { source in
                            if let url = URL(string: source.url) {
                                Link(destination: url) {
                                    VStack(alignment: .leading, spacing: 4) {
                                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                                            Text(source.title)
                                                .font(.subheadline.weight(.semibold))
                                                .multilineTextAlignment(.leading)
                                            Spacer(minLength: 0)
                                            Text(source.source)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                        }
                                        if let snippet = source.snippet?.nonEmpty {
                                            Text(snippet)
                                                .font(.caption)
                                                .foregroundStyle(.secondary)
                                                .multilineTextAlignment(.leading)
                                                .fixedSize(horizontal: false, vertical: true)
                                        }
                                    }
                                    .frame(maxWidth: .infinity, alignment: .leading)
                                    .padding(.vertical, 6)
                                }
                                .buttonStyle(.plain)
                            }
                        }
                    }
                }
                label: {
                    HStack {
                        Text("Sources")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 0)
                        Text("\(self.research.sources.count)")
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct CorrectionWorkspaceStatusSection: View {
    let title: String
    let status: CorrectionWorkspaceStatusSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            Label(self.title, systemImage: self.status.systemImage)
                .font(.headline)
            Text(self.status.detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct CorrectionWorkspaceClosureSection: View {
    let closure: CorrectionWorkspaceClosureSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 14) {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Label("Closed Loop", systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                    .font(.headline)
                Spacer(minLength: 0)
                Text(self.closure.headline)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.trailing)
            }

            Text(self.closure.detail)
                .font(.callout)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            LazyVGrid(
                columns: [GridItem(.adaptive(minimum: 104), spacing: 8, alignment: .top)],
                alignment: .leading,
                spacing: 8)
            {
                ForEach(self.closure.stages) { stage in
                    CorrectionWorkspaceLoopStageChip(stage: stage)
                }
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }
}

private struct CorrectionWorkspaceLoopStageChip: View {
    let stage: CorrectionWorkspaceLoopStageSnapshot

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 8) {
                Image(systemName: self.stage.systemImage)
                    .font(.system(size: 11, weight: .semibold))
                    .foregroundStyle(self.stage.state.tint)
                Text(self.stage.title)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.primary)
                Spacer(minLength: 0)
            }

            Text(self.stage.state.title)
                .font(.caption2.weight(.bold))
                .foregroundStyle(self.stage.state.tint)
                .padding(.horizontal, 8)
                .padding(.vertical, 4)
                .background(self.stage.state.tint.opacity(self.stage.state.fillOpacity), in: Capsule(style: .continuous))

            Text(self.stage.detail)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .frame(maxWidth: .infinity, minHeight: 108, alignment: .topLeading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(self.stage.state.tint.opacity(max(0.08, self.stage.state.fillOpacity * 0.7))))
        .overlay(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .strokeBorder(self.stage.state.tint.opacity(0.18), lineWidth: 0.9))
    }
}

private struct CorrectionWorkspaceDispatchSheet: View {
    let confirmation: CorrectionWorkspaceDispatchConfirmation
    let onCancel: () -> Void
    let onConfirm: () -> Void
    @State private var showsFullPayload = false

    var body: some View {
        VStack(alignment: .leading, spacing: 18) {
            HStack(alignment: .top, spacing: 14) {
                Image(systemName: self.confirmation.systemImage)
                    .font(.system(size: 20, weight: .semibold))
                    .foregroundStyle(.primary)
                    .frame(width: 32, height: 32)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 10, style: .continuous))

                VStack(alignment: .leading, spacing: 6) {
                    Text(self.confirmation.title)
                        .font(.title3.weight(.semibold))
                    Text("Check the target and confirm.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }

                Spacer(minLength: 0)
            }

            HStack(spacing: 12) {
                VStack(alignment: .leading, spacing: 8) {
                    Text("To")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(self.confirmation.destinationTitle)
                        .font(.body.weight(.semibold))
                    if let destinationDetail = self.confirmation.destinationDetail?.nonEmpty {
                        Text(destinationDetail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
                .padding(16)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

                VStack(alignment: .leading, spacing: 8) {
                    Text("Action")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                    Text(self.confirmation.confirmLabel)
                        .font(.body.weight(.semibold))
                    Text(self.confirmation.payloadTitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                .frame(width: 180, alignment: .leading)
                .padding(16)
                .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))
            }

            VStack(alignment: .leading, spacing: 10) {
                Text(self.confirmation.payloadTitle)
                    .font(.headline)

                Text(self.payloadSummary)
                    .font(.system(.body, design: .monospaced))
                    .textSelection(.enabled)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(14)
                    .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 16, style: .continuous))

                if self.hasExtendedPayload {
                    DisclosureGroup(isExpanded: self.$showsFullPayload) {
                        ScrollView {
                            Text(self.confirmation.payloadPreview)
                                .font(.system(.caption, design: .monospaced))
                                .textSelection(.enabled)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }
                        .frame(minHeight: 120, maxHeight: 220)
                        .padding(.top, 8)
                    } label: {
                        Text("Full payload")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.secondary)
                    }
                }
            }
            .padding(16)
            .background(.thinMaterial, in: RoundedRectangle(cornerRadius: 18, style: .continuous))

            HStack {
                Spacer()
                Button("Cancel") {
                    self.onCancel()
                }
                .buttonStyle(.bordered)

                Button(self.confirmation.confirmLabel) {
                    self.onConfirm()
                }
                .buttonStyle(.borderedProminent)
            }
        }
        .padding(20)
        .frame(minWidth: 560, idealWidth: 620, minHeight: 380)
        .background(Color(nsColor: .windowBackgroundColor))
    }

    private var payloadSummary: String {
        self.payloadLines.prefix(8).joined(separator: "\n")
    }

    private var hasExtendedPayload: Bool {
        self.payloadLines.count > 8
    }

    private var payloadLines: [String] {
        self.confirmation.payloadPreview
            .split(separator: "\n", omittingEmptySubsequences: false)
            .map(String.init)
    }
}

private struct CorrectionWorkspaceSection: View {
    let title: String
    let content: String
    let systemImage: String

    var bodyView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Label(self.title, systemImage: self.systemImage)
                .font(.headline)
            Text(self.content)
                .font(.callout)
                .foregroundStyle(.primary)
                .lineLimit(3)
                .fixedSize(horizontal: false, vertical: true)
        }
        .padding(16)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    var body: some View {
        self.bodyView
    }
}

private struct CorrectionWorkspaceListSection: View {
    let title: String
    let items: [String]
    @State private var isExpanded = false

    var body: some View {
        DisclosureGroup(isExpanded: self.$isExpanded) {
            VStack(alignment: .leading, spacing: 10) {
                ForEach(self.visibleItems, id: \.self) { item in
                    HStack(alignment: .top, spacing: 8) {
                        Image(systemName: "circle.fill")
                            .font(.system(size: 6))
                            .foregroundStyle(.secondary)
                            .padding(.top, 6)
                        Text(item)
                            .font(.body)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .padding(.top, 8)
        } label: {
            VStack(alignment: .leading, spacing: 6) {
                HStack {
                    Label(self.title, systemImage: "list.bullet.rectangle")
                        .font(.headline)
                    Spacer(minLength: 0)
                    Text("\(self.items.count)")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(.secondary)
                }
                if let preview = self.items.first?.nonEmpty {
                    Text(preview)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(self.isExpanded ? 2 : 1)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
        .padding(16)
        .background(Color.white.opacity(0.34), in: RoundedRectangle(cornerRadius: 22, style: .continuous))
    }

    private var visibleItems: [String] {
        self.isExpanded ? self.items : Array(self.items.prefix(3))
    }
}

@MainActor
private enum CorrectionWorkspaceIssueBuilder {
    private static let relativeFormatter = RelativeDateTimeFormatter()
    private static let listFormatter = ListFormatter()
    private static let staleActivityThreshold: TimeInterval = 5 * 60

    static func build(
        state: AppState,
        healthStore: HealthStore,
        heartbeatStore: HeartbeatStore,
        activityStore: WorkActivityStore,
        agentEventStore: AgentEventStore,
        controlChannel: ControlChannel,
        pairingPrompter: NodePairingApprovalPrompter,
        devicePairingPrompter: DevicePairingApprovalPrompter,
        sessionIdentities: SessionIdentitySnapshot,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> [CorrectionWorkspaceIssue]
    {
        var issues: [CorrectionWorkspaceIssue] = []

        let controlState = controlChannel.state
        switch controlState {
        case .disconnected:
            issues.append(
                Self.issue(
                    id: "control-disconnected",
                    subjectID: "control-lane",
                    subjectRole: "system",
                    seat: "Control lane",
                    title: "Control channel is disconnected",
                    subtitle: "Real-time correction cannot stay closed-loop while the control path is down.",
                    diagnosisID: "control_channel_disconnected",
                    diagnosis: "Evidence from the gateway cannot be trusted until the control lane reconnects.",
                    prescription: "Re-establish the control lane first, then rerun health and resume intervention.",
                    evidence: [
                        "Connection state: disconnected",
                        healthStore.summaryLine,
                    ],
                    severity: .critical,
                    remedyTemplateID: "reconnect_control_lane",
                    remedyTemplateLabel: "Reconnect Control Lane",
                    likelyRootCause: "The supervision transport is offline, so downstream correction evidence is stale.",
                    observationFingerprint: Self.fingerprint([
                        "control",
                        "disconnected",
                        healthStore.summaryLine,
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .refreshSignals,
                    secondaryAction: .openSettings(.general)))
        case let .degraded(message):
            issues.append(
                Self.issue(
                    id: "control-degraded",
                    subjectID: "control-lane",
                    subjectRole: "system",
                    seat: "Control lane",
                    title: "Control channel is degraded",
                    subtitle: message.isEmpty ? "The supervision link is unstable." : message,
                    diagnosisID: "control_channel_degraded",
                    diagnosis: "Live bot state may be partial or stale while the control lane is degraded.",
                    prescription: "Repair transport quality before trusting the next correction result.",
                    evidence: [
                        "Connection state: degraded",
                        message.isEmpty ? "Gateway did not provide a detail string." : message,
                        healthStore.summaryLine,
                    ],
                    severity: .warning,
                    remedyTemplateID: "stabilize_control_lane",
                    remedyTemplateLabel: "Stabilize Control Lane",
                    likelyRootCause: "The supervision transport is unstable, so the app may be reacting to partial state.",
                    observationFingerprint: Self.fingerprint([
                        "control",
                        "degraded",
                        message,
                        healthStore.summaryLine,
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .refreshSignals,
                    secondaryAction: .openSettings(.general)))
        case .connecting:
            issues.append(
                Self.issue(
                    id: "control-connecting",
                    subjectID: "control-lane",
                    subjectRole: "system",
                    seat: "Control lane",
                    title: "Control channel is still reconnecting",
                    subtitle: "The app is waiting for a stable supervision path.",
                    diagnosisID: "control_channel_reconnecting",
                    diagnosis: "Real-time correction is not fully closed-loop until reconnect completes.",
                    prescription: "Wait for reconnection or refresh signals before accepting the current state.",
                    evidence: [
                        "Connection state: connecting",
                        healthStore.summaryLine,
                    ],
                    severity: .watch,
                    remedyTemplateID: "await_control_reconnect",
                    remedyTemplateLabel: "Await Control Reconnect",
                    likelyRootCause: "The control path is still re-establishing, so any seat diagnosis may be premature.",
                    observationFingerprint: Self.fingerprint([
                        "control",
                        "connecting",
                        healthStore.summaryLine,
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .refreshSignals,
                    secondaryAction: .openSettings(.general)))
        case .connected:
            break
        }

        switch healthStore.state {
        case let .degraded(message):
            var evidence = [healthStore.summaryLine]
            if let detail = healthStore.detailLine, !detail.isEmpty {
                evidence.append(detail)
            }
            issues.append(
                Self.issue(
                    id: "gateway-health",
                    subjectID: "evidence-chain",
                    subjectRole: "system",
                    seat: "Evidence chain",
                    title: "Gateway health needs correction",
                    subtitle: message,
                    diagnosisID: "gateway_health_degraded",
                    diagnosis: "The app cannot prove bot health cleanly because the evidence chain is degraded.",
                    prescription: "Repair health first; only then trust remediation outcomes for bot cases.",
                    evidence: evidence,
                    severity: .critical,
                    remedyTemplateID: "restore_gateway_health",
                    remedyTemplateLabel: "Restore Gateway Health",
                    likelyRootCause: "The evidence chain itself is degraded, so bot-level conclusions cannot be trusted yet.",
                    observationFingerprint: Self.fingerprint([
                        "gateway",
                        "degraded",
                        message,
                        healthStore.summaryLine,
                        healthStore.detailLine ?? "",
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .refreshSignals,
                    secondaryAction: .openSettings(.channels)))
        case .linkingNeeded:
            issues.append(
                Self.issue(
                    id: "gateway-linking",
                    subjectID: "evidence-chain",
                    subjectRole: "system",
                    seat: "Evidence chain",
                    title: "Gateway still needs linking",
                    subtitle: healthStore.summaryLine,
                    diagnosisID: "gateway_linking_needed",
                    diagnosis: "The app cannot diagnose downstream seats while the gateway is not linked.",
                    prescription: "Finish linking, then reopen the correction workspace and re-check evidence.",
                    evidence: [
                        "Health summary: \(healthStore.summaryLine)",
                    ],
                    severity: .critical,
                    remedyTemplateID: "complete_gateway_linking",
                    remedyTemplateLabel: "Complete Gateway Linking",
                    likelyRootCause: "The gateway is not linked, so the correction loop has no trustworthy upstream source.",
                    observationFingerprint: Self.fingerprint([
                        "gateway",
                        "linking-needed",
                        healthStore.summaryLine,
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .openSettings(.channels),
                    secondaryAction: .refreshSignals))
        case .unknown:
            issues.append(
                Self.issue(
                    id: "gateway-unknown",
                    subjectID: "evidence-chain",
                    subjectRole: "system",
                    seat: "Evidence chain",
                    title: "Gateway health is still unknown",
                    subtitle: healthStore.summaryLine,
                    diagnosisID: "gateway_health_unknown",
                    diagnosis: "Observation started, but the app has not yet closed the evidence chain.",
                    prescription: "Refresh signals before escalating a seat-level correction.",
                    evidence: [
                        "Health summary: \(healthStore.summaryLine)",
                    ],
                    severity: .watch,
                    remedyTemplateID: "refresh_gateway_evidence",
                    remedyTemplateLabel: "Refresh Gateway Evidence",
                    likelyRootCause: "The app has not gathered enough evidence yet to confirm health or failure.",
                    observationFingerprint: Self.fingerprint([
                        "gateway",
                        "unknown",
                        healthStore.summaryLine,
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .refreshSignals,
                    secondaryAction: .openSettings(.channels)))
        case .ok:
            break
        }

        if let heartbeatIssue = Self.heartbeatIssue(
            heartbeatStore: heartbeatStore,
            healthStore: healthStore,
            casebook: casebook)
        {
            issues.append(heartbeatIssue)
        }

        if let activityIssue = Self.activityIssue(
            activityStore: activityStore,
            agentEventStore: agentEventStore,
            sessionIdentities: sessionIdentities,
            casebook: casebook)
        {
            issues.append(activityIssue)
        }

        if pairingPrompter.pendingCount > 0 {
            issues.append(
                Self.issue(
                    id: "node-pairing",
                    subjectID: "access-approvals",
                    subjectRole: "system",
                    seat: "Access approvals",
                    title: "Node pairing is waiting on intervention",
                    subtitle: "\(pairingPrompter.pendingCount) request(s) are queued for approval.",
                    diagnosisID: "node_pairing_blocked",
                    diagnosis: "Required seat access is blocked on pairing approval.",
                    prescription: "Approve or reject queued node requests so correction can continue with evidence attached.",
                    evidence: [
                        "Pending node requests: \(pairingPrompter.pendingCount)",
                        "Repair requests: \(pairingPrompter.pendingRepairCount)",
                    ],
                    severity: pairingPrompter.pendingRepairCount > 0 ? .warning : .watch,
                    remedyTemplateID: "resolve_node_pairing",
                    remedyTemplateLabel: "Resolve Node Pairing",
                    likelyRootCause: "Required access is still waiting on approval, so the correction flow cannot finish end to end.",
                    observationFingerprint: Self.fingerprint([
                        "node-pairing",
                        "\(pairingPrompter.pendingCount)",
                        "\(pairingPrompter.pendingRepairCount)",
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .openSettings(.instances),
                    secondaryAction: .refreshSignals))
        }

        if devicePairingPrompter.pendingCount > 0 {
            issues.append(
                Self.issue(
                    id: "device-pairing",
                    subjectID: "device-approvals",
                    subjectRole: "system",
                    seat: "Device approvals",
                    title: "Device pairing is still open",
                    subtitle: "\(devicePairingPrompter.pendingCount) device request(s) are pending.",
                    diagnosisID: "device_pairing_blocked",
                    diagnosis: "Correction cannot use the waiting device path until approval completes.",
                    prescription: "Resolve queued device approvals before expecting downstream delivery or observation to recover.",
                    evidence: [
                        "Pending device requests: \(devicePairingPrompter.pendingCount)",
                        "Repair requests: \(devicePairingPrompter.pendingRepairCount)",
                    ],
                    severity: devicePairingPrompter.pendingRepairCount > 0 ? .warning : .watch,
                    remedyTemplateID: "resolve_device_pairing",
                    remedyTemplateLabel: "Resolve Device Pairing",
                    likelyRootCause: "The waiting device lane is blocked on approval, so downstream recovery cannot close the loop.",
                    observationFingerprint: Self.fingerprint([
                        "device-pairing",
                        "\(devicePairingPrompter.pendingCount)",
                        "\(devicePairingPrompter.pendingRepairCount)",
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    primaryAction: .openSettings(.instances),
                    secondaryAction: .refreshSignals))
        }

        if issues.isEmpty {
            let healthyDetail = activityStore.current.map { current in
                "Current seat: \(current.label)"
            } ?? "No long-running correction is currently flagged."
            issues.append(
                Self.issue(
                    id: "healthy-flow",
                    subjectID: "system",
                    subjectRole: "system",
                    seat: "System",
                    title: "No active correction cases",
                    subtitle: healthyDetail,
                    diagnosisID: "healthy_flow",
                    diagnosis: "The current evidence chain is healthy and no urgent seat-level intervention is selected.",
                    prescription: "Keep observing for fresh evidence before escalating a new diagnosis.",
                    evidence: [
                        healthStore.summaryLine,
                    ],
                    severity: .healthy,
                    remedyTemplateID: nil,
                    remedyTemplateLabel: nil,
                    likelyRootCause: nil,
                    observationFingerprint: Self.fingerprint([
                        "healthy",
                        healthStore.summaryLine,
                        healthyDetail,
                    ]),
                    casebook: casebook,
                    lastHealthy: healthStore.lastSuccess,
                    tracksCasebook: false,
                    primaryAction: .refreshSignals,
                    secondaryAction: state.canvasEnabled ? .openCanvas : .openChat))
        }

        return issues.sorted { lhs, rhs in
            Self.sortRank(lhs.severity) > Self.sortRank(rhs.severity)
        }
    }

    private static func heartbeatIssue(
        heartbeatStore: HeartbeatStore,
        healthStore: HealthStore,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> CorrectionWorkspaceIssue?
    {
        guard let evt = heartbeatStore.lastEvent else {
            return Self.issue(
                id: "heartbeat-missing",
                subjectID: "heartbeat-loop",
                subjectRole: "system",
                seat: "Heartbeat loop",
                title: "Heartbeat evidence has not arrived yet",
                subtitle: "The correction loop is missing a recent heartbeat event.",
                diagnosisID: "heartbeat_missing",
                diagnosis: "Without a heartbeat sample, the app cannot tell whether delivery and monitoring are still breathing.",
                prescription: "Refresh signals and confirm heartbeat transport before escalating a bot failure.",
                evidence: [
                    "Heartbeat: none observed yet",
                    healthStore.summaryLine,
                ],
                severity: .watch,
                remedyTemplateID: "restore_heartbeat_loop",
                remedyTemplateLabel: "Restore Heartbeat Loop",
                likelyRootCause: "The monitoring loop has not emitted a recent heartbeat, so the correction path lacks liveness proof.",
                observationFingerprint: Self.fingerprint([
                    "heartbeat",
                    "missing",
                    healthStore.summaryLine,
                ]),
                casebook: casebook,
                lastHealthy: healthStore.lastSuccess,
                primaryAction: .refreshSignals,
                secondaryAction: .openSettings(.cron))
        }

        let eventDate = Date(timeIntervalSince1970: evt.ts / 1000)
        let age = Date().timeIntervalSince(eventDate)
        let ageLine = "Last heartbeat: \(Self.relativeFormatter.localizedString(for: eventDate, relativeTo: .now))"
        if evt.status == "failed" || age > staleActivityThreshold {
            return Self.issue(
                id: "heartbeat-stale",
                subjectID: "heartbeat-loop",
                subjectRole: "system",
                seat: "Heartbeat loop",
                title: "Heartbeat loop needs attention",
                subtitle: evt.reason?.nonEmpty ?? "Heartbeat is stale or failed.",
                diagnosisID: "heartbeat_stale",
                diagnosis: "The monitoring loop is not confirming fresh activity quickly enough for reliable correction.",
                prescription: "Repair the heartbeat path, then re-check whether the seat is truly stalled.",
                evidence: [
                    "Status: \(evt.status)",
                    ageLine,
                    evt.reason?.nonEmpty ?? "No explicit heartbeat reason was provided.",
                ],
                severity: evt.status == "failed" ? .critical : .warning,
                remedyTemplateID: "restore_heartbeat_loop",
                remedyTemplateLabel: "Restore Heartbeat Loop",
                likelyRootCause: "The heartbeat loop is stale or failed, so the app cannot prove that delivery is still alive.",
                observationFingerprint: Self.fingerprint([
                    "heartbeat",
                    evt.status,
                    ageLine,
                    evt.reason ?? "",
                ]),
                casebook: casebook,
                lastHealthy: healthStore.lastSuccess,
                primaryAction: .refreshSignals,
                secondaryAction: .openSettings(.cron))
        }
        return nil
    }

    private static func activityIssue(
        activityStore: WorkActivityStore,
        agentEventStore: AgentEventStore,
        sessionIdentities: SessionIdentitySnapshot,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> CorrectionWorkspaceIssue?
    {
        guard let current = activityStore.current else { return nil }
        let age = Date().timeIntervalSince(current.startedAt)
        guard age > staleActivityThreshold else { return nil }
        let identity = sessionIdentities.resolve(sessionKey: current.sessionKey)
            ?? SessionIdentityStore.fallbackIdentity(for: current.sessionKey, role: current.role)
        let latestAssistantOutput = agentEventStore.latestAssistantOutput(sessionKey: current.sessionKey)
        let runtimeEvidence = Self.mergedRuntimeEvidence(
            current: Self.casebookRuntimeEvidence(
                subjectID: identity.subjectID,
                diagnosisID: "correction_stall_over_5m",
                casebook: casebook),
            incoming: Self.activityRuntimeEvidence(
                subjectID: identity.subjectID,
                diagnosisID: "correction_stall_over_5m",
                current: current,
                latestAssistantOutput: latestAssistantOutput,
                casebook: casebook))
        var evidence = [
            "Bot case: \(identity.caseLabel)",
            "Current activity: \(current.label)",
            "Started: \(Self.relativeFormatter.localizedString(for: current.startedAt, relativeTo: .now))",
        ]
        if let contextLabel = identity.contextLabel,
           !contextLabel.isEmpty,
           contextLabel.localizedCaseInsensitiveCompare(identity.caseLabel) != .orderedSame
        {
            evidence.append("Current session: \(contextLabel)")
        }
        if let agentID = identity.agentID, !agentID.isEmpty {
            evidence.append("Bot id: \(agentID)")
        }
        if let toolLabel = activityStore.lastToolLabel, !toolLabel.isEmpty {
            evidence.append("Latest tool trace: \(toolLabel)")
        }
        Self.appendRuntimeEvidenceLines(runtimeEvidence, to: &evidence)
        if runtimeEvidence == nil {
            evidence.append("No assistant output is present in the retained runtime event window.")
        }

        return Self.issue(
            id: "activity-stale-\(identity.subjectID)",
            subjectID: identity.subjectID,
            subjectRole: identity.subjectRole,
            seat: identity.seatLabel,
            title: "\(identity.caseLabel) has been correcting for more than five minutes",
            subtitle: current.label,
            diagnosisID: "correction_stall_over_5m",
            diagnosis: "The active lane is spending time without producing a fresh verified intervention result.",
            prescription: "Shrink scope, ship one verified output, then reassess whether deeper correction is still needed.",
            evidence: evidence,
            severity: current.role == .main ? .warning : .watch,
            remedyTemplateID: "ship_one_verified_output",
            remedyTemplateLabel: "Ship One Verified Output",
            likelyRootCause: "The lane is burning time without producing a fresh verified artifact.",
            observationFingerprint: Self.fingerprint([
                "activity",
                identity.subjectID,
                identity.contextLabel ?? "",
                current.label,
                identity.caseLabel,
                activityStore.lastToolLabel ?? "",
            ]),
            casebook: casebook,
            lastHealthy: nil,
            dispatchSessionKey: current.sessionKey,
            primaryAction: .openChat,
            secondaryAction: .refreshSignals)
            .updating(
                likelyRootCause: Self.activityLikelyRootCause(
                    current: current,
                    runtimeEvidence: runtimeEvidence),
                runtimeTruth: Self.activityRuntimeTruthStatus(
                    subjectID: identity.subjectID,
                    diagnosisID: "correction_stall_over_5m",
                    current: current,
                    runtimeEvidence: runtimeEvidence,
                    casebook: casebook),
                interventionProgress: Self.interventionProgressStatus(
                    subjectID: identity.subjectID,
                    diagnosisID: "correction_stall_over_5m",
                    remedyTemplateID: "ship_one_verified_output",
                    remedyTemplateLabel: "Ship One Verified Output",
                    runtimeEvidence: runtimeEvidence,
                    casebook: casebook,
                    tracksCasebook: true),
                runtimeEvidence: runtimeEvidence)
            .refreshingProfessionalRoleAssessment()
    }

    private static func issue(
        id: String,
        subjectID: String,
        subjectRole: String,
        seat: String,
        title: String,
        subtitle: String,
        diagnosisID: String,
        diagnosisLabel: String? = nil,
        diagnosis: String,
        prescription: String,
        evidence: [String],
        severity: CorrectionWorkspaceIssue.Severity,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        likelyRootCause: String?,
        observationFingerprint: String,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        lastHealthy: Date?,
        tracksCasebook: Bool = true,
        dispatchSessionKey: String? = nil,
        primaryAction: CorrectionWorkspaceAction,
        secondaryAction: CorrectionWorkspaceAction?) -> CorrectionWorkspaceIssue
    {
        let runtimeEvidence = Self.casebookRuntimeEvidence(
            subjectID: subjectID,
            diagnosisID: diagnosisID,
            casebook: casebook)
        return CorrectionWorkspaceIssue(
            id: id,
            subjectID: subjectID,
            subjectRole: subjectRole,
            seat: seat,
            title: title,
            subtitle: subtitle,
            diagnosisID: diagnosisID,
            diagnosisLabel: diagnosisLabel ?? title,
            diagnosis: diagnosis,
            prescription: prescription,
            evidence: evidence,
            history: Self.historyLines(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                casebook: casebook,
                lastHealthy: lastHealthy,
                tracksCasebook: tracksCasebook),
            severity: severity,
            remedyTemplateID: remedyTemplateID,
            remedyTemplateLabel: remedyTemplateLabel,
            likelyRootCause: likelyRootCause,
            casebookGuidance: Self.casebookGuidanceStatus(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                remedyTemplateID: remedyTemplateID,
                remedyTemplateLabel: remedyTemplateLabel,
                casebook: casebook,
                tracksCasebook: tracksCasebook),
            runtimeTruth: Self.runtimeTruthStatus(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                casebook: casebook,
                tracksCasebook: tracksCasebook),
            templateValidation: Self.templateValidationStatus(
                remedyTemplateID: remedyTemplateID,
                remedyTemplateLabel: remedyTemplateLabel,
                casebook: casebook,
                tracksCasebook: tracksCasebook),
            interventionProgress: Self.interventionProgressStatus(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                remedyTemplateID: remedyTemplateID,
                remedyTemplateLabel: remedyTemplateLabel,
                runtimeEvidence: runtimeEvidence,
                casebook: casebook,
                tracksCasebook: tracksCasebook),
            similarCases: Self.similarCasesStatus(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                remedyTemplateID: remedyTemplateID,
                remedyTemplateLabel: remedyTemplateLabel,
                runtimeEvidence: runtimeEvidence,
                casebook: casebook,
                tracksCasebook: tracksCasebook),
            runtimeEvidence: runtimeEvidence,
            observationFingerprint: observationFingerprint,
            tracksCasebook: tracksCasebook,
            dispatchSessionKey: dispatchSessionKey,
            primaryAction: primaryAction,
            secondaryAction: secondaryAction)
            .refreshingProfessionalRoleAssessment()
    }

    private static func historyLines(
        subjectID: String,
        diagnosisID: String,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        lastHealthy: Date?,
        tracksCasebook: Bool) -> [String]
    {
        guard tracksCasebook else {
            return Self.healthyCheckpointLine(lastHealthy)
        }
        guard let condition = casebook.condition(subjectID: subjectID, diagnosisID: diagnosisID) else {
            return [
                "No earlier matching case is recorded for this bot yet.",
            ] + Self.healthyCheckpointLine(lastHealthy)
        }

        var lines: [String] = []
        if condition.recurrenceCount > 0 {
            lines.append("Seen before in \(condition.recurrenceCount) prior round(s).")
        } else {
            lines.append("This is the first documented round for this diagnosis on this bot.")
        }

        if condition.successCount > 0 || condition.failureCount > 0 {
            lines.append("Past outcomes: \(condition.successCount) resolved, \(condition.failureCount) failed or superseded.")
        }

        if let lastOutcome = condition.lastOutcome {
            if let lastResolvedAtMs = condition.lastResolvedAtMs {
                let resolvedDate = Date(timeIntervalSince1970: Double(lastResolvedAtMs) / 1000)
                lines.append("Last outcome: \(lastOutcome.title) \(Self.relativeFormatter.localizedString(for: resolvedDate, relativeTo: .now)).")
            } else {
                lines.append("Last outcome on record: \(lastOutcome.title).")
            }
        }

        if let latestTreatment = casebook.latestTreatment(subjectID: subjectID, diagnosisID: diagnosisID) {
            lines.append("\(Self.treatmentSummaryPrefix(for: latestTreatment.result)): \(latestTreatment.prescriptionLine)")
        } else if !condition.lastPrescriptionLine.isEmpty {
            lines.append("Last prescription: \(condition.lastPrescriptionLine)")
        }

        if !condition.lastRootCause.isEmpty {
            lines.append("Likely root cause on record: \(condition.lastRootCause)")
        }

        return lines
    }

    private static func casebookGuidanceStatus(
        subjectID: String,
        diagnosisID: String,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        tracksCasebook: Bool) -> CorrectionWorkspaceStatusSnapshot?
    {
        guard tracksCasebook,
              let portfolio = casebook.diagnosisPortfolio(diagnosisID: diagnosisID)
        else {
            return nil
        }

        let scopeLine: String
        if portfolio.seenBotCount <= 1 && portfolio.seenSubjectIDs == [subjectID] {
            scopeLine = "Only this bot has a recorded case for this diagnosis so far."
        } else {
            scopeLine = "This diagnosis has been recorded on \(portfolio.seenBotCount) bot(s)."
        }
        let outcomeLine = "\(portfolio.resolvedCount) recorded round(s) resolved and \(portfolio.failedCount) failed or were superseded."
        let rootCauseLine = portfolio.leadingRootCauses.first.map { " Common recorded root cause: \($0)" } ?? ""
        let currentRemedyTitle = remedyTemplateLabel ?? remedyTemplateID ?? "the current remedy"

        guard let recommendation = portfolio.topRecommendation else {
            return CorrectionWorkspaceStatusSnapshot(
                title: "No clean precedent yet",
                detail: "\(scopeLine) \(outcomeLine) No remedy template has closed this diagnosis cleanly yet.\(rootCauseLine)",
                systemImage: "books.vertical")
        }

        switch recommendation.stage {
        case .recommended:
            if recommendation.templateID == remedyTemplateID {
                return CorrectionWorkspaceStatusSnapshot(
                    title: "Current remedy matches best precedent",
                    detail: "\(scopeLine) \(outcomeLine) \(recommendation.templateLabel) is the cleanest precedent with \(recommendation.successCount) resolved round(s) across \(recommendation.successfulBotCount) bot(s) and no recorded failures.\(rootCauseLine)",
                    systemImage: "checkmark.seal")
            }
            return CorrectionWorkspaceStatusSnapshot(
                title: "Stronger precedent exists",
                detail: "\(scopeLine) \(outcomeLine) Best clean precedent is \(recommendation.templateLabel), with \(recommendation.successCount) resolved round(s) across \(recommendation.successfulBotCount) bot(s) and no recorded failures. Current round is using \(currentRemedyTitle).\(rootCauseLine)",
                systemImage: "books.vertical.fill")
        case .building:
            let roundsLine = recommendation.roundsRemainingForRecommendation == 1
                ? "1 more clean resolve"
                : "\(recommendation.roundsRemainingForRecommendation) more clean resolves"
            let botsLine = recommendation.botsRemainingForRecommendation == 1
                ? "1 more bot"
                : "\(recommendation.botsRemainingForRecommendation) more bots"
            let leadLine: String
            if recommendation.templateID == remedyTemplateID {
                leadLine = "Current remedy \(recommendation.templateLabel) is building precedent with \(recommendation.successCount) clean resolve(s) across \(recommendation.successfulBotCount) bot(s)."
            } else {
                leadLine = "Best-looking precedent so far is \(recommendation.templateLabel), with \(recommendation.successCount) clean resolve(s) across \(recommendation.successfulBotCount) bot(s)."
            }
            return CorrectionWorkspaceStatusSnapshot(
                title: recommendation.templateID == remedyTemplateID ? "Current remedy is building precedent" : "Best precedent is still forming",
                detail: "\(scopeLine) \(outcomeLine) \(leadLine) It still needs \(roundsLine) and \(botsLine) before this diagnosis has a stronger recommended template.\(rootCauseLine)",
                systemImage: "chart.line.uptrend.xyaxis.circle")
        case .mixed:
            return CorrectionWorkspaceStatusSnapshot(
                title: "Template precedent is mixed",
                detail: "\(scopeLine) \(outcomeLine) \(recommendation.templateLabel) has \(recommendation.successCount) resolved round(s) but \(recommendation.failureCount) failed or superseded round(s), so the casebook does not treat it as a clean answer yet.\(rootCauseLine)",
                systemImage: "equal.circle")
        case .atRisk:
            return CorrectionWorkspaceStatusSnapshot(
                title: "Template precedent is at risk",
                detail: "\(scopeLine) \(outcomeLine) \(recommendation.templateLabel) has no clean resolves yet and \(recommendation.failureCount) failed or superseded round(s), so it is not a trustworthy precedent.\(rootCauseLine)",
                systemImage: "exclamationmark.triangle")
        case .unproven:
            return CorrectionWorkspaceStatusSnapshot(
                title: "Template precedent is unproven",
                detail: "\(scopeLine) \(outcomeLine) \(recommendation.templateLabel) has been attached before, but it does not have a runtime-validated result yet.\(rootCauseLine)",
                systemImage: "questionmark.circle")
        }
    }

    private static func interventionProgressStatus(
        subjectID: String,
        diagnosisID: String,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        tracksCasebook: Bool) -> CorrectionWorkspaceProgressSnapshot?
    {
        guard tracksCasebook else { return nil }

        let activeCase = casebook.activeCases.first(where: {
            $0.subjectID == subjectID && $0.diagnosisID == diagnosisID
        })
        let latestTreatment = casebook.latestTreatment(subjectID: subjectID, diagnosisID: diagnosisID)

        guard activeCase != nil || latestTreatment?.result == .pending else {
            return nil
        }

        let remedyTitle =
            remedyTemplateLabel?.nonEmpty
            ?? latestTreatment?.remedyTemplateLabel?.nonEmpty
            ?? activeCase?.remedyTemplateLabel?.nonEmpty
            ?? remedyTemplateID?.nonEmpty
            ?? latestTreatment?.remedyTemplateID?.nonEmpty
            ?? activeCase?.remedyTemplateID?.nonEmpty
            ?? "Current remedy"
        let prescribedAtMs = latestTreatment?.prescribedAtMs ?? activeCase?.firstSeenAtMs
        let lastSeenAtMs = activeCase?.lastSeenAtMs
        let mergedRuntimeEvidence = runtimeEvidence
            ?? activeCase?.runtimeEvidence
            ?? latestTreatment?.runtimeEvidence

        var highlights: [String] = ["Current treatment: \(remedyTitle)"]
        if let prescribedAtMs {
            let openedDate = Date(timeIntervalSince1970: Double(prescribedAtMs) / 1000)
            highlights.append("Current round opened \(Self.relativeFormatter.localizedString(for: openedDate, relativeTo: .now)).")
        }
        if let lastSeenAtMs {
            let lastSeenDate = Date(timeIntervalSince1970: Double(lastSeenAtMs) / 1000)
            highlights.append("Live diagnosis was last refreshed \(Self.relativeFormatter.localizedString(for: lastSeenDate, relativeTo: .now)).")
        }

        let title: String
        let detail: String
        let systemImage: String
        let dispatchDate = mergedRuntimeEvidence?.interventionDispatchedAtMs
            .map { Date(timeIntervalSince1970: Double($0) / 1000) }
        let dispatchRelative = dispatchDate.map { Self.relativeFormatter.localizedString(for: $0, relativeTo: .now) }
        if let dispatchRelative {
            highlights.append("Intervention was dispatched \(dispatchRelative).")
        } else {
            highlights.append("This round has not yet recorded a confirmed intervention dispatch.")
        }
        if let summary = mergedRuntimeEvidence?.interventionDispatchSummary?.nonEmpty {
            highlights.append("Dispatch summary: \(summary)")
        }

        if let mergedRuntimeEvidence,
           let assistantOutputAtMs = mergedRuntimeEvidence.assistantOutputAtMs
        {
            let outputDate = Date(timeIntervalSince1970: Double(assistantOutputAtMs) / 1000)
            let outputRelative = Self.relativeFormatter.localizedString(for: outputDate, relativeTo: .now)
            if mergedRuntimeEvidence.outputAfterRoundStart == true {
                if mergedRuntimeEvidence.assistantOutputHasArtifact == true {
                    title = "Fresh artifact observed"
                    detail = "A new assistant-visible artifact landed \(outputRelative) after treatment began. The round stays open until the diagnosis clears or is replaced by newer runtime truth."
                    systemImage = "checklist"
                } else {
                    title = "Fresh output observed"
                    detail = "A new assistant output landed \(outputRelative) after treatment began, but the app has not yet seen enough runtime proof to auto-close the round."
                    systemImage = "waveform.path.ecg"
                }
            } else {
                title = dispatchDate == nil ? "Awaiting intervention dispatch" : "Awaiting fresh runtime proof"
                detail = dispatchDate == nil
                    ? "The latest assistant output was \(outputRelative), but this round still has no recorded dispatch. The app cannot treat it as a closed-loop intervention yet."
                    : "The latest assistant output was \(outputRelative), before this treatment round started. The app is still waiting for fresh post-treatment proof."
                systemImage = "hourglass"
            }

            if let summary = mergedRuntimeEvidence.assistantOutputSummary?.nonEmpty {
                highlights.append("Latest runtime summary: \(summary)")
            }
            if mergedRuntimeEvidence.assistantOutputHasArtifact == true {
                highlights.append("The latest assistant output included an artifact attachment.")
            } else {
                highlights.append("No artifact is attached to the latest assistant-visible output yet.")
            }
        } else {
            title = dispatchDate == nil ? "Awaiting intervention dispatch" : "Awaiting first runtime evidence"
            detail = dispatchDate == nil
                ? "This treatment round is open, but the app has not yet recorded a confirmed intervention send for it."
                : "This treatment round is open, but no assistant-visible runtime output has been attached to it yet."
            systemImage = "hourglass"
            highlights.append(dispatchDate == nil
                ? "No confirmed intervention dispatch has been captured for this round yet."
                : "No fresh assistant output has been captured for this round yet.")
        }

        return CorrectionWorkspaceProgressSnapshot(
            title: title,
            detail: detail,
            highlights: Array(Self.uniqueOrdered(highlights).prefix(4)),
            systemImage: systemImage)
    }

    private static func similarCasesStatus(
        subjectID: String,
        diagnosisID: String,
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        tracksCasebook: Bool) -> CorrectionWorkspaceResearchSnapshot?
    {
        guard tracksCasebook,
              let portfolio = casebook.diagnosisPortfolio(diagnosisID: diagnosisID)
        else {
            return nil
        }

        let seenElsewhere = portfolio.seenSubjectIDs.filter { $0 != subjectID }
        let activeElsewhere = portfolio.activeSubjectIDs.filter { $0 != subjectID }
        let seenLabels = Self.subjectLabels(for: seenElsewhere, casebook: casebook)
        let activeLabels = Self.subjectLabels(for: activeElsewhere, casebook: casebook)

        var highlights: [String] = []
        if seenLabels.isEmpty {
            highlights.append("Only this bot has a recorded case for this diagnosis so far.")
        } else {
            let labelLine = Self.listFormatter.string(from: seenLabels) ?? seenLabels.joined(separator: ", ")
            highlights.append("Also seen on \(labelLine).")
        }

        if activeLabels.isEmpty {
            highlights.append("No other bot is currently active with the same diagnosis.")
        } else {
            let labelLine = Self.listFormatter.string(from: activeLabels) ?? activeLabels.joined(separator: ", ")
            highlights.append("Still active elsewhere on \(labelLine).")
        }

        if let rootCause = portfolio.leadingRootCauses.first?.nonEmpty {
            highlights.append("Leading recorded root cause: \(rootCause)")
        }

        if let recommendation = portfolio.topRecommendation {
            let currentRemedyTitle = remedyTemplateLabel ?? remedyTemplateID ?? "Current remedy"
            switch recommendation.stage {
            case .recommended:
                if recommendation.templateID == remedyTemplateID {
                    highlights.append("\(recommendation.templateLabel) is the strongest clean precedent with \(recommendation.successCount) resolved round(s) across \(recommendation.successfulBotCount) bot(s).")
                } else {
                    highlights.append("Strongest precedent is \(recommendation.templateLabel). Current remedy is \(currentRemedyTitle).")
                }
            case .building:
                highlights.append("\(recommendation.templateLabel) is the closest precedent so far, but still needs \(recommendation.roundsRemainingForRecommendation) more clean resolve(s) across \(recommendation.botsRemainingForRecommendation) more bot(s).")
            case .mixed:
                highlights.append("\(recommendation.templateLabel) is mixed: \(recommendation.successCount) resolved round(s), \(recommendation.failureCount) failed or superseded.")
            case .atRisk:
                highlights.append("\(recommendation.templateLabel) is currently risky with \(recommendation.failureCount) failed or superseded round(s) and no clean resolve yet.")
            case .unproven:
                highlights.append("\(recommendation.templateLabel) has been attached before but still lacks runtime-validated outcomes.")
            }
        }

        if let researchEvidence = runtimeEvidence,
           let fetchedAtMs = researchEvidence.externalResearchFetchedAtMs
        {
            let fetchedAt = Date(timeIntervalSince1970: Double(fetchedAtMs) / 1000)
            let queryLine = researchEvidence.externalResearchQuery?.nonEmpty.map { "Query: \($0)." } ?? ""
            let summaryLine = researchEvidence.externalResearchSummary?.nonEmpty ?? "External web research was refreshed."
            highlights.append(
                "External research refreshed \(Self.relativeFormatter.localizedString(for: fetchedAt, relativeTo: .now)). \(summaryLine) \(queryLine)")

            for item in researchEvidence.externalResearchItems.prefix(2) {
                let snippet = item.snippet.nonEmpty.map { ": \($0)" } ?? ""
                highlights.append("Web: \(item.title) (\(item.source))\(snippet)")
            }
        }

        return CorrectionWorkspaceResearchSnapshot(
            title: researchEvidenceTitle(
                seenBotCount: portfolio.seenBotCount,
                hasExternalResearch: runtimeEvidence?.externalResearchFetchedAtMs != nil),
            detail: researchEvidenceDetail(
                portfolio: portfolio,
                runtimeEvidence: runtimeEvidence),
            highlights: Array(Self.uniqueOrdered(highlights).prefix(6)),
            sources: runtimeEvidence?.externalResearchItems.map {
                CorrectionWorkspaceResearchSourceSnapshot(
                    title: $0.title,
                    source: $0.source,
                    snippet: $0.snippet.nonEmpty,
                    url: $0.url)
            } ?? [],
            systemImage: runtimeEvidence?.externalResearchFetchedAtMs != nil ? "globe" : "books.vertical.fill")
    }

    private static func researchEvidenceTitle(seenBotCount: Int, hasExternalResearch: Bool) -> String {
        if hasExternalResearch, seenBotCount > 1 {
            return "Cross-bot and external research are available"
        }
        if hasExternalResearch {
            return "External research is available"
        }
        return seenBotCount > 1 ? "Cross-bot symptom map is available" : "Casebook is still local to this bot"
    }

    private static func researchEvidenceDetail(
        portfolio: OpenClawKit.CorrectionDiagnosisPortfolioStats,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?) -> String
    {
        let baseLine = "\(portfolio.diagnosisLabel) has been recorded on \(portfolio.seenBotCount) bot(s), with \(portfolio.activeBotCount) currently active and \(portfolio.resolvedCount) resolved round(s) on record."
        guard let summary = runtimeEvidence?.externalResearchSummary?.nonEmpty else {
            return baseLine
        }
        return "\(baseLine) \(summary)"
    }

    private static func casebookRuntimeEvidence(
        subjectID: String,
        diagnosisID: String,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> OpenClawKit.CorrectionRuntimeEvidence?
    {
        casebook.activeCases.first(where: {
            $0.subjectID == subjectID && $0.diagnosisID == diagnosisID
        })?.runtimeEvidence
            ?? casebook.latestTreatment(subjectID: subjectID, diagnosisID: diagnosisID)?.runtimeEvidence
    }

    private static func mergedRuntimeEvidence(
        current: OpenClawKit.CorrectionRuntimeEvidence?,
        incoming: OpenClawKit.CorrectionRuntimeEvidence?) -> OpenClawKit.CorrectionRuntimeEvidence?
    {
        guard current != nil || incoming != nil else {
            return nil
        }

        let incomingTouchesExternalResearch =
            incoming?.externalResearchFetchedAtMs != nil
            || incoming?.externalResearchQuery?.nonEmpty != nil
            || incoming?.externalResearchSummary?.nonEmpty != nil
            || incoming?.externalResearchItems.isEmpty == false

        return OpenClawKit.CorrectionRuntimeEvidence(
            assistantOutputAtMs: incoming?.assistantOutputAtMs ?? current?.assistantOutputAtMs,
            assistantOutputSummary: incoming?.assistantOutputSummary ?? current?.assistantOutputSummary,
            assistantOutputHasArtifact: incoming?.assistantOutputHasArtifact ?? current?.assistantOutputHasArtifact,
            outputAfterRoundStart: incoming?.outputAfterRoundStart ?? current?.outputAfterRoundStart,
            interventionDispatchedAtMs: incoming?.interventionDispatchedAtMs ?? current?.interventionDispatchedAtMs,
            interventionDispatchSummary: incoming?.interventionDispatchSummary ?? current?.interventionDispatchSummary,
            externalResearchFetchedAtMs: incomingTouchesExternalResearch
                ? incoming?.externalResearchFetchedAtMs
                : current?.externalResearchFetchedAtMs,
            externalResearchQuery: incomingTouchesExternalResearch
                ? incoming?.externalResearchQuery
                : current?.externalResearchQuery,
            externalResearchSummary: incomingTouchesExternalResearch
                ? incoming?.externalResearchSummary
                : current?.externalResearchSummary,
            externalResearchItems: incomingTouchesExternalResearch
                ? (incoming?.externalResearchItems ?? [])
                : (current?.externalResearchItems ?? []))
    }

    private static func runtimeTruthStatus(
        subjectID: String,
        diagnosisID: String,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        tracksCasebook: Bool) -> CorrectionWorkspaceStatusSnapshot?
    {
        guard tracksCasebook else { return nil }
        guard let latestTreatment = casebook.latestTreatment(subjectID: subjectID, diagnosisID: diagnosisID) else {
            return CorrectionWorkspaceStatusSnapshot(
                title: "Await runtime truth",
                detail: "This round stays open until fresh runtime evidence clears, mutates, or replaces the live signal.",
                systemImage: "hourglass")
        }

        switch latestTreatment.result {
        case .pending:
            let date = Date(timeIntervalSince1970: Double(latestTreatment.prescribedAtMs) / 1000)
            return CorrectionWorkspaceStatusSnapshot(
                title: "Await runtime truth",
                detail: "Treatment started \(Self.relativeFormatter.localizedString(for: date, relativeTo: .now)). The app will validate this round from live state, not by manual claim.",
                systemImage: "waveform.path.ecg")
        case .resolved:
            let resolvedDate = latestTreatment.resolvedAtMs.map { Date(timeIntervalSince1970: Double($0) / 1000) }
            let when = resolvedDate.map { Self.relativeFormatter.localizedString(for: $0, relativeTo: .now) } ?? "on the latest recorded round"
            return CorrectionWorkspaceStatusSnapshot(
                title: "Last round auto-resolved",
                detail: "Runtime evidence closed this diagnosis as resolved \(when).",
                systemImage: "checkmark.seal")
        case .failed:
            let resolvedDate = latestTreatment.resolvedAtMs.map { Date(timeIntervalSince1970: Double($0) / 1000) }
            let when = resolvedDate.map { Self.relativeFormatter.localizedString(for: $0, relativeTo: .now) } ?? "on the latest recorded round"
            return CorrectionWorkspaceStatusSnapshot(
                title: "Last round auto-failed",
                detail: "Runtime evidence showed the same diagnosis persisted or worsened \(when).",
                systemImage: "xmark.octagon")
        case .superseded:
            let resolvedDate = latestTreatment.resolvedAtMs.map { Date(timeIntervalSince1970: Double($0) / 1000) }
            let when = resolvedDate.map { Self.relativeFormatter.localizedString(for: $0, relativeTo: .now) } ?? "on the latest recorded round"
            return CorrectionWorkspaceStatusSnapshot(
                title: "Last round superseded",
                detail: "Runtime evidence replaced this diagnosis with a different active condition \(when).",
                systemImage: "arrow.triangle.branch")
        }
    }

    private static func activityRuntimeTruthStatus(
        subjectID: String,
        diagnosisID: String,
        current: WorkActivityStore.Activity,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> CorrectionWorkspaceStatusSnapshot?
    {
        if let latestTreatment = casebook.latestTreatment(subjectID: subjectID, diagnosisID: diagnosisID),
           latestTreatment.result != .pending
        {
            return Self.runtimeTruthStatus(
                subjectID: subjectID,
                diagnosisID: diagnosisID,
                casebook: casebook,
                tracksCasebook: true)
        }

        guard let runtimeEvidence else {
            return CorrectionWorkspaceStatusSnapshot(
                title: "No runtime output yet",
                detail: "No assistant output has been observed for this lane in the retained runtime event window, so the round has no delivery proof yet.",
                systemImage: "hourglass")
        }

        let relativeOutput = runtimeEvidence.assistantOutputAtMs
            .map { Date(timeIntervalSince1970: Double($0) / 1000) }
            .map { Self.relativeFormatter.localizedString(for: $0, relativeTo: .now) }
            ?? "recently"
        let artifactLine = runtimeEvidence.assistantOutputHasArtifact == true ? " It included an artifact attachment." : ""
        if runtimeEvidence.outputAfterRoundStart == true {
            return CorrectionWorkspaceStatusSnapshot(
                title: "Fresh runtime output observed",
                detail: "Latest assistant output landed \(relativeOutput) after this activity started.\(artifactLine) The round is still open because no close-out evidence has cleared it yet.",
                systemImage: "waveform.path.ecg")
        }

        return CorrectionWorkspaceStatusSnapshot(
            title: "No fresh runtime output",
            detail: "Latest assistant output was \(relativeOutput), before this activity started.\(artifactLine) No newer verified output has appeared for this lane yet.",
            systemImage: "hourglass")
    }

    private static func templateValidationStatus(
        remedyTemplateID: String?,
        remedyTemplateLabel: String?,
        casebook: OpenClawKit.CorrectionCasebookSnapshot,
        tracksCasebook: Bool) -> CorrectionWorkspaceStatusSnapshot?
    {
        guard tracksCasebook,
              let templateID = remedyTemplateID
        else {
            return nil
        }

        let title = remedyTemplateLabel ?? templateID
        let portfolio = casebook.templatePortfolio(templateID: templateID)
        let summary = casebook.templatePortfolioSummary()
        let syntheticTrial = casebook.syntheticTrialTemplate(templateID: templateID)
        let nextSyntheticRun = casebook.nextSyntheticTrialRun(templateID: templateID)

        guard let portfolio else {
            return CorrectionWorkspaceStatusSnapshot(
                title: title,
                detail: "Unvalidated template. No recorded runtime outcome exists for this remedy yet.",
                systemImage: "questionmark.circle")
        }

        let attempts = max(portfolio.prescribedCount, portfolio.totalResolvedRounds)
        switch portfolio.stage {
        case .candidate:
            let trialLine: String
            if let syntheticTrial {
                let nextPlanLine = nextSyntheticRun.map {
                    " Next run is iteration \($0.iteration). \($0.profileSummary)"
                } ?? ""
                switch syntheticTrial.stage {
                case .queued:
                    trialLine = " Synthetic randomized bot \(syntheticTrial.syntheticBotLabel) is queued for \(syntheticTrial.plannedRunCount) validation run(s).\(nextPlanLine)"
                case .validating:
                    trialLine = " Synthetic randomized bot \(syntheticTrial.syntheticBotLabel) has passed \(syntheticTrial.passedRunCount)/\(syntheticTrial.plannedRunCount) run(s) so far.\(nextPlanLine)"
                case .failed:
                    trialLine = " Synthetic randomized bot \(syntheticTrial.syntheticBotLabel) exposed \(syntheticTrial.failedRunCount) failed run(s), so universal promotion is blocked."
                case .universal:
                    trialLine = " Synthetic randomized bot \(syntheticTrial.syntheticBotLabel) cleared all \(syntheticTrial.plannedRunCount) run(s), so this remedy is ready as a universal backup candidate."
                }
            } else if summary.readyForSyntheticTrials {
                trialLine = " Portfolio now has \(summary.candidateTemplateCount) candidate templates, so synthetic randomized bot trials can begin."
            } else {
                let missing = max(0, 3 - summary.candidateTemplateCount)
                trialLine = " Needs \(missing) more candidate template(s) before synthetic randomized bot trials begin."
            }
            return CorrectionWorkspaceStatusSnapshot(
                title: title,
                detail: "Candidate backup template. \(portfolio.successCount)/\(attempts) recorded round(s) resolved cleanly across \(portfolio.successfulBotCount) bot(s)." + trialLine,
                systemImage: "checkmark.seal")
        case .atRisk:
            return CorrectionWorkspaceStatusSnapshot(
                title: title,
                detail: "At risk. \(portfolio.failureCount)/\(attempts) recorded round(s) failed or were superseded. Candidate promotion stays blocked until the template proves a clean recovery path.",
                systemImage: "exclamationmark.triangle")
        case .mixed:
            return CorrectionWorkspaceStatusSnapshot(
                title: title,
                detail: "Mixed template. \(portfolio.successCount) resolved, \(portfolio.failureCount) failed or were superseded across \(max(portfolio.successfulBotCount, portfolio.failedBotCount)) tracked bot(s). Candidate promotion stays blocked.",
                systemImage: "equal.circle")
        case .building:
            let roundsLine = portfolio.roundsRemainingForCandidate == 1
                ? "1 more successful round"
                : "\(portfolio.roundsRemainingForCandidate) more successful rounds"
            let botsLine = portfolio.botsRemainingForCandidate == 1
                ? "1 more bot"
                : "\(portfolio.botsRemainingForCandidate) more bots"
            return CorrectionWorkspaceStatusSnapshot(
                title: title,
                detail: "Building candidate. \(portfolio.successCount)/\(attempts) recorded round(s) resolved across \(portfolio.successfulBotCount) bot(s). Needs \(roundsLine) and \(botsLine) before this remedy can be promoted into the candidate backup set.",
                systemImage: "chart.line.uptrend.xyaxis.circle")
        case .unproven:
            return CorrectionWorkspaceStatusSnapshot(
                title: title,
                detail: "Unproven template. Waiting for the first runtime-validated outcome before promotion accounting can begin.",
                systemImage: "questionmark.circle")
        }
    }

    private static func activityLikelyRootCause(
        current: WorkActivityStore.Activity,
        runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?) -> String
    {
        guard let runtimeEvidence else {
            return "The lane is spending runtime without producing any retained assistant-visible output."
        }
        if runtimeEvidence.outputAfterRoundStart == true {
            if runtimeEvidence.assistantOutputHasArtifact == true {
                return "The lane is producing artifacts, but it is not closing the loop with a final verified completion signal."
            }
            return "The lane is still talking, but it is not converting that work into a closed, verified delivery result."
        }
        return "The lane went quiet after an earlier round and has not produced fresh runtime output for the current correction window."
    }

    private static func activityRuntimeEvidence(
        subjectID: String,
        diagnosisID: String,
        current: WorkActivityStore.Activity,
        latestAssistantOutput: AgentEventStore.AssistantOutputEvidence?,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> OpenClawKit.CorrectionRuntimeEvidence?
    {
        if let latestAssistantOutput {
            return OpenClawKit.CorrectionRuntimeEvidence(
                assistantOutputAtMs: Int(latestAssistantOutput.eventDate.timeIntervalSince1970 * 1000),
                assistantOutputSummary: Self.runtimeOutputSummary(latestAssistantOutput.text),
                assistantOutputHasArtifact: latestAssistantOutput.hasMedia,
                outputAfterRoundStart: latestAssistantOutput.eventDate >= current.startedAt)
        }

        guard let latestTreatment = casebook.latestTreatment(subjectID: subjectID, diagnosisID: diagnosisID),
              latestTreatment.result == .pending
        else {
            return nil
        }
        return latestTreatment.runtimeEvidence
    }

    private static func appendRuntimeEvidenceLines(
        _ runtimeEvidence: OpenClawKit.CorrectionRuntimeEvidence?,
        to evidence: inout [String])
    {
        guard let runtimeEvidence else { return }
        if let assistantOutputAtMs = runtimeEvidence.assistantOutputAtMs {
            let relativeOutput = Self.relativeFormatter.localizedString(
                for: Date(timeIntervalSince1970: Double(assistantOutputAtMs) / 1000),
                relativeTo: .now)
            if runtimeEvidence.outputAfterRoundStart == true {
                evidence.append("Latest assistant output: \(relativeOutput)")
            } else {
                evidence.append("Latest assistant output predates this round: \(relativeOutput)")
            }
        } else {
            evidence.append("Runtime output has been recorded for this lane.")
        }
        if runtimeEvidence.assistantOutputHasArtifact == true {
            evidence.append("Latest assistant output attached an artifact.")
        }
        if let summary = runtimeEvidence.assistantOutputSummary?.nonEmpty {
            evidence.append("Output summary: \(summary)")
        }
    }

    private static func runtimeOutputSummary(_ text: String) -> String? {
        let condensed = text
            .split(whereSeparator: \.isWhitespace)
            .joined(separator: " ")
            .trimmingCharacters(in: .whitespacesAndNewlines)
        guard let condensed = condensed.nonEmpty else { return nil }
        if condensed.count <= 140 {
            return condensed
        }
        let index = condensed.index(condensed.startIndex, offsetBy: 140)
        return "\(condensed[..<index])..."
    }

    private static func healthyCheckpointLine(_ lastHealthy: Date?) -> [String] {
        guard let lastHealthy else {
            return ["No confirmed healthy checkpoint has been recorded in this app session yet."]
        }
        return ["Last healthy evidence checkpoint: \(Self.relativeFormatter.localizedString(for: lastHealthy, relativeTo: .now))"]
    }

    private static func treatmentSummaryPrefix(for result: OpenClawKit.CorrectionTreatmentResult) -> String {
        switch result {
        case .pending: "Current treatment"
        case .resolved: "Last resolved treatment"
        case .failed: "Last failed treatment"
        case .superseded: "Last superseded treatment"
        }
    }

    private static func subjectLabels(
        for subjectIDs: [String],
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> [String]
    {
        self.uniqueOrdered(subjectIDs.map { self.subjectLabel(for: $0, casebook: casebook) })
    }

    private static func subjectLabel(
        for subjectID: String,
        casebook: OpenClawKit.CorrectionCasebookSnapshot) -> String
    {
        if let label = casebook.record(subjectID: subjectID)?.label.nonEmpty {
            return label
        }
        if let suffix = subjectID.split(separator: ":").last {
            let normalized = String(suffix).replacingOccurrences(of: "-", with: " ")
            return normalized.capitalized
        }
        return subjectID
    }

    private static func uniqueOrdered(_ values: [String]) -> [String] {
        var seen = Set<String>()
        return values.filter { value in
            let normalized = value.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !normalized.isEmpty else { return false }
            if seen.contains(normalized) {
                return false
            }
            seen.insert(normalized)
            return true
        }
    }

    private static func fingerprint(_ parts: [String]) -> String {
        parts
            .map { $0.replacingOccurrences(of: "|", with: "/").trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }
            .joined(separator: "|")
    }

    private static func sortRank(_ severity: CorrectionWorkspaceIssue.Severity) -> Int {
        switch severity {
        case .critical: 4
        case .warning: 3
        case .watch: 2
        case .healthy: 1
        }
    }
}
