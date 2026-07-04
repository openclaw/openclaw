import SwiftUI

/// iOS 9-style Siri waveform for the Talk screen, driven by the runtime mode.
/// Math adapted from noahchalifour/swiftui-siri-waveform-view (MIT), as packaged
/// by alfianlosari/SiriWaveView; redrawn with Canvas + TimelineView so lobes flow
/// continuously instead of re-randomizing per power change.
///
/// State rendering: off = flat static grey; connecting/thinking = slow low
/// breathing; listening = amplitude follows mic level; speech detected = full
/// power; agent speaking = strong TTS-style pulse.
struct TalkSiriWaveView: View {
    var mode: TalkProWaveformMode

    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    private static let born = Date()

    private static let monoColors: [Color] = [
        OpenClawBrand.accent,
        Color(red: 0.95, green: 0.45, blue: 0.30),
        Color(red: 0.45, green: 0.08, blue: 0.12),
    ]
    private static let inactiveColors: [Color] = [
        Color(uiColor: .systemGray2),
        Color(uiColor: .systemGray3),
        Color(uiColor: .systemGray4),
    ]

    var body: some View {
        let frozen = self.reduceMotion || self.mode == .still
        TimelineView(.animation(minimumInterval: 1.0 / 30.0, paused: frozen)) { timeline in
            let time = frozen ? 0 : timeline.date.timeIntervalSince(Self.born)
            let power = Self.power(for: self.mode, time: time)
            Canvas { context, size in
                let midY = size.height / 2
                var line = Path()
                line.move(to: CGPoint(x: 0, y: midY))
                line.addLine(to: CGPoint(x: size.width, y: midY))
                context.stroke(line, with: .color(.secondary.opacity(0.30)), lineWidth: 1)

                // Screen blend pops on dark; opacity overlap reads better on light.
                context.blendMode = self.colorScheme == .dark ? .screen : .normal
                let opacity = self.colorScheme == .dark ? 0.9 : 0.55
                for (index, color) in self.colors.enumerated() {
                    let path = Self.wavePath(
                        in: size,
                        time: time,
                        seed: Double(index) * 7.31,
                        power: power)
                    context.fill(path, with: .color(color.opacity(opacity)))
                }
            }
        }
        .opacity(self.mode == .still ? 0.6 : 1.0)
    }

    private var colors: [Color] {
        self.mode == .still ? Self.inactiveColors : Self.monoColors
    }

    /// Per-state drive: thinking breathes low and slow, speaking pulses like
    /// TTS playback, listening follows the live mic level.
    private static func power(for mode: TalkProWaveformMode, time: Double) -> Double {
        switch mode {
        case .still:
            0.05
        case .indeterminate:
            0.16 + 0.10 * (0.5 + 0.5 * sin(time * 1.6))
        case let .level(level):
            0.30 + 0.65 * min(max(level, 0), 1)
        case .inputSpeech:
            0.95
        case .speaking:
            0.70 * (0.55 + 0.45 * abs(sin(time * 5.0)))
        }
    }

    /// One wave = max envelope of three drifting lobes, mirrored around the midline.
    private static func wavePath(in size: CGSize, time: Double, seed: Double, power: Double) -> Path {
        let midX = Double(size.width) / 2
        let midY = Double(size.height) / 2

        // Lobe parameters oscillate smoothly so peaks sweep back and forth
        // across the line instead of scrolling off-screen.
        let lobes: [(A: Double, k: Double, t: Double)] = (0..<3).map { index in
            let f = Double(index)
            let amp = 0.30 + 0.70 * (0.5 + 0.5 * sin(time * (0.9 + 0.23 * f) + seed * 2.4 + f * 2.1))
            let k = 0.62 + 0.11 * f
            let t = 2.8 * sin(time * (0.45 + 0.17 * f) + seed + f * 1.9)
            return (A: amp, k: k, t: t)
        }

        var upper: [CGPoint] = []
        var x = -midX
        while x <= midX {
            let graphX = x / (midX / 9.0)
            var y: Double = 0
            for lobe in lobes {
                let amplitude = lobe.A * midY * power
                y = max(y, Self.attenuatedSine(x: graphX, A: amplitude, k: lobe.k, t: lobe.t))
            }
            upper.append(CGPoint(x: midX + x, y: midY - y))
            x += 2
        }

        var path = Path()
        path.move(to: CGPoint(x: 0, y: midY))
        path.addLines(upper)
        for point in upper.reversed() {
            path.addLine(to: CGPoint(x: point.x, y: 2 * midY - point.y))
        }
        path.closeSubpath()
        return path
    }

    /// |A·sin(kx − t)| shaped by the bell envelope g = (K/(K+(kx−t′)²))^K, K = 4.
    private static func attenuatedSine(x: Double, A: Double, k: Double, t: Double) -> Double {
        let sine = A * sin(k * x - t)
        let tPrime = t - .pi / 2
        let envelope = pow(4.0 / (4.0 + pow(k * x - tPrime, 2)), 4.0)
        return abs(sine * envelope)
    }
}
