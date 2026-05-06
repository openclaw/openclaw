//
//  GatewayConfigView.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//

import SwiftUI

struct GatewayConfigView: View {

    @EnvironmentObject var nodeManager: NodeManager
    @State private var showToken = false

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {

            Text("Gateway Config")
                .font(.headline)

            // Gateway URL
            VStack(alignment: .leading, spacing: 6) {
                Text("Gateway URL")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                TextField("your-gateway-host.ts.net", text: $nodeManager.gatewayURL)
                    .textFieldStyle(.roundedBorder)
                    .autocorrectionDisabled()
                    .textInputAutocapitalization(.never)
            }

            // Auth token
            VStack(alignment: .leading, spacing: 6) {
                Text("Auth Token")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                HStack {
                    if showToken {
                        TextField("Token", text: $nodeManager.gatewayToken)
                            .textFieldStyle(.roundedBorder)
                            .autocorrectionDisabled()
                            .textInputAutocapitalization(.never)
                    } else {
                        SecureField("Token", text: $nodeManager.gatewayToken)
                            .textFieldStyle(.roundedBorder)
                    }
                    Button {
                        showToken.toggle()
                    } label: {
                        Image(systemName: showToken ? "eye.slash" : "eye")
                    }
                    .buttonStyle(.plain)
                }
            }

            // Save + Connect buttons
            HStack(spacing: 12) {
                Button("Save") {
                    nodeManager.saveConfig()
                }
                .buttonStyle(.bordered)

                Spacer()

                if nodeManager.connectionState == .connected {
                    Button("Disconnect") {
                        nodeManager.disconnect()
                    }
                    .buttonStyle(.bordered)
                    .tint(.red)
                } else {
                    Button("Connect") {
                        nodeManager.saveConfig()
                        Task { await nodeManager.connect() }
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(nodeManager.gatewayURL.isEmpty || nodeManager.connectionState == .connecting)
                }
            }
        }
    }
}
