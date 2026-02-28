import SwiftUI

struct WatchEmptyStateView: View {
    @State private var isPulsing = false

    var body: some View {
        VStack(spacing: WatchDesignTokens.spacingMD) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
                .symbolEffect(.pulse, options: .repeating, value: isPulsing)

            Text("Waiting for messages")
                .font(WatchDesignTokens.fontCaption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .onAppear {
            isPulsing = true
        }
    }
}
