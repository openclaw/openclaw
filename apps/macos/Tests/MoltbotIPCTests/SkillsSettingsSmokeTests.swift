import DNAProtocol
import Testing
@testable import DNA

@Suite(.serialized)
@MainActor
struct SkillsSettingsSmokeTests {
    @Test func skillsSettingsBuildsBodyWithSkillsRemote() {
        let model = SkillsSettingsModel()
        model.statusMessage = "Loaded"
        model.skills = [
            SkillStatus(
                name: "Needs Setup",
                description: "Missing bins and env",
                source: "dna-managed",
                filePath: "/tmp/skills/needs-setup",
                baseDir: "/tmp/skills",
                skillKey: "needs-setup",
                primaryEnv: "API_KEY",
                emoji: "🧰",
                homepage: "https://example.com/needs-setup",
                always: false,
                disabled: false,
                eligible: false,
                requirements: SkillRequirements(
                    bins: ["python3"],
                    env: ["API_KEY"],
                    config: ["skills.needs-setup"]),
                missing: SkillMissing(
                    bins: ["python3"],
                    env: ["API_KEY"],
                    config: ["skills.needs-setup"]),
                configChecks: [
                    SkillStatusConfigCheck(path: "skills.needs-setup", value: AnyCodable(false), satisfied: false),
                ],
                install: [
                    SkillInstallOption(id: "brew", kind: "brew", label: "brew install python", bins: ["python3"]),
                ]),
            SkillStatus(
                name: "Ready Skill",
                description: "All set",
                source: "dna-bundled",
                filePath: "/tmp/skills/ready",
                baseDir: "/tmp/skills",
                skillKey: "ready",
                primaryEnv: nil,
                emoji: "✅",
                homepage: "https://example.com/ready",
                always: false,
                disabled: false,
                eligible: true,
                requirements: SkillRequirements(bins: [], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: []),
                configChecks: [
                    SkillStatusConfigCheck(path: "skills.ready", value: AnyCodable(true), satisfied: true),
                    SkillStatusConfigCheck(path: "skills.limit", value: AnyCodable(5), satisfied: true),
                ],
                install: []),
            SkillStatus(
                name: "Disabled Skill",
                description: "Disabled in config",
                source: "dna-extra",
                filePath: "/tmp/skills/disabled",
                baseDir: "/tmp/skills",
                skillKey: "disabled",
                primaryEnv: nil,
                emoji: "🚫",
                homepage: nil,
                always: false,
                disabled: true,
                eligible: false,
                requirements: SkillRequirements(bins: [], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: []),
                configChecks: [],
                install: []),
        ]

        let state = AppState(preview: true)
        state.connectionMode = .remote
        var view = SkillsSettings(state: state, model: model)
        view.setFilterForTesting("all")
        _ = view.body
        view.setFilterForTesting("needsSetup")
        _ = view.body
    }

    @Test func skillsSettingsBuildsBodyWithLocalMode() {
        let model = SkillsSettingsModel()
        model.skills = [
            SkillStatus(
                name: "Local Skill",
                description: "Local ready",
                source: "dna-workspace",
                filePath: "/tmp/skills/local",
                baseDir: "/tmp/skills",
                skillKey: "local",
                primaryEnv: nil,
                emoji: "🏠",
                homepage: nil,
                always: false,
                disabled: false,
                eligible: true,
                requirements: SkillRequirements(bins: [], env: [], config: []),
                missing: SkillMissing(bins: [], env: [], config: []),
                configChecks: [],
                install: []),
        ]

        let state = AppState(preview: true)
        state.connectionMode = .local
        var view = SkillsSettings(state: state, model: model)
        view.setFilterForTesting("ready")
        _ = view.body
    }

    @Test func skillsSettingsExercisesPrivateViews() {
        SkillsSettings.exerciseForTesting()
    }
}
