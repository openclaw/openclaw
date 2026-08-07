import Observation
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct RealtimeTalkSettingsDraft: Equatable {
    var enabled: Bool
    var model: String
    var voice: String
    var explicitlyUsesOpenAI: Bool

    static let defaults = RealtimeTalkSettingsDraft(
        enabled: false,
        model: "gpt-realtime-2.1",
        voice: "marin",
        explicitlyUsesOpenAI: false)
}

struct RealtimeTalkProviderDescriptor: Equatable {
    let configured: Bool
    let models: [String]
    let voices: [String]
}

enum RealtimeTalkSettingsConfig {
    static func parse(_ root: [String: Any]) -> RealtimeTalkSettingsDraft {
        let talk = root["talk"] as? [String: Any]
        let realtime = talk?["realtime"] as? [String: Any]
        let providers = realtime?["providers"] as? [String: Any]
        let openAI = Self.dictionary(in: providers, matching: "openai")
        let provider = Self.string(realtime?["provider"])
        let model = Self.string(realtime?["model"])
            ?? Self.string(openAI?["model"])
            ?? RealtimeTalkSettingsDraft.defaults.model
        let voice = Self.string(realtime?["speakerVoice"])
            ?? Self.string(realtime?["voice"])
            ?? Self.string(openAI?["speakerVoice"])
            ?? Self.string(openAI?["voice"])
            ?? RealtimeTalkSettingsDraft.defaults.voice
        let explicitlyUsesOpenAI = provider?.caseInsensitiveCompare("openai") == .orderedSame || openAI != nil
        let enabled = explicitlyUsesOpenAI &&
            Self.string(realtime?["mode"])?.caseInsensitiveCompare("realtime") == .orderedSame &&
            Self.string(realtime?["transport"])?.caseInsensitiveCompare("gateway-relay") == .orderedSame

        return RealtimeTalkSettingsDraft(
            enabled: enabled,
            model: model,
            voice: voice,
            explicitlyUsesOpenAI: explicitlyUsesOpenAI)
    }

    static func applying(_ draft: RealtimeTalkSettingsDraft, to root: [String: Any]) -> [String: Any] {
        var result = root
        var talk = result["talk"] as? [String: Any] ?? [:]
        var realtime = talk["realtime"] as? [String: Any] ?? [:]

        if draft.enabled {
            realtime["provider"] = "openai"
            realtime["model"] = draft.model
            realtime["speakerVoice"] = draft.voice
            realtime["mode"] = "realtime"
            realtime["transport"] = "gateway-relay"
            realtime["brain"] = "agent-consult"
        } else if draft.explicitlyUsesOpenAI {
            realtime.removeValue(forKey: "mode")
            if Self.string(realtime["transport"])?.caseInsensitiveCompare("gateway-relay") == .orderedSame {
                realtime.removeValue(forKey: "transport")
            }
            if Self.string(realtime["brain"])?.caseInsensitiveCompare("agent-consult") == .orderedSame {
                realtime.removeValue(forKey: "brain")
            }
        }

        talk["realtime"] = realtime
        result["talk"] = talk
        return result
    }

    static func openAIProvider(in catalog: TalkCatalogResult) -> RealtimeTalkProviderDescriptor? {
        guard let providers = catalog.realtime["providers"]?.arrayValue else { return nil }
        for rawProvider in providers {
            guard let provider = rawProvider.dictionaryValue,
                  provider["id"]?.stringValue?.caseInsensitiveCompare("openai") == .orderedSame
            else {
                continue
            }
            return RealtimeTalkProviderDescriptor(
                configured: provider["configured"]?.boolValue ?? false,
                models: Self.strings(provider["models"]),
                voices: Self.strings(provider["voices"]))
        }
        return nil
    }

