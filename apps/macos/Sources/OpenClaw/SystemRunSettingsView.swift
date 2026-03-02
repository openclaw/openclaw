import Foundation
import Observation
import SwiftUI

struct SystemRunSettingsView: View {
    @State private var model = ExecApprovalsSettingsModel()
    @State private var tab: ExecApprovalsSettingsTab = .policy
    @State private var newPattern: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                Text("代码审批")
                    .font(.body)
                Spacer(minLength: 0)
                Picker("智能体(Agent)", selection: Binding(
                    get: { self.model.selectedAgentId },
                    set: { self.model.selectAgent($0) }))
                {
                    ForEach(self.model.agentPickerIds, id: \.self) { id in
                        Text(self.model.label(for: id)).tag(id)
                    }
                }
                .pickerStyle(.menu)
                .frame(width: 180, alignment: .trailing)
            }

            Picker("", selection: self.$tab) {
                ForEach(ExecApprovalsSettingsTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 320)

            if self.tab == .policy {
                self.policyView
            } else {
                self.allowlistView
            }
        }
        .task { await self.model.refresh() }
        .onChange(of: self.tab) { _, _ in
            Task { await self.model.refreshSkillBins() }
        }
    }

    private var policyView: some View {
        VStack(alignment: .leading, spacing: 8) {
            Picker("", selection: Binding(
                get: { self.model.security },
                set: { self.model.setSecurity($0) }))
            {
                ForEach(ExecSecurity.allCases) { security in
                    Text(security.title).tag(security)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Picker("", selection: Binding(
                get: { self.model.ask },
                set: { self.model.setAsk($0) }))
            {
                ForEach(ExecAsk.allCases) { ask in
                    Text(ask.title).tag(ask)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Picker("", selection: Binding(
                get: { self.model.askFallback },
                set: { self.model.setAskFallback($0) }))
            {
                ForEach(ExecSecurity.allCases) { mode in
                    Text("降级至: \(mode.title)").tag(mode)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Text(self.scopeMessage)
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var allowlistView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("自动允许技能 CLI 工具", isOn: Binding(
                get: { self.model.autoAllowSkills },
                set: { self.model.setAutoAllowSkills($0) }))

            if self.model.autoAllowSkills, !self.model.skillBins.isEmpty {
                Text("Skill CLIs: \(self.model.skillBins.joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            if self.model.isDefaultsScope {
                Text("白名单是按智能体设置的。请选择智能体编辑。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                HStack(spacing: 8) {
                    TextField("添加白名单路径模式（不区分大小写的 glob 通配符）", text: self.$newPattern)
                        .textFieldStyle(.roundedBorder)
                    Button("添加") {
                        if self.model.addEntry(self.newPattern) == nil {
                            self.newPattern = ""
                        }
                    }
                    .buttonStyle(.bordered)
                    .disabled(!self.model.isPathPattern(self.newPattern))
                }

                Text("仅支持路径模式。像 \"echo\" 这样的基本名称条目将被忽略。")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                if let validationMessage = self.model.allowlistValidationMessage {
                    Text(validationMessage)
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }

                if self.model.entries.isEmpty {
                    Text("暂无白名单命令。")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                } else {
                    VStack(alignment: .leading, spacing: 8) {
                        ForEach(self.model.entries, id: \.id) { entry in
                            ExecAllowlistRow(
                                entry: Binding(
                                    get: { self.model.entry(for: entry.id) ?? entry },
                                    set: { self.model.updateEntry($0, id: entry.id) }),
                                onRemove: { self.model.removeEntry(id: entry.id) })
                        }
                    }
                }
            }
        }
    }

    private var scopeMessage: String {
        if self.model.isDefaultsScope {
            return "当智能体没有覆盖设置时应用默认值。「询问」控制提示行为；当无法连接到配套 UI 时将使用「降级」设置。"
        }
        return "「安全性」控制当此 Mac 作为节点配对时，是否允许执行 system.run。「询问」控制提示行为；当无法连接到配套 UI 时将使用「降级」设置。"
    }
}

private enum ExecApprovalsSettingsTab: String, CaseIterable, Identifiable {
    case policy
    case allowlist

    var id: String {
        self.rawValue
    }

    var title: String {
        switch self {
        case .policy: "访问策略"
        case .allowlist: "白名单"
        }
    }
}

struct ExecAllowlistRow: View {
    @Binding var entry: ExecAllowlistEntry
    let onRemove: () -> Void
    @State private var draftPattern: String = ""

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                TextField("模式", text: self.patternBinding)
                    .textFieldStyle(.roundedBorder)

                Button(role: .destructive) {
                    self.onRemove()
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }

            if let lastUsedAt = self.entry.lastUsedAt {
                let date = Date(timeIntervalSince1970: lastUsedAt / 1000.0)
                Text("最后使用时间: \(Self.relativeFormatter.localizedString(for: date, relativeTo: Date()))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let lastUsedCommand = self.entry.lastUsedCommand, !lastUsedCommand.isEmpty {
                Text("最近命令: \(lastUsedCommand)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let lastResolvedPath = self.entry.lastResolvedPath, !lastResolvedPath.isEmpty {
                Text("解析最终读取系统绝对寻址目标路径: \(lastResolvedPath)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .onAppear {
            self.draftPattern = self.entry.pattern
        }
    }

    private var patternBinding: Binding<String> {
        Binding(
            get: { self.draftPattern.isEmpty ? self.entry.pattern : self.draftPattern },
            set: { newValue in
                self.draftPattern = newValue
                self.entry.pattern = newValue
            })
    }
}

@MainActor
@Observable
final class ExecApprovalsSettingsModel {
    private static let defaultsScopeId = "__defaults__"
    var agentIds: [String] = []
    var selectedAgentId: String = "main"
    var defaultAgentId: String = "main"
    var security: ExecSecurity = .deny
    var ask: ExecAsk = .onMiss
    var askFallback: ExecSecurity = .deny
    var autoAllowSkills = false
    var entries: [ExecAllowlistEntry] = []
    var skillBins: [String] = []
    var allowlistValidationMessage: String?

    var agentPickerIds: [String] {
        [Self.defaultsScopeId] + self.agentIds
    }

    var isDefaultsScope: Bool {
        self.selectedAgentId == Self.defaultsScopeId
    }

    func label(for id: String) -> String {
        if id == Self.defaultsScopeId { return "Defaults" }
        return id
    }

    func refresh() async {
        await self.refreshAgents()
        self.loadSettings(for: self.selectedAgentId)
        await self.refreshSkillBins()
    }

    func refreshAgents() async {
        let root = await ConfigStore.load()
        let agents = root["agents"] as? [String: Any]
        let list = agents?["list"] as? [[String: Any]] ?? []
        var ids: [String] = []
        var seen = Set<String>()
        var defaultId: String?
        for entry in list {
            guard let raw = entry["id"] as? String else { continue }
            let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
            guard !trimmed.isEmpty else { continue }
            if !seen.insert(trimmed).inserted { continue }
            ids.append(trimmed)
            if (entry["default"] as? Bool) == true, defaultId == nil {
                defaultId = trimmed
            }
        }
        if ids.isEmpty {
            ids = ["main"]
            defaultId = "main"
        } else if defaultId == nil {
            defaultId = ids.first
        }
        self.agentIds = ids
        self.defaultAgentId = defaultId ?? "main"
        if self.selectedAgentId == Self.defaultsScopeId {
            return
        }
        if !self.agentIds.contains(self.selectedAgentId) {
            self.selectedAgentId = self.defaultAgentId
        }
    }

    func selectAgent(_ id: String) {
        self.selectedAgentId = id
        self.allowlistValidationMessage = nil
        self.loadSettings(for: id)
        Task { await self.refreshSkillBins() }
    }

    func loadSettings(for agentId: String) {
        if agentId == Self.defaultsScopeId {
            let defaults = ExecApprovalsStore.resolveDefaults()
            self.security = defaults.security
            self.ask = defaults.ask
            self.askFallback = defaults.askFallback
            self.autoAllowSkills = defaults.autoAllowSkills
            self.entries = []
            self.allowlistValidationMessage = nil
            return
        }
        let resolved = ExecApprovalsStore.resolve(agentId: agentId)
        self.security = resolved.agent.security
        self.ask = resolved.agent.ask
        self.askFallback = resolved.agent.askFallback
        self.autoAllowSkills = resolved.agent.autoAllowSkills
        self.entries = resolved.allowlist
            .sorted { $0.pattern.localizedCaseInsensitiveCompare($1.pattern) == .orderedAscending }
        self.allowlistValidationMessage = nil
    }

    func setSecurity(_ security: ExecSecurity) {
        self.security = security
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.security = security
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.security = security
            }
        }
        self.syncQuickMode()
    }

    func setAsk(_ ask: ExecAsk) {
        self.ask = ask
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.ask = ask
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.ask = ask
            }
        }
        self.syncQuickMode()
    }

    func setAskFallback(_ mode: ExecSecurity) {
        self.askFallback = mode
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.askFallback = mode
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.askFallback = mode
            }
        }
    }

    func setAutoAllowSkills(_ enabled: Bool) {
        self.autoAllowSkills = enabled
        if self.isDefaultsScope {
            ExecApprovalsStore.updateDefaults { defaults in
                defaults.autoAllowSkills = enabled
            }
        } else {
            ExecApprovalsStore.updateAgentSettings(agentId: self.selectedAgentId) { entry in
                entry.autoAllowSkills = enabled
            }
        }
        Task { await self.refreshSkillBins(force: enabled) }
    }

    @discardableResult
    func addEntry(_ pattern: String) -> ExecAllowlistPatternValidationReason? {
        guard !self.isDefaultsScope else { return nil }
        switch ExecApprovalHelpers.validateAllowlistPattern(pattern) {
        case let .valid(normalizedPattern):
            self.entries.append(ExecAllowlistEntry(pattern: normalizedPattern, lastUsedAt: nil))
            let rejected = ExecApprovalsStore.updateAllowlist(agentId: self.selectedAgentId, allowlist: self.entries)
            self.allowlistValidationMessage = rejected.first?.reason.message
            return rejected.first?.reason
        case let .invalid(reason):
            self.allowlistValidationMessage = reason.message
            return reason
        }
    }

    @discardableResult
    func updateEntry(_ entry: ExecAllowlistEntry, id: UUID) -> ExecAllowlistPatternValidationReason? {
        guard !self.isDefaultsScope else { return nil }
        guard let index = self.entries.firstIndex(where: { $0.id == id }) else { return nil }
        var next = entry
        switch ExecApprovalHelpers.validateAllowlistPattern(next.pattern) {
        case let .valid(normalizedPattern):
            next.pattern = normalizedPattern
        case let .invalid(reason):
            self.allowlistValidationMessage = reason.message
            return reason
        }
        self.entries[index] = next
        let rejected = ExecApprovalsStore.updateAllowlist(agentId: self.selectedAgentId, allowlist: self.entries)
        self.allowlistValidationMessage = rejected.first?.reason.message
        return rejected.first?.reason
    }

    func removeEntry(id: UUID) {
        guard !self.isDefaultsScope else { return }
        guard let index = self.entries.firstIndex(where: { $0.id == id }) else { return }
        self.entries.remove(at: index)
        let rejected = ExecApprovalsStore.updateAllowlist(agentId: self.selectedAgentId, allowlist: self.entries)
        self.allowlistValidationMessage = rejected.first?.reason.message
    }

    func entry(for id: UUID) -> ExecAllowlistEntry? {
        self.entries.first(where: { $0.id == id })
    }

    func isPathPattern(_ pattern: String) -> Bool {
        ExecApprovalHelpers.isPathPattern(pattern)
    }

    func refreshSkillBins(force: Bool = false) async {
        guard self.autoAllowSkills else {
            self.skillBins = []
            return
        }
        let bins = await SkillBinsCache.shared.currentBins(force: force)
        self.skillBins = bins.sorted()
    }

    private func syncQuickMode() {
        if self.isDefaultsScope {
            AppStateStore.shared.execApprovalMode = ExecApprovalQuickMode.from(security: self.security, ask: self.ask)
            return
        }
        if self.selectedAgentId == self.defaultAgentId || self.agentIds.count <= 1 {
            AppStateStore.shared.execApprovalMode = ExecApprovalQuickMode.from(security: self.security, ask: self.ask)
        }
    }
}
