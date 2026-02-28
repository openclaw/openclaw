import SwiftUI

struct WatchMessageCard: View {
    let title: String
    let body: String
    var details: String?
    var risk: String?
    var isExpired: Bool = false

    @State private var appeared = false

    var body: some View {
        VStack(alignment: .leading, spacing: WatchDesignTokens.spacingSM) {
            if let risk, !risk.isEmpty {
                WatchRiskBadge(risk: risk)
            }

            Text(title)
                .font(WatchDesignTokens.fontTitle)
                .lineLimit(2)

            Text(self.body)
                .font(WatchDesignTokens.fontBody)
                .fixedSize(horizontal: false, vertical: true)

            if let details, !details.isEmpty {
                Text(details)
                    .font(WatchDesignTokens.fontCaption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if isExpired {
                Text("Expired")
                    .font(WatchDesignTokens.fontBadge)
                    .foregroundStyle(.tertiary)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(WatchDesignTokens.spacingMD)
        .glassEffect(.regular)
        .opacity(appeared ? 1 : 0)
        .scaleEffect(appeared ? 1 : 0.95)
        .onAppear {
            withAnimation(WatchDesignTokens.spring) {
                appeared = true
            }
        }
    }
}
