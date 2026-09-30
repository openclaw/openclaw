import SwiftUI

struct WatchMascot: View {
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.isLuminanceReduced) private var isLuminanceReduced

    let mood: OpenClawMascotMood
    let size: CGFloat

    var body: some View {
        Group {
            if self.isLuminanceReduced {
                // Always-On display must stay static so the animation loop never consumes background power.
                OpenClawMascotCanvas(
                    pose: .staticPose(for: self.mood),
                    palette: .forScheme(self.colorScheme))
            } else {
                // Fifteen frames per second keeps the tiny watch animation expressive without needless battery cost.
                OpenClawMascotView(
                    mood: self.mood,
                    minimumFrameInterval: 1.0 / 15.0)
            }
        }
        .frame(width: self.size, height: self.size)
        .accessibilityHidden(true)
    }
}
