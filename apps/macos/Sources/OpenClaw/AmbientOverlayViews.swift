import SwiftUI

struct AmbientOverlayVisualStyle: Equatable {
    let intensity: Double

    init(intensity: Double) {
        self.intensity = min(max(intensity, 0), 1)
    }

    var frameOpacity: Double { 0.2 + self.intensity * 0.34 }
    var cornerOpacity: Double { 0.28 + self.intensity * 0.36 }
    var glowOpacity: Double { 0.12 + self.intensity * 0.32 }
    var sweepOpacity: Double { 0.08 + self.intensity * 0.28 }
    var gridOpacity: Double { 0.035 + self.intensity * 0.065 }
    var lineWidth: CGFloat { 1.4 + self.intensity * 1.8 }
}

struct AmbientOverlayView: View {
    let intensity: Double

    var body: some View {
        let style = AmbientOverlayVisualStyle(intensity: self.intensity)

        ZStack {
            Color.clear

            Rectangle()
                .fill(
                    RadialGradient(
                        colors: [
                            Color.white.opacity(0),
                            Color.white.opacity(style.glowOpacity * 0.42),
                            Color.cyan.opacity(style.glowOpacity),
                        ],
                        center: .center,
                        startRadius: 260,
                        endRadius: 900))
                .blendMode(.screen)

            TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
                let phase = timeline.date.timeIntervalSinceReferenceDate
                    .truncatingRemainder(dividingBy: 7) / 7

                ZStack {
                    AmbientOverlayGrid(opacity: style.gridOpacity)
                    AmbientOverlaySweep(phase: phase, opacity: style.sweepOpacity)
                }
            }

            RoundedRectangle(cornerRadius: 28, style: .continuous)
                .strokeBorder(
                    LinearGradient(
                        colors: [
                            Color.white.opacity(style.frameOpacity),
                            Color.cyan.opacity(style.frameOpacity * 0.9),
                            Color.white.opacity(style.frameOpacity * 0.72),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing),
                    lineWidth: style.lineWidth)
                .shadow(color: Color.cyan.opacity(style.glowOpacity), radius: 30)
                .padding(10)

            AmbientOverlayCorners(opacity: style.cornerOpacity, lineWidth: style.lineWidth + 0.8)
                .padding(18)
        }
        .ignoresSafeArea()
        .allowsHitTesting(false)
    }
}

private struct AmbientOverlayGrid: View {
    let opacity: Double

    var body: some View {
        Canvas { context, size in
            var path = Path()
            let spacing: CGFloat = 96

            for x in stride(from: spacing, through: size.width, by: spacing) {
                path.move(to: CGPoint(x: x, y: 0))
                path.addLine(to: CGPoint(x: x, y: size.height))
            }
            for y in stride(from: spacing, through: size.height, by: spacing) {
                path.move(to: CGPoint(x: 0, y: y))
                path.addLine(to: CGPoint(x: size.width, y: y))
            }

            context.stroke(path, with: .color(.white.opacity(self.opacity)), lineWidth: 0.75)
        }
        .blendMode(.screen)
    }
}

private struct AmbientOverlaySweep: View {
    let phase: Double
    let opacity: Double

    var body: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width * 0.28, 220)
            let travel = proxy.size.width + width * 2

            Rectangle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.clear,
                            Color.cyan.opacity(self.opacity * 0.45),
                            Color.white.opacity(self.opacity),
                            Color.clear,
                        ],
                        startPoint: .leading,
                        endPoint: .trailing))
                .frame(width: width, height: proxy.size.height * 1.35)
                .rotationEffect(.degrees(-11))
                .offset(x: -width + travel * self.phase, y: -proxy.size.height * 0.14)
                .blur(radius: 18)
                .blendMode(.screen)
        }
    }
}

private struct AmbientOverlayCorners: View {
    let opacity: Double
    let lineWidth: CGFloat

    var body: some View {
        Canvas { context, size in
            var path = Path()
            let length = min(max(min(size.width, size.height) * 0.12, 70), 150)
            let radius: CGFloat = 20

            func corner(_ origin: CGPoint, horizontal: CGFloat, vertical: CGFloat) {
                path.move(to: CGPoint(x: origin.x + horizontal * radius, y: origin.y))
                path.addLine(to: CGPoint(x: origin.x + horizontal * length, y: origin.y))
                path.move(to: CGPoint(x: origin.x, y: origin.y + vertical * radius))
                path.addLine(to: CGPoint(x: origin.x, y: origin.y + vertical * length))
            }

            corner(CGPoint(x: 0, y: 0), horizontal: 1, vertical: 1)
            corner(CGPoint(x: size.width, y: 0), horizontal: -1, vertical: 1)
            corner(CGPoint(x: 0, y: size.height), horizontal: 1, vertical: -1)
            corner(CGPoint(x: size.width, y: size.height), horizontal: -1, vertical: -1)

            context.stroke(
                path,
                with: .linearGradient(
                    Gradient(colors: [
                        .white.opacity(self.opacity),
                        .cyan.opacity(self.opacity * 0.9),
                    ]),
                    startPoint: .zero,
                    endPoint: CGPoint(x: size.width, y: size.height)),
                style: StrokeStyle(lineWidth: self.lineWidth, lineCap: .round))
        }
        .blendMode(.screen)
    }
}

struct AmbientWorkspaceSheetView: View {
    let onClose: () -> Void

    var body: some View {
        HStack(spacing: 14) {
            VStack(alignment: .leading, spacing: 4) {
                Text("Ambient Workspace")
                    .font(.system(size: 14, weight: .semibold))
                    .foregroundStyle(.primary)

                Text("Ready")
                    .font(.system(size: 12, weight: .medium))
                    .foregroundStyle(.secondary)
            }

            Spacer(minLength: 16)

            Button(action: self.onClose) {
                Image(systemName: "xmark")
                    .font(.system(size: 12, weight: .bold))
                    .frame(width: 24, height: 24)
                    .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Close")
        }
        .padding(.horizontal, 18)
        .padding(.vertical, 14)
        .frame(width: 420, height: 86)
        .background(.regularMaterial, in: RoundedRectangle(cornerRadius: 8, style: .continuous))
        .overlay(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .strokeBorder(Color.white.opacity(0.18), lineWidth: 1))
        .shadow(color: Color.black.opacity(0.18), radius: 18, x: 0, y: 8)
    }
}
