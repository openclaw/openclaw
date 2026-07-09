import SwiftUI

/// Animated OpenClaw mascot. Redraws the canonical 120x120 vector from
/// `ui/public/favicon.svg` so individual parts (claws, antennae, eyes) can
/// animate like the openclaw.ai hero mark; the bundled PNG asset cannot.
/// Styling (palette, glow colors, float depth) follows the openclaw.ai hero
/// (`src/pages/index.astro` + `Layout.astro` theme variables).
public struct OpenClawMascotView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @Environment(\.colorScheme) private var colorScheme

    private let floats: Bool

    public init(floats: Bool = true) {
        self.floats = floats
    }

    public var body: some View {
        let palette = OpenClawMascotPalette.forScheme(self.colorScheme)
        if self.reduceMotion {
            OpenClawMascotCanvas(pose: .still, palette: palette)
        } else {
            TimelineView(.animation(minimumInterval: 1.0 / 30.0)) { timeline in
                let pose = OpenClawMascotPose.at(time: timeline.date.timeIntervalSinceReferenceDate)
                // Float translates the whole canvas like the site floats the hero
                // container; drawing the offset inside the canvas would clip the
                // antennae (art starts at y~5 of 120) at the -9.6 float peak.
                GeometryReader { proxy in
                    OpenClawMascotCanvas(pose: pose, palette: palette)
                        .offset(
                            y: self.floats
                                ? pose.floatOffset * min(proxy.size.width, proxy.size.height) / 120
                                : 0)
                }
            }
        }
    }

    /// openclaw.ai hero drop-shadow color (`--logo-glow` / `--logo-glow-hover`).
    /// Pair with a shadow radius of ~10% of the mascot size (15% while hovering)
    /// to match the site's `drop-shadow(0 0 20px)` on a 100px mark.
    public static func heroGlowColor(for colorScheme: ColorScheme, hovering: Bool = false) -> Color {
        switch (colorScheme, hovering) {
        case (.light, false): Color(red: 239 / 255, green: 75 / 255, blue: 88 / 255).opacity(0.2)
        case (.light, true): Color(red: 0, green: 143 / 255, blue: 135 / 255).opacity(0.35)
        case (_, false): Color(red: 1, green: 77 / 255, blue: 77 / 255).opacity(0.4)
        case (_, true): Color(red: 0, green: 229 / 255, blue: 204 / 255).opacity(0.6)
        }
    }
}

/// Body/antenna colors from the openclaw.ai theme variables: `:root` (dark)
/// and `html[data-theme='light']` in `Layout.astro`. Eye colors are fixed in
/// the site markup and shared by both themes.
struct OpenClawMascotPalette: Equatable {
    let gradientTop: Color
    let gradientBottom: Color
    let antenna: Color

    static let dark = OpenClawMascotPalette(
        gradientTop: Color(red: 1, green: 77 / 255, blue: 77 / 255),
        gradientBottom: Color(red: 153 / 255, green: 27 / 255, blue: 27 / 255),
        antenna: Color(red: 1, green: 77 / 255, blue: 77 / 255))

    static let light = OpenClawMascotPalette(
        gradientTop: Color(red: 255 / 255, green: 112 / 255, blue: 121 / 255),
        gradientBottom: Color(red: 234 / 255, green: 76 / 255, blue: 89 / 255),
        antenna: Color(red: 239 / 255, green: 75 / 255, blue: 88 / 255))

    static func forScheme(_ colorScheme: ColorScheme) -> OpenClawMascotPalette {
        colorScheme == .light ? .light : .dark
    }
}

/// Part transforms for one animation frame. Mirrors the openclaw.ai CSS
/// keyframes: float 4s, antenna wiggle 2s, eye blink 3s, claw snap 4s with
/// the right claw trailing by 0.2s.
struct OpenClawMascotPose: Equatable {
    var floatOffset: CGFloat = 0
    var antennaDegrees: CGFloat = 0
    var leftClawDegrees: CGFloat = 0
    var rightClawDegrees: CGFloat = 0
    var eyeGlowOpacity: CGFloat = 1

    static let still = OpenClawMascotPose()

