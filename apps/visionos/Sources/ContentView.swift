//
//  ContentView.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//

import SwiftUI

struct ContentView: View {

    @EnvironmentObject var nodeManager: NodeManager
    @Environment(\.openImmersiveSpace) var openImmersiveSpace
    @Environment(\.dismissImmersiveSpace) var dismissImmersiveSpace

    var body: some View {
        VStack(spacing: 24) {

            // Header
            VStack(spacing: 8) {
                Text("OpenClaw Node")
                    .font(.largeTitle.bold())
                Text("visionOS Peripheral")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }

            Divider()

            // Connection status
            ConnectionStatusView()
                .environmentObject(nodeManager)

            Divider()

            // Gateway config
            GatewayConfigView()
                .environmentObject(nodeManager)

            Divider()

            // ImmersiveSpace toggle — keeping this active keeps the node alive
            VStack(spacing: 12) {
                Label("Node Active Space", systemImage: "circle.hexagongrid.fill")
                    .font(.headline)

                Text("The immersive space must stay open to maintain the Gateway connection. Closing it will disconnect the node.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .multilineTextAlignment(.center)

                Toggle(nodeManager.immersiveSpaceActive ? "Space Active ✓" : "Open Node Space",
                       isOn: Binding(
                        get: { nodeManager.immersiveSpaceActive },
                        set: { shouldOpen in
                            Task {
                                if shouldOpen {
                                    await openImmersiveSpace(id: "NodeSpace")
                                } else {
                                    await dismissImmersiveSpace()
                                }
                            }
                        }
                       ))
                .toggleStyle(.button)
                .tint(nodeManager.immersiveSpaceActive ? .green : .blue)
            }
        }
        .padding(32)
        .frame(minWidth: 500, minHeight: 600)
        .onAppear {
            // Connection is owned by the app window lifecycle, not the ImmersiveSpace.
            // Auto-connect on first appear if config is set.
            if !nodeManager.gatewayURL.isEmpty && !nodeManager.isSocketConnected {
                Task { await nodeManager.connect() }
            }
        }
    }
}

#Preview(windowStyle: .automatic) {
    ContentView()
        .environmentObject(NodeManager())
}
