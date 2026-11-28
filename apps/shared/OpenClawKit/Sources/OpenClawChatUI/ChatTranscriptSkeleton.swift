import SwiftUI

/// An existing chat's transcript while its history loads. iOS draws the skeleton; macOS chat
/// windows keep the delayed spinner, because their transcript uses different type and spacing.
struct ChatTranscriptLoadingPlaceholder: View {
    let columnLayout: ChatColumnLayout

    #if os(iOS)
    static let transition = AnyTransition.asymmetric(
        insertion: .identity,
        removal: .opacity.animation(.easeIn(duration: ChatTranscriptSkeleton.fadeOut)))
    #else
    static let transition = AnyTransition.identity
    #endif

    var body: some View {
        #if os(iOS)
        // Loading rows decorate the transcript; their intrinsic height must not push the composer
        // behind the keyboard on a small phone. Only draw the rows that fit the viewport.
        Color.clear
            .overlay(alignment: .top) {
                ChatTranscriptSkeleton().chatColumn(self.columnLayout)
            }
            .clipped()
        #else
        ChatDelayedLoadingIndicator()
            .frame(maxWidth: .infinity, maxHeight: .infinity)
        #endif
    }
}

extension View {
    /// Brings the transcript in after the skeleton on iOS; a no-op elsewhere.
    func chatTranscriptReveal(isWaiting: Bool) -> some View {
        #if os(iOS)
        self.modifier(ChatTranscriptReveal(isWaiting: isWaiting))
        #else
        self
        #endif
    }
}

#if os(iOS)
/// The transcript's shape while an existing chat's history loads: still, low-contrast rows where
/// the first messages will land (a user bubble, three agent lines, a bubble, two lines). No motion,
/// no label. Tone and timing follow the chat-loading board's option (a); positions are the iPhone
/// transcript's own row metrics at the default text size, scaled with Dynamic Type.
struct ChatTranscriptSkeleton: View {
    static let fadeIn = 0.2
    static let fadeOut = 0.15

    /// Body text line height at the default size; every text-driven length scales with it.
    @ScaledMetric(relativeTo: .body) private var bodyLine: CGFloat = 17
    @State private var isShown = false

    var body: some View {
        let scale = self.bodyLine / 17
        let rows = Self.rows(scale: scale)
        Canvas { context, size in
            let ink = GraphicsContext.Shading.color(OpenClawChatTheme.assistantText.opacity(0.07))
            for row in rows {
                let width = row.isBubble
                    ? min(row.width * scale, size.width * 0.8)
                    : size.width * 0.92 * row.width
                let x = row.isBubble ? size.width - width : 0
                let rect = CGRect(x: x, y: row.top, width: width, height: row.height)
                context.fill(Path(roundedRect: rect, cornerRadius: min(18, row.height / 2)), with: ink)
            }
        }
        .frame(height: rows.last.map { $0.top + $0.height } ?? 0)
        .opacity(self.isShown ? 1 : 0)
        .onAppear {
            withAnimation(.easeOut(duration: Self.fadeIn)) { self.isShown = true }
        }
        .accessibilityHidden(true)
    }

    private struct Bar {
        let top: CGFloat
        let height: CGFloat
        /// Points for a bubble, a fraction of the text column for an agent line.
        let width: CGFloat
        let isBubble: Bool
    }

    /// Mirrors the List rows: 6 pt content margin, 6 pt row padding, a bubble of one text line plus
    /// 10 pt padding, its timestamp 4 pt below, and agent text 15 pt into its row at a 21 pt pitch.
    private static func rows(scale: CGFloat) -> [Bar] {
        let line = 17 * scale, pitch = 21 * scale, stamp = 13.3 * scale, bar = 9 * scale
        let bubble = line + 20
        var top: CGFloat = 6
        var bars: [Bar] = []
        func user(_ width: CGFloat, stamped: Bool) {
            bars.append(Bar(top: top + 6, height: bubble, width: width, isBubble: true))
            top += 6 + bubble + (stamped ? 4 + stamp : 0) + 6
        }
        func agent(_ widths: [CGFloat]) {
            for (index, width) in widths.enumerated() {
                let lineTop = top + 15 + CGFloat(index) * pitch
                bars.append(Bar(top: lineTop + (line - bar) / 2, height: bar, width: width, isBubble: false))
            }
            top += 15 + line + CGFloat(widths.count - 1) * pitch + 15
        }
        user(196, stamped: true)
        agent([0.94, 0.9, 0.36])
        user(160, stamped: true)
        agent([0.92, 0.42])
        return bars
    }
}

/// After the skeleton, the transcript resolves in: a short fade from a few points of blur to sharp,
/// applied once to the whole transcript. Reduce Motion gets the fade without the blur. A transcript
/// that is already there on the first frame never passes through this, so nothing flashes.
struct ChatTranscriptReveal: ViewModifier {
    static let blurRadius: CGFloat = 2
    static let duration = 0.2
    static let reducedMotionDuration = 0.15

    let isWaiting: Bool
    @State private var progress: CGFloat = 1
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    func body(content: Content) -> some View {
        content
            .opacity(self.progress)
            .blur(radius: self.reduceMotion ? 0 : (1 - self.progress) * Self.blurRadius)
            .onChange(of: self.isWaiting, initial: true) { _, isWaiting in
                if isWaiting {
                    var hidden = Transaction()
                    hidden.disablesAnimations = true
                    withTransaction(hidden) { self.progress = 0 }
                } else if self.progress < 1 {
                    let animation = self.reduceMotion
                        ? Animation.easeOut(duration: Self.reducedMotionDuration)
                        : Animation.easeOut(duration: Self.duration)
                    withAnimation(animation) { self.progress = 1 }
                }
            }
    }
}
#endif
