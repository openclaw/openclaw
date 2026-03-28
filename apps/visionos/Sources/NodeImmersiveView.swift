//
//  NodeImmersiveView.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//
//  The ImmersiveSpace that keeps the node process alive.
//
//  ARCHITECTURAL NOTE:
//  visionOS suspends app processes and drops WebSocket connections
//  as soon as a standard window loses foreground priority. An active
//  ImmersiveSpace prevents process suspension — as long as this space
//  is presented, the URLSessionWebSocketTask in GatewaySocket stays alive.
//
//  This view is intentionally minimal. It renders nothing visible by default.
//  Its only job is to exist and be active.
//

import SwiftUI
import RealityKit
import ARKit

struct NodeImmersiveView: View {

    @EnvironmentObject var nodeManager: NodeManager

    var body: some View {
        RealityView { content in
            // Empty scene — no visible content required.
            // ARKit session is managed by SpatialManager, started in .task below.
        }
        .task {
            // Start ARKit data providers when the immersive space opens.
            await nodeManager.spatialManager.start()
            await nodeManager.log("ImmersiveSpace active — ARKit session started")
        }
        .onAppear {
            nodeManager.immersiveSpaceActive = true
            nodeManager.log("ImmersiveSpace opened — ARKit active")
            // Do NOT connect here — connection is managed by ContentView lifecycle.
        }
        .onDisappear {
            // ImmersiveSpace dismissed — stop ARKit, but keep the socket alive.
            // The connection is owned by the app process, not the ImmersiveSpace.
            nodeManager.immersiveSpaceActive = false
            nodeManager.spatialManager.stop()
            nodeManager.log("ImmersiveSpace dismissed — ARKit stopped, socket stays alive")
        }
    }
}
