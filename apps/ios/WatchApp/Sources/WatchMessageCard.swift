import SwiftUI

struct WatchMessageCard: View {
    let title: String
    let message: String
    var details: String?
    var risk: String?
    var isExpired: Bool = false

    @State private var appeared = false

    private var accessibilityDescription: String {
        var parts: [String] = []
        if let risk, !risk.isEmpty {
            parts.append("\(risk) risk")
        }
        parts.append(title)
        parts.append(message)
        if let details, !details.isEmpty {
            parts.append(details)
        }
        if isExpired {
            parts.append("Expired")
        }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        VStack(alignment: .leading, spacing: WatchDesignTokens.spacingSM) {
            if let risk, !risk.isEmpty {
                WatchRiskBadge(risk: risk)
            }

            Text(title)
                .font(WatchDesignTokens.fontTitle)
                .lineLimit(2)

            Text(message)
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
        .background(.fill.quaternary, in: RoundedRectangle(cornerRadius: 12))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(accessibilityDescription)
        .opacity(appeared ? 1 : 0)
        .scaleEffect(appeared ? 1 : 0.95)
        .onAppear {
            withAnimation(WatchDesignTokens.spring) {
                appeared = true
            }
        }
    }
}
