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
    let transports: [String]
    let brains: [String]

    /// This card only ever writes `gateway-relay` + `agent-consult`, so readiness means the Gateway
    /// declared that exact pair for OpenAI -- `configured` alone would enable a setting the
    /// realtime session cannot launch.
    var supportsGatewayRelayAgentConsult: Bool {
        self.transports.contains { $0.caseInsensitiveCompare("gateway-relay") == .orderedSame } &&
            self.brains.contains { $0.caseInsensitiveCompare("agent-consult") == .orderedSame }
    }
}

enum RealtimeTalkSettingsConfig {
    static func parse(_ root: [String: Any]) -> RealtimeTalkSettingsDraft {
        let talk = root["talk"] as? [String: Any]
        let realtime = talk?["realtime"] as? [String: Any]
        let providers = realtime?["providers"] as? [String: Any]
        let openAI = Self.dictionary(in: providers, matching: "openai")
        let provider = Self.string(realtime?["provider"])
        let selectedProvider = provider ?? Self.onlyProviderKey(in: providers)
        let selectsOpenAI = selectedProvider?.caseInsensitiveCompare("openai") == .orderedSame
        let model = (selectsOpenAI ? Self.string(realtime?["model"]) : nil)
            ?? Self.string(openAI?["model"])
            ?? RealtimeTalkSettingsDraft.defaults.model
        let voice = (selectsOpenAI ? Self.string(realtime?["speakerVoice"]) : nil)
            ?? (selectsOpenAI ? Self.string(realtime?["voice"]) : nil)
            ?? Self.string(openAI?["speakerVoice"])
            ?? Self.string(openAI?["voice"])
            ?? RealtimeTalkSettingsDraft.defaults.voice
        let explicitlyUsesOpenAI = selectsOpenAI || openAI != nil
        let enabled = selectsOpenAI &&
            Self.string(realtime?["mode"])?.caseInsensitiveCompare("realtime") == .orderedSame &&
            Self.string(realtime?["transport"])?.caseInsensitiveCompare("gateway-relay") == .orderedSame &&
            Self.string(realtime?["brain"])?.caseInsensitiveCompare("agent-consult") == .orderedSame

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
        let explicitProvider = Self.string(realtime["provider"])
        let selectedProvider = explicitProvider ?? Self.onlyProviderKey(in: realtime["providers"] as? [String: Any])
        let selectsOpenAI = selectedProvider?.caseInsensitiveCompare("openai") == .orderedSame

        Self.persistOpenAIOptions(draft, in: &realtime)

        if draft.enabled {
            realtime["provider"] = "openai"
            realtime["model"] = draft.model
            realtime["speakerVoice"] = draft.voice
            realtime["mode"] = "realtime"
            realtime["transport"] = "gateway-relay"
            realtime["brain"] = "agent-consult"
            // GPT-Live delegates to the agent natively, so the provider rejects a gateway-relay
            // launch that also forces consult routing. Saving both would persist an "enabled"
            // state that can never create a Talk session; GA realtime models keep their routing.
            if Self.isGptLiveModel(draft.model),
               Self.string(realtime["consultRouting"])?
                   .caseInsensitiveCompare("force-agent-consult") == .orderedSame
            {
                realtime.removeValue(forKey: "consultRouting")
            }
        } else if selectsOpenAI {
            realtime["provider"] = "openai"
            realtime["model"] = draft.model
            realtime["speakerVoice"] = draft.voice
            realtime.removeValue(forKey: "mode")
            if Self.string(realtime["transport"])?.caseInsensitiveCompare("gateway-relay") == .orderedSame {
                realtime.removeValue(forKey: "transport")
            }
            if Self.string(realtime["brain"])?.caseInsensitiveCompare("agent-consult") == .orderedSame {
                realtime.removeValue(forKey: "brain")
            }
        } else if explicitProvider == nil, let selectedProvider {
            // Adding the OpenAI entry turns an inferred single-provider map into a multi-provider
            // map. Preserve the previously inferred selection explicitly so the schema stays valid.
            realtime["provider"] = selectedProvider
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
                voices: Self.strings(provider["voices"]),
                transports: Self.strings(provider["transports"]),
                brains: Self.strings(provider["brains"]))
        }
        return nil
    }

    private static func strings(_ value: AnyCodable?) -> [String] {
        value?.arrayValue?.compactMap(\.stringValue) ?? []
    }

    /// Mirrors the provider's own GPT-Live check (`isOpenAIGptLiveModel`), which keys off the
    /// `gpt-live` model-id prefix rather than an enumerated list.
    static func isGptLiveModel(_ model: String) -> Bool {
        let normalized = model.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return normalized == "gpt-live" || normalized.hasPrefix("gpt-live-")
    }

    private static func string(_ value: Any?) -> String? {
        let string = value as? String
        let trimmed = string?.trimmingCharacters(in: .whitespacesAndNewlines)
        return trimmed?.isEmpty == false ? trimmed : nil
    }

    private static func onlyProviderKey(in providers: [String: Any]?) -> String? {
        guard let providers, providers.count == 1 else { return nil }
        return providers.keys.first
    }

    private static func persistOpenAIOptions(
        _ draft: RealtimeTalkSettingsDraft,
        in realtime: inout [String: Any])
    {
        var providers = realtime["providers"] as? [String: Any] ?? [:]
        let existingKey = providers.keys.first {
            $0.caseInsensitiveCompare("openai") == .orderedSame
        }
        var openAI = existingKey.flatMap { providers[$0] as? [String: Any] } ?? [:]
        openAI["model"] = draft.model
        openAI["speakerVoice"] = draft.voice
        if let existingKey, existingKey != "openai" {
            providers.removeValue(forKey: existingKey)
        }
        providers["openai"] = openAI
        realtime["providers"] = providers
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
            guard provider.supportsGatewayRelayAgentConsult else {
                self.availability = .unavailable(
                    "This Gateway's OpenAI realtime provider does not support relayed Talk sessions.")
                self.hasLoaded = true
                return
            }
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
                    subtitle: .verbatim(
                        "Stream speech continuously while OpenClaw keeps agent tools " +
                            "and computer actions available."),
                    binding: self.$model.draft.enabled)
                    .disabled(!self.model.canEnable)

                SettingsCardRow(
                    title: "Voice model",
                    subtitle: .verbatim(
                        "GPT-Live uses ChatGPT/Codex OAuth when available; " +
                            "GA realtime models may require Platform API access."))
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
            "Use an OpenClaw OpenAI login or Platform API key. " +
                "An existing Codex CLI login is not imported automatically."
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
