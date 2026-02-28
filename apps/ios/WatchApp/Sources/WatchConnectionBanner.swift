import SwiftUI

struct WatchConnectionBanner: View {
    let isConnected: Bool

    @State private var visible = true

    private var icon: String {
        isConnected ? "antenna.radiowaves.left.and.right" : "antenna.radiowaves.left.and.right.slash"
    }

    private var label: String {
        isConnected ? "Connected" : "Disconnected"
    }

    private var tint: Color {
        isConnected ? .green : .red
    }

    var body: some View {
        if visible {
            HStack(spacing: WatchDesignTokens.spacingXS) {
                Image(systemName: icon)
                    .font(WatchDesignTokens.fontBadge)
                Text(label)
                    .font(WatchDesignTokens.fontBadge)
            }
            .padding(.horizontal, WatchDesignTokens.spacingSM)
            .padding(.vertical, WatchDesignTokens.spacingXS)
            .frame(maxWidth: .infinity)
            .glassEffect(.regular.tint(tint))
            .transition(.opacity)
            .onChange(of: isConnected) { _, connected in
                if connected {
                    // Auto-hide after brief delay when connected
                    Task { @MainActor in
                        try? await Task.sleep(for: .seconds(WatchDesignTokens.bannerAutoDismiss))
                        withAnimation(WatchDesignTokens.spring) {
                            visible = false
                        }
                    }
                } else {
                    withAnimation(WatchDesignTokens.spring) {
                        visible = true
                    }
                }
            }
            .accessibilityLabel(label)
        }
    }
}
