//
//  ConnectionStatusView.swift
//  visionOS-node
//
//  OpenClaw visionOS Node — LOAM STUDIO
//

import SwiftUI

struct ConnectionStatusView: View {

    @EnvironmentObject var nodeManager: NodeManager

    var body: some View {
        VStack(spacing: 16) {

            // State indicator
            HStack(spacing: 12) {
                Circle()
                    .fill(stateColor)
                    .frame(width: 12, height: 12)
                    .shadow(color: stateColor.opacity(0.6), radius: 4)

                Text(nodeManager.connectionState.rawValue)
                    .font(.headline)

                Spacer()

                if nodeManager.connectionState == .connected {
                    Text("ID: \(HandshakeManager.deviceID().prefix(12))…")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .monospaced()
                }
            }

            // Error message
            if let error = nodeManager.lastError {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(.red)
                    .multilineTextAlignment(.leading)
                    .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Pending approval hint
            if nodeManager.connectionState == .pending {
                VStack(alignment: .leading, spacing: 4) {
                    Text("Run on your Mac mini to approve:")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text("openclaw devices list")
                        .font(.caption)
                        .monospaced()
                        .padding(6)
                        .background(.ultraThinMaterial)
                        .cornerRadius(6)
                    Text("openclaw devices approve <id>")
                        .font(.caption)
                        .monospaced()
                        .padding(6)
                        .background(.ultraThinMaterial)
                        .cornerRadius(6)
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }

            // Log (last 8 entries)
            if !nodeManager.commandLog.isEmpty {
                ScrollView {
                    VStack(alignment: .leading, spacing: 2) {
                        ForEach(nodeManager.commandLog.suffix(8), id: \.self) { entry in
                            Text(entry)
                                .font(.caption2)
                                .monospaced()
                                .foregroundStyle(.secondary)
                        }
                    }
                    .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(height: 100)
                .padding(8)
                .background(.ultraThinMaterial)
                .cornerRadius(8)
            }
        }
    }

    private var stateColor: Color {
        switch nodeManager.connectionState {
        case .connected:    return .green
        case .connecting,
             .challenging:  return .yellow
        case .pending:      return .orange
        case .error:        return .red
        case .disconnected: return .gray
        }
    }
}
