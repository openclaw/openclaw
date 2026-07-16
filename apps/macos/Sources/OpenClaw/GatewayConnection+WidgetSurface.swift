import OpenClawKit

extension GatewayConnection {
    func canvasPluginSurfaceRoute() async -> GatewayCanvasHostRoute? {
        guard let url = await self.canvasPluginSurfaceUrl() else { return nil }
        // The operator channel uses platform trust. Pinned remote routes belong
        // to MacNodeModeCoordinator and arrive through its node session.
        return GatewayCanvasHostRoute(url: url, tlsFingerprintSHA256: nil)
    }
}
