import SwiftUI

struct BuddyModeView: View {
    var snapshot: BuddySnapshot = .listening()
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var blink: Bool = false
    @State private var breathe: Bool = false

    var body: some View {
        ZStack {
            Color(red: 0.01, green: 0.02, blue: 0.03)
                .ignoresSafeArea()

            VStack(spacing: 24) {
                Spacer(minLength: 12)

                BuddyFaceView(state: self.snapshot.state, blink: self.blink, breathe: self.breathe)
                    .frame(maxWidth: 720, maxHeight: 420)
                    .aspectRatio(1.85, contentMode: .fit)
                    .padding(.horizontal, 28)

                if let message = self.snapshot.agent.message, !message.isEmpty {
                    Text(message)
                        .font(.system(.title3, design: .rounded).weight(.semibold))
                        .foregroundStyle(Color.white.opacity(0.94))
                        .lineLimit(2)
                        .multilineTextAlignment(.center)
                        .minimumScaleFactor(0.72)
                        .padding(.horizontal, 18)
                        .padding(.vertical, 12)
                        .background(
                            RoundedRectangle(cornerRadius: 8, style: .continuous)
                                .fill(Color.black.opacity(0.42))
                                .overlay(
                                    RoundedRectangle(cornerRadius: 8, style: .continuous)
                                        .stroke(Color.white.opacity(0.10), lineWidth: 1)))
                        .padding(.horizontal, 24)
                }

                Spacer(minLength: 18)
            }
        }
        .onAppear {
            guard !self.reduceMotion else { return }
            withAnimation(.easeInOut(duration: 1.8).repeatForever(autoreverses: true)) {
                self.breathe = true
            }
            Task { @MainActor in
                while !Task.isCancelled {
                    try? await Task.sleep(nanoseconds: 3_200_000_000)
                    withAnimation(.easeInOut(duration: 0.10)) {
                        self.blink = true
                    }
                    try? await Task.sleep(nanoseconds: 120_000_000)
                    withAnimation(.easeInOut(duration: 0.14)) {
                        self.blink = false
                    }
                }
            }
        }
        .accessibilityElement(children: .combine)
        .accessibilityLabel("Nemo \(self.snapshot.state.rawValue)")
    }
}

private struct BuddyFaceView: View {
    var state: BuddyState
    var blink: Bool
    var breathe: Bool

    var body: some View {
        GeometryReader { proxy in
            let size = min(proxy.size.width / 2.4, proxy.size.height)
            let eyeWidth = size * 0.44
            let eyeHeight = self.blink ? size * 0.08 : self.eyeHeight(size)

            ZStack {
                HStack(spacing: size * 0.56) {
                    BuddyEye(width: eyeWidth, height: eyeHeight, pupilOffset: self.pupilOffset)
                    BuddyEye(width: eyeWidth, height: eyeHeight, pupilOffset: -self.pupilOffset)
                }
                .scaleEffect(self.breathe ? 1.025 : 0.99)

                BuddyMouth(state: self.state)
                    .stroke(self.mouthColor, lineWidth: max(4, size * 0.035))
                    .frame(width: size * 0.34, height: size * 0.22)
                    .offset(y: size * 0.46)
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        }
    }

    private func eyeHeight(_ size: CGFloat) -> CGFloat {
        switch self.state {
        case .thinking, .executing:
            return size * 0.34
        case .speaking:
            return size * 0.48
        case .recording, .wakeDetected:
            return size * 0.54
        default:
            return size * 0.50
        }
    }

    private var pupilOffset: CGFloat {
        switch self.state {
        case .visionScanning:
            return 18
        case .thinking, .executing:
            return -10
        default:
            return 0
        }
    }

    private var mouthColor: Color {
        self.state == .disconnected || self.state == .permissionRequired
            ? Color(red: 1.0, green: 0.45, blue: 0.42)
            : Color(red: 1.0, green: 0.62, blue: 0.74)
    }
}

private struct BuddyEye: View {
    var width: CGFloat
    var height: CGFloat
    var pupilOffset: CGFloat

    var body: some View {
        Capsule()
            .fill(Color(red: 0.88, green: 1.0, blue: 1.0))
            .frame(width: self.width, height: self.height)
            .overlay(alignment: .center) {
                Capsule()
                    .fill(Color(red: 0.02, green: 0.03, blue: 0.04))
                    .frame(width: max(8, self.width * 0.20), height: max(10, self.height * 0.82))
                    .offset(x: self.pupilOffset)
            }
            .shadow(color: Color(red: 0.62, green: 1.0, blue: 1.0).opacity(0.22), radius: 20)
    }
}

private struct BuddyMouth: Shape {
    var state: BuddyState

    func path(in rect: CGRect) -> Path {
        var path = Path()
        let midX = rect.midX
        let topY = rect.minY + rect.height * 0.34
        let bottomY = rect.maxY - rect.height * 0.16

        path.move(to: CGPoint(x: rect.minX + rect.width * 0.18, y: topY))
        path.addQuadCurve(
            to: CGPoint(x: midX, y: bottomY),
            control: CGPoint(x: rect.minX + rect.width * 0.30, y: rect.maxY))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX - rect.width * 0.18, y: topY),
            control: CGPoint(x: rect.maxX - rect.width * 0.30, y: rect.maxY))

        if self.state == .speaking {
            path.move(to: CGPoint(x: midX, y: bottomY + rect.height * 0.05))
            path.addLine(to: CGPoint(x: midX, y: rect.maxY))
        }
        return path
    }
}
