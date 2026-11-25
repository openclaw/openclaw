import SwiftUI

/// The offline recovery entrypoint stays usable before a Gateway can serve the dashboard.
struct GatewayInstallerView: View {
    let status: GatewayEnvironmentStatus
    let failure: String?
    let existingGatewayDetails: String?
    let isInstalling: Bool
    let installStatus: String?
    let onInstall: () -> Void
    let onRecheck: () -> Void

    var body: some View {
        LabeledContent {
            HStack {
                if self.isInstalling {
                    ProgressView().controlSize(.small)
                }
                if let title = self.recoveryTitle {
                    Button(title, action: self.onInstall)
                        .accessibilityIdentifier("gateway-install-recovery")
                }
                Button("Recheck", action: self.onRecheck)
            }
            .disabled(self.isInstalling)
        } label: {
            HStack(spacing: 8) {
                Circle()
                    .fill(self.statusColor)
                    .frame(width: 8, height: 8)
                Text(self.status.message)
            }
            if let detail = self.detail {
                Text(detail)
            }
            if let installStatus {
                Text(installStatus)
            } else if let failure {
                Text(String(format: String(localized: "Last failure: %@"), failure))
                    .foregroundStyle(.red)
            }
        }
    }

    private var recoveryTitle: String? {
        switch self.status.kind {
        case .missingNode, .missingGateway:
            String(localized: "Install Gateway…")
        case let .incompatible(found, required):
            if CLIInstallPrompter.isManagedUpgrade(found: found, required: required) {
                String(localized: "Update Gateway…")
            } else {
                String(localized: "Set Up Gateway…")
            }
        case .error:
            String(localized: "Repair Gateway…")
        case .ok, .checking:
            nil
        }
    }

    private var statusColor: Color {
        if self.failure != nil { return .red }
        switch self.status.kind {
        case .ok: return .green
        case .checking: return .secondary
        case .missingNode, .missingGateway, .incompatible, .error: return .orange
        }
    }

    private var detail: String? {
        var parts: [String] = []
        if let gatewayVersion = self.status.gatewayVersion,
           let required = self.status.requiredGateway,
           gatewayVersion != required
        {
            parts.append(String(
                format: String(localized: "Installed: %@ · Required: %@"), gatewayVersion, required))
        } else if let gatewayVersion = self.status.gatewayVersion {
            parts.append(String(format: String(localized: "Gateway %@ detected"), gatewayVersion))
        }
        if let node = self.status.nodeVersion {
            parts.append("Node \(node)")
        }
        if let existingGatewayDetails {
            parts.append(existingGatewayDetails)
        }
        return parts.isEmpty ? nil : parts.joined(separator: " · ")
    }
}
