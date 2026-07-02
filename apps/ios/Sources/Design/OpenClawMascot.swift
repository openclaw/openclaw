import SwiftUI

// MARK: - Mascot Size Scale

/// Predefined mascot sizes from the iOS style guide.
/// Minimum rendered size is 20pt; never use the mascot smaller than `.inline`.
enum OpenClawMascotScale {
    case hero // 96pt
    case emptyState // 64pt
    case sheet // 44pt
    case section // 32pt
    case nav // 24pt
    case inline // 20pt

    var points: CGFloat {
        switch self {
        case .hero: 96
        case .emptyState: 64
        case .sheet: 44
        case .section: 32
        case .nav: 24
        case .inline: 20
        }
    }
}

// MARK: - Mascot View

/// The OpenClaw mascot rendered from the `OpenClawMascot` asset catalog entry.
/// Use predefined scale tiers or pass a custom `size`.
struct OpenClawMascot: View {
    var scale: OpenClawMascotScale?
    var size: CGFloat?
    var shadow: Bool = true

    private var resolvedSize: CGFloat {
        self.size ?? self.scale?.points
            ?? OpenClawMascotScale.section.points
    }

    private var shadowRadius: CGFloat {
        self.resolvedSize * 0.22
    }

    var body: some View {
        Image("OpenClawMascot")
            .resizable()
            .scaledToFit()
            .frame(
                width: self.resolvedSize,
                height: self.resolvedSize)
            .modifier(MascotShadowModifier(
                enabled: self.shadow,
                radius: self.shadowRadius))
            .accessibilityLabel("OpenClaw")
    }
}

private struct MascotShadowModifier: ViewModifier {
    let enabled: Bool
    let radius: CGFloat

    func body(content: Content) -> some View {
        if self.enabled {
            content.shadow(
                color: OpenClawBrand.accent.opacity(0.18),
                radius: self.radius,
                y: self.radius / 3)
        } else {
            content
        }
    }
}