    private static func strings(_ value: AnyCodable?) -> [String] {
        value?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    private static func string(_ value: Any?) -> String? {
        let string = value as? String
        let trimmed = string?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func dictionary(in values: [String: Any]?, matching expected: String) -> [String: Any]? {
        values?.first { key, _ in
            key.caseInsensitiveCompare(expected) == .orderedSame
        }?.value as? [String: Any]
    }
}

@MainActor
@Observable
final class RealtimeTalkSettingsModel {
    enum Availability: Equatable {
        case loading
        case ready
        case needsOpenAIAccess
        case unavailable(String)
    }

    var draft = RealtimeTalkSettingsDraft.defaults
    var availability: Availability = .loading
    var models = [RealtimeTalkSettingsDraft.defaults.model]
    var voices = ["marin", "cedar", "alloy"]
    var isSaving = false
    var saveMessage: String?
    private var hasLoaded = false

    var showsConfiguration: Bool {
        self.availability == .ready || self.draft.explicitlyUsesOpenAI
    }

    var canEnable: Bool {
        self.availability == .ready || self.draft.enabled
    }

    func load(force: Bool = false) async {
        guard force || !self.hasLoaded else { return }
        self.availability = .loading
        let root = await ConfigStore.load()
        self.draft = RealtimeTalkSettingsConfig.parse(root)

        do {
            let data = try await GatewayConnection.shared.requestRaw(
                method: "talk.catalog",
                params: [:],
                timeoutMs: 8000)
            let catalog = try JSONDecoder().decode(TalkCatalogResult.self, from: data)
            guard let provider = RealtimeTalkSettingsConfig.openAIProvider(in: catalog) else {
                self.availability = .unavailable("This Gateway does not expose the OpenAI realtime provider.")
                self.hasLoaded = true
                return
            }
            self.models = Self.options(current: self.draft.model, catalog: provider.models)
            self.voices = Self.options(current: self.draft.voice, catalog: provider.voices)
            self.availability = provider.configured ? .ready : .needsOpenAIAccess
        } catch {
            self.availability = .unavailable("Could not verify realtime access: \(error.localizedDescription)")
        }
        self.hasLoaded = true
    }

    func save() async {
        guard !self.isSaving else { return }
        self.isSaving = true
        self.saveMessage = nil
        defer { self.isSaving = false }

        do {
            let root = await ConfigStore.load()
            try await ConfigStore.save(RealtimeTalkSettingsConfig.applying(self.draft, to: root))
            self.draft.explicitlyUsesOpenAI = true
            self.saveMessage = self.draft.enabled ? "OpenAI realtime Talk enabled." : "Realtime Talk disabled."
            self.hasLoaded = false
            await self.load(force: true)
        } catch {
            self.saveMessage = error.localizedDescription
        }
    }

    private static func options(current: String, catalog: [String]) -> [String] {
        var options = catalog
        if !options.contains(current) {
            options.insert(current, at: 0)
        }
        return options
    }
}

struct RealtimeTalkSettingsSection: View {
    let isActive: Bool
    @State private var model = RealtimeTalkSettingsModel()

    var body: some View {
        SettingsCardGroup("OpenAI Realtime / GPT-Live") {
            SettingsCardRow(
                title: .verbatim(self.statusTitle),
                subtitle: .verbatim(self.statusSubtitle),
                showsDivider: self.model.showsConfiguration)
            {
                self.statusAccessory
            }

            if self.model.showsConfiguration {
                SettingsCardToggleRow(
                    title: "Use realtime conversation",
                    subtitle: "Stream speech continuously while OpenClaw keeps agent tools and computer actions available.",
                    binding: self.$model.draft.enabled)
                    .disabled(!self.model.canEnable)

                SettingsCardRow(
                    title: "Voice model",
                    subtitle: "GPT-Live uses ChatGPT/Codex OAuth when available; GA realtime models may require Platform API access.")
                {
                    Picker("Voice model", selection: self.$model.draft.model) {
                        ForEach(self.model.models, id: \.self) { model in
                            Text(model).tag(model)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 230)
                }

                SettingsCardRow(title: "Assistant voice", subtitle: "Marin and Cedar are recommended.") {
                    Picker("Assistant voice", selection: self.$model.draft.voice) {
                        ForEach(self.model.voices, id: \.self) { voice in
                            Text(voice.capitalized).tag(voice)
                        }
                    }
                    .labelsHidden()
                    .frame(width: 230)
                }

                SettingsCardRow(
                    title: "Apply realtime settings",
                    subtitle: self.model.saveMessage.map(SettingsTextValue.verbatim),
                    showsDivider: false)
                {
                    Button(self.model.isSaving ? "Saving…" : "Apply") {
                        Task { await self.model.save() }
                    }
                    .disabled(self.model.isSaving || (self.model.draft.enabled && !self.model.canEnable))
                }
            }
        }
        .task(id: self.isActive) {
            guard self.isActive else { return }
            await self.model.load()
        }
        .onReceive(NotificationCenter.default.publisher(for: .openclawConfigDidChange)) { _ in
            guard self.isActive else { return }
            Task { await self.model.load(force: true) }
        }
    }

    private var statusTitle: String {
        switch self.model.availability {
        case .loading: "Checking Gateway…"
        case .ready: "OpenAI realtime is available"
        case .needsOpenAIAccess: "Connect OpenAI to enable realtime"
        case .unavailable: "Realtime availability is unverified"
        }
    }

    private var statusSubtitle: String {
        switch self.model.availability {
        case .loading:
            "Reading the Gateway Talk catalog."
        case .ready:
            "The Gateway reports that OpenAI realtime access is ready for this configuration."
        case .needsOpenAIAccess:
            "Use an OpenClaw OpenAI login or Platform API key. An existing Codex CLI login is not imported automatically."
        case let .unavailable(message):
            message
        }
    }

    @ViewBuilder
    private var statusAccessory: some View {
        switch self.model.availability {
        case .loading:
            ProgressView().controlSize(.small)
        case .ready:
            Image(systemName: "checkmark.circle.fill").foregroundStyle(.green)
        case .needsOpenAIAccess, .unavailable:
            Button("Open Talk Settings…") {
                Task { @MainActor in
                    await DashboardManager.shared.show(atPath: DashboardRouteMap.talkSettingsPath)
                }
            }
        }
    }
}
