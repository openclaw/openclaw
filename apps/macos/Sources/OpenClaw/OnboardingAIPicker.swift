import Foundation

/// Groups the Gateway's detected access and setup options into the first-run picker rows.
/// Presentation only: the Gateway still owns detection, sign-in, activation, and verification.
struct OnboardingAIPicker {
    typealias Model = OnboardingAISetupModel

    enum RowID: Hashable {
        case chatGPT
        case claude
        case gemini
        case apiKey
        case localModel
        /// Access the Gateway found that none of the rows above owns, such as a saved sign-in.
        case found(String)
    }

    enum Action: Equatable {
        /// Test access the Gateway already found. Nothing is tested until the user picks it.
        case candidate(String)
        case signIn(Model.AuthOption)
        /// Open the key form, preselecting this manual provider when set.
        case apiKey(String?)
        case localModel
    }

    struct Row: Identifiable {
        let id: RowID
        let action: Action
        let detected: Bool
        var candidate: Model.Candidate?
    }

    let rows: [Row]
    let localCandidates: [Model.Candidate]
    let localAuthOptions: [Model.AuthOption]
    /// Sign-in options no row owns, behind More providers.
    let moreAuthOptions: [Model.AuthOption]
    /// Downloads for local model apps with no model found yet, beside Check again.
    let localInstalls: [Model.RecommendedInstall]
    /// The other downloads, behind More providers.
    let otherInstalls: [Model.RecommendedInstall]

    /// The usual rows, shown before the Gateway answers so the page never starts empty.
    static let placeholderRows: [RowID] = [.chatGPT, .claude, .gemini, .apiKey, .localModel]

    init(
        candidates: [Model.Candidate],
        authOptions: [Model.AuthOption],
        manualProviders: [Model.ManualProvider],
        prepareOptions: [Model.PrepareOption],
        recommendedInstalls: [Model.RecommendedInstall] = [])
    {
        let usable = candidates.filter { $0.credentials != false }
        let local = usable.filter { Self.isLocalModelRef($0.modelRef) }
        let localOptions = authOptions.filter { Self.isLocalProvider($0.brandId ?? $0.id) }
        var claimed = Set(local.map(\.kind))
        var usedOptions = Set(localOptions.map(\.id))
        var rows: [Row] = []

        func accountRow(_ id: RowID, candidateKind: String, brand: String, allowsInstall: Bool) -> Row? {
            if let candidate = usable.first(where: { $0.kind == candidateKind }) {
                claimed.insert(candidate.kind)
                return Row(id: id, action: .candidate(candidate.kind), detected: true, candidate: candidate)
            }
            let kinds = allowsInstall ? ["oauth", "device-code", "install"] : ["oauth", "device-code"]
            // Gateway order already ranks options; a browser sign-in beats a device code on this Mac.
            let options = authOptions.filter { $0.brandId == brand && kinds.contains($0.kind) }
            guard let option = options.first(where: { $0.kind == "oauth" }) ?? options.first else { return nil }
            usedOptions.insert(option.id)
            return Row(id: id, action: .signIn(option), detected: false)
        }

        if let row = accountRow(.chatGPT, candidateKind: "codex-cli", brand: "openai", allowsInstall: false) {
            rows.append(row)
        }
        if let row = accountRow(.claude, candidateKind: "claude-cli", brand: "anthropic", allowsInstall: true) {
            rows.append(row)
        }
        // Google sign-in is not a Gateway setup option today; the Gemini row falls back to its key.
        if let row = accountRow(.gemini, candidateKind: "gemini-cli", brand: "google", allowsInstall: false) {
            rows.append(row)
        } else if let key = manualProviders.first(where: { $0.brandId == "google" }) {
            rows.append(Row(id: .gemini, action: .apiKey(key.id), detected: false))
        }
        if !manualProviders.isEmpty {
            rows.append(Row(id: .apiKey, action: .apiKey(nil), detected: false))
        }
        // The Gateway already drops downloads for apps that are running; a found model means installed.
        let localApps = Set(local.compactMap { $0.brandId?.lowercased() })
        let localInstalls = recommendedInstalls.filter {
            let id = ($0.brandId ?? $0.id).lowercased()
            return Self.isLocalProvider(id) && !localApps.contains(id)
        }
        if !local.isEmpty || !localOptions.isEmpty || !prepareOptions.isEmpty || !localInstalls.isEmpty {
            rows.append(Row(id: .localModel, action: .localModel, detected: !local.isEmpty))
        }
        let found = usable.filter { !claimed.contains($0.kind) }.map {
            Row(id: .found($0.kind), action: .candidate($0.kind), detected: true, candidate: $0)
        }
        self.rows = found + rows
        self.localCandidates = local
        self.localAuthOptions = localOptions
        self.moreAuthOptions = authOptions.filter { !usedOptions.contains($0.id) }
        self.localInstalls = localInstalls
        self.otherInstalls = recommendedInstalls.filter { !Self.isLocalProvider($0.brandId ?? $0.id) }
    }

    func row(for selection: Row, manualProviders: [Model.ManualProvider]) -> Row? {
        // Keep the selected key form open while its provider is in the current catalog.
        if case let .apiKey(providerID?) = selection.action,
           manualProviders.contains(where: { $0.id == providerID })
        {
            return selection
        }
        return self.rows.first { $0.id == selection.id }
    }

    static func isLocalModelRef(_ modelRef: String) -> Bool {
        self.isLocalProvider(modelRef.split(separator: "/", maxSplits: 1).first.map(String.init) ?? "")
    }

    /// Model services that run where the user chooses. Their endpoints may still be remote.
    static func isLocalProvider(_ provider: String) -> Bool {
        ["ollama", "lmstudio", "llama-cpp"].contains(provider.lowercased())
    }
}
