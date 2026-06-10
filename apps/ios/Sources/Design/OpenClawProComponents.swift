import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 18
    static let cardRadius: CGFloat = 10
    static let controlRadius: CGFloat = 8
    static let bottomScrollInset: CGFloat = 96
}

struct OpenClawProBackground: View {
    @Environment(\.colorScheme) private var colorScheme

    var body: some View {
        Color(uiColor: self.colorScheme == .dark ? .systemBackground : .systemGroupedBackground)
            .ignoresSafeArea()
            .overlay(alignment: .top) {
                if self.colorScheme == .light {
                    Color.white.opacity(0.22)
                        .frame(height: 140)
                        .ignoresSafeArea()
                }
            }
    }
}

struct ProSectionHeader: View {
    let title: String
    var actionTitle: String?
    var action: (() -> Void)?
    var uppercase = true

    var body: some View {
        HStack {
            Text(self.title)
                .font(.caption.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(self.uppercase ? .uppercase : nil)
            Spacer()
            if let actionTitle {
                if let action {
                    Button(actionTitle, action: action)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(OpenClawBrand.accent)
                } else {
                    Text(actionTitle)
                        .font(.caption.weight(.medium))
                        .foregroundStyle(.secondary)
                }
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }
}

struct ProCard<Content: View>: View {
    var tint: Color?
    var isProminent: Bool = false
    var padding: CGFloat = 12
    var radius: CGFloat = OpenClawProMetric.cardRadius
    @ViewBuilder var content: Content

    var body: some View {
        self.content
            .padding(self.padding)
            .frame(maxWidth: .infinity, alignment: .leading)
            .proPanelSurface(
                tint: self.tint,
                radius: self.radius,
                isProminent: self.isProminent)
    }
}

private struct ProPanelBackground: View {
    @Environment(\.colorScheme) private var colorScheme
    let radius: CGFloat
    let tint: Color?
    let isProminent: Bool

    var body: some View {
        let shape = RoundedRectangle(cornerRadius: self.radius, style: .continuous)
        shape
            .fill(self.fill)
            .overlay {
                shape.strokeBorder(self.borderStyle, lineWidth: 1)
            }
            .overlay {
                if self.isProminent {
                    shape.strokeBorder(
                        OpenClawBrand.accent.opacity(self.colorScheme == .dark ? 0.12 : 0.07),
                        lineWidth: 1)
                        .padding(1)
                }
            }
    }

    private var fill: AnyShapeStyle {
        let base = self.isProminent
            ? Color(uiColor: .systemBackground)
            : Color(uiColor: .secondarySystemGroupedBackground)
        if let tint {
            let gradient = LinearGradient(
                colors: [
                    base,
                    tint.opacity(self.colorScheme == .dark ? 0.08 : 0.045),
                    base,
                ],
                startPoint: .topLeading,
                endPoint: .bottomTrailing)
            return AnyShapeStyle(gradient)
        }
        return AnyShapeStyle(base)
    }

    private var borderStyle: AnyShapeStyle {
        AnyShapeStyle(Color(uiColor: .separator).opacity(self.colorScheme == .dark ? 0.26 : 0.30))
    }
}

private struct ProGlassEffectLayer<Surface: View>: View {
    @Environment(\.colorScheme) private var colorScheme
    let radius: CGFloat
    var interactive = false
    @ViewBuilder let surface: Surface

    var body: some View {
        if #available(iOS 26.0, *), self.colorScheme == .light {
            self.surface.glassEffect(
                self.interactive ? .regular.interactive() : .regular,
                in: .rect(cornerRadius: self.radius))
        } else {
            self.surface
        }
    }
}

private struct ProGlassSurfaceModifier: ViewModifier {
    let fill: Color
    let stroke: Color
    let radius: CGFloat
    let isProminent: Bool
    var interactive = false

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: self.radius, style: .continuous)
        content.background {
            ProGlassEffectLayer(
                radius: self.radius,
                interactive: self.interactive)
            {
                shape
                    .fill(self.fill)
                    .overlay {
                        shape.strokeBorder(self.stroke, lineWidth: self.isProminent ? 1.2 : 1)
                    }
            }
        }
    }
}

extension View {
    func proPanelSurface(
        tint: Color? = nil,
        radius: CGFloat = OpenClawProMetric.cardRadius,
        isProminent: Bool = false) -> some View
    {
        self.modifier(ProPanelSurfaceModifier(
            tint: tint,
            radius: radius,
            isProminent: isProminent))
    }

    func proGlassSurface(
        fill: Color,
        stroke: Color,
        radius: CGFloat,
        isProminent: Bool = false,
        interactive: Bool = false) -> some View
    {
        self.modifier(ProGlassSurfaceModifier(
            fill: fill,
            stroke: stroke,
            radius: radius,
            isProminent: isProminent,
            interactive: interactive))
    }
}

