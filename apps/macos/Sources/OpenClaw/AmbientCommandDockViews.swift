import AppKit
import OpenClawKit
import SwiftUI

struct AmbientThomasOrbView: View {
    let state: AmbientThomasOrbState

    private static let thomasImage: NSImage? = {
        let bundle = OpenClawKitResources.bundle
        let url = bundle.url(
            forResource: "thomas_avatar",
            withExtension: "png",
            subdirectory: "CanvasScaffold")
            ?? bundle.url(forResource: "thomas_avatar", withExtension: "png")
        return url.flatMap { NSImage(contentsOf: $0) }
    }()

    var body: some View {
        let profile = AmbientThomasOrbMotionProfile.profile(for: self.state)

        TimelineView(.animation(minimumInterval: 1 / 30)) { timeline in
            let time = timeline.date.timeIntervalSinceReferenceDate
            let motion = AmbientThomasOrbMotionSample.sample(time: time, state: self.state)
            let orbit = Angle.degrees(motion.spinDegrees)

            ZStack {
                Circle()
                    .stroke(self.ringColor.opacity(0.28), lineWidth: 1.2)
                    .scaleEffect(self.pulseScale(time: time, seconds: profile.pulseSeconds))
                    .opacity(self.pulseOpacity(time: time, seconds: profile.pulseSeconds))

                Circle()
                    .fill(
                        AngularGradient(
                            colors: [.cyan, .mint, .yellow, .pink, .cyan],
                            center: .center,
                            angle: orbit))
                    .shadow(color: self.ringColor.opacity(profile.glowOpacity), radius: 26)
                    .padding(3)

                Circle()
                    .fill(.black.opacity(0.66))
                    .padding(9)

                self.thomasImage
                    .clipShape(Circle())
                    .overlay(Circle().stroke(.white.opacity(0.42), lineWidth: 2))
                    .padding(13)

                Circle()
                    .fill(self.statusColor)
                    .frame(width: 15, height: 15)
                    .overlay(Circle().stroke(.black.opacity(0.8), lineWidth: 2))
                    .offset(x: 29, y: 29)

                Circle()
                    .fill(.yellow)
                    .frame(width: 10, height: 10)
                    .shadow(color: .yellow.opacity(0.8), radius: 12)
                    .offset(x: 37, y: -37)

                Circle()
                    .fill(.cyan)
                    .frame(width: 7, height: 7)
                    .shadow(color: .cyan.opacity(0.8), radius: 10)
                    .offset(x: -39, y: 24)
            }
            .frame(width: 92, height: 92)
            .scaleEffect(self.breatheScale(time: time, seconds: profile.pulseSeconds))
            .rotationEffect(.degrees(motion.tiltDegrees))
            .offset(x: motion.offsetX, y: motion.offsetY)
            .accessibilityHidden(true)
        }
        .frame(width: 190, height: 184)
    }

    @ViewBuilder
    private var thomasImage: some View {
        if let image = Self.thomasImage {
            Image(nsImage: image)
                .resizable()
                .aspectRatio(contentMode: .fill)
        } else {
            Image(nsImage: NSApp.applicationIconImage)
                .resizable()
                .aspectRatio(contentMode: .fill)
        }
    }

    private var ringColor: Color {
        switch self.state {
        case .ready:
            .cyan
        case .focused:
            .mint
        case .sending:
            .yellow
        case .working:
            .cyan
        case .success:
            .green
        case .error:
            .orange
        }
    }

    private var statusColor: Color {
        switch self.state {
        case .ready, .focused:
            .mint
        case .sending, .working:
            .yellow
        case .success:
            .green
        case .error:
            .orange
        }
    }

    private func breatheScale(time: TimeInterval, seconds: Double) -> Double {
        1.0 + sin(time * 2 * .pi / seconds) * 0.035
    }

    private func pulseScale(time: TimeInterval, seconds: Double) -> Double {
        1.08 + (sin(time * 2 * .pi / seconds) + 1) * 0.14
    }

    private func pulseOpacity(time: TimeInterval, seconds: Double) -> Double {
        0.18 + (sin(time * 2 * .pi / seconds) + 1) * 0.12
    }
}
