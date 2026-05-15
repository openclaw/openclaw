import AppKit
import CoreGraphics
import Foundation

@MainActor
enum AmbientAssistantLayerService {
    static func makeSnapshot() async -> AmbientAssistantSurfaceSnapshot {
        var snapshot = AmbientAssistantSurfaceSnapshot.default
        let sessionKey = await GatewayConnection.shared.mainSessionKey()
        snapshot.context.sessionLabel = "\(sessionKey) session"
        snapshot.context.gatewayLabel = "Gateway local"
        snapshot.context.frontApp = NSWorkspace.shared.frontmostApplication?.localizedName ?? "Current app"
        snapshot.context.permissionSummaries = [
            CGPreflightScreenCaptureAccess() ? "Screen: granted" : "Screen: optional",
            AXIsProcessTrusted() ? "Accessibility: granted" : "Accessibility: optional",
        ]

        let work = WorkActivityStore.shared.current
        snapshot.status = AmbientAssistantLaneItem(
            id: "status",
            title: "Thomas",
            detail: work?.label ?? "Ready for a prompt or slash command",
            tone: work == nil ? .ready : .working)
        snapshot.context.confidenceLabel = work == nil ? "Local context" : "Live work"

        return snapshot
    }
}
