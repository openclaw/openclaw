import SwiftUI

struct WatchConnectionBanner: View {
    let isConnected: Bool

    @State private var visible = true
    @State private var autoDismissTask: Task<Void, Never>?

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
                autoDismissTask?.cancel()
                autoDismissTask = nil
                if connected {
                    autoDismissTask = Task { @MainActor in
                        try? await Task.sleep(for: .seconds(WatchDesignTokens.bannerAutoDismiss))
                        guard !Task.isCancelled else { return }
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
            .onDisappear {
                autoDismissTask?.cancel()
                autoDismissTask = nil
            }
            .accessibilityLabel(label)
        }
    }
}
