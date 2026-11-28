import Foundation
import OpenClawKit

public struct ChatModelProviderSection: Identifiable, Sendable, Equatable {
    public let id: String
    public let displayName: String
    public let models: [OpenClawChatModelChoice]
    public let isDefaultProvider: Bool
}

public struct ChatModelPickerSections: Sendable, Equatable {
    public let pinned: [OpenClawChatModelChoice]
    public let recent: [OpenClawChatModelChoice]
    public let providers: [ChatModelProviderSection]
}

/// The phone picker's catalog. Unlike the menu sections, every provider keeps all of its models in catalog
/// order, so a pinned or recent model still appears under its provider.
public struct ChatModelPickerCatalog: Sendable, Equatable {
    public static let maxRecents = 5

    public let favorites: [OpenClawChatModelChoice]
    public let recents: [OpenClawChatModelChoice]
    public let providers: [ChatModelProviderSection]

    /// The provider that serves a choice, for its mark and secondary text.
    public func provider(for choice: OpenClawChatModelChoice) -> ChatModelProviderSection? {
        self.providers.first { $0.models.contains { $0.selectionID == choice.selectionID } }
    }

    /// Flat results across every provider, in picker order. A query matches a model's name, its id or its
    /// provider's name.
    public func search(_ query: String) -> [OpenClawChatModelChoice] {
        let query = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !query.isEmpty else { return [] }
        return self.providers.flatMap { provider in
            let providerMatches = provider.displayName.localizedStandardContains(query) ||
                provider.id.localizedStandardContains(query)
            return provider.models.filter { model in
                providerMatches || model.modelID.localizedStandardContains(query) ||
                    OpenClawChatViewModel.shortModelLabel(
                        name: model.name,
                        provider: model.provider,
                        modelID: model.modelID).localizedStandardContains(query)
            }
        }
    }
}

@MainActor
public final class ChatModelPickerStore {
    private static let favoritesKey = "openclaw.chat.modelFavorites"
    private static let recentsKey = "openclaw.chat.modelRecents"
    private static let maxRecents = 5

    private let defaults: UserDefaults

    public private(set) var favorites: [String]
    public private(set) var recents: [String]

