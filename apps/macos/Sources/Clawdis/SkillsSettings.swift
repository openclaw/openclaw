import ClawdisProtocol
import Observation
import SwiftUI

struct SkillsSettings: View {
    @State private var model = SkillsSettingsModel()
    @State private var envEditor: EnvEditorState?

    var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                self.header
                self.statusBanner
                self.skillsList
                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(.horizontal, 24)
            .padding(.vertical, 18)
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
        HStack(alignment: .top, spacing: 12) {
            VStack(alignment: .leading, spacing: 6) {
                Text("Skills")
                    .font(.title3.weight(.semibold))
                Text("Skills are enabled when requirements are met (binaries, env, config).")
                    .font(.callout)
                    .foregroundStyle(.secondary)
            }
            Spacer()
            Button("Refresh") { Task { await self.model.refresh() } }
                .disabled(self.model.isLoading)
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

    private var skillsList: some View {
        VStack(spacing: 10) {
            ForEach(self.model.skills) { skill in
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
            }
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
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .top, spacing: 12) {
                VStack(alignment: .leading, spacing: 4) {
                    Text(self.skill.name)
                        .font(.headline)
                    Text(self.skill.description)
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(self.sourceLabel)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                self.statusBadge
            }

            if self.skill.disabled {
                Text("Disabled in config")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if self.skill.eligible {
                Text("Enabled")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                self.missingSummary
            }

            if !self.skill.configChecks.isEmpty {
                self.configChecksView
            }

            self.actionRow
        }
        .padding(12)
        .background(Color(nsColor: .controlBackgroundColor))
        .clipShape(RoundedRectangle(cornerRadius: 10))
        .overlay(
            RoundedRectangle(cornerRadius: 10)
                .stroke(Color.secondary.opacity(0.15), lineWidth: 1))
    }

    private var sourceLabel: String {
        self.skill.source.replacingOccurrences(of: "clawdis-", with: "")
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
        .font(.subheadline)
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

    private var actionRow: some View {
        HStack(spacing: 8) {
            if self.skill.disabled {
                Button("Enable") { self.onToggleEnabled(true) }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isBusy)
            } else {
                Button("Disable") { self.onToggleEnabled(false) }
                    .buttonStyle(.bordered)
                    .disabled(self.isBusy)
            }

            ForEach(self.installOptions) { option in
                Button(option.label) { self.onInstall(option) }
                    .buttonStyle(.borderedProminent)
                    .disabled(self.isBusy)
            }

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