private struct ProPanelSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let tint: Color?
    let radius: CGFloat
    let isProminent: Bool

    func body(content: Content) -> some View {
        content
            .background {
                ProGlassEffectLayer(radius: self.radius) {
                    ProPanelBackground(
                        radius: self.radius,
                        tint: self.tint,
                        isProminent: self.isProminent)
                }
            }
            .shadow(
                color: self.colorScheme == .dark ? .black.opacity(0.22) : .black.opacity(0.028),
                radius: self.isProminent ? 9 : 4,
                y: self.isProminent ? 4 : 1)
    }
}

struct ProIconBadge: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(.caption.weight(.semibold))
            .foregroundStyle(self.color)
            .frame(width: 30, height: 30)
            .background {
                RoundedRectangle(cornerRadius: 8, style: .continuous)
                    .fill(self.color.opacity(0.12))
            }
    }
}

struct OpenClawSidebarHeaderAction {
    let systemName: String
    let accessibilityLabel: String
    let accessibilityIdentifier: String?
    let action: () -> Void

    init(
        systemName: String,
        accessibilityLabel: String,
        accessibilityIdentifier: String? = nil,
        action: @escaping () -> Void)
    {
        self.systemName = systemName
        self.accessibilityLabel = accessibilityLabel
        self.accessibilityIdentifier = accessibilityIdentifier
        self.action = action
    }
}

struct OpenClawSidebarRevealButton: View {
    let headerAction: OpenClawSidebarHeaderAction

    init(action: OpenClawSidebarHeaderAction) {
        self.headerAction = action
    }

    var body: some View {
        let button = Button(action: self.headerAction.action) {
            Image(systemName: self.headerAction.systemName)
                .font(.system(size: 16, weight: .semibold))
                .frame(width: 38, height: 38)
                .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawBrand.accent)
        .accessibilityLabel(self.headerAction.accessibilityLabel)

        if let accessibilityIdentifier = self.headerAction.accessibilityIdentifier {
            button.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            button
        }
    }
}

struct OpenClawSidebarHeaderLeadingSlot: View {
    let action: OpenClawSidebarHeaderAction

    var body: some View {
        OpenClawSidebarRevealButton(action: self.action)
            .frame(width: 44, height: 44, alignment: .center)
    }
}

struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View {
    let title: String
    let subtitle: String
    var titleFont: Font = .title3.weight(.semibold)
    var subtitleFont: Font = .subheadline
    var subtitleLineLimit: Int? = 2
    @ViewBuilder let leading: Leading
    @ViewBuilder let accessory: Accessory

    init(
        title: String,
        subtitle: String,
        titleFont: Font = .title3.weight(.semibold),
        subtitleFont: Font = .subheadline,
        subtitleLineLimit: Int? = 2,
        @ViewBuilder leading: () -> Leading,
        @ViewBuilder accessory: () -> Accessory)
    {
        self.title = title
        self.subtitle = subtitle
        self.titleFont = titleFont
        self.subtitleFont = subtitleFont
        self.subtitleLineLimit = subtitleLineLimit
        self.leading = leading()
        self.accessory = accessory()
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            self.horizontalLayout
            self.stackedLayout
        }
    }

    private var horizontalLayout: some View {
        HStack(alignment: .top, spacing: 12) {
            self.leading

            self.titleBlock
                .layoutPriority(1)

            Spacer(minLength: 8)

            self.accessory
                .fixedSize(horizontal: true, vertical: false)
        }
    }

    private var stackedLayout: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .top, spacing: 12) {
                self.leading

                self.titleBlock
                    .layoutPriority(1)

                Spacer(minLength: 8)
            }

            HStack {
                Spacer(minLength: 0)
                self.accessory
                    .fixedSize(horizontal: true, vertical: false)
            }
        }
    }

    private var titleBlock: some View {
        VStack(alignment: .leading, spacing: 4) {
            Text(self.title)
                .font(self.titleFont)
                .lineLimit(2)
                .minimumScaleFactor(0.86)
                .fixedSize(horizontal: false, vertical: true)
            Text(self.subtitle)
                .font(self.subtitleFont)
                .foregroundStyle(.secondary)
                .lineLimit(self.subtitleLineLimit)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

struct ProStatusDot: View {
    var color: Color

    var body: some View {
        Circle()
            .fill(self.color)
            .frame(width: 8, height: 8)
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
    var size: CGFloat = 42
    var shadowRadius: CGFloat = 10

    var body: some View {
        Image("OpenClawIcon")
            .resizable()
            .scaledToFit()
            .frame(width: self.size, height: self.size)
            .shadow(color: OpenClawBrand.accent.opacity(0.18), radius: self.shadowRadius, y: self.shadowRadius / 3)
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
                .lineLimit(1)
                .minimumScaleFactor(0.78)
        }
        .fixedSize(horizontal: true, vertical: false)
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

struct OpenClawGatewayCompactPill: View {
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        ProCapsule(
            title: self.title,
            color: self.color,
            icon: self.icon)
            .accessibilityLabel("Gateway \(self.title)")
    }

    private var title: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            "Online"
        case .connecting:
            "Connecting"
        case .error:
            "Attention"
        case .disconnected:
            "Offline"
        }
    }

    private var color: Color {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            OpenClawBrand.ok
        case .connecting:
            OpenClawBrand.accent
        case .error:
            OpenClawBrand.warn
        case .disconnected:
            .secondary
        }
    }

    private var icon: String {
        switch GatewayStatusBuilder.build(appModel: self.appModel) {
        case .connected:
            "checkmark.circle.fill"
        case .connecting:
            "arrow.triangle.2.circlepath"
        case .error:
            "exclamationmark.triangle.fill"
        case .disconnected:
            "wifi.slash"
        }
    }
}

