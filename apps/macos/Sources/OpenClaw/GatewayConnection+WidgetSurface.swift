import Foundation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import OSLog

private let gatewayWidgetSurfaceLogger = Logger(subsystem: "ai.openclaw", category: "gateway.widget-surface")

private struct PluginSurfaceRefreshResponse: Decodable {
    let pluginSurfaceUrls: [String: AnyCodable]?
}

extension GatewayConnection {
    struct CanvasPluginSurfaceKey: Equatable, Sendable {
        let lease: ServerLease
        let expectedProfileId: String?

        static func == (lhs: Self, rhs: Self) -> Bool {
            lhs.lease == rhs.lease &&
                lhs.expectedProfileId.map { Array($0.utf8) } == rhs.expectedProfileId.map { Array($0.utf8) }
        }
    }

    struct CanvasPluginSurfaceRefresh {
        let id: UUID
        let key: CanvasPluginSurfaceKey
        let task: Task<GatewayCanvasHostRoute?, Error>
    }

    struct CanvasPluginSurface {
        let key: CanvasPluginSurfaceKey
        let url: String
        let operationID: UUID?
    }

    func canvasPluginSurfaceUrl() async -> String? {
        await self.canvasPluginSurfaceRoute()?.url
    }

    func canvasPluginSurfaceRoute() async -> GatewayCanvasHostRoute? {
        guard let surface = self.canvasPluginSurface else { return nil }
        if surface.key.expectedProfileId == nil {
            return self.currentCanvasPluginSurfaceRoute(for: surface.key)
        }
        // A native owner can occupy the single cache entry. Ordinary windows
        // reacquire their own unbound surface through the same refresh owner.
        guard let lease = await self.captureServerLease() else { return nil }
        return try? await self.refreshCanvasPluginSurfaceRoute(
            replacing: nil, ifCurrentServerLease: lease)
    }

    func refreshCanvasPluginSurfaceRoute(replacing observedURL: String?) async -> GatewayCanvasHostRoute? {
        guard let lease = await self.captureServerLease(), !Task.isCancelled else { return nil }
        do {
            return try await self.refreshCanvasPluginSurfaceRoute(
                replacing: observedURL, ifCurrentServerLease: lease)
        } catch {
            gatewayWidgetSurfaceLogger.debug(
                "plugin.surface.refresh failed: \(error.localizedDescription, privacy: .public)")
            return nil
        }
    }

    func canvasPluginSurfaceRoute(
        ifCurrentServerLease lease: ServerLease,
        expectedProfileId: String?,
        isCurrent: @Sendable () -> Bool) async throws -> GatewayCanvasHostRoute?
    {
        let key = CanvasPluginSurfaceKey(lease: lease, expectedProfileId: expectedProfileId)
        try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
        return self.currentCanvasPluginSurfaceRoute(for: key)
    }

    func refreshCanvasPluginSurfaceRoute(
        replacing observedURL: String?,
        ifCurrentServerLease lease: ServerLease,
        expectedProfileId: String? = nil,
        isCurrent: @escaping @Sendable () -> Bool = { true }) async throws -> GatewayCanvasHostRoute?
    {
        let key = CanvasPluginSurfaceKey(lease: lease, expectedProfileId: expectedProfileId)
        try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
        while let active = self.canvasPluginSurfaceRefresh {
            if active.key == key {
                let route = try await active.task.value
                try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
                guard route == nil || self.canvasPluginSurface?.operationID == active.id else {
                    throw CancellationError()
                }
                return route
            }
            // A different owner serializes rotation but grants no result/cache
            // authority. Keep the caller's original observed URL across this wait.
            _ = await active.task.result
            try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
            if self.canvasPluginSurfaceRefresh?.id == active.id {
                self.canvasPluginSurfaceRefresh = nil
            }
        }
        if let cached = self.currentCanvasPluginSurfaceRoute(for: key), cached.url != observedURL {
            return cached
        }
        let id = UUID()
        let task = Task<GatewayCanvasHostRoute?, Error> { [weak self] in
            guard let self else { throw CancellationError() }
            return try await self.requestCanvasPluginSurfaceRefresh(
                replacing: observedURL,
                key: key,
                operationID: id,
                isCurrent: isCurrent)
        }
        // Install before the task's first suspension so sibling widgets share
        // one rotation instead of invalidating each other's new capability.
        self.canvasPluginSurfaceRefresh = CanvasPluginSurfaceRefresh(id: id, key: key, task: task)
        defer {
            if self.canvasPluginSurfaceRefresh?.id == id {
                self.canvasPluginSurfaceRefresh = nil
            }
        }
        let route = try await task.value
        try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
        guard route == nil || self.canvasPluginSurface?.operationID == id else { throw CancellationError() }
        return route
    }