    static func at(time: TimeInterval) -> OpenClawMascotPose {
        // Float depth matches the hero: -8px on a 100px mark = 8% of the 120 box.
        OpenClawMascotPose(
            floatOffset: -4.8 * (1 - cos(2 * .pi * self.cyclePhase(time, period: 4))),
            antennaDegrees: -3 * sin(2 * .pi * self.cyclePhase(time, period: 2)),
            leftClawDegrees: self.clawSnapDegrees(phase: self.cyclePhase(time, period: 4)),
            rightClawDegrees: self.clawSnapDegrees(phase: self.cyclePhase(time - 0.2, period: 4)),
            eyeGlowOpacity: self.blinkOpacity(phase: self.cyclePhase(time, period: 3)))
    }

    private static func cyclePhase(_ time: TimeInterval, period: TimeInterval) -> CGFloat {
        let normalized = (time / period).truncatingRemainder(dividingBy: 1)
        return CGFloat(normalized < 0 ? normalized + 1 : normalized)
    }

    private static func clawSnapDegrees(phase: CGFloat) -> CGFloat {
        // 0deg until 85%, snap to -8deg at 90%, back to 0deg at 95%, hold.
        if phase < 0.85 || phase >= 0.95 {
            return 0
        }
        if phase < 0.9 {
            return -8 * self.easeInOut((phase - 0.85) / 0.05)
        }
        return -8 * (1 - self.easeInOut((phase - 0.9) / 0.05))
    }

    private static func blinkOpacity(phase: CGFloat) -> CGFloat {
        // Full glow until 90%, dip to 0.3 at 95%, recover by 100%.
        if phase < 0.9 {
            return 1
        }
        let dip = phase < 0.95 ? self.easeInOut((phase - 0.9) / 0.05) : 1 - self.easeInOut((phase - 0.95) / 0.05)
        return 1 - 0.7 * dip
    }

    private static func easeInOut(_ t: CGFloat) -> CGFloat {
        let clamped = min(max(t, 0), 1)
        return clamped * clamped * (3 - 2 * clamped)
    }
}

private struct OpenClawMascotCanvas: View {
    let pose: OpenClawMascotPose
    let palette: OpenClawMascotPalette

    var body: some View {
        Canvas { context, size in
            Self.draw(context: &context, size: size, pose: self.pose, palette: self.palette)
        }
        .accessibilityHidden(true)
    }

    // Geometry below is the favicon.svg path data in its native 120x120 space.
    private static let eyeColor = Color(red: 5 / 255, green: 8 / 255, blue: 16 / 255)
    private static let eyeGlowColor = Color(red: 0, green: 229 / 255, blue: 204 / 255)
    // Rotation pivots: claws hinge on their body-facing edge, antennae on their own center.
    private static let leftClawPivot = CGPoint(x: 26, y: 53)
    private static let rightClawPivot = CGPoint(x: 94, y: 53)
    private static let leftAntennaPivot = CGPoint(x: 37.5, y: 11)
    private static let rightAntennaPivot = CGPoint(x: 82.5, y: 11)

