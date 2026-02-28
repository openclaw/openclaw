import SwiftUI

struct WatchEmptyStateView: View {
    var body: some View {
        VStack(spacing: WatchDesignTokens.spacingMD) {
            Image(systemName: "bubble.left.and.bubble.right")
                .font(.system(size: 32))
                .foregroundStyle(.secondary)
                .symbolEffect(.variableColor.iterative, options: .repeating)
                .accessibilityHidden(true)

            Text("Waiting for messages")
                .font(WatchDesignTokens.fontCaption)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Waiting for messages from your iPhone")
    }
}
