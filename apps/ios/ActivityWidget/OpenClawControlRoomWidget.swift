import SwiftUI
import WidgetKit

private let controlRoomWidgetKind = "com.tommiedejong.openclaw.control-room"

struct OpenClawControlRoomWidget: Widget {
    var body: some WidgetConfiguration {
        StaticConfiguration(kind: controlRoomWidgetKind, provider: ControlRoomTimelineProvider()) { entry in
            ControlRoomWidgetView(entry: entry)
        }
        .configurationDisplayName("Thomas Control Room")
        .description("A playful OpenClaw status board for Home Screen and Lock Screen.")
        .supportedFamilies([.systemSmall, .systemMedium, .accessoryCircular, .accessoryRectangular, .accessoryInline])
    }
}

private struct ControlRoomEntry: TimelineEntry {
    let date: Date
    let phase: ControlRoomPhase
    let sessionName: String
    let nextAction: String
    let signalLevel: Int
    let canvasLevel: Int
    let voiceLevel: Int
}

private struct ControlRoomTimelineProvider: TimelineProvider {
    func placeholder(in context: Context) -> ControlRoomEntry {
        self.entry(date: .now)
    }

    func getSnapshot(in context: Context, completion: @escaping (ControlRoomEntry) -> Void) {
        completion(self.entry(date: .now))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<ControlRoomEntry>) -> Void) {
        let now = Date()
        let entries = (0..<6).map { offset in
            let date = Calendar.current.date(byAdding: .minute, value: offset * 12, to: now) ?? now
            return self.entry(date: date)
        }
        completion(Timeline(entries: entries, policy: .after(entries.last?.date ?? now)))
    }

    private func entry(date: Date) -> ControlRoomEntry {
        let minute = Calendar.current.component(.minute, from: date)
        let hour = Calendar.current.component(.hour, from: date)
        let phase = ControlRoomPhase.allCases[(minute / 12) % ControlRoomPhase.allCases.count]
        return ControlRoomEntry(
            date: date,
            phase: phase,
            sessionName: hour < 18 ? "Main Studio" : "Evening Watch",
            nextAction: phase.nextAction,
            signalLevel: 64 + ((minute * 3) % 29),
            canvasLevel: 71 + ((minute * 5) % 24),
            voiceLevel: 52 + ((minute * 7) % 35))
    }
}

private enum ControlRoomPhase: CaseIterable {
    case online
    case thinking
    case listening
    case roaming
    case offline

    var title: String {
        switch self {
        case .online: "Online"
        case .thinking: "Thinking"
        case .listening: "Listening"
        case .roaming: "Roaming"
        case .offline: "Standby"
        }
    }

    var shortTitle: String {
        switch self {
        case .online: "Live"
        case .thinking: "Think"
        case .listening: "Voice"
        case .roaming: "Scout"
        case .offline: "Rest"
        }
    }

    var nextAction: String {
        switch self {
        case .online: "Review the canvas"
        case .thinking: "Open next insight"
        case .listening: "Try voice wake"
        case .roaming: "Find hidden cards"
        case .offline: "Reconnect gateway"
        }
    }

    var systemImage: String {
        switch self {
        case .online: "bolt.fill"
        case .thinking: "sparkles"
        case .listening: "waveform"
        case .roaming: "figure.walk.motion"
        case .offline: "moon.zzz.fill"
        }
    }

    var palette: ControlRoomPalette {
        switch self {
        case .online:
            ControlRoomPalette(primary: .cyan, secondary: .green, accent: .yellow, shadow: .cyan.opacity(0.42))
        case .thinking:
            ControlRoomPalette(primary: .purple, secondary: .pink, accent: .orange, shadow: .purple.opacity(0.4))
        case .listening:
            ControlRoomPalette(primary: .orange, secondary: .yellow, accent: .mint, shadow: .orange.opacity(0.38))
        case .roaming:
            ControlRoomPalette(primary: .blue, secondary: .mint, accent: .pink, shadow: .blue.opacity(0.38))
        case .offline:
            ControlRoomPalette(primary: .indigo, secondary: .gray, accent: .cyan, shadow: .black.opacity(0.24))
        }
    }
}

