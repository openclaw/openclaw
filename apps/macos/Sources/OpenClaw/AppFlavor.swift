import Foundation

enum AppFlavor: String {
    case standard
    case consumer

    static var current: AppFlavor {
        // Resolve the flavor in override order so packaging/tests can force consumer mode
        // without relying on the final signed bundle metadata being present.
        if let env = ProcessInfo.processInfo.environment["OPENCLAW_APP_VARIANT"]?
            .trimmingCharacters(in: .whitespacesAndNewlines)
            .lowercased(),
           let flavor = Self(rawValue: env)
        {
            return flavor
        }

        if let raw = Bundle.main.infoDictionary?["OpenClawAppVariant"] as? String,
           let flavor = Self(rawValue: raw.trimmingCharacters(in: .whitespacesAndNewlines).lowercased())
        {
            return flavor
        }

        let bundleID = Bundle.main.bundleIdentifier?.lowercased() ?? ""
        if bundleID.contains(".consumer") {
            return .consumer
        }

        return .standard
    }

    var isConsumer: Bool {
        self == .consumer
    }

    var appName: String {
        switch self {
        case .standard:
            "OpenClaw"
        case .consumer:
            "OpenClaw Consumer"
        }
    }

    var defaultsPrefix: String {
        switch self {
        case .standard:
            "openclaw"
        case .consumer:
            "openclaw.consumer"
        }
    }

    var stableSuiteName: String {
        switch self {
        case .standard:
            "ai.openclaw.mac"
        case .consumer:
            "ai.openclaw.consumer.mac"
        }
    }

    var gatewayLaunchLabel: String {
        switch self {
        case .standard:
            "ai.openclaw.gateway"
        case .consumer:
            "ai.openclaw.consumer.gateway"
        }
    }

    var defaultStateDirName: String {
        switch self {
        case .standard:
            ".openclaw"
        case .consumer:
            ".openclaw-consumer"
        }
    }

    var defaultGatewayPort: Int {
        switch self {
        case .standard:
            18789
        case .consumer:
            19001
        }
    }

    var defaultLogDirName: String {
        switch self {
        case .standard:
            "openclaw"
        case .consumer:
            "openclaw-consumer"
        }
    }
}
