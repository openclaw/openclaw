//
//  ScenePhaseMonitor.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  Observes scenePhase changes and forwards them to NodeManager.
//  Does NOT disconnect on background — the ImmersiveSpace keeps the
//  WebSocket alive. Only updates isBackgrounded so RPC dispatch can
//  return NODE_BACKGROUND_UNAVAILABLE for camera/canvas commands.
//

import SwiftUI

struct ScenePhaseMonitor: ViewModifier {

    let nodeManager: NodeManager
    @Environment(\.scenePhase) private var scenePhase

    func body(content: Content) -> some View {
        content
            .onChange(of: scenePhase) { _, newPhase in
                switch newPhase {
                case .background:
                    nodeManager.isBackgrounded = true
                    nodeManager.onBackground()
                case .active:
                    nodeManager.isBackgrounded = false
                    nodeManager.onForeground()
                case .inactive:
                    break // Transitional state — no action
                @unknown default:
                    break
                }
            }
    }
}

extension View {
    func scenePhaseMonitor(nodeManager: NodeManager) -> some View {
        modifier(ScenePhaseMonitor(nodeManager: nodeManager))
    }
}
