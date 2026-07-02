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

// MARK: - Mascot Badge

/// Status badge tones matching the semantic color palette.
enum OpenClawMascotBadgeTone {
    case connected
    case pending
    case error
    case info
    case agent
    case skill
    case offline
    case attention

    var color: Color {
        switch self {
        case .connected: OpenClawBrand.ok
        case .pending: OpenClawBrand.warn
        case .error: OpenClawBrand.danger
        case .info: OpenClawBrand.info
        case .agent: OpenClawBrand.teal
        case .skill:
            Color(red: 0.655, green: 0.545, blue: 0.98)
        case .offline: OpenClawBrand.textTertiary
        case .attention: OpenClawBrand.accent
        }
    }

    var symbol: String {
        switch self {
        case .connected: "checkmark"
        case .pending: "clock"
        case .error: "xmark"
        case .info: "arrow.up.right"
        case .agent: "sparkle"
        case .skill: "puzzlepiece.extension"
        case .offline: "minus"
        case .attention: "exclamationmark"
        }
    }
}

/// Mascot with a semantic status badge overlay in the bottom-right corner.
struct OpenClawMascotBadge: View {
    var scale: OpenClawMascotScale = .sheet
    var tone: OpenClawMascotBadgeTone

    private var mascotSize: CGFloat {
        self.scale.points
    }

    private var badgeSize: CGFloat {
        max(self.mascotSize * 0.38, 16)
    }

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            RoundedRectangle(
                cornerRadius: self.mascotSize * 0.28,
                style: .continuous)
                .fill(OpenClawBrand.slate)
                .frame(
                    width: self.mascotSize * 1.2,
                    height: self.mascotSize * 1.2)
                .overlay {
                    OpenClawMascot(
                        scale: self.scale,
                        shadow: false)
                }

            Image(systemName: self.tone.symbol)
                .font(.system(
                    size: self.badgeSize * 0.48,
                    weight: .bold))
                .foregroundStyle(.white)
                .frame(
                    width: self.badgeSize,
                    height: self.badgeSize)
                .background(self.tone.color, in: Circle())
                .shadow(
                    color: self.tone.color.opacity(0.4),
                    radius: 4,
                    y: 2)
                .offset(x: 2, y: 2)
        }
    }
}

// MARK: - Ghost Mascot

/// Reduced-opacity mascot for watermarks and empty-state backgrounds.
struct OpenClawMascotGhost: View {
    var scale: OpenClawMascotScale = .emptyState

    var body: some View {
        OpenClawMascot(scale: self.scale, shadow: false)
            .opacity(0.15)
    }
}
