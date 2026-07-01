import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
    static let controlRadius: CGFloat = 12
    static let compactControlSize: CGFloat = 36
    static let bottomScrollInset: CGFloat = 96
}

struct OpenClawProBackground: View {
    var body: some View {
        Color(uiColor: .systemGroupedBackground)
            .ignoresSafeArea()
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
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
                .textCase(self.uppercase ? .uppercase : nil)
            Spacer()
            if let actionTitle {
                if let action {
                    Button(actionTitle, action: action)
                        .font(.footnote.weight(.medium))
                        .foregroundStyle(OpenClawBrand.accent)
                } else {
                    Text(actionTitle)
                        .font(.footnote.weight(.medium))
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
    }

    private var fill: AnyShapeStyle {
        let color = self.isProminent ? UIColor.systemBackground : UIColor.secondarySystemGroupedBackground
        return AnyShapeStyle(Color(uiColor: color))
    }

    private var borderStyle: AnyShapeStyle {
        if let tint {
            return AnyShapeStyle(tint.opacity(self.isProminent ? 0.18 : 0.10))
        }
        return AnyShapeStyle(Color(uiColor: .separator).opacity(self.colorScheme == .dark ? 0.22 : 0.12))
    }
}

private struct ProInsetSurfaceModifier: ViewModifier {
    @Environment(\.colorScheme) private var colorScheme
    let tint: Color
    let radius: CGFloat

    func body(content: Content) -> some View {
        let shape = RoundedRectangle(cornerRadius: self.radius, style: .continuous)
        content.background {
            shape
                .fill(Color(uiColor: .tertiarySystemGroupedBackground))
                .overlay {
                    shape.strokeBorder(
                        self.tint.opacity(self.colorScheme == .dark ? 0.18 : 0.10),
                        lineWidth: 1)
                }
        }
    }
}

private struct OpenClawGlassButtonModifier: ViewModifier {
    let prominent: Bool
    let tint: Color?

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            if self.prominent {
                content
                    .buttonStyle(.glassProminent)
                    .tint(self.tint ?? OpenClawBrand.accent)
            } else {
                content
                    .buttonStyle(.glass)
                    .tint(self.tint)
            }
        } else if self.prominent {
            content
                .buttonStyle(.borderedProminent)
                .tint(self.tint ?? OpenClawBrand.accent)
        } else {
            content
                .buttonStyle(.bordered)
                .tint(self.tint)
        }
    }
}

private struct OpenClawTabBarBehaviorModifier: ViewModifier {
    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.tabBarMinimizeBehavior(.onScrollDown)
        } else {
            content
        }
    }
}

private struct OpenClawGlassSurfaceModifier: ViewModifier {
    let radius: CGFloat

    func body(content: Content) -> some View {
        if #available(iOS 26.0, *) {
            content.glassEffect(.regular, in: .rect(cornerRadius: self.radius))
        } else {
            content.background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: self.radius, style: .continuous))
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

    func proInsetSurface(tint: Color, radius: CGFloat) -> some View {
        self.modifier(ProInsetSurfaceModifier(tint: tint, radius: radius))
    }

    func openClawGlassButton(prominent: Bool = false, tint: Color? = nil) -> some View {
        self.modifier(OpenClawGlassButtonModifier(prominent: prominent, tint: tint))
    }

    func openClawTabBarBehavior() -> some View {
        self.modifier(OpenClawTabBarBehaviorModifier())
    }

    func openClawGlassSurface(radius: CGFloat = OpenClawProMetric.controlRadius) -> some View {
        self.modifier(OpenClawGlassSurfaceModifier(radius: radius))
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
                ProPanelBackground(
                    radius: self.radius,
                    tint: self.tint,
                    isProminent: self.isProminent)
            }
            .shadow(
                color: self.isProminent
                    ? (self.colorScheme == .dark ? .black.opacity(0.14) : .black.opacity(0.045))
                    : .clear,
                radius: self.isProminent ? 5 : 0,
                y: self.isProminent ? 2 : 0)
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
                .frame(
                    width: OpenClawProMetric.compactControlSize,
                    height: OpenClawProMetric.compactControlSize)
                .contentShape(Rectangle())
        }
        .buttonBorderShape(.circle)
        .openClawGlassButton(tint: OpenClawBrand.accent)
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

struct OpenClawGlassControlGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        if #available(iOS 26.0, *) {
            GlassEffectContainer(spacing: 8) {
                self.content
            }
        } else {
            self.content
        }
    }
}

enum OpenClawNoticeDetail {
    case accent(String)
    case requestID(String)
}

struct OpenClawNoticeBanner: View {
    let icon: String
    let title: String
    let message: String
    let ownerLabel: String
    let tint: Color
    var detail: OpenClawNoticeDetail?
    var primaryActionTitle: String?
    var onPrimaryAction: (() -> Void)?
    var secondaryActionTitle: String?
    var onSecondaryAction: (() -> Void)?

    var body: some View {
        ProCard(tint: self.tint, padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: self.icon, color: self.tint)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            Text(self.title)
                                .font(.subheadline.weight(.semibold))
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            Text(self.ownerLabel)
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                        }

                        Text(self.message)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        self.detailView
                    }
                }

                if self.onPrimaryAction != nil || self.onSecondaryAction != nil {
                    OpenClawGlassControlGroup {
                        HStack(spacing: 10) {
                            if let primaryActionTitle, let onPrimaryAction {
                                Button(primaryActionTitle, action: onPrimaryAction)
                                    .openClawGlassButton(prominent: true)
                                    .controlSize(.small)
                            }
                            if let secondaryActionTitle, let onSecondaryAction {
                                Button(secondaryActionTitle, action: onSecondaryAction)
                                    .openClawGlassButton()
                                    .controlSize(.small)
                            }
                        }
                    }
                }
            }
        }
    }

    @ViewBuilder
    private var detailView: some View {
        if let detail {
            switch detail {
            case let .accent(value):
                Text(value)
                    .font(.caption.weight(.medium))
                    .foregroundStyle(self.tint)
                    .fixedSize(horizontal: false, vertical: true)
            case let .requestID(value):
                Text("Request ID: \(value)")
                    .font(.system(.caption, design: .monospaced).weight(.medium))
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View {
    let title: String
    let subtitle: String?
    var titleFont: Font = .title3.weight(.semibold)
    var subtitleFont: Font = .subheadline
    var subtitleLineLimit: Int? = 2
    @ViewBuilder let leading: Leading
    @ViewBuilder let accessory: Accessory

    init(
        title: String,
        subtitle: String? = nil,
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
            if let subtitle, !subtitle.isEmpty {
                Text(subtitle)
                    .font(self.subtitleFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(self.subtitleLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
            }
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
            .font(.footnote.weight(.semibold))
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

struct OpenClawGatewayCompactPill: View {
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        HStack(spacing: 6) {
            Image(systemName: self.icon)
                .font(.caption.weight(.semibold))
            Text(self.title)
                .font(.caption.weight(.semibold))
                .lineLimit(1)
        }
        .foregroundStyle(self.color)
        .padding(.horizontal, 4)
        .frame(minHeight: 30)
        .fixedSize(horizontal: true, vertical: false)
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
        .proInsetSurface(tint: self.color, radius: OpenClawProMetric.controlRadius)
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
