import Foundation

/// One provider on the phone's accounts page: whether OpenClaw can use it, what is wrong when something is,
/// and the ways to sign in to it.
struct ChatModelAccount: Identifiable, Equatable {
    /// Shown under the name only when something needs attention.
    enum Source: Equatable {
        case settingsKey
        case environmentKey
        case providerApp
    }

    enum Notice: Equatable {
        case expiresSoon(Date?)
        case expired
        case failed
        case unknown

        /// An expiry at or before now reads as expired, never "Sign-in expires 5 seconds ago".
        static func expiring(at date: Date?, now: Date = Date()) -> Self {
            if let date, date <= now { return .expired }
            return .expiresSoon(date)
        }
    }

    let id: String
    let name: String
    let isSignedIn: Bool
    let notice: Notice?
    let options: [ChatModelAuthStatus.LoginOption]
    let profiles: [ChatModelAuthStatus.Profile]
    let plan: String?
    /// How a sign-in without a saved profile reaches the provider: a key in settings or the environment, or
    /// the provider's own app on the OpenClaw host.
    let source: Source?
    /// Every provider id this account answers to: its own, its credential owner's and its options' provider.
    let keys: Set<String>

    /// Saved sign-ins the server says it can remove. Sign-ins owned elsewhere (a CLI, config) carry none.
    var removableProfileIDs: [String] {
        self.profiles.filter { $0.logoutSupported == true }.map(\.profileId)
    }
}

/// The accounts page: providers OpenClaw can use first, then the ones it can't until someone signs in.
struct ChatModelAccountGroups: Equatable {
    let signedIn: [ChatModelAccount]
    let notSignedIn: [ChatModelAccount]

    /// - Parameter failedProviders: providers whose every model the catalog reports as sign-in failed. The
    ///   status read can call such a provider fine (a saved key the provider now rejects), so this is the only
    ///   source for "Sign-in failed".
    init(status: ChatModelAuthStatus, failedProviders: Set<String> = []) {
        let capabilities = status.providerCapabilities ?? []
        var claimed = Set<Int>()
        var accounts: [ChatModelAccount] = status.providers.map { provider in
            let keys = Set([provider.provider, provider.authProvider].compactMap(Self.key))
            var options: [ChatModelAuthStatus.LoginOption] = []
            for (index, capability) in capabilities.enumerated()
                where Self.key(capability.provider).map(keys.contains) == true
            {
                claimed.insert(index)
                options += capability.loginOptions ?? []
            }
            let profiles = provider.profiles ?? []
            let notice: ChatModelAccount.Notice? = switch provider.status {
            case "ok", "static": keys.isDisjoint(with: failedProviders.compactMap(Self.key)) ? nil : .failed
            case "expiring": .expiring(at: provider.expiry.map { Date(timeIntervalSince1970: $0.at / 1000) })
            case "expired": .expired
            case "missing": nil
            default: .unknown
            }
            return ChatModelAccount(
                id: provider.provider,
                // The server falls back to the bare id when it has no label for a provider ("openai").
                name: provider.displayName.caseInsensitiveCompare(provider.provider) == .orderedSame
                    ? ChatModelPickerStore.providerDisplayName(provider.provider.lowercased())
                    : provider.displayName,
                isSignedIn: provider.status != "missing",
                notice: notice,
                options: Self.unique(options),
                profiles: profiles,
                plan: provider.nativeAuth?.plan?.trimmedNonEmpty,
                source: provider.nativeAuth != nil ? .providerApp
                    : provider.apiKey?.source == "env" ? .environmentKey
                    : provider.apiKey != nil ? .settingsKey : nil,
                keys: keys)
        }
        // Providers the server can sign in to but reports nothing about yet.
        var unclaimed: [String: [ChatModelAuthStatus.LoginOption]] = [:]
        var order: [String] = []
        for (index, capability) in capabilities.enumerated() where !claimed.contains(index) {
            let id = Self.key(capability.provider) ?? ""
            if unclaimed[id] == nil { order.append(id) }
            unclaimed[id, default: []] += capability.loginOptions ?? []
        }
        for id in order {
            let options = Self.unique(unclaimed[id] ?? [])
            guard !options.isEmpty else { continue }
            accounts.append(ChatModelAccount(
                id: id,
                name: options.lazy.compactMap { $0.groupLabel?.trimmedNonEmpty }.first
                    ?? (id.isEmpty ? String(localized: "Other") : ChatModelPickerStore.providerDisplayName(id)),
                isSignedIn: false,
                notice: nil,
                options: options,
                profiles: [],
                plan: nil,
                source: nil,
                keys: [id]))
        }
        let sorted = accounts.sorted {
            $0.name.localizedCaseInsensitiveCompare($1.name) == .orderedAscending
        }
        self.signedIn = sorted.filter(\.isSignedIn)
        self.notSignedIn = sorted.filter { !$0.isSignedIn }
    }

    var isEmpty: Bool {
        self.signedIn.isEmpty && self.notSignedIn.isEmpty
    }

    /// The account for a provider id from the model catalog or from this page.
    func account(_ id: String) -> ChatModelAccount? {
        guard let key = Self.key(id) else { return nil }
        let accounts = self.signedIn + self.notSignedIn
        return accounts.first { $0.id == id } ?? accounts.first { $0.keys.contains(key) }
    }

    private static func key(_ provider: String?) -> String? {
        provider?.trimmedNonEmpty?.lowercased()
    }

    private static func unique(_ options: [ChatModelAuthStatus.LoginOption]) -> [ChatModelAuthStatus.LoginOption] {
        var seen = Set<String>()
        return options.filter { seen.insert($0.id).inserted }
    }
}

extension ChatModelProviderSection {
    /// Set when none of this provider's models can be used until someone signs in: every model is unavailable
    /// for a missing or failed sign-in. Any other reason, or one usable model, leaves it nil.
    var signInNeed: OpenClawChatModelUnavailableReason? {
        guard !self.models.isEmpty else { return nil }
        let reasons = self.models.map { $0.available == false ? $0.availabilityReason : nil }
        guard reasons.allSatisfy({ $0 == .missingAuth || $0 == .authFailed }) else { return nil }
        return reasons.contains(.authFailed) ? .authFailed : .missingAuth
    }
}
