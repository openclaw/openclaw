import Foundation

@MainActor
final class GatewayCanvasRegistry {
    static let shared = GatewayCanvasRegistry()

    private var managers: [String: CanvasManager] = [:]

    func manager(for profile: GatewayProfile) -> CanvasManager {
        if let existing = self.managers[profile.id] { return existing }
        let connectionProvider: @Sendable () async -> GatewayConnection = {
            await GatewayChatConnectionRegistry.shared.connection(for: profile)
        }
        let manager = CanvasManager(
            profileName: profile.displayName,
            connectionProvider: connectionProvider,
            autoNavigateToGatewayHost: false)
        self.managers[profile.id] = manager
        return manager
    }
}
