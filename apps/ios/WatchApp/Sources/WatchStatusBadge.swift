import SwiftUI

struct WatchStatusBadge: View {
    enum Status {
        case connected
        case disconnected
        case pending

        var label: String {
            switch self {
            case .connected: "Connected"
            case .disconnected: "Disconnected"
            case .pending: "Pending"
            }
        }

        var icon: String {
            switch self {
            case .connected: "checkmark.circle.fill"
            case .disconnected: "xmark.circle.fill"
            case .pending: "clock.fill"
            }
        }

        var tint: Color {
            switch self {
            case .connected: .green
            case .disconnected: .red
            case .pending: .orange
            }
        }
    }

    let status: Status

    var body: some View {
        HStack(spacing: WatchDesignTokens.spacingXS) {
            Image(systemName: status.icon)
                .font(WatchDesignTokens.fontBadge)
            Text(status.label)
                .font(WatchDesignTokens.fontBadge)
        }
        .padding(.horizontal, WatchDesignTokens.spacingSM)
        .padding(.vertical, WatchDesignTokens.spacingXS)
        .clipShape(Capsule())
        .glassEffect(.regular.tint(status.tint))
        .accessibilityLabel(status.label)
    }
}
