import SwiftUI

struct CommandPanel<Content: View>: View {
    var tint: Color?
    var isProminent = false
    var padding: CGFloat = 13
    @ViewBuilder var content: Content

    init(
        tint: Color? = nil,
        isProminent: Bool = false,
        padding: CGFloat = 13,
        @ViewBuilder content: () -> Content)
    {
        self.tint = tint
        self.isProminent = isProminent
        self.padding = padding
        self.content = content()
    }

    var body: some View {
        ProCard(
            tint: self.tint,
            isProminent: self.isProminent,
            padding: self.padding,
            radius: OpenClawProMetric.cardRadius)
        {
            self.content
        }
    }
}

struct CommandControlBackground: View {
    var body: some View {
        OpenClawProBackground()
    }
}

struct CommandSessionRow: View {
    let item: CommandCenterTab.WorkItem

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: self.item.icon)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(self.item.color)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: OpenClawRadius.sm, style: .continuous)
                        .fill(self.item.color.opacity(0.12))
                }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    Text(self.item.title)
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Spacer(minLength: 6)
                    Text(self.item.trailing)
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Text(self.item.detail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    if let progress = self.item.progress {
                        ProProgressBar(progress: progress, color: self.item.color)
                            .frame(width: 68)
                    }
                    Text(self.progressLabel)
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(self.item.color)
                        .lineLimit(1)
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
        .contentShape(Rectangle())
    }

    private var progressLabel: String {
        guard let progress = item.progress else {
            return self.item.state
        }
        if self.item.state == "offline" || self.item.state == "off" || self.item.state == "idle" {
            return self.item.state
        }
        return "\(Int((progress * 100).rounded()))%"
    }
}

struct CommandViewMoreRow: View {
    var body: some View {
        Label("View More", systemImage: "chevron.right")
            .font(OpenClawType.subheadBold)
            .foregroundStyle(OpenClawBrand.accent)
            .frame(maxWidth: .infinity)
            .padding(.vertical, 10)
            .contentShape(Rectangle())
    }
}

struct CommandEmptyStateRow: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.icon)
                .font(OpenClawType.captionBold)
                .foregroundStyle(OpenClawBrand.ok)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous)
                        .fill(OpenClawBrand.ok.opacity(0.10))
                }
            VStack(alignment: .leading, spacing: 2) {
                Text(self.title)
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                Text(self.detail)
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
    }
}
