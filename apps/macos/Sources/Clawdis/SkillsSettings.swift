import ClawdisProtocol
import Observation
import SwiftUI

struct SkillsSettings: View {
    @State private var model = SkillsSettingsModel()
    @State private var envEditor: EnvEditorState?
    @State private var searchQuery = ""
    @State private var filter: SkillsFilter = .all

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            self.header
            self.filterBar
            self.statusBanner
            self.skillsList
            Spacer(minLength: 0)
        }
        .task { await self.model.refresh() }
        .sheet(item: self.$envEditor) { editor in
            EnvEditorView(editor: editor) { value in
                Task {
                    await self.model.updateEnv(
                        skillKey: editor.skillKey,
                        envKey: editor.envKey,
                        value: value,
                        isPrimary: editor.isPrimary)
                }
            }
        }
    }

    private var header: some View {
        HStack {
            VStack(alignment: .leading, spacing: 4) {
                Text("Skills")
                    .font(.headline)
                Text("Skills are enabled when requirements are met (binaries, env, config).")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            if self.model.isLoading {
                ProgressView()
            } else {
                Button {
                    Task { await self.model.refresh() }
                } label: {
                    Label("Refresh", systemImage: "arrow.clockwise")
                }
                .buttonStyle(.bordered)
                .help("Refresh")
            }
        }
    }

    @ViewBuilder
    private var statusBanner: some View {
        if let error = self.model.error {
            Text(error)
                .font(.footnote)
                .foregroundStyle(.orange)
        } else if let message = self.model.statusMessage {
            Text(message)
                .font(.footnote)
                .foregroundStyle(.secondary)
        }
    }

    @ViewBuilder
    private var skillsList: some View {
        if self.model.skills.isEmpty {
            Text("No skills reported yet.")
                .foregroundStyle(.secondary)
        } else {
            List {
                ForEach(self.filteredSkills) { skill in
                    SkillRow(
                        skill: skill,
                        isBusy: self.model.isBusy(skill: skill),
                        onToggleEnabled: { enabled in
                            Task { await self.model.setEnabled(skillKey: skill.skillKey, enabled: enabled) }
                        },
                        onInstall: { option in
                            Task { await self.model.install(skill: skill, option: option) }
                        },
                        onSetEnv: { envKey, isPrimary in
                            self.envEditor = EnvEditorState(
                                skillKey: skill.skillKey,
                                skillName: skill.name,
                                envKey: envKey,
                                isPrimary: isPrimary)
                        })
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
                if !self.model.skills.isEmpty, self.filteredSkills.isEmpty {
                    Text("No skills match this filter.")
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .listRowInsets(EdgeInsets(top: 8, leading: 16, bottom: 8, trailing: 16))
                }
            }
            .listStyle(.inset)
            .searchable(text: self.$searchQuery, placement: .automatic, prompt: "Search skills")
        }
    }

    private var filterBar: some View {
        HStack(spacing: 10) {
            Text("Filter")
                .font(.caption)
                .foregroundStyle(.secondary)
            Picker("", selection: self.$filter) {
                ForEach(SkillsFilter.allCases) { filter in
                    Text(filter.title)
                        .tag(filter)
                }
            }
            .labelsHidden()
            .pickerStyle(.menu)
            .frame(width: 160, alignment: .leading)
            Spacer(minLength: 0)
        }
    }

    private var filteredSkills: [SkillStatus] {
        let trimmed = self.searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let query = trimmed.lowercased()
        return self.model.skills.filter { skill in
            if !query.isEmpty {
                let matchesName = skill.name.lowercased().contains(query)
                let matchesDescription = skill.description.lowercased().contains(query)
                if !(matchesName || matchesDescription) { return false }
            }
            switch self.filter {
            case .all:
                return true
            case .ready:
                return !skill.disabled && skill.eligible
            case .needsSetup:
                return !skill.disabled && !skill.eligible
            case .disabled:
                return skill.disabled
            }
        }
    }
}

private enum SkillsFilter: String, CaseIterable, Identifiable {
    case all
    case ready
    case needsSetup
    case disabled

    var id: String { self.rawValue }

    var title: String {
        switch self {
        case .all:
            "All"
        case .ready:
            "Ready"
        case .needsSetup:
            "Needs Setup"
        case .disabled:
            "Disabled"
        }
    }
}

private struct SkillRow: View {
    let skill: SkillStatus
    let isBusy: Bool
    let onToggleEnabled: (Bool) -> Void
    let onInstall: (SkillInstallOption) -> Void
    let onSetEnv: (String, Bool) -> Void

    private var missingBins: [String] { self.skill.missing.bins }
    private var missingEnv: [String] { self.skill.missing.env }
    private var missingConfig: [String] { self.skill.missing.config }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Text(self.skill.emoji ?? "✨")
                .font(.title2)

            VStack(alignment: .leading, spacing: 6) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(self.skill.name)
                        .font(.headline)
                    self.statusBadge
                }
                Text(self.skill.description)
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                self.metaRow

                if self.skill.disabled {
                    Text("Disabled in config")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                } else if !self.skill.eligible {
                    self.missingSummary
                }

                if !self.skill.configChecks.isEmpty {
                    self.configChecksView
                }

                if !self.missingEnv.isEmpty {
                    self.envActionRow
                }
            }

            Spacer(minLength: 0)

            self.trailingActions
        }
        .padding(.vertical, 6)
    }

    private var sourceLabel: String {
        switch self.skill.source {
        case "clawdis-bundled":
            "Bundled"
        case "clawdis-managed":
            "Managed"
        case "clawdis-workspace":
            "Workspace"
        case "clawdis-extra":
            "Extra"
        default:
            self.skill.source
        }
    }

    private var statusBadge: some View {
        Group {
            if self.skill.disabled {
                Label("Disabled", systemImage: "slash.circle")
                    .foregroundStyle(.secondary)
            } else if self.skill.eligible {
                Label("Ready", systemImage: "checkmark.circle.fill")
                    .foregroundStyle(.green)
            } else {
                Label("Needs setup", systemImage: "exclamationmark.triangle")
                    .foregroundStyle(.orange)
            }
        }
        .font(.caption)
    }

    private var metaRow: some View {
        HStack(spacing: 10) {
            SkillTag(text: self.sourceLabel)
            if let url = self.homepageUrl {
                Link(destination: url) {
                    Label("Website", systemImage: "link")
                        .font(.caption2.weight(.semibold))
                }
                .buttonStyle(.link)
            }
            Spacer(minLength: 0)
        }
    }

    private var homepageUrl: URL? {
        guard let raw = self.skill.homepage?.trimmingCharacters(in: .whitespacesAndNewlines) else {
            return nil
        }
        guard !raw.isEmpty else { return nil }
        return URL(string: raw)
    }

    private var enabledBinding: Binding<Bool> {
        Binding(
            get: { !self.skill.disabled },
            set: { self.onToggleEnabled($0) })
    }

    @ViewBuilder
    private var missingSummary: some View {
        VStack(alignment: .leading, spacing: 4) {
            if !self.missingBins.isEmpty {
                Text("Missing binaries: \(self.missingBins.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !self.missingEnv.isEmpty {
                Text("Missing env: \(self.missingEnv.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            if !self.missingConfig.isEmpty {
                Text("Requires config: \(self.missingConfig.joined(separator: ", "))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    @ViewBuilder
    private var configChecksView: some View {
        VStack(alignment: .leading, spacing: 4) {
            ForEach(self.skill.configChecks) { check in
                HStack(spacing: 6) {
                    Image(systemName: check.satisfied ? "checkmark.circle" : "xmark.circle")
                        .foregroundStyle(check.satisfied ? .green : .secondary)
                    Text(check.path)
                        .font(.caption)
                    Text(self.formatConfigValue(check.value))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    private var envActionRow: some View {
        HStack(spacing: 8) {
            ForEach(self.missingEnv, id: \.self) { envKey in
                let isPrimary = envKey == self.skill.primaryEnv
                Button(isPrimary ? "Set API Key" : "Set \(envKey)") {
                    self.onSetEnv(envKey, isPrimary)
                }
                .buttonStyle(.bordered)
                .disabled(self.isBusy)
            }
            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private var trailingActions: some View {
        VStack(alignment: .trailing, spacing: 8) {
            if !self.installOptions.isEmpty {
                ForEach(self.installOptions) { option in
                    Button(option.label) { self.onInstall(option) }
                        .buttonStyle(.borderedProminent)
                        .disabled(self.isBusy)
                }
            } else {
                Toggle("", isOn: self.enabledBinding)
                    .toggleStyle(.switch)
                    .labelsHidden()
                    .disabled(self.isBusy)
            }

            if self.isBusy {
                ProgressView()
                    .controlSize(.small)
            }
        }
    }

    private var installOptions: [SkillInstallOption] {
        guard !self.missingBins.isEmpty else { return [] }
        let missing = Set(self.missingBins)
        return self.skill.install.filter { option in
            if option.bins.isEmpty { return true }
            return !missing.isDisjoint(with: option.bins)
        }
    }

    private func formatConfigValue(_ value: AnyCodable?) -> String {
        guard let value else { return "" }
        switch value.value {
        case let bool as Bool:
            return bool ? "true" : "false"
        case let int as Int:
            return String(int)
        case let double as Double:
            return String(double)
        case let string as String:
            return string
        default:
            return ""
        }
    }
}

private struct SkillTag: View {
    let text: String

    var body: some View {
        Text(self.text)
            .font(.caption2.weight(.semibold))
            .foregroundStyle(.secondary)
            .padding(.horizontal, 8)
            .padding(.vertical, 2)
            .background(Color.secondary.opacity(0.12))
            .clipShape(Capsule())
    }
}

private struct EnvEditorState: Identifiable {
    let skillKey: String
    let skillName: String
    let envKey: String
    let isPrimary: Bool

    var id: String { "\(self.skillKey)::\(self.envKey)" }
}

private struct EnvEditorView: View {
    let editor: EnvEditorState
    let onSave: (String) -> Void
    @Environment(\.dismiss) private var dismiss
    @State private var value: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            Text(self.title)
                .font(.headline)
            Text(self.subtitle)
                .font(.subheadline)
                .foregroundStyle(.secondary)
            SecureField(self.editor.envKey, text: self.$value)
                .textFieldStyle(.roundedBorder)
            HStack {
                Button("Cancel") { self.dismiss() }
                Spacer()
                Button("Save") {
                    self.onSave(self.value)
                    self.dismiss()
                }
                .buttonStyle(.borderedProminent)
                .disabled(self.value.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
        }
        .padding(20)
        .frame(width: 420)
    }

    private var title: String {
        self.editor.isPrimary ? "Set API Key" : "Set Environment Variable"
    }

    private var subtitle: String {
        "Skill: \(self.editor.skillName)"
    }
}

@MainActor
@Observable
final class SkillsSettingsModel {
    var skills: [SkillStatus] = []
    var isLoading = false
    var error: String?
    var statusMessage: String?
    private var busySkills: Set<String> = []

    func isBusy(skill: SkillStatus) -> Bool {
        self.busySkills.contains(skill.skillKey)
    }

    func refresh() async {
        guard !self.isLoading else { return }
        self.isLoading = true
        self.error = nil
        do {
            let report = try await GatewayConnection.shared.skillsStatus()
            self.skills = report.skills.sorted { $0.name < $1.name }
        } catch {
            self.error = error.localizedDescription
        }
        self.isLoading = false
    }

    func install(skill: SkillStatus, option: SkillInstallOption) async {
        await self.withBusy(skill.skillKey) {
            do {
                let result = try await GatewayConnection.shared.skillsInstall(
                    name: skill.name,
                    installId: option.id,
                    timeoutMs: 300_000)
                self.statusMessage = result.message
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh()
        }
    }

    func setEnabled(skillKey: String, enabled: Bool) async {
        await self.withBusy(skillKey) {
            do {
                _ = try await GatewayConnection.shared.skillsUpdate(
                    skillKey: skillKey,
                    enabled: enabled)
                self.statusMessage = enabled ? "Skill enabled" : "Skill disabled"
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh()
        }
    }

    func updateEnv(skillKey: String, envKey: String, value: String, isPrimary: Bool) async {
        await self.withBusy(skillKey) {
            do {
                if isPrimary {
                    _ = try await GatewayConnection.shared.skillsUpdate(
                        skillKey: skillKey,
                        apiKey: value)
                    self.statusMessage = "Saved API key"
                } else {
                    _ = try await GatewayConnection.shared.skillsUpdate(
                        skillKey: skillKey,
                        env: [envKey: value])
                    self.statusMessage = "Saved \(envKey)"
                }
            } catch {
                self.statusMessage = error.localizedDescription
            }
            await self.refresh()
        }
    }

    private func withBusy(_ id: String, _ work: @escaping () async -> Void) async {
        self.busySkills.insert(id)
        defer { self.busySkills.remove(id) }
        await work()
    }
}

#if DEBUG
struct SkillsSettings_Previews: PreviewProvider {
    static var previews: some View {
        SkillsSettings()
            .frame(width: SettingsTab.windowWidth, height: SettingsTab.windowHeight)
    }
}
#endif
