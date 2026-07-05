import OpenClawChatUI
import SwiftUI

struct GlowingOpenClawIcon: View {
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    let size: CGFloat
    let glowIntensity: Double
    let enableFloating: Bool

    @State private var breathe = false

    init(size: CGFloat = 148, glowIntensity: Double = 0.35, enableFloating: Bool = true) {
        self.size = size
        self.glowIntensity = glowIntensity
        self.enableFloating = enableFloating
    }

    var body: some View {
        let glowBlurRadius: CGFloat = 18
        let glowCanvasSize: CGFloat = self.size + 56
        ZStack {
            Circle()
                .fill(
                    LinearGradient(
                        colors: [
                            Color.accentColor.opacity(self.glowIntensity),
                            Color.blue.opacity(self.glowIntensity * 0.6),
                        ],
                        startPoint: .topLeading,
                        endPoint: .bottomTrailing))
                .frame(width: glowCanvasSize, height: glowCanvasSize)
                .padding(glowBlurRadius)
                .blur(radius: glowBlurRadius)
                .scaleEffect(self.breathe ? 1.08 : 0.96)
                .opacity(0.84)

            // Mascot animates itself (and goes still under reduce motion), so no breathe scale here.
            OpenClawMascotView()
                .frame(width: self.size, height: self.size)
                .shadow(color: .black.opacity(0.18), radius: 14, y: 6)
        }
        .frame(
            width: glowCanvasSize + (glowBlurRadius * 2),
            height: glowCanvasSize + (glowBlurRadius * 2))
        .onAppear { self.updateBreatheAnimation() }
        .onDisappear { self.breathe = false }
        .onChange(of: self.scenePhase) { _, _ in
            self.updateBreatheAnimation()
        }
    }

    private func updateBreatheAnimation() {
        guard self.enableFloating, !self.reduceMotion, self.scenePhase == .active else {
            self.breathe = false
            return
        }
        guard !self.breathe else { return }
        withAnimation(Animation.easeInOut(duration: 3.6).repeatForever(autoreverses: true)) {
            self.breathe = true
        }
    }
}