private struct ControlRoomPalette {
    let primary: Color
    let secondary: Color
    let accent: Color
    let shadow: Color
}

private struct ControlRoomWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: ControlRoomEntry

    var body: some View {
        Group {
            switch self.family {
            case .systemMedium:
                ControlRoomMediumView(entry: self.entry)
            case .accessoryCircular:
                ControlRoomCircularView(entry: self.entry)
            case .accessoryRectangular:
                ControlRoomRectangularView(entry: self.entry)
            case .accessoryInline:
                Label(
                    "OpenClaw \(self.entry.phase.shortTitle): \(self.entry.nextAction)",
                    systemImage: self.entry.phase.systemImage)
            default:
                ControlRoomSmallView(entry: self.entry)
            }
        }
        .widgetURL(Self.deepLink(for: self.entry))
    }

    private static func deepLink(for entry: ControlRoomEntry) -> URL? {
        var components = URLComponents()
        components.scheme = "openclaw"
        components.host = "agent"
        components.queryItems = [
            URLQueryItem(
                name: "message",
                value: "Open the Thomas Control Room and show me \(entry.nextAction.lowercased())."),
            URLQueryItem(name: "sessionKey", value: "main"),
            URLQueryItem(name: "deliver", value: "false"),
        ]
        return components.url
    }
}

private struct ControlRoomSmallView: View {
    let entry: ControlRoomEntry

    var body: some View {
        ZStack {
            ControlRoomBackground(palette: self.entry.phase.palette)
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    ThomasWidgetAvatar(palette: self.entry.phase.palette, size: 54)
                    Spacer()
                    ControlRoomStatusPill(entry: self.entry)
                }
                Spacer(minLength: 0)
                VStack(alignment: .leading, spacing: 3) {
                    Text("Thomas")
                        .font(.title3.weight(.black))
                    Text(self.entry.phase.title)
                        .font(.caption.weight(.bold))
                        .foregroundStyle(.white.opacity(0.78))
                    Text(self.entry.nextAction)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.white.opacity(0.66))
                        .lineLimit(2)
                }
            }
            .padding(14)
        }
        .containerBackground(.clear, for: .widget)
    }
}

private struct ControlRoomMediumView: View {
    let entry: ControlRoomEntry

    var body: some View {
        ZStack {
            ControlRoomBackground(palette: self.entry.phase.palette)
            HStack(spacing: 14) {
                VStack(alignment: .leading, spacing: 10) {
                    HStack(spacing: 8) {
                        ControlRoomStatusPill(entry: self.entry)
                        Text(self.entry.sessionName)
                            .font(.caption2.weight(.bold))
                            .foregroundStyle(.white.opacity(0.68))
                    }
                    VStack(alignment: .leading, spacing: 2) {
                        Text("Thomas Control Room")
                            .font(.headline.weight(.black))
                        Text(self.entry.nextAction)
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.white.opacity(0.72))
                            .lineLimit(2)
                    }
                    Spacer(minLength: 0)
                    HStack(spacing: 7) {
                        ControlRoomMeter(
                            label: "Signal",
                            value: self.entry.signalLevel,
                            tint: self.entry.phase.palette.secondary)
                        ControlRoomMeter(
                            label: "Canvas",
                            value: self.entry.canvasLevel,
                            tint: self.entry.phase.palette.accent)
                        ControlRoomMeter(
                            label: "Voice",
                            value: self.entry.voiceLevel,
                            tint: self.entry.phase.palette.primary)
                    }
                }
                Spacer(minLength: 0)
                ZStack {
                    ControlRoomOrbit(palette: self.entry.phase.palette)
                    ThomasWidgetAvatar(palette: self.entry.phase.palette, size: 82)
                }
                .frame(width: 104, height: 112)
            }
            .padding(15)
        }
        .containerBackground(.clear, for: .widget)
    }
}

