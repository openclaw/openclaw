import Foundation
import Network
import OpenClawKit

enum A2UIReadyState {
    case ready(String)
    case hostNotConfigured
    case hostUnavailable
}

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
        await MainActor.run {
            // Keep the bundled home canvas as the default connected view.
            // Agents can still explicitly present a remote or local canvas later.
            self.lastAutoA2uiURL = nil
            self.screen.showDefaultCanvas()
        }
    }

    func ensureA2UIReadyWithCapabilityRefresh(timeoutMs: Int = 5000) async -> A2UIReadyState {
        guard let initialUrl = await self.resolveA2UIHostURLWithCapabilityRefresh() else {
            return .hostNotConfigured
        }
        self.screen.navigate(to: initialUrl)
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return .ready(initialUrl)
        }

        // First render can fail when scoped capability rotates between reconnects.
        guard await self.gatewaySession.refreshNodeCanvasCapability() else { return .hostUnavailable }
        guard let refreshedUrl = await self.resolveA2UIHostURL() else { return .hostUnavailable }
        self.screen.navigate(to: refreshedUrl)
        if await self.screen.waitForA2UIReady(timeoutMs: timeoutMs) {
            return .ready(refreshedUrl)
        }
        return .hostUnavailable
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

    private static func probeTCP(url: URL, timeoutSeconds: Double) async -> Bool {
        guard let host = url.host, !host.isEmpty else { return false }
        let portInt = url.port ?? ((url.scheme ?? "").lowercased() == "wss" ? 443 : 80)
        return await TCPProbe.probe(
            host: host,
            port: portInt,
            timeoutSeconds: timeoutSeconds,
            queueLabel: "a2ui.preflight")
    }
}
