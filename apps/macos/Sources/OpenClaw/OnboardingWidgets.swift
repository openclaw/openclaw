import OpenClawChatUI
import SwiftUI

/// Onboarding hero mascot with the openclaw.ai hero treatment: the animated
/// mascot plus its coral silhouette glow (drop-shadow at ~10% of size).
struct GlowingOpenClawIcon: View {
    @Environment(\.colorScheme) private var colorScheme

    let size: CGFloat

    init(size: CGFloat = 148) {
        self.size = size
    }

    var body: some View {
        OpenClawMascotView()
            .frame(width: self.size, height: self.size)
            .shadow(
                color: OpenClawMascotView.heroGlowColor(for: self.colorScheme),
                radius: self.size * 0.1)
    }
}