private struct ControlRoomCircularView: View {
    let entry: ControlRoomEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            Gauge(value: Double(self.entry.signalLevel), in: 0...100) {
                Image(systemName: self.entry.phase.systemImage)
            }
            .gaugeStyle(.accessoryCircularCapacity)
            .tint(self.entry.phase.palette.accent)
            VStack(spacing: 0) {
                ThomasWidgetAvatar(palette: self.entry.phase.palette, size: 25)
                Text(self.entry.phase.shortTitle)
                    .font(.system(size: 10, weight: .black, design: .rounded))
                    .minimumScaleFactor(0.6)
            }
        }
        .widgetAccentable()
    }
}

private struct ControlRoomRectangularView: View {
    let entry: ControlRoomEntry

    var body: some View {
        ZStack {
            AccessoryWidgetBackground()
            HStack(spacing: 8) {
                Image(systemName: self.entry.phase.systemImage)
                    .font(.headline.weight(.heavy))
                    .foregroundStyle(self.entry.phase.palette.accent)
                VStack(alignment: .leading, spacing: 2) {
                    Text("Thomas \(self.entry.phase.title)")
                        .font(.headline.weight(.black))
                        .lineLimit(1)
                    Text(self.entry.nextAction)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
                Spacer(minLength: 0)
                Text("\(self.entry.signalLevel)%")
                    .font(.caption.monospacedDigit().weight(.black))
            }
            .padding(.horizontal, 4)
        }
        .widgetAccentable()
    }
}

private struct ControlRoomBackground: View {
    let palette: ControlRoomPalette

    var body: some View {
        ZStack {
            LinearGradient(
                colors: [
                    Color(red: 0.03, green: 0.06, blue: 0.13),
                    Color(red: 0.12, green: 0.05, blue: 0.1),
                    Color(red: 0.05, green: 0.09, blue: 0.18),
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            Circle()
                .fill(self.palette.primary.opacity(0.45))
                .frame(width: 150, height: 150)
                .blur(radius: 26)
                .offset(x: -52, y: -48)
            Circle()
                .fill(self.palette.secondary.opacity(0.42))
                .frame(width: 126, height: 126)
                .blur(radius: 22)
                .offset(x: 92, y: 58)
            Capsule()
                .fill(self.palette.accent.opacity(0.3))
                .frame(width: 170, height: 38)
                .rotationEffect(.degrees(-24))
                .offset(x: 18, y: -18)
            ForEach(0..<5) { index in
                RoundedRectangle(cornerRadius: 4)
                    .stroke(.white.opacity(0.12), lineWidth: 1)
                    .frame(width: CGFloat(36 + index * 11), height: CGFloat(18 + index * 6))
                    .rotationEffect(.degrees(Double(index * 17)))
                    .offset(x: CGFloat(index * 24 - 48), y: CGFloat(index * 11 - 22))
            }
        }
        .overlay(.white.opacity(0.08))
    }
}

private struct ThomasWidgetAvatar: View {
    let palette: ControlRoomPalette
    let size: CGFloat

    var body: some View {
        ZStack {
            Circle()
                .fill(
                    AngularGradient(
                        colors: [
                            self.palette.accent,
                            self.palette.primary,
                            self.palette.secondary,
                            self.palette.accent,
                        ],
                        center: .center))
                .shadow(color: self.palette.shadow, radius: 12, x: 0, y: 8)
            Circle()
                .fill(Color(red: 0.96, green: 0.57, blue: 0.28))
                .padding(self.size * 0.14)
            HairShape()
                .fill(Color(red: 0.39, green: 0.16, blue: 0.05))
                .frame(width: self.size * 0.74, height: self.size * 0.4)
                .offset(x: -self.size * 0.02, y: -self.size * 0.18)
            HStack(spacing: self.size * 0.16) {
                Circle()
                    .fill(.black.opacity(0.86))
                Circle()
                    .fill(.black.opacity(0.86))
            }
            .frame(width: self.size * 0.35, height: self.size * 0.08)
            .offset(y: self.size * 0.01)
            SmileShape()
                .stroke(
                    .black.opacity(0.52),
                    style: StrokeStyle(lineWidth: max(1.4, self.size * 0.035), lineCap: .round))
                .frame(width: self.size * 0.3, height: self.size * 0.12)
                .offset(y: self.size * 0.2)
            Circle()
                .fill(.white.opacity(0.95))
                .frame(width: self.size * 0.08, height: self.size * 0.08)
                .offset(x: -self.size * 0.1, y: -self.size * 0.02)
        }
        .frame(width: self.size, height: self.size)
    }
}

private struct HairShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX + rect.width * 0.05, y: rect.midY))
        path.addCurve(
            to: CGPoint(x: rect.maxX, y: rect.midY + rect.height * 0.24),
            control1: CGPoint(x: rect.minX + rect.width * 0.24, y: rect.minY - rect.height * 0.1),
            control2: CGPoint(x: rect.minX + rect.width * 0.78, y: rect.minY))
        path.addCurve(
            to: CGPoint(x: rect.minX + rect.width * 0.1, y: rect.maxY),
            control1: CGPoint(x: rect.maxX - rect.width * 0.08, y: rect.maxY + rect.height * 0.1),
            control2: CGPoint(x: rect.minX + rect.width * 0.26, y: rect.maxY + rect.height * 0.06))
        path.closeSubpath()
        return path
    }
}

