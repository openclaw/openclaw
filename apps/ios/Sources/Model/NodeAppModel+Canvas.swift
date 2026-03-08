import Foundation
import OpenClawKit

extension NodeAppModel {
    func resolveCanvasHostURL() async -> String? {
        guard let raw = await self.gatewaySession.currentCanvasHostUrl() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let base = URL(string: trimmed) else { return nil }
        if let host = base.host, LoopbackHost.isLoopback(host) {
            return nil
        }
        return base.appendingPathComponent("__openclaw__/canvas/").absoluteString
    }

    func _test_resolveA2UIHostURL() async -> String? {
        await self.resolveA2UIHostURL()
    }

    func resolveA2UIHostURL() async -> String? {
        guard let raw = await self.gatewaySession.currentCanvasHostUrl() else { return nil }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, let base = URL(string: trimmed) else { return nil }
        if let host = base.host, LoopbackHost.isLoopback(host) {
            return nil
        }
        return base.appendingPathComponent("__openclaw__/a2ui/").absoluteString + "?platform=ios"
    }

    func showA2UIOnConnectIfNeeded() async {
        let current = self.screen.urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        if current.isEmpty || current == self.lastAutoA2uiURL {
            if let canvasUrl = await self.resolveCanvasHostURLWithCapabilityRefresh() {
                self.screen.navigate(to: canvasUrl)
                self.lastAutoA2uiURL = canvasUrl
            } else {
                self.lastAutoA2uiURL = nil
                self.screen.showDefaultCanvas()
            }
        }
    }

    func ensureA2UIReadyWithCapabilityRefresh(timeoutMs: Int = 5000) async -> String? {
        guard let initialUrl = await self.resolveA2UIHostURLWithCapabilityRefresh() else { return nil }
        self.screen.navigate(to: initialUrl)
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return initialUrl
        }

        // First render can fail when scoped capability rotates between reconnects.
        guard await self.gatewaySession.refreshNodeCanvasCapability() else { return nil }
        guard let refreshedUrl = await self.resolveA2UIHostURL() else { return nil }
        self.screen.navigate(to: refreshedUrl)
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return refreshedUrl
        }
        return nil
    }

    func showLocalCanvasOnDisconnect() {
        self.lastAutoA2uiURL = nil
        self.screen.showDefaultCanvas()
    }

    private func resolveA2UIHostURLWithCapabilityRefresh() async -> String? {
        if let url = await self.resolveA2UIHostURL() {
            return url
        }
        guard await self.gatewaySession.refreshNodeCanvasCapability() else { return nil }
        return await self.resolveA2UIHostURL()
    }

    private func resolveCanvasHostURLWithCapabilityRefresh() async -> String? {
        if let url = await self.resolveCanvasHostURL() {
            return url
        }
        guard await self.gatewaySession.refreshNodeCanvasCapability() else { return nil }
        return await self.resolveCanvasHostURL()
    }
}
