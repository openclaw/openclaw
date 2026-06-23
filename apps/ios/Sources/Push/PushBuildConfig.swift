import Foundation

enum PushTransportMode: String {
    case direct
    case relay
}

enum PushDistributionMode: String {
    case local
    case official
}

enum PushAPNsEnvironment: String {
    case sandbox
    case production
}

enum PushRelayProfile: String {
    case production
    case deviceSandbox
    case simulatorSandbox
}

enum PushProofPolicy: String {
    case appleStrict
    case appleDevelopment
    case internalSimulator
}

struct PushBuildConfig {
    let transport: PushTransportMode
    let distribution: PushDistributionMode
    let relayBaseURL: URL?
    let apnsEnvironment: PushAPNsEnvironment
    let relayProfile: PushRelayProfile
    let proofPolicy: PushProofPolicy

    static let current = PushBuildConfig()
    static let openClawHostedRelayHost = "ios-push-relay.openclaw.ai"
    static let openClawSandboxRelayHost = "ios-push-relay-sandbox.openclaw.ai"

    var usesOpenClawHostedRelay: Bool {
        guard self.transport == .relay, self.distribution == .official else { return false }
        guard let relayBaseURL = self.relayBaseURL,
              let components = URLComponents(url: relayBaseURL, resolvingAgainstBaseURL: false)
        else {
            return false
        }
        return components.scheme?.lowercased() == "https"
            && [Self.openClawHostedRelayHost, Self.openClawSandboxRelayHost]
            .contains(components.host?.lowercased() ?? "")
            && components.user == nil
            && components.password == nil
    }

    init(bundle: Bundle = .main) {
        self.transport = Self.readEnum(
            bundle: bundle,
            key: "OpenClawPushTransport",
            fallback: .direct)
        self.distribution = Self.readEnum(
            bundle: bundle,
            key: "OpenClawPushDistribution",
            fallback: .local)
        self.apnsEnvironment = Self.readEnum(
            bundle: bundle,
            key: "OpenClawPushAPNsEnvironment",
            fallback: Self.defaultAPNsEnvironment)
        self.relayProfile = Self.readEnum(
            bundle: bundle,
            key: "OpenClawPushRelayProfile",
            fallback: Self.defaultRelayProfile(apnsEnvironment: self.apnsEnvironment))
        self.proofPolicy = Self.readEnum(
            bundle: bundle,
            key: "OpenClawPushProofPolicy",
            fallback: Self.defaultProofPolicy(relayProfile: self.relayProfile))
        self.relayBaseURL = Self.readURL(bundle: bundle, key: "OpenClawPushRelayBaseURL")
    }

    private static func readURL(bundle: Bundle, key: String) -> URL? {
        guard let raw = bundle.object(forInfoDictionaryKey: key) as? String else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        guard let components = URLComponents(string: trimmed),
              components.scheme?.lowercased() == "https",
              let host = components.host,
              !host.isEmpty,
              components.user == nil,
              components.password == nil,
              components.query == nil,
              components.fragment == nil
        else {
            return nil
        }
        return components.url
    }

    private static func readEnum<T: RawRepresentable>(
        bundle: Bundle,
        key: String,
        fallback: T)
    -> T where T.RawValue == String {
        guard let raw = bundle.object(forInfoDictionaryKey: key) as? String else { return fallback }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return T(rawValue: trimmed) ?? T(rawValue: trimmed.lowercased()) ?? fallback
    }

    private static let defaultAPNsEnvironment: PushAPNsEnvironment = .sandbox

    private static func defaultRelayProfile(apnsEnvironment: PushAPNsEnvironment) -> PushRelayProfile {
        apnsEnvironment == .production ? .production : .deviceSandbox
    }

    private static func defaultProofPolicy(relayProfile: PushRelayProfile) -> PushProofPolicy {
        switch relayProfile {
        case .production:
            .appleStrict
        case .deviceSandbox:
            .appleDevelopment
        case .simulatorSandbox:
            .internalSimulator
        }
    }
}