    private static let bodyPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 60, y: 10))
        path.addCurve(to: CGPoint(x: 15, y: 55), control1: CGPoint(x: 30, y: 10), control2: CGPoint(x: 15, y: 35))
        path.addCurve(to: CGPoint(x: 45, y: 100), control1: CGPoint(x: 15, y: 75), control2: CGPoint(x: 30, y: 95))
        path.addLine(to: CGPoint(x: 45, y: 110))
        path.addLine(to: CGPoint(x: 55, y: 110))
        path.addLine(to: CGPoint(x: 55, y: 100))
        path.addCurve(to: CGPoint(x: 65, y: 100), control1: CGPoint(x: 55, y: 100), control2: CGPoint(x: 60, y: 102))
        path.addLine(to: CGPoint(x: 65, y: 110))
        path.addLine(to: CGPoint(x: 75, y: 110))
        path.addLine(to: CGPoint(x: 75, y: 100))
        path.addCurve(to: CGPoint(x: 105, y: 55), control1: CGPoint(x: 90, y: 95), control2: CGPoint(x: 105, y: 75))
        path.addCurve(to: CGPoint(x: 60, y: 10), control1: CGPoint(x: 105, y: 35), control2: CGPoint(x: 90, y: 10))
        path.closeSubpath()
        return path
    }()

    private static let leftClawPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 20, y: 45))
        path.addCurve(to: CGPoint(x: 5, y: 60), control1: CGPoint(x: 5, y: 40), control2: CGPoint(x: 0, y: 50))
        path.addCurve(to: CGPoint(x: 25, y: 55), control1: CGPoint(x: 10, y: 70), control2: CGPoint(x: 20, y: 65))
        path.addCurve(to: CGPoint(x: 20, y: 45), control1: CGPoint(x: 28, y: 48), control2: CGPoint(x: 25, y: 45))
        path.closeSubpath()
        return path
    }()

    private static let rightClawPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 100, y: 45))
        path.addCurve(to: CGPoint(x: 115, y: 60), control1: CGPoint(x: 115, y: 40), control2: CGPoint(x: 120, y: 50))
        path.addCurve(to: CGPoint(x: 95, y: 55), control1: CGPoint(x: 110, y: 70), control2: CGPoint(x: 100, y: 65))
        path.addCurve(to: CGPoint(x: 100, y: 45), control1: CGPoint(x: 92, y: 48), control2: CGPoint(x: 95, y: 45))
        path.closeSubpath()
        return path
    }()

    private static let leftAntennaPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 45, y: 15))
        path.addQuadCurve(to: CGPoint(x: 30, y: 8), control: CGPoint(x: 35, y: 5))
        return path
    }()

    private static let rightAntennaPath: Path = {
        var path = Path()
        path.move(to: CGPoint(x: 75, y: 15))
        path.addQuadCurve(to: CGPoint(x: 90, y: 8), control: CGPoint(x: 85, y: 5))
        return path
    }()

    private static func draw(
        context: inout GraphicsContext,
        size: CGSize,
        pose: OpenClawMascotPose,
        palette: OpenClawMascotPalette)
    {
        let scale = min(size.width, size.height) / 120
        context.scaleBy(x: scale, y: scale)

        // Site antennae: stroke-width 2, `--coral-bright`.
        let antennaStroke = StrokeStyle(lineWidth: 2, lineCap: .round)

        // Same paint order as favicon.svg: body, claws, antennae, eyes.
        context.fill(self.bodyPath, with: self.gradient(for: self.bodyPath, palette: palette))
        self.drawRotated(context: context, degrees: pose.leftClawDegrees, pivot: self.leftClawPivot) {
            $0.fill(self.leftClawPath, with: self.gradient(for: self.leftClawPath, palette: palette))
        }
        self.drawRotated(context: context, degrees: pose.rightClawDegrees, pivot: self.rightClawPivot) {
            $0.fill(self.rightClawPath, with: self.gradient(for: self.rightClawPath, palette: palette))
        }
        self.drawRotated(context: context, degrees: pose.antennaDegrees, pivot: self.leftAntennaPivot) {
            $0.stroke(self.leftAntennaPath, with: .color(palette.antenna), style: antennaStroke)
        }
        self.drawRotated(context: context, degrees: pose.antennaDegrees, pivot: self.rightAntennaPivot) {
            $0.stroke(self.rightAntennaPath, with: .color(palette.antenna), style: antennaStroke)
        }

        context.fill(Path(ellipseIn: CGRect(x: 39, y: 29, width: 12, height: 12)), with: .color(self.eyeColor))
        context.fill(Path(ellipseIn: CGRect(x: 69, y: 29, width: 12, height: 12)), with: .color(self.eyeColor))
        var glowContext = context
        glowContext.opacity = pose.eyeGlowOpacity
        glowContext.fill(
            Path(ellipseIn: CGRect(x: 44, y: 32, width: 4, height: 4)),
            with: .color(self.eyeGlowColor))
        glowContext.fill(
            Path(ellipseIn: CGRect(x: 74, y: 32, width: 4, height: 4)),
            with: .color(self.eyeGlowColor))
    }

    /// SVG gradients default to objectBoundingBox units, so the body and each
    /// claw span the full top-left -> bottom-right ramp across their own bounds;
    /// one canvas-wide gradient would leave the claws nearly flat-colored.
    private static func gradient(
        for path: Path,
        palette: OpenClawMascotPalette) -> GraphicsContext.Shading
    {
        let box = path.boundingRect
        return .linearGradient(
            Gradient(colors: [palette.gradientTop, palette.gradientBottom]),
            startPoint: box.origin,
            endPoint: CGPoint(x: box.maxX, y: box.maxY))
    }

    private static func drawRotated(
        context: GraphicsContext,
        degrees: CGFloat,
        pivot: CGPoint,
        draw: (inout GraphicsContext) -> Void)
    {
        var rotated = context
        rotated.translateBy(x: pivot.x, y: pivot.y)
        rotated.rotate(by: .degrees(degrees))
        rotated.translateBy(x: -pivot.x, y: -pivot.y)
        draw(&rotated)
    }
}
