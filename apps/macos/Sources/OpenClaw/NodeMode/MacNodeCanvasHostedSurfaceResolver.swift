import Foundation

struct MacNodeCanvasHostedSurfaceResolver: Sendable {
    private let currentSurfaceURL: @Sendable () async -> String?
    private let refreshSurfaceURL: @Sendable (String?) async -> String?

    init(
        currentSurfaceURL: @escaping @Sendable () async -> String?,
        refreshSurfaceURL: @escaping @Sendable (String?) async -> String?)
    {
        self.currentSurfaceURL = currentSurfaceURL
        self.refreshSurfaceURL = refreshSurfaceURL
    }

    func resolveA2UIURL(forceRefresh: Bool = false) async -> String? {
        let observedSurface = await currentSurfaceURL()
        if !forceRefresh,
           let current = CanvasHostedURLResolver.resolveA2UIURL(surfaceURL: observedSurface)
        {
            return current
        }
        let refreshedSurface = await refreshSurfaceURL(observedSurface)
        return CanvasHostedURLResolver.resolveA2UIURL(surfaceURL: refreshedSurface)
    }

    func resolveTarget(_ target: String?) async throws -> CanvasHostedTarget? {
        guard let target, CanvasHostedURLResolver.isHostedTarget(target) else { return nil }
        let observedSurface = await currentSurfaceURL()
        if let refreshedSurface = await refreshSurfaceURL(observedSurface),
           let resolved = CanvasHostedURLResolver.resolve(surfaceURL: refreshedSurface, target: target)
        {
            return resolved
        }
        if let resolved = CanvasHostedURLResolver.resolve(surfaceURL: observedSurface, target: target) {
            return resolved
        }
        throw NSError(domain: "Canvas", code: 32, userInfo: [
            NSLocalizedDescriptionKey: "CANVAS_HOST_NOT_CONFIGURED: gateway did not advertise canvas host",
        ])
    }
}
