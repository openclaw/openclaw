import SwiftUI

#if os(iOS)
struct OpenClawSubagentAvatar: View {
    let key: String
    var size: CGFloat = 32
    @Environment(\.colorScheme) private var scheme

    var body: some View {
        let colors = ChatSubagentAvatarColors.pill(self.key, scheme: self.scheme)
        Circle().fill(colors.tile).overlay {
            ChatSubagentBotGlyph()
                .stroke(colors.ink, style: StrokeStyle(lineWidth: 1.5, lineCap: .round, lineJoin: .round))
                .padding(self.size * 3 / 16)
        }
        .frame(width: self.size, height: self.size).accessibilityHidden(true)
    }
}
#endif

/// The Control UI's subagent avatar: the bot glyph on a tile whose color comes from the session key
/// (ui/src/pages/chat/components/chat-subagent-badge.tsx, chat-activity-pills.tsx).
enum ChatSubagentAvatarColors {
    /// FNV-1a over UTF-16 code units, as src/shared/fnv1a.ts, so a child keeps the web's hue.
    static func hue(_ key: String) -> Double {
        var hash: UInt32 = 0x811C_9DC5
        for unit in key.utf16 {
            hash ^= UInt32(unit)
            hash = hash &* 0x0100_0193
        }
        return Double(hash % 360)
    }

    /// The dark activity pill draws from a fixed, quiet palette instead of the hue
    /// (avatarPalette in chat-activity-pills.tsx).
    private static let darkPillPalette: [(UInt32, UInt32)] = [
        (0x34383B, 0xBDC3C7), (0x34414B, 0xAFC4D4), (0x38353E, 0xBEB6CA),
        (0x30383C, 0xACBEC5), (0x3C363A, 0xC6B9C1), (0x3A3832, 0xC3BEAE),
    ]

    /// Tile and glyph colors for the activity pill.
    static func pill(_ key: String, scheme: ColorScheme) -> (tile: Color, ink: Color) {
        if scheme == .dark {
            var hash: UInt32 = 0
            for scalar in key.unicodeScalars {
                hash = hash &* 31 &+ UInt32(String(scalar).utf16.first ?? 0)
            }
            let (tile, ink) = self.darkPillPalette[Int(hash % UInt32(self.darkPillPalette.count))]
            return (self.rgb(tile), self.rgb(ink))
        }
        let hue = self.hue(key)
        return (self.hsl(hue, 0.45, 0.94), self.hsl(hue, 0.45, 0.36))
    }

    private static func rgb(_ value: UInt32) -> Color {
        Color(
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255)
    }

    static func hsl(_ hue: Double, _ saturation: Double, _ lightness: Double, _ opacity: Double = 1) -> Color {
        let chroma = (1 - abs(2 * lightness - 1)) * saturation
        let sector = hue / 60
        let second = chroma * (1 - abs(sector.truncatingRemainder(dividingBy: 2) - 1))
        let (red, green, blue): (Double, Double, Double) = switch Int(sector) % 6 {
        case 0: (chroma, second, 0)
        case 1: (second, chroma, 0)
        case 2: (0, chroma, second)
        case 3: (0, second, chroma)
        case 4: (second, 0, chroma)
        default: (chroma, 0, second)
        }
        let match = lightness - chroma / 2
        return Color(red: red + match, green: green + match, blue: blue + match, opacity: opacity)
    }
}

/// Lucide's "bot", the glyph the Control UI draws for every subagent (ui/src/components/icon-data.ts).
struct ChatSubagentBotGlyph: Shape {
    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width, rect.height) / 24
        func point(_ x: CGFloat, _ y: CGFloat) -> CGPoint {
            CGPoint(x: rect.minX + x * scale, y: rect.minY + y * scale)
        }
        var path = Path()
        path.move(to: point(12, 8))
        path.addLine(to: point(12, 4))
        path.addLine(to: point(8, 4))
        path.addRoundedRect(
            in: CGRect(origin: point(4, 8), size: CGSize(width: 16 * scale, height: 12 * scale)),
            cornerSize: CGSize(width: 2 * scale, height: 2 * scale))
        for (from, to) in [((2, 14), (4, 14)), ((20, 14), (22, 14)), ((15, 13), (15, 15)), ((9, 13), (9, 15))] {
            path.move(to: point(CGFloat(from.0), CGFloat(from.1)))
            path.addLine(to: point(CGFloat(to.0), CGFloat(to.1)))
        }
        return path
    }
}

