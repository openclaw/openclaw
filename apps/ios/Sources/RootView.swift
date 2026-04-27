import SwiftUI

struct RootView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    @State private var splashVisible = true
    @State private var splashSettled = false

    var body: some View {
        ZStack {
            RootCanvas()

            if self.splashVisible {
                LaunchSplashView(settled: self.splashSettled)
                    .transition(.opacity.animation(.easeOut(duration: 0.42)))
                    .zIndex(10)
            }
        }
        .task {
            guard self.splashVisible else { return }
            if self.reduceMotion {
                self.splashSettled = true
                try? await Task.sleep(nanoseconds: 350_000_000)
            } else {
                try? await Task.sleep(nanoseconds: 820_000_000)
                self.splashSettled = true
                try? await Task.sleep(nanoseconds: 520_000_000)
            }
            withAnimation(.easeOut(duration: self.reduceMotion ? 0.2 : 0.42)) {
                self.splashVisible = false
            }
        }
    }
}

private struct LaunchSplashView: View {
    @Environment(\.accessibilityReduceMotion) private var reduceMotion
    let settled: Bool

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color.black,
                    Color(red: 0.05, green: 0.08, blue: 0.13),
                    Color(red: 0.03, green: 0.05, blue: 0.08),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            .ignoresSafeArea()

            ZStack {
                Circle()
                    .fill(
                        RadialGradient(
                            colors: [
                                Color(red: 0.45, green: 0.83, blue: 0.95).opacity(self.settled ? 0.12 : 0.22),
                                .clear,
                            ],
                            center: .center,
                            startRadius: 12,
                            endRadius: self.settled ? 150 : 190)
                    )
                    .frame(width: self.settled ? 280 : 360, height: self.settled ? 280 : 360)
                    .blur(radius: self.settled ? 24 : 34)

                RoundedRectangle(cornerRadius: 34, style: .continuous)
                    .fill(.ultraThinMaterial.opacity(0.92))
                    .overlay(
                        RoundedRectangle(cornerRadius: 34, style: .continuous)
                            .strokeBorder(Color.white.opacity(0.14), lineWidth: 1)
                    )
                    .frame(width: self.settled ? 118 : 132, height: self.settled ? 118 : 132)
                    .shadow(color: Color.black.opacity(0.35), radius: 22, y: 10)
                    .overlay {
                        ZStack {
                            Circle()
                                .stroke(
                                    LinearGradient(
                                        colors: [
                                            Color(red: 0.47, green: 0.88, blue: 0.97),
                                            Color.white.opacity(0.35),
                                            Color(red: 0.3, green: 0.7, blue: 0.88),
                                        ],
                                        startPoint: .topLeading,
                                        endPoint: .bottomTrailing
                                    ),
                                    lineWidth: 7
                                )
                                .frame(width: 58, height: 58)

                            Circle()
                                .fill(Color.white.opacity(0.92))
                                .frame(width: 12, height: 12)
                                .offset(x: 0, y: -29)
                        }
                        .rotationEffect(.degrees(self.settled ? 34 : -18))
                    }
                    .scaleEffect(self.settled ? 0.94 : 1.0)

                if !self.reduceMotion {
                    Circle()
                        .stroke(Color.white.opacity(self.settled ? 0.0 : 0.16), lineWidth: 1)
                        .frame(width: self.settled ? 150 : 220, height: self.settled ? 150 : 220)
                        .blur(radius: 0.4)
                    Circle()
                        .stroke(Color(red: 0.45, green: 0.83, blue: 0.95).opacity(self.settled ? 0.0 : 0.24), lineWidth: 1.2)
                        .frame(width: self.settled ? 178 : 270, height: self.settled ? 178 : 270)
                        .blur(radius: 0.8)
                }
            }
            .offset(y: self.settled ? -28 : -8)

            VStack(spacing: 8) {
                Spacer()

                VStack(spacing: 6) {
                    Text("OpenClaw")
                        .font(.system(size: self.settled ? 30 : 34, weight: .bold, design: .rounded))
                        .foregroundStyle(.white)
                        .tracking(self.settled ? 0.8 : 1.4)

                    Text("Local agent runtime")
                        .font(.system(size: 13, weight: .medium, design: .rounded))
                        .foregroundStyle(Color.white.opacity(0.62))
                        .tracking(1.8)
                }
                .offset(y: self.settled ? -74 : -52)
                .opacity(self.settled ? 0.82 : 1.0)
                .scaleEffect(self.settled ? 0.97 : 1.0)
            }
            .padding(.bottom, 92)
        }
        .allowsHitTesting(false)
        .animation(self.reduceMotion ? .easeOut(duration: 0.18) : .spring(response: 0.9, dampingFraction: 0.82), value: self.settled)
    }
}
