import SwiftUI

struct TalkOverlayView: View {
    var controller: TalkOverlayController
    @State private var appState = AppStateStore.shared
    @State private var hoveringWindow = false

    var body: some View {
        ZStack {
            TalkOrbView(
                phase: self.controller.model.phase,
                level: self.controller.model.level,
                accent: self.seamColor)
                .frame(width: 96, height: 96)
                .contentShape(Circle())
                .onTapGesture {
                    TalkModeController.shared.stopSpeaking(reason: .userTap)
                }
                .overlay(alignment: .topLeading) {
                    Button {
                        TalkModeController.shared.exitTalkMode()
                    } label: {
                        Image(systemName: "xmark")
                            .font(.system(size: 10, weight: .bold))
                            .foregroundStyle(Color.white.opacity(0.95))
                            .frame(width: 18, height: 18)
                            .background(Color.black.opacity(0.4))
                            .clipShape(Circle())
                }
                .buttonStyle(.plain)
                .contentShape(Circle())
                .offset(x: -7, y: -7)
                .opacity(self.hoveringWindow ? 1 : 0)
                .animation(.easeOut(duration: 0.12), value: self.hoveringWindow)
                .allowsHitTesting(self.hoveringWindow)
            }
        }
        .frame(width: TalkOverlayController.overlaySize, height: TalkOverlayController.overlaySize, alignment: .center)
        .contentShape(Rectangle())
        .onHover { self.hoveringWindow = $0 }
    }

    private static let defaultSeamColor = Color(red: 127 / 255.0, green: 184 / 255.0, blue: 212 / 255.0)

    private var seamColor: Color {
        Self.color(fromHex: self.appState.seamColorHex) ?? Self.defaultSeamColor
    }

    private static func color(fromHex raw: String?) -> Color? {
        let trimmed = (raw ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        let hex = trimmed.hasPrefix("#") ? String(trimmed.dropFirst()) : trimmed
        guard hex.count == 6, let value = Int(hex, radix: 16) else { return nil }
        let r = Double((value >> 16) & 0xFF) / 255.0
        let g = Double((value >> 8) & 0xFF) / 255.0
        let b = Double(value & 0xFF) / 255.0
        return Color(red: r, green: g, blue: b)
    }
}

private struct TalkOrbView: View {
    let phase: TalkModePhase
    let level: Double
    let accent: Color

    var body: some View {
        TimelineView(.animation) { context in
            let t = context.date.timeIntervalSinceReferenceDate
            let listenScale = phase == .listening ? (1 + CGFloat(self.level) * 0.12) : 1
            let pulse = phase == .speaking ? (1 + 0.06 * sin(t * 6)) : 1

            ZStack {
                Circle()
                    .fill(self.orbGradient)
                    .overlay(Circle().stroke(Color.white.opacity(0.45), lineWidth: 1))
                    .shadow(color: Color.black.opacity(0.22), radius: 10, x: 0, y: 5)
                    .scaleEffect(pulse * listenScale)

                TalkWaveRings(phase: phase, level: level, time: t, accent: self.accent)

                if phase == .thinking {
                    TalkOrbitArcs(time: t)
                }
            }
        }
    }

    private var orbGradient: RadialGradient {
        RadialGradient(
            colors: [Color.white, self.accent],
            center: .topLeading,
            startRadius: 4,
            endRadius: 52)
    }
}

private struct TalkWaveRings: View {
    let phase: TalkModePhase
    let level: Double
    let time: TimeInterval
    let accent: Color

    var body: some View {
        ZStack {
            ForEach(0..<3, id: \.self) { idx in
                let speed = phase == .speaking ? 1.4 : phase == .listening ? 0.9 : 0.6
                let progress = (time * speed + Double(idx) * 0.28).truncatingRemainder(dividingBy: 1)
                let amplitude = phase == .speaking ? 0.95 : phase == .listening ? 0.5 + level * 0.7 : 0.35
                let scale = 0.75 + progress * amplitude + (phase == .listening ? level * 0.15 : 0)
                let alpha = phase == .speaking ? 0.72 : phase == .listening ? 0.58 + level * 0.28 : 0.4
                Circle()
                    .stroke(self.accent.opacity(alpha - progress * 0.3), lineWidth: 1.6)
                    .scaleEffect(scale)
                    .opacity(alpha - progress * 0.6)
            }
        }
    }
}

private struct TalkOrbitArcs: View {
    let time: TimeInterval

    var body: some View {
        ZStack {
            Circle()
                .trim(from: 0.08, to: 0.26)
                .stroke(Color.white.opacity(0.88), style: StrokeStyle(lineWidth: 1.6, lineCap: .round))
                .rotationEffect(.degrees(time * 42))
            Circle()
                .trim(from: 0.62, to: 0.86)
                .stroke(Color.white.opacity(0.7), style: StrokeStyle(lineWidth: 1.4, lineCap: .round))
                .rotationEffect(.degrees(-time * 35))
        }
        .scaleEffect(1.08)
    }
}
