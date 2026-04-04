import AppKit
import SwiftUI

enum AppleParallaxMotion {
    static func collapseProgress(for minY: CGFloat, range: CGFloat) -> CGFloat {
        let travel = max(0, -minY)
        return min(1, travel / max(range, 1))
    }

    static func lagOffset(for minY: CGFloat, factor: CGFloat, limit: CGFloat) -> CGFloat {
        let value = max(0, -minY) * factor
        return min(limit, value)
    }

    static func stretchScale(for minY: CGFloat, factor: CGFloat = 0.0007, limit: CGFloat = 0.03) -> CGFloat {
        guard minY > 0 else { return 1 }
        return 1 + min(limit, minY * factor)
    }
}

struct AppleGlassParallaxHero<Content: View>: View {
    let coordinateSpace: String
    let height: CGFloat
    let cornerRadius: CGFloat
    let accent: Color
    let secondaryAccent: Color
    let content: () -> Content

    init(
        coordinateSpace: String,
        height: CGFloat = 320,
        cornerRadius: CGFloat = 34,
        accent: Color = .accentColor,
        secondaryAccent: Color = Color(nsColor: .systemTeal),
        @ViewBuilder content: @escaping () -> Content)
    {
        self.coordinateSpace = coordinateSpace
        self.height = height
        self.cornerRadius = cornerRadius
        self.accent = accent
        self.secondaryAccent = secondaryAccent
        self.content = content
    }

    var body: some View {
        GeometryReader { proxy in
            let minY = proxy.frame(in: .named(self.coordinateSpace)).minY
            let collapse = AppleParallaxMotion.collapseProgress(for: minY, range: self.height * 0.7)
            let contentLag = AppleParallaxMotion.lagOffset(for: minY, factor: 0.06, limit: 10)
            let backgroundLag = AppleParallaxMotion.lagOffset(for: minY, factor: 0.10, limit: 14)
            let stretch = AppleParallaxMotion.stretchScale(for: minY)

            ZStack(alignment: .top) {
                ZStack {
                    VisualEffectView(material: .underWindowBackground, blendingMode: .withinWindow, emphasized: false)

                    LinearGradient(
                        colors: [
                            Color(red: 0.97, green: 0.95, blue: 0.91).opacity(0.82),
                            Color(red: 0.95, green: 0.96, blue: 0.94).opacity(0.90),
                            Color(red: 0.91, green: 0.95, blue: 0.99).opacity(0.92),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing)

                    Ellipse()
                        .fill(Color(red: 0.98, green: 0.81, blue: 0.58).opacity(0.34))
                        .frame(width: 420, height: 286)
                        .blur(radius: 78)
                        .offset(x: -172, y: -116 + backgroundLag)

                    Ellipse()
                        .fill(self.accent.opacity(0.12))
                        .frame(width: 320, height: 232)
                        .blur(radius: 64)
                        .offset(x: -18, y: -102 + (backgroundLag * 0.48))

                    Ellipse()
                        .fill(self.secondaryAccent.opacity(0.14))
                        .frame(width: 496, height: 246)
                        .blur(radius: 94)
                        .offset(x: 126, y: 142 + (backgroundLag * 0.72))

                    Ellipse()
                        .fill(Color.white.opacity(0.56))
                        .frame(width: 332, height: 170)
                        .blur(radius: 72)
                        .offset(x: 118, y: -72 + (backgroundLag * 0.24))

                }
                .scaleEffect(stretch)
                .offset(y: -backgroundLag)

                self.content()
                    .padding(.top, 34)
                    .padding(.horizontal, 24)
                    .offset(y: contentLag)
                    .scaleEffect(1 - (collapse * 0.018))
            }
            .clipShape(RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous))
            .overlay(
                RoundedRectangle(cornerRadius: self.cornerRadius, style: .continuous)
                    .strokeBorder(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.60),
                                Color.white.opacity(0.18),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing),
                        lineWidth: 1))
            .shadow(color: Color(red: 0.44, green: 0.58, blue: 0.72).opacity(0.14), radius: 30, y: 18)
            .shadow(color: .white.opacity(0.18), radius: 12, y: -4)
        }
        .frame(height: self.height)
    }
}
