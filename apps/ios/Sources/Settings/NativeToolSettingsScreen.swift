import Foundation
import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct NativeToolSettingsScreen: View {
    enum Kind {
        case skills
        case plugins

        var title: String {
            self == .skills ? String(localized: "Skills") : String(localized: "Plugins")
        }

        var detailTitle: String {
            self == .skills ? String(localized: "Skill") : String(localized: "Plugin")
        }

        var searchPrompt: String {
            self == .skills ? String(localized: "Search skills") : String(localized: "Search plugins")
        }

        var readMethod: String {
            self == .skills ? "skills.status" : "plugins.list"
        }

        var updateMethod: String {
            self == .skills ? "skills.update" : "plugins.setEnabled"
        }
    }

    let kind: Kind
    let agentID: String
    let agentName: String
    let gatewayName: String?
    var onTrySkill: ((String) -> Void)?

    @Environment(NodeAppModel.self) private var appModel
    @State private var query = ""
    @State private var inventory = NativeToolSettingsInventory()

    private var connectionID: String {
        "\(self.appModel.operatorAuthorityGeneration)|\(self.agentID)"
    }

    var body: some View {
        let visibleSkills = self.inventory.skills.filter { self.matchesQuery($0.name) }
        let visiblePlugins = self.inventory.plugins.filter { self.matchesQuery($0.name) }
        List {
            Section {
                if self.inventory.isLoading, !self.inventory.hasLoaded {
                    ProgressView()
                }
                NativeToolSettingsFeedback(inventory: self.inventory)
                if self.inventory.hasLoaded, !self.inventory.canEdit {
                    Text("Read-only access").font(OpenClawType.footnote).foregroundStyle(.secondary)
                }
                if self.inventory.hasLoaded, visibleSkills.isEmpty, visiblePlugins.isEmpty {
                    Text(self.emptyLabel)
                        .font(OpenClawType.body)
                        .foregroundStyle(.secondary)
                }
                if self.kind == .skills {
                    ForEach(visibleSkills) { skill in
                        NavigationLink {
                            self.detail(id: skill.id)
                        } label: {
                            self.inventoryRow(
                                name: skill.name,
                                status: Self.attentionStatus(skill))
                        }
                    }
                } else {
                    ForEach(visiblePlugins) { plugin in
                        NavigationLink {
                            self.detail(id: plugin.id)
                        } label: {
                            self.inventoryRow(
                                name: plugin.name,
                                status: plugin.attentionStatus)
                        }
                    }
                }
            } header: {
                if let name = self.kind == .skills ? self.agentName.trimmedNonEmpty : self.gatewayName?
                    .trimmedNonEmpty
                {
                    Text(verbatim: name).font(OpenClawType.footnote)
                }
            }
        }
        .listStyle(.insetGrouped)
        .navigationTitle(self.kind.title)
        .navigationBarTitleDisplayMode(.inline)
        .searchable(
            text: self.$query,
            placement: .navigationBarDrawer(displayMode: .always),
            prompt: Text(self.kind.searchPrompt))
        .refreshable { await self.load() }
        .task(id: self.connectionID) {
            self.inventory.route = nil
            self.inventory.skills = []
            self.inventory.plugins = []
            self.inventory.hasLoaded = false
            self.inventory.canEdit = false
            self.inventory.notice = nil
            await self.load()
        }
    }

    private var emptyLabel: LocalizedStringKey {
        if !self.query.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty { return "No matches" }
        return self.kind == .skills ? "No skills available" : "No plugins installed"
    }

    private func matchesQuery(_ name: String) -> Bool {
        let filter = self.query.trimmingCharacters(in: .whitespacesAndNewlines)
        return filter.isEmpty || name.localizedStandardContains(filter)
    }

    @ViewBuilder
    private func inventoryRow(name: String, status: String?) -> some View {
        if let status {
            LabeledContent {
                Text(verbatim: status)
                    .font(OpenClawType.footnote)
                    .foregroundStyle(.secondary)
            } label: {
                Text(verbatim: name).font(OpenClawType.body)
            }
        } else {
            Text(verbatim: name).font(OpenClawType.body)
        }
    }

    private func detail(id: String) -> some View {
        NativeToolSettingsDetail(
            kind: self.kind,
            id: id,
            inventory: self.inventory,
            onTrySkill: self.onTrySkill,
            onSetEnabled: { enabled, id in await self.setEnabled(enabled, id: id) })
    }

    fileprivate static func attentionStatus(_ skill: SkillStatus) -> String? {
        if skill.disabled { return String(localized: "Disabled") }
        return self.unavailableReason(skill) == nil ? nil : String(localized: "Unavailable")
    }

    fileprivate static func sourceLabel(_ source: String) -> String? {
        switch source {
        case "openclaw-workspace", "workspace": String(localized: "Agent workspace")
        case "openclaw-bundled": String(localized: "Built-in")
        case "openclaw-managed": String(localized: "Installed")
        case "openclaw-workshop": String(localized: "Skill Workshop")
        case "openclaw-library": String(localized: "Skill library")
        default: nil
        }
    }

    private func load() async {
        let loadID = UUID()
        self.inventory.loadID = loadID
        self.inventory.isLoading = true
        self.inventory.failure = nil
        defer {
            if self.inventory.loadID == loadID {
                self.inventory.isLoading = false
            }
        }
        let gateway = self.appModel.operatorSession
        guard let currentRoute = await gateway.currentRoute() else {
            guard self.inventory.loadID == loadID, !Task.isCancelled else { return }
            self.inventory.canEdit = false
            self.inventory.failure = String(localized: "Connect to a Gateway to load these settings.")
            return
        }
        do {
            let scopes = await gateway.currentOperatorScopes(ifCurrentRoute: currentRoute) ?? []
            guard self.inventory.loadID == loadID, !Task.isCancelled else { return }
            guard !scopes.isDisjoint(with: ["operator.read", "operator.write", "operator.admin"]) else {
                self.inventory.canEdit = false
                self.inventory
                    .failure = String(localized: "This connection does not have permission to read these settings.")
                return
            }
            guard await gateway.supportsServerMethod(self.kind.readMethod, ifCurrentRoute: currentRoute) == true else {
                guard self.inventory.loadID == loadID, !Task.isCancelled else { return }
                self.inventory.canEdit = false
                self.inventory
                    .failure =
                    String(localized: "This Gateway does not support these settings. Update it and try again.")
                return
            }
            let params: [String: AnyCodable] = self.kind == .skills ? ["agentId": AnyCodable(self.agentID)] : [:]
            let data = try await gateway.request(
                method: self.kind.readMethod,
                params: params,
                ifCurrentRoute: currentRoute)
            let supportsUpdate = await gateway.supportsServerMethod(
                self.kind.updateMethod, ifCurrentRoute: currentRoute) == true
            guard self.inventory.loadID == loadID, !Task.isCancelled,
                  await gateway.currentRoute() == currentRoute else { return }
            if self.kind == .skills {
                self.inventory.skills = try JSONDecoder().decode(SkillsStatusReport.self, from: data).skills
                    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                self.inventory.canEdit = scopes.contains("operator.admin") && supportsUpdate
            } else {
                let report = try JSONDecoder().decode(NativeInstalledPluginsReport.self, from: data)
                self.inventory.plugins = report.plugins.filter(\.installed)
                    .sorted { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
                self.inventory.canEdit = scopes.contains("operator.admin") && supportsUpdate && report.mutationAllowed
            }
            self.inventory.route = currentRoute
            self.inventory.hasLoaded = true
        } catch {
            guard self.inventory.loadID == loadID, !Task.isCancelled else { return }
            self.inventory.canEdit = false
            self.inventory.failure = error.localizedDescription
        }
    }

    private func setEnabled(_ enabled: Bool, id: String) async {
        guard self.inventory.canEdit, self.inventory.pendingID == nil, let route = self.inventory.route else { return }
        let identity = self.connectionID
        self.inventory.pendingID = id
        self.inventory.failure = nil
        self.inventory.notice = nil
        defer { self.inventory.pendingID = nil }
        let gateway = self.appModel.operatorSession
        guard await gateway.currentOperatorScopes(ifCurrentRoute: route)?.contains("operator.admin") == true,
              await gateway.supportsServerMethod(self.kind.updateMethod, ifCurrentRoute: route) == true
        else {
            self.inventory.canEdit = false
            self.inventory.failure = String(localized: "The connection changed. Refresh these settings and try again.")
            return
        }
        var params: [String: AnyCodable] = [
            kind == .skills ? "skillKey" : "pluginId": AnyCodable(id),
            "enabled": AnyCodable(enabled),
        ]
        if self.kind == .plugins {
            params["allowlistPolicy"] = AnyCodable("preserve")
        }
        do {
            let data = try await gateway.request(
                method: self.kind.updateMethod,
                params: params,
                ifCurrentRoute: route,
                distinguishPreDispatchRouteChange: true)
            guard self.connectionID == identity else { return }
            if self.kind == .plugins {
                let result = try JSONDecoder().decode(NativePluginUpdateResult.self, from: data)
                var messages = result.warnings ?? []
                if result.restartRequired {
                    messages.insert(String(localized: "Saved. Restart the Gateway to apply this change."), at: 0)
                }
                self.inventory.notice = messages.isEmpty ? nil : messages.joined(separator: "\n")
            }
            // The write can be acknowledged before the runtime configuration is reloaded.
            for attempt in 0..<3 {
                guard self.connectionID == identity else { return }
                await self.load()
                guard self.connectionID == identity, self.inventory.failure == nil else { return }
                if self.enabledState(for: id) == enabled { return }
                if attempt < 2 { try await Task.sleep(for: .milliseconds(300)) }
            }
            if self.inventory.notice == nil {
                self.inventory.notice = String(localized: "Saved. Status hasn’t updated yet.")
            }
        } catch is CancellationError {
            return
        } catch {
            guard self.connectionID == identity else { return }
            self.inventory.failure = error.localizedDescription
        }
    }

    private func enabledState(for id: String) -> Bool? {
        switch self.kind {
        case .skills:
            self.inventory.skills.first(where: { $0.id == id }).map { !$0.disabled }
        case .plugins:
            self.inventory.plugins.first(where: { $0.id == id })?.enabled
        }
    }

    fileprivate static func unavailableReason(_ skill: SkillStatus) -> String? {
        if skill.blockedByAllowlist == true {
            return String(localized: "Blocked by the skill allowlist.")
        }
        if skill.blockedByAgentFilter == true {
            return String(localized: "Not included in this agent’s skills.")
        }
        let missing = skill.missing
        if !missing.os.isEmpty {
            return String(localized: "Requires operating system: ") + missing.os.joined(separator: ", ")
        }
        if skill.platformIncompatible == true {
            return String(localized: "Not supported on this Gateway’s operating system.")
        }
        if !missing.bins.isEmpty {
            return String(localized: "Missing programs: ") + missing.bins.joined(separator: ", ")
        }
        if !missing.anyBins.isEmpty {
            return String(localized: "Install one of these programs: ") + missing.anyBins.joined(separator: ", ")
        }
        if !missing.env.isEmpty {
            return String(localized: "Missing environment variables: ") + missing.env.joined(separator: ", ")
        }
        if !missing.config.isEmpty {
            return String(localized: "Needs configuration: ") + missing.config.joined(separator: ", ")
        }
        return skill.eligible || skill.disabled ? nil : String(localized: "Unavailable")
    }
}

@MainActor
@Observable
private final class NativeToolSettingsInventory {
    var skills: [SkillStatus] = []
    var plugins: [NativeInstalledPlugin] = []
    var route: GatewayNodeSessionRoute?
    var canEdit = false
    var isLoading = false
    var loadID = UUID()
    var hasLoaded = false
    var pendingID: String?
    var failure: String?
    var notice: String?
}

private struct NativeToolSettingsFeedback: View {
    let inventory: NativeToolSettingsInventory

    var body: some View {
        if let failure = self.inventory.failure {
            Text(verbatim: failure).font(OpenClawType.footnote).foregroundStyle(OpenClawBrand.danger)
        }
        if let notice = self.inventory.notice {
            Text(verbatim: notice).font(OpenClawType.footnote).foregroundStyle(.secondary)
        }
    }
}

private struct NativeToolSettingsDetail: View {
    let kind: NativeToolSettingsScreen.Kind
    let id: String
    let inventory: NativeToolSettingsInventory
    let onTrySkill: ((String) -> Void)?
    let onSetEnabled: (Bool, String) async -> Void

    var body: some View {
        if self.kind == .skills {
            self.skillDetail(id: self.id)
        } else {
            self.pluginDetail(id: self.id)
        }
    }

    private func detailHeader(name: String, description: String?) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(verbatim: name)
                .font(OpenClawType.title2SemiBold)
                .foregroundStyle(OpenClawBrand.textStrong)
                .accessibilityAddTraits(.isHeader)
            if let description = description?.trimmedNonEmpty {
                Text(verbatim: description)
                    .font(OpenClawType.subhead)
                    .foregroundStyle(OpenClawBrand.textSecondary)
            }
        }
        .textCase(nil)
        .padding(.bottom, 4)
    }

    private func skillDetail(id: String) -> some View {
        List {
            if let skill = self.inventory.skills.first(where: { $0.id == id }) {
                let unavailableReason = NativeToolSettingsScreen.unavailableReason(skill)
                Section {
                    let status = NativeToolSettingsScreen.attentionStatus(skill) ?? String(localized: "Available")
                    SettingsDetailRow("Status", value: .verbatim(status))
                    if let source = NativeToolSettingsScreen.sourceLabel(skill.source) {
                        SettingsDetailRow("Source", value: .verbatim(source))
                    }
                    if let onTrySkill, skill.eligible, !skill.disabled {
                        Button {
                            onTrySkill(String.localizedStringWithFormat(
                                String(localized: "Use the %@ skill."),
                                skill.name))
                        } label: {
                            HStack {
                                Text("Try in chat").font(OpenClawType.body)
                                Spacer()
                                Image(systemName: "arrow.right")
                                    .font(.system(size: 12, weight: .semibold))
                                    .foregroundStyle(.secondary)
                                    .accessibilityHidden(true)
                            }
                        }
                        .disabled(self.inventory.pendingID != nil || self.inventory.isLoading)
                    }
                    if self.inventory.canEdit, unavailableReason == nil {
                        self.enableButton(id: id, enabled: !skill.disabled)
                    }
                } header: {
                    self.detailHeader(name: skill.name, description: skill.description)
                } footer: {
                    if let unavailableReason {
                        Text(verbatim: unavailableReason).font(OpenClawType.footnote)
                    }
                }
            }
            NativeToolSettingsFeedback(inventory: self.inventory)
        }
        .listStyle(.insetGrouped)
        .navigationTitle(self.kind.detailTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func pluginDetail(id: String) -> some View {
        List {
            if let plugin = self.inventory.plugins.first(where: { $0.id == id }) {
                Section {
                    SettingsDetailRow("Status", value: .verbatim(plugin.status))
                    if self.inventory.canEdit {
                        self.enableButton(id: id, enabled: plugin.enabled)
                    }
                } header: {
                    self.detailHeader(name: plugin.name, description: plugin.description)
                } footer: {
                    if let problem = plugin.runtime?.error ?? plugin.error {
                        Text(verbatim: problem).font(OpenClawType.footnote)
                    }
                }
            }
            NativeToolSettingsFeedback(inventory: self.inventory)
        }
        .listStyle(.insetGrouped)
        .navigationTitle(self.kind.detailTitle)
        .navigationBarTitleDisplayMode(.inline)
    }

    private func enableButton(id: String, enabled: Bool) -> some View {
        Button {
            Task { await self.onSetEnabled(!enabled, id) }
        } label: {
            HStack {
                Text(enabled ? String(localized: "Disable") : String(localized: "Enable"))
                    .font(OpenClawType.body)
                Spacer()
                if self.inventory.pendingID == id {
                    ProgressView()
                }
            }
            .contentShape(Rectangle())
        }
        .disabled(!self.inventory.canEdit || self.inventory.pendingID != nil || self.inventory.isLoading)
    }
}

private struct NativeInstalledPluginsReport: Decodable {
    let plugins: [NativeInstalledPlugin]
    let mutationAllowed: Bool
}

private struct NativePluginUpdateResult: Decodable {
    let restartRequired: Bool
    let warnings: [String]?
}

private struct NativeInstalledPlugin: Decodable, Identifiable {
    struct Runtime: Decodable {
        let state: String
        let error: String?
    }

    let id: String
    let name: String
    let description: String?
    let installed: Bool
    let enabled: Bool
    let state: String
    let error: String?
    let runtime: Runtime?

    var status: String {
        self.attentionStatus ?? String(localized: "Enabled")
    }

    var attentionStatus: String? {
        if !self.enabled { return String(localized: "Disabled") }
        if self.state == "needs-setup" { return String(localized: "Setup required") }
        if self.state == "error" || self.runtime?.error != nil || self.error != nil {
            return String(localized: "Could not load plugin")
        }
        return self.runtime?.state == "active" ? nil : String(localized: "Enabled, not active")
    }
}