struct ProMetricTile: View {
    @Environment(\.colorScheme) private var colorScheme
    let title: String
    let value: String
    let icon: String
    let color: Color

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack {
                Image(systemName: self.icon)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.color)
                    .frame(width: 24, height: 24)
                    .background(self.color.opacity(self.colorScheme == .dark ? 0.18 : 0.10), in: Circle())
                Spacer(minLength: 4)
            }

            VStack(alignment: .leading, spacing: 2) {
                Text(self.value)
                    .font(.headline.weight(.bold))
                    .lineLimit(1)
                    .minimumScaleFactor(0.72)
                Text(self.title)
                    .font(.caption2.weight(.medium))
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
        .padding(11)
        .frame(maxWidth: .infinity, alignment: .leading)
        .proGlassSurface(
            fill: self.colorScheme == .dark ? Color.white.opacity(0.04) : Color.white.opacity(0.52),
            stroke: self.color.opacity(self.colorScheme == .dark ? 0.18 : 0.10),
            radius: 16)
    }
}

struct ProMetric: Identifiable {
    let id = UUID()
    let icon: String
    let title: String
    let value: String
    let color: Color
}

struct ProMetricGrid: View {
    @Environment(\.horizontalSizeClass) private var horizontalSizeClass
    let metrics: [ProMetric]

    var body: some View {
        LazyVGrid(
            columns: Array(repeating: GridItem(.flexible()), count: self.columnCount),
            spacing: 10)
        {
            ForEach(self.metrics) { metric in
                ProMetricTile(
                    title: metric.title,
                    value: metric.value,
                    icon: metric.icon,
                    color: metric.color)
            }
        }
        .padding(.horizontal, OpenClawProMetric.pagePadding)
    }

    private var columnCount: Int {
        guard self.horizontalSizeClass != .compact else { return 1 }
        return min(max(self.metrics.count, 1), 3)
    }
}

struct ProPanelHeader: View {
    let title: String
    var value: String?
    var actionTitle: String?
    var actionIcon: String?
    var actionAccessibilityLabel: String?
    var isActionDisabled = false
    var action: (() -> Void)?

    var body: some View {
        HStack(spacing: 8) {
            Text(self.title)
                .font(.subheadline.weight(.semibold))
            if let value {
                Text(value)
                    .font(.caption2.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            Spacer(minLength: 8)
            self.actionControl
        }
        .padding(.horizontal, 14)
        .padding(.top, 12)
        .padding(.bottom, 8)
    }

    @ViewBuilder
    private var actionControl: some View {
        if let action {
            if let actionIcon {
                Button(action: action) {
                    Image(systemName: actionIcon)
                }
                .accessibilityLabel(self.actionAccessibilityLabel ?? self.actionTitle ?? self.title)
                .disabled(self.isActionDisabled)
            } else if let actionTitle {
                Button(actionTitle, action: action)
                    .font(.caption.weight(.semibold))
                    .disabled(self.isActionDisabled)
            }
        }
    }
}

struct ProStatusRow: View {
    let icon: String
    let title: String
    let detail: String
    let value: String?
    let color: Color
    var actionTitle: String?
    var action: (() -> Void)?

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            ProIconBadge(systemName: self.icon, color: self.color)
            VStack(alignment: .leading, spacing: 4) {
                Text(self.title)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(1)
                Text(self.detail)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 6) {
                if let value {
                    ProValuePill(value: value, color: self.color)
                }
                if let actionTitle, let action {
                    Button(actionTitle, action: action)
                        .font(.caption.weight(.semibold))
                        .buttonStyle(.bordered)
                        .controlSize(.mini)
                }
            }
        }
        .padding(.horizontal, 14)
        .padding(.vertical, 10)
    }
}