/// Up to three working children, overlapping, as the web's subagents pill leads with them. Each tile takes a
/// small hop in turn on one shared clock; the label and the stack’s footprint stay still.
struct ChatSubagentAvatarStack: View {
    let keys: [String]
    let canWave: Bool
    @Environment(\.scenePhase) private var scenePhase
    @State private var isVisible = false
    @State private var wave = false
    @ScaledMetric(relativeTo: .subheadline) private var scaledSide: CGFloat = 21
    @Environment(\.colorScheme) private var colorScheme
    @Environment(\.accessibilityReduceMotion) private var reduceMotion

    /// The web's 23 px box keeps a 2 px ring of the pill around a 19 px tile and overlaps the next by 7 px.
    private static let gap: CGFloat = 2
    private static let overlap: CGFloat = 7

    private static let stagger = 0.10
    private static let hop = KeyframeTimeline(initialValue: CGFloat.zero) {
        KeyframeTrack {
            CubicKeyframe(-4, duration: 0.10, startVelocity: 0, endVelocity: 0)
            SpringKeyframe(0, duration: 0.20, spring: .smooth(duration: 0.18), startVelocity: 0)
        }
    }

    var body: some View {
        let shown = Array(self.keys.prefix(3))
        Group {
            if self.canWave, self.isVisible, self.scenePhase == .active, !self.reduceMotion, !shown.isEmpty {
                let duration = Self.hop.duration + Double(shown.count - 1) * Self.stagger
                KeyframeAnimator(initialValue: 0.0, trigger: self.wave) { elapsed in
                    self.avatars(shown, elapsed: elapsed)
                } keyframes: { _ in
                    KeyframeTrack {
                        LinearKeyframe(duration, duration: duration, timingCurve: .linear)
                        MoveKeyframe(0)
                    }
                }
                .task {
                    while !Task.isCancelled {
                        do { try await Task.sleep(for: .seconds(10)) } catch { return }
                        self.wave.toggle()
                    }
                }
            } else {
                self.avatars(shown, elapsed: 0)
            }
        }
        .onScrollVisibilityChange(threshold: 0.01) { self.isVisible = $0 }
        .accessibilityHidden(true)
    }

    private func avatars(_ shown: [String], elapsed: Double) -> some View {
        let side = max(19, self.scaledSide)
        let pitch = side + 2 * Self.gap - Self.overlap
        let radius = side * 4 / 19
        let lifts = shown.indices.map { Self.hop.value(time: max(0, elapsed - Double($0) * Self.stagger)) }
        return ZStack(alignment: .topLeading) {
            ForEach(Array(shown.enumerated()), id: \.element) { index, key in
                let colors = ChatSubagentAvatarColors.pill(key, scheme: self.colorScheme)
                RoundedRectangle(cornerRadius: radius, style: .continuous)
                    .fill(colors.tile)
                    .overlay {
                        ChatSubagentBotGlyph()
                            .stroke(colors.ink, style: StrokeStyle(
                                lineWidth: side * 16 / 19 * 1.55 / 24,
                                lineCap: .round,
                                lineJoin: .round))
                            .padding(side * 1.5 / 19)
                    }
                    .frame(width: side, height: side)
                    // The tile in front keeps a ring of the pill around it, cut out of the one behind.
                    .mask {
                        ZStack(alignment: .topLeading) {
                            Rectangle()
                            if index > 0 {
                                RoundedRectangle(cornerRadius: radius + Self.gap, style: .continuous)
                                    .frame(width: side + 2 * Self.gap, height: side + 2 * Self.gap)
                                    .offset(x: -pitch - Self.gap, y: lifts[index - 1] - lifts[index] - Self.gap)
                                    .blendMode(.destinationOut)
                            }
                        }
                        .compositingGroup()
                    }
                    .offset(x: CGFloat(index) * pitch, y: lifts[index])
                    .zIndex(Double(shown.count - index))
            }
        }
        .frame(width: side + CGFloat(max(0, shown.count - 1)) * pitch, height: side, alignment: .topLeading)
    }
}
