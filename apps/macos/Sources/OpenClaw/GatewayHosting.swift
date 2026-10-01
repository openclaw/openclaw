import Foundation

enum GatewayHosting: String, Sendable {
    case app
    case service

    static let defaultsKey = "gatewayHosting"

    static func usesSeededGateway(
        hasService: Bool,
        installedCLI: GatewayLaunchAgentManager.InstalledServiceCLI?,
        hasCurrentSeed: Bool,
        stateDirectory: URL,
        hasRetainedService: Bool = false,
        retainedCLI: GatewayLaunchAgentManager.InstalledServiceCLI? = nil) -> Bool
    {
        guard hasService || hasRetainedService else { return hasCurrentSeed }
        let cli = hasService ? installedCLI : retainedCLI
        return GatewayLaunchAgentManager.bundledRuntimeReplacementError(
            appManaged: true,
            installedRuntimePath: cli?.prefix.last,
            stateDirectory: stateDirectory) == nil
    }

    static func resolve(stored: String?, bundled: Bool, serviceExists: Bool) -> Self {
        guard bundled, !serviceExists else { return .service }
        if let stored, let hosting = Self(rawValue: stored) { return hosting }
        return .app
    }
}

struct GatewayHostingError: LocalizedError {
    let message: String
    var errorDescription: String? {
        self.message
    }
}