    public init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        self.favorites = defaults.stringArray(forKey: Self.favoritesKey) ?? []
        self.recents = defaults.stringArray(forKey: Self.recentsKey) ?? []
    }

    public func isFavorite(_ selectionID: String) -> Bool {
        self.favorites.contains(selectionID)
    }

    public func toggleFavorite(_ selectionID: String) {
        self.favorites = self.defaults.stringArray(forKey: Self.favoritesKey) ?? []
        if self.isFavorite(selectionID) {
            self.favorites.removeAll { $0 == selectionID }
        } else {
            self.favorites.append(selectionID)
        }
        self.defaults.set(self.favorites, forKey: Self.favoritesKey)
    }

    public func recordRecent(_ selectionID: String) {
        guard !selectionID.isEmpty, selectionID != OpenClawChatViewModel.defaultModelSelectionID else { return }
        self.recents = self.defaults.stringArray(forKey: Self.recentsKey) ?? []
        self.recents.removeAll { $0 == selectionID }
        self.recents.insert(selectionID, at: 0)
        self.recents = Array(self.recents.prefix(Self.maxRecents))
        self.defaults.set(self.recents, forKey: Self.recentsKey)
    }

    public static func sections(
        choices: [OpenClawChatModelChoice],
        favorites: [String],
        recents: [String],
        defaultProvider: String? = nil) -> ChatModelPickerSections
    {
        let choices = choices.filter { $0.manualSelectionAllowed != false }
        var choicesByID: [String: OpenClawChatModelChoice] = [:]
        for choice in choices where choicesByID[choice.selectionID] == nil {
            choicesByID[choice.selectionID] = choice
        }

        var included = Set<String>()
        let pinned = favorites.compactMap { selectionID -> OpenClawChatModelChoice? in
            guard included.insert(selectionID).inserted else { return nil }
            return choicesByID[selectionID]
        }
        let recent = recents.compactMap { selectionID -> OpenClawChatModelChoice? in
            guard included.insert(selectionID).inserted else { return nil }
            return choicesByID[selectionID]
        }
        let remaining = choices.filter { included.insert($0.selectionID).inserted }
        return ChatModelPickerSections(
            pinned: pinned,
            recent: recent,
            providers: self.providerSections(remaining, defaultProvider: defaultProvider))
    }

    /// Models used lately, most recent first: each chat's model as the chat list reports it, from any device,
    /// then picks made on this device that no listed chat shows. Each model once, at most `limit`.
    public static func recentModelIDs(
        chats: [(selectionID: String?, activeAt: Double)],
        picks: [String],
        limit: Int = ChatModelPickerCatalog.maxRecents) -> [String]
    {
        var seen = Set<String>()
        let fromChats = chats.enumerated()
            .sorted {
                $0.element.activeAt != $1.element.activeAt ? $0.element.activeAt > $1.element.activeAt : $0.offset < $1
                    .offset
            }
            .compactMap(\.element.selectionID)
        return Array((fromChats + picks).filter { !$0.isEmpty && seen.insert($0).inserted }.prefix(limit))
    }

    /// The phone picker: favorites, at most five recents, and every provider with all of its models.
    /// The current model always sits on the root: in Favorites when it is one, otherwise first in Recent.
    /// With one provider the root already lists its models with the check, so Recent leaves the current one
    /// out. Models that cannot be used right now are left out of Recent. The stored recents are not changed.
    public static func catalog(
        choices: [OpenClawChatModelChoice],
        favorites: [String],
        recents: [String],
        current: String? = nil,
        defaultProvider: String? = nil) -> ChatModelPickerCatalog
    {
        let providers = self.providerSections(
            choices.filter { $0.manualSelectionAllowed != false },
            defaultProvider: defaultProvider)
        let recents: [String] = if let current {
            providers.count > 1 ? [current] + recents.filter { $0 != current } : recents.filter { $0 != current }
        } else {
            recents
        }
        let sections = self.sections(
            choices: choices,
            favorites: favorites,
            recents: recents,
            defaultProvider: defaultProvider)
        return ChatModelPickerCatalog(
            favorites: sections.pinned,
            recents: Array(sections.recent
                .filter { $0.selectionID == current || $0.available != false }
                .prefix(ChatModelPickerCatalog.maxRecents)),
            providers: providers)
    }

    /// Models grouped by provider in catalog order; the default provider first, then by name.
    private static func providerSections(
        _ models: [OpenClawChatModelChoice],
        defaultProvider: String?) -> [ChatModelProviderSection]
    {
        let normalizedDefaultProvider = self.normalizedProviderIfPresent(defaultProvider)
        var seen = Set<String>()
        let grouped = Dictionary(grouping: models.filter { seen.insert($0.selectionID).inserted }) {
            self.effectiveProvider($0)
        }
        return grouped.map { provider, models in
            ChatModelProviderSection(
                id: provider,
                // A name the operator configured for the provider wins over the built-in one.
                displayName: models.lazy.compactMap { $0.providerName?.trimmedNonEmpty }.first
                    ?? self.providerDisplayName(provider),
                models: models,
                isDefaultProvider: normalizedDefaultProvider.map { provider == $0 } ?? false)
        }.sorted { lhs, rhs in
            if lhs.isDefaultProvider != rhs.isDefaultProvider {
                return lhs.isDefaultProvider
            }
            let nameOrder = lhs.displayName.localizedCaseInsensitiveCompare(rhs.displayName)
            if nameOrder != .orderedSame {
                return nameOrder == .orderedAscending
            }
            return lhs.id < rhs.id
        }
    }

    static func isDefaultModel(
        _ choice: OpenClawChatModelChoice,
        defaultProvider: String?,
        defaultModel: String?) -> Bool
    {
        guard let rawDefaultModel = ChatPayloadDecoding.trimmedNonEmptyString(defaultModel) else { return false }
        let qualifiedDefault = self.splitQualifiedModelID(rawDefaultModel)
        let expectedProvider = self.normalizedProviderIfPresent(defaultProvider)
            ?? qualifiedDefault.map { self.normalizedProvider($0.provider) }
        let expectedModel = qualifiedDefault?.modelID ?? rawDefaultModel
        let choiceModel = self.splitQualifiedModelID(choice.modelID)?.modelID ?? choice.modelID
        guard choiceModel == expectedModel || choice.modelID == rawDefaultModel else { return false }
        guard let expectedProvider else { return true }
        return self.effectiveProvider(choice) == expectedProvider
    }

    static func resolvedDefaultProvider(provider: String?, model: String?) -> String? {
        self.normalizedProviderIfPresent(provider)
            ?? model.flatMap(self.providerFromQualifiedModelID)
    }

    private static func normalizedProvider(_ provider: String?) -> String {
        self.normalizedProviderIfPresent(provider) ?? "other"
    }

    private static func normalizedProviderIfPresent(_ provider: String?) -> String? {
        provider?.trimmedNonEmpty?.lowercased()
    }

    private static func effectiveProvider(_ choice: OpenClawChatModelChoice) -> String {
        let metadataProvider = self.normalizedProvider(choice.provider)
        if metadataProvider != "other" {
            return metadataProvider
        }
        return self.providerFromQualifiedModelID(choice.modelID) ?? metadataProvider
    }

    private static func splitQualifiedModelID(_ modelID: String) -> (provider: String, modelID: String)? {
        let parts = modelID.split(separator: "/", maxSplits: 1).map(String.init)
        guard parts.count == 2 else { return nil }
        return (parts[0], parts[1])
    }

    private static func providerFromQualifiedModelID(_ modelID: String) -> String? {
        guard let parts = self.splitQualifiedModelID(modelID) else { return nil }
        let normalized = self.normalizedProvider(parts.provider)
        return normalized == "other" ? nil : normalized
    }

    /// Brand names whose title-cased id reads wrong, as the Control UI writes them (provider-icon-data.ts).
    private nonisolated static let brandNames: [String: String] = [
        "byteplus": "BytePlus", "claude-cli": "Claude CLI", "clawrouter": "ClawRouter", "deepinfra": "DeepInfra",
        "deepseek": "DeepSeek", "github-copilot": "GitHub Copilot", "huggingface": "Hugging Face",
        "litellm": "LiteLLM", "llama-cpp": "llama.cpp", "lmstudio": "LM Studio", "moonshot": "Moonshot AI",
        "nvidia": "NVIDIA", "opencode": "OpenCode", "openrouter": "OpenRouter", "vllm": "vLLM", "zai": "Z.AI",
    ]

    nonisolated static func providerDisplayName(_ provider: String) -> String {
        switch provider {
        case "anthropic": "Anthropic"
        case "google", "google-gemini-cli": "Google"
        case "minimax", "minimax-portal": "MiniMax"
        case "openai": "OpenAI"
        case "xai": "xAI"
        case "other": String(localized: "Other")
        default:
            self.brandNames[provider] ?? provider
                .split(separator: "-")
                .map(\.capitalized)
                .joined(separator: " ")
        }
    }
}