private struct SmileShape: Shape {
    func path(in rect: CGRect) -> Path {
        var path = Path()
        path.move(to: CGPoint(x: rect.minX, y: rect.minY + rect.height * 0.2))
        path.addQuadCurve(
            to: CGPoint(x: rect.maxX, y: rect.minY + rect.height * 0.2),
            control: CGPoint(x: rect.midX, y: rect.maxY))
        return path
    }
}

private struct ControlRoomStatusPill: View {
    let entry: ControlRoomEntry

    var body: some View {
        HStack(spacing: 5) {
            Image(systemName: self.entry.phase.systemImage)
                .font(.caption2.weight(.black))
            Text(self.entry.phase.shortTitle)
                .font(.caption2.weight(.black))
        }
        .foregroundStyle(.black.opacity(0.78))
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(self.entry.phase.palette.accent, in: Capsule())
    }
}

private struct ControlRoomMeter: View {
    let label: String
    let value: Int
    let tint: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.label.uppercased())
                .font(.system(size: 8, weight: .black, design: .rounded))
                .foregroundStyle(.white.opacity(0.54))
            GeometryReader { proxy in
                ZStack(alignment: .leading) {
                    Capsule()
                        .fill(.white.opacity(0.14))
                    Capsule()
                        .fill(self.tint)
                        .frame(width: proxy.size.width * CGFloat(self.value) / 100)
                }
            }
            .frame(height: 6)
            Text("\(self.value)%")
                .font(.system(size: 9, weight: .black, design: .rounded).monospacedDigit())
        }
        .padding(7)
        .background(.white.opacity(0.09), in: RoundedRectangle(cornerRadius: 12, style: .continuous))
    }
}

private struct ControlRoomOrbit: View {
    let palette: ControlRoomPalette

    var body: some View {
        ZStack {
            Circle()
                .stroke(self.palette.primary.opacity(0.34), lineWidth: 8)
                .frame(width: 90, height: 90)
            Circle()
                .trim(from: 0.08, to: 0.72)
                .stroke(self.palette.accent, style: StrokeStyle(lineWidth: 4, lineCap: .round))
                .frame(width: 104, height: 104)
                .rotationEffect(.degrees(-28))
            Circle()
                .fill(self.palette.secondary)
                .frame(width: 10, height: 10)
                .offset(x: 46, y: -18)
            Circle()
                .fill(self.palette.accent)
                .frame(width: 7, height: 7)
                .offset(x: -38, y: 38)
        }
    }
}

#Preview(as: .systemSmall) {
    OpenClawControlRoomWidget()
} timeline: {
    ControlRoomEntry(
        date: .now,
        phase: .online,
        sessionName: "Main Studio",
        nextAction: "Review the canvas",
        signalLevel: 86,
        canvasLevel: 92,
        voiceLevel: 73)
}

#Preview(as: .accessoryRectangular) {
    OpenClawControlRoomWidget()
} timeline: {
    ControlRoomEntry(
        date: .now,
        phase: .listening,
        sessionName: "Main Studio",
        nextAction: "Try voice wake",
        signalLevel: 79,
        canvasLevel: 88,
        voiceLevel: 84)
}
