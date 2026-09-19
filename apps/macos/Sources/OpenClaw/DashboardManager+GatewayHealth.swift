import Foundation

extension DashboardManager {
    var hasVisibleWindows: Bool {
        self.dashboardControllers().contains { $0.controller.isWindowOpen }
    }

    /// A live dashboard is stronger evidence than a separate native connection
    /// (notably browser sign-in). One failing/closing window cannot hide another
    /// connected window for the same target. Nil means no dashboard evidence.
    func dashboardHealth(for target: DashboardGatewayTarget) -> DashboardGatewayHealth? {
        let health = self.dashboardControllers().filter { $0.target == target }
            .compactMap(\.controller.gatewayHealth)
        if health.contains(.ok) { return .ok }
        if health.contains(.error) { return .error }
        return health.isEmpty ? nil : .unknown
    }

    func applyingDashboardHealth(to entries: [DashboardGatewayEntry]) -> [DashboardGatewayEntry] {
        entries.map { entry in
            guard let target = DashboardGatewayTarget(bridgeID: entry.id),
                  let health = self.dashboardHealth(for: target) else { return entry }
            return DashboardGatewayEntry(
                id: entry.id,
                name: entry.name,
                kind: entry.kind,
                isPrimary: entry.isPrimary,
                canPromote: entry.canPromote,
                health: health)
        }
    }
}
