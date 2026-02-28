import SwiftUI

struct WatchRiskBadge: View {
    let risk: String?

    private var normalizedRisk: String {
        risk?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    }

    private var icon: String {
        switch normalizedRisk {
        case "high": "exclamationmark.triangle.fill"
        case "medium": "info.circle.fill"
        default: "shield.fill"
        }
    }

    private var label: String {
        switch normalizedRisk {
        case "high": "High Risk"
        case "medium": "Medium Risk"
        default: "Low Risk"
        }
    }

    /// Optional tint color; nil means neutral glass.
    private var tintColor: Color? {
        switch normalizedRisk {
        case "high": .red
        case "medium": .orange
        default: nil
        }
    }

    var body: some View {
        HStack(spacing: WatchDesignTokens.spacingXS) {
            Image(systemName: icon)
                .font(WatchDesignTokens.fontBadge)
            Text(label)
                .font(WatchDesignTokens.fontBadge)
        }
        .padding(.horizontal, WatchDesignTokens.spacingSM)
        .padding(.vertical, WatchDesignTokens.spacingXS)
        .clipShape(Capsule())
        .modifier(RiskGlassModifier(tint: tintColor))
        .accessibilityLabel(label)
    }
}

/// Applies tinted or neutral glass depending on risk level.
private struct RiskGlassModifier: ViewModifier {
    let tint: Color?

    func body(content: Content) -> some View {
        if let tint {
            content.glassEffect(.regular.tint(tint))
        } else {
            content.glassEffect(.regular)
        }
    }
}
