import SwiftUI

// MARK: - Background modifier (OS-adaptive)

/// Applies Liquid Glass on iOS 26+ or a manual material/stroke/shadow on iOS 18–25.
/// Kept separate so the padding in `StatusGlassCardModifier` is written exactly once.
///
/// Note: `glassEffect(_:in:)` is available in the iOS 26 SDK (Xcode 26+). The
/// `#available(iOS 26, *)` check is a *runtime* gate; at compile time the symbol must
/// exist in the SDK being used. This file builds correctly when the project is built
/// with Xcode 26+ (which ships the iOS 26 SDK). Building with Xcode 16 / iOS 18 SDK
/// would require removing or wrapping the iOS 26 branch — document this as a
/// minimum toolchain requirement for this feature.
private struct StatusGlassBackgroundModifier: ViewModifier {
    @Environment(\.colorSchemeContrast) private var contrast
    let brighten: Bool

    func body(content: Content) -> some View {
        if #available(iOS 26, *) {
            // iOS 26+: native Liquid Glass — the framework handles translucency,
            // vibrancy, and color adaptation automatically.
            // The `brighten` hint is not needed on iOS 26.
            content
                .glassEffect(
                    .regular,
                    in: RoundedRectangle(cornerRadius: 14, style: .continuous)
                )
        } else {
            // iOS 18–25: manual material + stroke border + shadow.
            content
                .background {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(.ultraThinMaterial)
                        .overlay {
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .strokeBorder(
                                    .white.opacity(self.contrast == .increased ? 0.5 : (self.brighten ? 0.24 : 0.18)),
                                    lineWidth: self.contrast == .increased ? 1.0 : 0.5
                                )
                        }
                        .shadow(color: .black.opacity(0.25), radius: 12, y: 6)
                }
        }
    }
}

// MARK: - Card modifier

private struct StatusGlassCardModifier: ViewModifier {
    let brighten: Bool
    let verticalPadding: CGFloat
    let horizontalPadding: CGFloat

    func body(content: Content) -> some View {
        content
            .padding(.vertical, self.verticalPadding)
            .padding(.horizontal, self.horizontalPadding)
            .modifier(StatusGlassBackgroundModifier(brighten: self.brighten))
    }
}

// MARK: - View extension

extension View {
    func statusGlassCard(brighten: Bool, verticalPadding: CGFloat, horizontalPadding: CGFloat = 12) -> some View {
        self.modifier(
            StatusGlassCardModifier(
                brighten: brighten,
                verticalPadding: verticalPadding,
                horizontalPadding: horizontalPadding
            )
        )
    }
}