    private func requestCanvasPluginSurfaceRefresh(
        replacing observedURL: String?,
        key: CanvasPluginSurfaceKey,
        operationID: UUID,
        isCurrent: @Sendable () -> Bool) async throws -> GatewayCanvasHostRoute?
    {
        try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
        guard self.canvasPluginSurfaceRefresh?.id == operationID else { throw CancellationError() }
        var params = ["surface": AnyCodable("canvas")]
        if let observedURL {
            params["observedUrl"] = AnyCodable(observedURL)
        }
        let data = try await self.request(
            method: "plugin.surface.refresh",
            params: params,
            timeoutMs: 8000,
            ifCurrentServerLease: key.lease,
            expectedProfileId: key.expectedProfileId)
        let response = try JSONDecoder().decode(PluginSurfaceRefreshResponse.self, from: data)
        try await self.requireCurrentCanvasPluginSurface(key, isCurrent: isCurrent)
        guard self.canvasPluginSurfaceRefresh?.id == operationID else { throw CancellationError() }
        let raw = response.pluginSurfaceUrls?["canvas"]?.value as? String
        guard let refreshed = GatewayPluginSurfaceURL.canonicalize(raw: raw, against: key.lease.route.url) else {
            return nil
        }
        self.canvasPluginSurface = CanvasPluginSurface(key: key, url: refreshed, operationID: operationID)
        return self.currentCanvasPluginSurfaceRoute(for: key)
    }

    private func requireCurrentCanvasPluginSurface(
        _ key: CanvasPluginSurfaceKey,
        isCurrent: @Sendable () -> Bool) async throws
    {
        try Task.checkCancellation()
        guard isCurrent(), await self.isCurrentServerLease(key.lease), isCurrent() else {
            throw OpenClawChatTransportSendError.notDispatched
        }
        try Task.checkCancellation()
    }

    private func currentCanvasPluginSurfaceRoute(for key: CanvasPluginSurfaceKey) -> GatewayCanvasHostRoute? {
        guard let surface = self.canvasPluginSurface, surface.key == key,
              self.serverLeaseMatchesCurrentState(key.lease)
        else { return nil }
        return GatewayCanvasHostRoute(
            url: surface.url,
            tlsFingerprintSHA256: self.configuredTLSFingerprintSHA256())
    }

    func installCanvasPluginSurfaceURL(from snapshot: HelloOk, lease: ServerLease) {
        let raw = snapshot.pluginsurfaceurls?["canvas"]?.value as? String
        self.resetCanvasPluginSurfaceState()
        if let url = GatewayPluginSurfaceURL.canonicalize(raw: raw, against: lease.route.url) {
            self.canvasPluginSurface = CanvasPluginSurface(
                key: CanvasPluginSurfaceKey(lease: lease, expectedProfileId: nil),
                url: url,
                operationID: nil)
        }
    }

    func resetCanvasPluginSurfaceState() {
        self.canvasPluginSurfaceRefresh?.task.cancel()
        self.canvasPluginSurfaceRefresh = nil
        self.canvasPluginSurface = nil
    }
}
