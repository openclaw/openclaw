import Foundation
import Observation
import SwiftUI

struct SystemRunSettingsView: View {
    @State private var model = SystemRunSettingsModel()
    @State private var tab: SystemRunSettingsTab = .policy
    @State private var newPattern: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .center, spacing: 12) {
                Text("Node Run Commands")
                    .font(.body)
                Spacer(minLength: 0)
                if self.model.agentIds.count > 1 {
                    Picker("Agent", selection: Binding(
                        get: { self.model.selectedAgentId },
                        set: { self.model.selectAgent($0) }))
                    {
                        ForEach(self.model.agentIds, id: \.self) { id in
                            Text(id).tag(id)
                        }
                    }
                    .pickerStyle(.menu)
                    .frame(width: 160, alignment: .trailing)
                }
            }

            Picker("", selection: self.$tab) {
                ForEach(SystemRunSettingsTab.allCases) { tab in
                    Text(tab.title).tag(tab)
                }
            }
            .pickerStyle(.segmented)
            .frame(width: 280)

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
        VStack(alignment: .leading, spacing: 6) {
            Picker("", selection: Binding(
                get: { self.model.policy },
                set: { self.model.setPolicy($0) }))
            {
                ForEach(SystemRunPolicy.allCases) { policy in
                    Text(policy.title).tag(policy)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)

            Text("Controls remote command execution on this Mac when it is paired as a node. \"Always Ask\" prompts on each command; \"Always Allow\" runs without prompts; \"Never\" disables system.run.")
                .font(.footnote)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var allowlistView: some View {
        VStack(alignment: .leading, spacing: 10) {
            Toggle("Auto-allow skill CLIs", isOn: Binding(
                get: { self.model.autoAllowSkills },
                set: { self.model.setAutoAllowSkills($0) }))

            if self.model.autoAllowSkills, !self.model.skillBins.isEmpty {
                Text("Skill CLIs: \(self.model.skillBins.joined(separator: ", "))")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }

            HStack(spacing: 8) {
                TextField("Add allowlist pattern (supports globs)", text: self.$newPattern)
                    .textFieldStyle(.roundedBorder)
                Button("Add") {
                    let pattern = self.newPattern.trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !pattern.isEmpty else { return }
                    self.model.addEntry(pattern)
                    self.newPattern = ""
                }
                .buttonStyle(.bordered)
                .disabled(self.newPattern.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }

            if self.model.entries.isEmpty {
                Text("No allowlisted commands yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(Array(self.model.entries.enumerated()), id: \.element.id) { index, _ in
                        SystemRunAllowlistRow(
                            entry: Binding(
                                get: { self.model.entries[index] },
                                set: { self.model.updateEntry($0) }),
                            onRemove: { self.model.removeEntry($0.id) })
                    }
                }
            }
        }
    }
}

private enum SystemRunSettingsTab: String, CaseIterable, Identifiable {
    case policy
    case allowlist

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .policy: "Policy"
        case .allowlist: "Allowlist"
        }
    }
}

struct SystemRunAllowlistRow: View {
    @Binding var entry: SystemRunAllowlistEntry
    let onRemove: (SystemRunAllowlistEntry) -> Void
    @State private var draftPattern: String = ""

    private static let relativeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .short
        return formatter
    }()

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 8) {
                Toggle("", isOn: self.$entry.enabled)
                    .labelsHidden()

                TextField("Pattern", text: self.patternBinding)
                    .textFieldStyle(.roundedBorder)

                if self.entry.matchKind == .argv {
                    Text("Legacy")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }

                Button(role: .destructive) {
                    self.onRemove(self.entry)
                } label: {
                    Image(systemName: "trash")
                }
                .buttonStyle(.borderless)
            }

            if let lastUsedAt = self.entry.lastUsedAt {
                Text("Last used \(Self.relativeFormatter.localizedString(for: lastUsedAt, relativeTo: Date()))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if let lastUsedCommand = self.entry.lastUsedCommand, !lastUsedCommand.isEmpty {
                Text("Last used: \(lastUsedCommand)")
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
                if self.entry.matchKind == .argv {
                    self.entry.matchKind = .glob
                }
            })
    }
}

@MainActor
@Observable
final class SystemRunSettingsModel {
    var agentIds: [String] = []
    var selectedAgentId: String = "main"
    var defaultAgentId: String = "main"
    var policy: SystemRunPolicy = .ask
    var autoAllowSkills = false
    var entries: [SystemRunAllowlistEntry] = []
    var skillBins: [String] = []

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
        if !self.agentIds.contains(self.selectedAgentId) {
            self.selectedAgentId = self.defaultAgentId
        }
    }

    func selectAgent(_ id: String) {
        self.selectedAgentId = id
        self.loadSettings(for: id)
        Task { await self.refreshSkillBins() }
    }

    func loadSettings(for agentId: String) {
        self.policy = SystemRunPolicy.load(agentId: agentId)
        self.autoAllowSkills = MacNodeConfigFile.systemRunAutoAllowSkills(agentId: agentId) ?? false
        self.entries = SystemRunAllowlistStore.load(agentId: agentId)
            .sorted { $0.pattern.localizedCaseInsensitiveCompare($1.pattern) == .orderedAscending }
    }

    func setPolicy(_ policy: SystemRunPolicy) {
        self.policy = policy
        MacNodeConfigFile.setSystemRunPolicy(policy, agentId: self.selectedAgentId)
        if self.selectedAgentId == self.defaultAgentId || self.agentIds.count <= 1 {
            AppStateStore.shared.systemRunPolicy = policy
        }
    }

    func setAutoAllowSkills(_ enabled: Bool) {
        self.autoAllowSkills = enabled
        MacNodeConfigFile.setSystemRunAutoAllowSkills(enabled, agentId: self.selectedAgentId)
        Task { await self.refreshSkillBins(force: enabled) }
    }

    func addEntry(_ pattern: String) {
        let trimmed = pattern.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        let entry = SystemRunAllowlistEntry(pattern: trimmed, enabled: true, matchKind: .glob, source: .manual)
        self.entries.append(entry)
        SystemRunAllowlistStore.save(self.entries, agentId: self.selectedAgentId)
    }

    func updateEntry(_ entry: SystemRunAllowlistEntry) {
        guard let index = self.entries.firstIndex(where: { $0.id == entry.id }) else { return }
        self.entries[index] = entry
        SystemRunAllowlistStore.save(self.entries, agentId: self.selectedAgentId)
    }

    func removeEntry(_ id: String) {
        self.entries.removeAll { $0.id == id }
        SystemRunAllowlistStore.save(self.entries, agentId: self.selectedAgentId)
    }

    func refreshSkillBins(force: Bool = false) async {
        guard self.autoAllowSkills else {
            self.skillBins = []
            return
        }
        let bins = await SkillBinsCache.shared.currentBins(force: force)
        self.skillBins = bins.sorted()
    }
}
