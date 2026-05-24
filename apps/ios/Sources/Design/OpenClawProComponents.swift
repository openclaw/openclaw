import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 20
    static let cardRadius: CGFloat = 14
    static let controlRadius: CGFloat = 12
    static let bottomScrollInset: CGFloat = 96
}

struct OpenClawProBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        LinearGradient(
            colors: OpenClawBrand.canvasColors(for: self.colorScheme),
            startPoint: .top,
            endPoint: .bottom)
            .ignoresSafeArea()
            .overlay(alignment: .topTrailing) {
                RadialGradient(
                    colors: [
                        OpenClawBrand.accent.opacity(self.colorScheme == .dark ? 0.16 : 0.08),
                        .clear,
                    ],
                    center: .center,
                    startRadius: 12,
                    endRadius: 280)
                    .frame(width: 360, height: 280)
                    .offset(x: 120, y: -120)
                    .ignoresSafeArea()
            }
    }
}

struct ProSectionHeader: View {
    let title: String
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack {
            Text(self.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(.uppercase)
            Spacer()
            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(OpenClawBrand.accent)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }
}

struct ProCard<Content: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    var tint: Color?
    var isProminent: Bool = false
    var padding: CGFloat = 14
    @ViewBuilder var content: Content

    var body: some View {
        self.content
            .padding(self.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background {
                RoundedRectangle(cornerRadius: OpenClawProMetric.cardRadius, style: .continuous)
                    .fill(self.fill)
                    .overlay {
                        RoundedRectangle(cornerRadius: OpenClawProMetric.cardRadius, style: .continuous)
                            .strokeBorder(self.stroke, lineWidth: 1)
                    }
            }
            .shadow(
                color: self.colorScheme == .dark ? .black.opacity(0.18) : .black.opacity(0.045),
                radius: self.isProminent ? 18 : 10,
                y: self.isProminent ? 10 : 5)
    }

    private var fill: Color {
        if self.colorScheme == .dark {
            return self.tint?.opacity(self.isProminent ? 0.11 : 0.045) ?? Color.white.opacity(0.052)
        }
        return self.tint?.opacity(self.isProminent ? 0.08 : 0.035) ?? Color.white.opacity(0.86)
    }

    private var stroke: Color {
        if let tint {
            return tint.opacity(self.colorScheme == .dark ? 0.24 : 0.16)
        }
        return self.colorScheme == .dark ? Color.white.opacity(0.09) : Color.black.opacity(0.07)
    }
}

struct ProIconBadge: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(.subheadline.weight(.semibold))
            .foregroundStyle(self.color)
            .frame(width: 34, height: 34)
            .background {
                RoundedRectangle(cornerRadius: 10, style: .continuous)
                    .fill(self.color.opacity(0.12))
            }
    }
}

struct ProStatusDot: View {
    var color: Color

    var body: some View {
        Circle()
            .fill(self.color)
            .frame(width: 8, height: 8)
            .shadow(color: self.color.opacity(0.35), radius: 4)
    }
}

struct ProValuePill: View {
    @Environment(\.colorScheme) private var colorScheme
    let value: String
    let color: Color

    var body: some View {
        Text(self.value)
            .font(.caption.weight(.semibold))
            .foregroundStyle(self.color)
            .lineLimit(1)
            .padding(.horizontal, 8)
            .padding(.vertical, 5)
            .background {
                Capsule()
                    .fill(self.color.opacity(self.colorScheme == .dark ? 0.12 : 0.08))
            }
    }
}

struct OpenClawProMark: View {
    var body: some View {
        Image("OpenClawIcon")
            .resizable()
            .scaledToFit()
            .frame(width: 42, height: 42)
            .shadow(color: OpenClawBrand.accent.opacity(0.28), radius: 10, y: 5)
            .accessibilityLabel("OpenClaw")
    }
}

struct ProProgressBar: View {
    let progress: Double
    var color: Color = OpenClawBrand.accentHot

    var body: some View {
        GeometryReader { proxy in
            let clamped = max(0, min(self.progress, 1))
            ZStack(alignment: .leading) {
                Capsule()
                    .fill(Color.primary.opacity(0.10))
                Capsule()
                    .fill(self.color)
                    .frame(width: proxy.size.width * clamped)
            }
        }
        .frame(height: 3)
    }
}

struct ProWorkRow: View {
    let icon: String
    let title: String
    let detail: String
    let state: String
    let trailing: String
    let color: Color
    var progress: Double?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 5) {
                HStack(alignment: .firstTextBaseline) {
                    Text(self.title)
                        .font(.subheadline.weight(.semibold))
                    Spacer(minLength: 8)
                    Text(self.trailing)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                HStack(spacing: 8) {
                    if let progress {
                        ProProgressBar(progress: progress, color: self.color)
                            .frame(maxWidth: 120)
                    }
                    Text(self.state)
                        .font(.caption2.weight(.semibold))
                        .foregroundStyle(self.color)
                }
            }
        }
        .padding(.vertical, 11)
    }
}

struct ProCapsule: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let color: Color
    var icon: String?

    var body: some View {
        HStack(spacing: 6) {
            if let icon {
                Image(systemName: icon)
                    .font(.caption.weight(.semibold))
            }
            Text(self.title)
                .font(.caption.weight(.semibold))
        }
        .foregroundStyle(self.color)
        .padding(.horizontal, 10)
        .padding(.vertical, 7)
        .background {
            Capsule()
                .fill(self.color.opacity(self.colorScheme == .dark ? 0.16 : 0.10))
                .overlay {
                    Capsule()
                        .strokeBorder(self.color.opacity(self.colorScheme == .dark ? 0.30 : 0.18), lineWidth: 1)
                }
        }
    }
}

struct ProSegmentedControl: View {
    let labels: [String]
    @Binding var selection: Int

    var body: some View {
        HStack(spacing: 4) {
            ForEach(Array(self.labels.enumerated()), id: \.offset) { index, label in
                Button {
                    self.selection = index
                } label: {
                    Text(label)
                        .font(.subheadline.weight(self.selection == index ? .semibold : .regular))
                        .frame(maxWidth: .infinity)
                        .padding(.vertical, 9)
                        .background(self.selection == index ? Color.primary.opacity(0.08) : Color.clear, in: Capsule())
                }
                .buttonStyle(.plain)
            }
        }
        .padding(4)
        .background(.regularMaterial, in: Capsule())
    }
}

struct ProStatusRow: View {
    let icon: String
    let title: String
    let detail: String
    let value: String
    let color: Color

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.subheadline.weight(.semibold))
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            ProValuePill(value: self.value, color: self.color)
        }
        .padding(.vertical, 11)
    }
}

struct ProTimelineRow: View {
    let done: Bool
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            ProIconBadge(
                systemName: self.done ? "checkmark.circle.fill" : "clock.fill",
                color: self.done ? OpenClawBrand.ok : OpenClawBrand.warn)
            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(.subheadline.weight(.medium))
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }
}
