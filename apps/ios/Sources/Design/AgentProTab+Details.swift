import OpenClawKit
import OpenClawProtocol
import SwiftUI

extension AgentProTab {
    @ViewBuilder
    func destination(for route: AgentRoute) -> some View {
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

    var nodesDestination: some View {
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

    var cronDestination: some View {
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

    var usageDestination: some View {
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

    var dreamingDestination: some View {
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

    var skillsPolicyControls: some View {
        ProCard(radius: AgentLayout.cardRadius) {
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

    var skillsFilterField: some View {
        ProCard(padding: 10, radius: AgentLayout.cardRadius) {
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

    var clawHubSearchCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
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

    func clawHubResultRow(_ result: ClawHubSearchResultLite) -> some View {
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

    var skillsList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Installed Skills")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
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

    var activeAgentName: String {
        if let agent = self.appModel.gatewayAgents.first(where: { $0.id == self.activeAgentID }) {
            return self.agentName(for: agent)
        }
        return self.activeAgentID
    }

    var agentSkillFilter: Set<String>? {
        self.overview?.agentSkillFilter.map { Set($0) }
    }

    var skillPolicySummary: String {
        guard self.gatewayConnected else { return "Connect a gateway to edit skills." }
        guard let filter = self.agentSkillFilter else {
            return "All available skills are allowed for this agent."
        }
        if filter.isEmpty {
            return "No skills are allowed for this agent."
        }
        return "\(filter.count) skills are allowed for this agent."
    }

    var skillMutationBusy: Bool {
        !self.skillMutationBusyKeys.isEmpty
    }

    var filteredSkills: [SkillStatusEntryLite] {
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

    func matchesSkillStatusFilter(_ skill: SkillStatusEntryLite) -> Bool {
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

    func sortSkills(_ lhs: SkillStatusEntryLite, _ rhs: SkillStatusEntryLite) -> Bool {
        let lhsEnabled = self.isSkillAllowed(lhs)
        let rhsEnabled = self.isSkillAllowed(rhs)
        if lhsEnabled != rhsEnabled { return lhsEnabled && !rhsEnabled }
        return lhs.name.localizedCaseInsensitiveCompare(rhs.name) == .orderedAscending
    }

    func skillRow(_ skill: SkillStatusEntryLite) -> some View {
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

    func skillToggle(_ skill: SkillStatusEntryLite, title: String) -> some View {
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

    func isSkillAllowed(_ skill: SkillStatusEntryLite) -> Bool {
        guard let filter = self.agentSkillFilter else { return true }
        return filter.contains(skill.name)
    }

    func isSkillConfigBusy(_ skill: SkillStatusEntryLite) -> Bool {
        self.skillConfigBusyKeys.contains(skill.effectiveSkillKey)
            || self.clawHubInstallSlug != nil
    }

    func canInstallSkillRequirements(_ skill: SkillStatusEntryLite) -> Bool {
        skill.install?.first?.id?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
            && !skill.missingBins.isEmpty
    }

    func skillByKey(_ key: String) -> SkillStatusEntryLite? {
        (self.overview?.skills?.skills ?? []).first { skill in
            skill.effectiveSkillKey == key || skill.name == key
        }
    }

    func openSkillEditor(_ skill: SkillStatusEntryLite) {
        self.skillEditorSelection = SkillEditorSelection(id: skill.effectiveSkillKey)
    }

    func skillAPIKeyBinding(for skill: SkillStatusEntryLite) -> Binding<String> {
        Binding(
            get: { self.skillAPIKeyDrafts[skill.effectiveSkillKey] ?? "" },
            set: { self.skillAPIKeyDrafts[skill.effectiveSkillKey] = $0 })
    }

    var missingSkillEditorSheet: some View {
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

    func skillEditorSheet(_ skill: SkillStatusEntryLite) -> some View {
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

    func skillEditorHeader(_ skill: SkillStatusEntryLite) -> some View {
        let status = self.skillStatus(skill)
        return ProCard(radius: AgentLayout.cardRadius) {
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

    func skillEditorControls(_ skill: SkillStatusEntryLite) -> some View {
        ProCard(radius: AgentLayout.cardRadius) {
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

    func skillEditorSetup(_ skill: SkillStatusEntryLite) -> some View {
        ProCard(radius: AgentLayout.cardRadius) {
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

    func skillEditorMetadata(_ skill: SkillStatusEntryLite) -> some View {
        ProCard(radius: AgentLayout.cardRadius) {
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
    func setSkillAllowed(_ skill: SkillStatusEntryLite, enabled: Bool) async {
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
    func enableAllSkills() async {
        let allNames = self.allSkillNames
        guard !allNames.isEmpty else { return }
        await self.patchAgentSkills(allNames, busyKey: "__all__")
    }

    @MainActor
    func disableAllSkills() async {
        await self.patchAgentSkills([], busyKey: "__all__")
    }

    @MainActor
    func resetSkillPolicy() async {
        await self.patchAgentSkills(nil, busyKey: "__all__")
    }

    var allSkillNames: [String] {
        (self.overview?.skills?.skills ?? [])
            .map(\.name)
            .filter { !$0.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty }
            .sorted()
    }

    @MainActor
    func patchAgentSkills(_ skills: [String]?, busyKey: String) async {
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
    func updateSkillGlobalEnabled(_ skill: SkillStatusEntryLite, enabled: Bool) async {
        await self.runSkillConfigMutation(skill) {
            let params = SkillUpdateParams(skillKey: skill.effectiveSkillKey, enabled: enabled)
            _ = try await self.requestGateway(method: "skills.update", params: params, timeoutSeconds: 20)
            return enabled ? "Skill enabled." : "Skill disabled."
        }
    }

    @MainActor
    func saveSkillAPIKey(_ skill: SkillStatusEntryLite) async {
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
    func installSkillRequirements(_ skill: SkillStatusEntryLite) async {
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
    func installClawHubSkill(_ result: ClawHubSearchResultLite) async {
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
    func searchClawHubSkills() async {
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
    func runSkillConfigMutation(
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

    func requestGateway(
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

    func requestConfigSnapshot() async throws -> ConfigSnapshotLite {
        let data = try await self.appModel.operatorSession.request(
            method: "config.get",
            paramsJSON: "{}",
            timeoutSeconds: 12)
        return try JSONDecoder().decode(ConfigSnapshotLite.self, from: data)
    }

    static func agentSkillsPatchRaw(agentId: String, skills: [String]?) throws -> String {
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

    static func skillMutationMessage(_ error: Error) -> String {
        if let gatewayError = error as? GatewayResponseError {
            let lower = gatewayError.message.lowercased()
            if lower.contains("operator.admin") || lower.contains("unauthorized") {
                return "This gateway connection cannot edit config yet. Reconnect with admin scope."
            }
            return gatewayError.message
        }
        return error.localizedDescription
    }

    func skillStatus(_ skill: SkillStatusEntryLite) -> (text: String, color: Color) {
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

    var cronStatusCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
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

    var cronNextRunLabel: String {
        guard let nextWakeAtMs = self.overview?.cronStatus?.nextwakeatms else { return "none" }
        return Self.relativeTime(fromMilliseconds: nextWakeAtMs)
    }

    func cronJobsList(limit: Int?) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Jobs")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
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

    var sortedCronJobs: [CronJob] {
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

    func cronJobDetailRow(_ job: CronJob) -> some View {
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
    func runCronJob(_ job: CronJob) async {
        await self.runCronAction(job, success: "Queued \(job.name).") {
            let params = CronRunParams(id: job.id, mode: "force")
            _ = try await self.requestGateway(method: "cron.run", params: params, timeoutSeconds: 20)
        }
    }

    @MainActor
    func setCronJob(_ job: CronJob, enabled: Bool) async {
        await self.runCronAction(job, success: enabled ? "Enabled \(job.name)." : "Paused \(job.name).") {
            let params = CronUpdateParams(id: job.id, patch: CronUpdatePatch(enabled: enabled))
            _ = try await self.requestGateway(method: "cron.update", params: params, timeoutSeconds: 20)
        }
    }

    @MainActor
    func runCronAction(
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

    func cronScheduleSummary(_ job: CronJob) -> String {
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

    var usageTotalsCard: some View {
        ProCard(radius: AgentLayout.cardRadius) {
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

    var usageTokenValue: String {
        guard let tokens = self.overview?.usage?.totalTokens else { return "0" }
        return Self.compactNumber(tokens)
    }

    var usageCacheValue: String {
        guard let cacheStatus = self.normalized(self.overview?.usage?.cacheStatus?["status"]?.value as? String) else {
            return "n/a"
        }
        return cacheStatus
    }

    var usageDailyList: some View {
        VStack(alignment: .leading, spacing: 8) {
            ProSectionHeader(title: "Daily")
            ProCard(padding: 0, radius: AgentLayout.cardRadius) {
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

    func usageDayRow(_ day: CostUsageDailyEntryLite) -> some View {
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

    func detailMetric(label: String, value: String) -> some View {
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

    func emptyDetailRow(icon: String, title: String, detail: String) -> some View {
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

    func agentName(for agent: AgentSummary) -> String {
        self.normalized(agent.name) ?? agent.id
    }

    func agentBadge(for agent: AgentSummary) -> String {
        if let identity = agent.identity,
           let emoji = identity["emoji"]?.value as? String,
           let normalizedEmoji = self.normalized(emoji)
        {
            return normalizedEmoji
        }

        let words = self.agentName(for: agent)
            .split(whereSeparator: { $0.isWhitespace || $0 == "-" || $0 == "_" })
            .prefix(2)
        let initials = words.compactMap(\.first).map(String.init).joined()
        return initials.isEmpty ? "OC" : initials.uppercased()
    }

    func agentTint(for agent: AgentSummary, state: AgentRosterState) -> Color {
        if agent.id == self.activeAgentID { return OpenClawBrand.accent }
        return state.color.opacity(0.62)
    }

    func agentDetail(for agent: AgentSummary) -> String {
        let parts = [
            self.normalized(agent.workspace),
            self.modelLabel(for: agent),
            agent.id == self.appModel.gatewayDefaultAgentId ? "default" : nil,
        ].compactMap(\.self)
        return parts.isEmpty ? agent.id : parts.joined(separator: " • ")
    }

    func agentSessionSummary(_ agent: AgentSummary) -> String {
        guard self.gatewayConnected else { return "0" }
        if agent.id == self.activeAgentID {
            return self.appModel.isOperatorGatewayConnected ? "1 running" : "0"
        }
        return "0"
    }

    func agentRuntimeSummary(_ agent: AgentSummary) -> String {
        if let runtime = agent.agentruntime,
           let id = runtime["id"]?.value as? String,
           let normalized = self.normalized(id)
        {
            return normalized
        }
        if let model = self.modelLabel(for: agent) {
            return Self.shortModelLabel(model)
        }
        return "default"
    }

    func agentRosterState(for agent: AgentSummary) -> AgentRosterState {
        guard self.gatewayConnected else { return .idle }
        if agent.id == self.activeAgentID { return .online }
        if self.cronJobsContain(agentID: agent.id) { return .busy }
        return .idle
    }

    func cronJobsContain(agentID: String) -> Bool {
        self.recentCronJobs.contains { job in
            self.normalized(job.agentid) == agentID && job.enabled
        }
    }

    func modelLabel(for agent: AgentSummary) -> String? {
        guard let model = agent.model else { return nil }
        for key in ["primary", "name", "id", "model"] {
            if let value = model[key]?.value as? String,
               let normalized = self.normalized(value)
            {
                return normalized
            }
        }
        return nil
    }

    static func shortModelLabel(_ model: String) -> String {
        let trimmed = model.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return "default" }
        let leaf = trimmed.split(separator: "/").last.map(String.init) ?? trimmed
        return leaf
            .replacingOccurrences(of: "claude-", with: "")
            .replacingOccurrences(of: "gpt-", with: "")
    }

    func presenceLabel(_ entry: PresenceEntry) -> String? {
        self.normalized(entry.host)
            ?? self.normalized(entry.devicefamily)
            ?? self.normalized(entry.platform)
            ?? self.normalized(entry.mode)
    }

    func cronJobDetail(_ job: CronJob) -> String {
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

    func cronJobState(_ job: CronJob) -> String {
        if !job.enabled {
            return "paused"
        }
        if let status = Self.stringValue(job.state["lastStatus"]) ?? Self.stringValue(job.state["lastRunStatus"]) {
            return status
        }
        return "enabled"
    }

    @MainActor
    func refreshOverview(force: Bool) async {
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

    func requestOptional<T: Decodable>(
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

    func normalized(_ value: String?) -> String? {
        let trimmed = value?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? nil : trimmed
    }

    static func stringValue(_ value: AnyCodable?) -> String? {
        guard let string = value?.value as? String else { return nil }
        let trimmed = string.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed.isEmpty ? nil : trimmed
    }

    static func relativeTime(fromMilliseconds milliseconds: Int) -> String {
        let date = Date(timeIntervalSince1970: Double(milliseconds) / 1000)
        return date.formatted(.relative(presentation: .named, unitsStyle: .abbreviated))
    }

    static func compactNumber(_ value: Int) -> String {
        value.formatted(.number.notation(.compactName))
    }

    static func currency(_ value: Double) -> String {
        value.formatted(.currency(code: "USD").precision(.fractionLength(0...2)))
    }

    static func duration(milliseconds: Int) -> String {
        let seconds = max(0, milliseconds / 1000)
        if seconds < 60 { return "\(seconds)s" }
        let minutes = seconds / 60
        if minutes < 60 { return "\(minutes)m" }
        let hours = minutes / 60
        if hours < 24 { return "\(hours)h" }
        return "\(hours / 24)d"
    }

    static func agentScopedParams(agentId: String) -> String {
        guard let data = try? JSONEncoder().encode(["agentId": agentId]),
              let json = String(data: data, encoding: .utf8)
        else {
            return "{}"
        }
        return json
    }
}
