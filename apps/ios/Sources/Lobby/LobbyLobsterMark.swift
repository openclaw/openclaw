import SwiftUI

/// Original, provisional Lobby symbol; not an official OpenClaw brand asset.
struct LobbyLobsterMark: View {
    let size: CGFloat

    var body: some View {
        ZStack {
            LobbyLobsterLimbs()
                .stroke(style: StrokeStyle(lineWidth: self.size / 22, lineCap: .round, lineJoin: .round))
            LobbyLobsterShell()
                .fill()
        }
        .frame(width: self.size, height: self.size)
        .accessibilityHidden(true)
    }
}

private struct LobbyLobsterShell: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        // Open pincers, joined to the torso by the arms below.
        var claw = Path()
        claw.move(to: CGPoint(x: 5.8, y: 1.4))
        claw.addCurve(
            to: CGPoint(x: 2.4, y: 5.2),
            control1: CGPoint(x: 3.8, y: 1.4),
            control2: CGPoint(x: 1.9, y: 3.1))
        claw.addCurve(
            to: CGPoint(x: 4.9, y: 7.4),
            control1: CGPoint(x: 2.7, y: 6.6),
            control2: CGPoint(x: 3.7, y: 7.4))
        claw.addCurve(
            to: CGPoint(x: 6.9, y: 4.4),
            control1: CGPoint(x: 6.2, y: 7.2),
            control2: CGPoint(x: 7.2, y: 5.7))
        claw.addLine(to: CGPoint(x: 6.5, y: 3.2))
        claw.addLine(to: CGPoint(x: 5.4, y: 5.3))
        claw.addQuadCurve(to: CGPoint(x: 4.3, y: 4.5), control: CGPoint(x: 4.6, y: 5.4))
        claw.closeSubpath()
        path.addPath(claw)
        path.addPath(claw, transform: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 24, ty: 0))

        // A continuous, tapered body stays legible without rib-like bands at toolbar size.
        path.move(to: CGPoint(x: 12, y: 7))
        path.addCurve(
            to: CGPoint(x: 9.3, y: 11),
            control1: CGPoint(x: 10.4, y: 7),
            control2: CGPoint(x: 9.2, y: 8.4))
        path.addCurve(
            to: CGPoint(x: 10.7, y: 19.7),
            control1: CGPoint(x: 9.4, y: 14.2),
            control2: CGPoint(x: 10.1, y: 17.5))
        path.addQuadCurve(to: CGPoint(x: 13.3, y: 19.7), control: CGPoint(x: 12, y: 20.5))
        path.addCurve(
            to: CGPoint(x: 14.7, y: 11),
            control1: CGPoint(x: 13.9, y: 17.5),
            control2: CGPoint(x: 14.6, y: 14.2))
        path.addCurve(
            to: CGPoint(x: 12, y: 7),
            control1: CGPoint(x: 14.8, y: 8.4),
            control2: CGPoint(x: 13.6, y: 7))
        path.closeSubpath()

        // The tail fan keeps the whole-animal silhouette distinct from the mascot.
        path.move(to: CGPoint(x: 12, y: 19))
        path.addQuadCurve(to: CGPoint(x: 8.5, y: 22.3), control: CGPoint(x: 8.9, y: 19.6))
        path.addQuadCurve(to: CGPoint(x: 12, y: 21.9), control: CGPoint(x: 10.5, y: 22.6))
        path.addQuadCurve(to: CGPoint(x: 15.5, y: 22.3), control: CGPoint(x: 13.5, y: 22.6))
        path.addQuadCurve(to: CGPoint(x: 12, y: 19), control: CGPoint(x: 15.1, y: 19.6))
        path.closeSubpath()
        return path.applying(CGAffineTransform(
            a: rect.width / 24, b: 0, c: 0, d: rect.height / 24, tx: rect.minX, ty: rect.minY))
    }
}

private struct LobbyLobsterLimbs: Shape {
    func path(in rect: CGRect) -> Path {
        var side = Path()
        side.move(to: CGPoint(x: 5.2, y: 7))
        side.addLine(to: CGPoint(x: 6.7, y: 10.1))
        side.addLine(to: CGPoint(x: 9.5, y: 10.7))

        for (bodyY, footY) in [(11.5, 12.8), (13.8, 15.8), (16.1, 18.5)] {
            side.move(to: CGPoint(x: 9.5, y: bodyY))
            side.addQuadCurve(
                to: CGPoint(x: 5.8, y: footY),
                control: CGPoint(x: 6.9, y: bodyY - 0.3))
        }

        side.move(to: CGPoint(x: 11, y: 8))
        side.addQuadCurve(to: CGPoint(x: 9.2, y: 3.3), control: CGPoint(x: 11, y: 4.8))
        var path = side
        path.addPath(side, transform: CGAffineTransform(a: -1, b: 0, c: 0, d: 1, tx: 24, ty: 0))
        return path.applying(CGAffineTransform(
            a: rect.width / 24, b: 0, c: 0, d: rect.height / 24, tx: rect.minX, ty: rect.minY))
    }
}
