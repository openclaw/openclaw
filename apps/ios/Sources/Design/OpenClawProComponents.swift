import OpenClawChatUI
import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
    static let controlRadius: CGFloat = 12
    static let compactControlSize: CGFloat = 36
    static let bottomScrollInset: CGFloat = 96
}

enum OpenClawRadius {
    static let xs: CGFloat = 8
    static let sm: CGFloat = 10
    static let md: CGFloat = 12
}

enum OpenClawTextValue: ExpressibleByStringLiteral {
    case localized(LocalizedStringKey)
    case verbatim(String)

    init(stringLiteral value: String) {
        self = .localized(LocalizedStringKey(value))
    }

    static func localized(_ value: String) -> Self {
        .localized(LocalizedStringKey(value))
    }

    var text: Text {
        switch self {
        case let .localized(key):
            Text(key)
        case let .verbatim(value):
            Text(verbatim: value)
        }
    }
}

struct OpenClawProBackground: View {
    var body: some View {
        Color(uiColor: .systemGroupedBackground)
            .ignoresSafeArea()
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

extension View {
    func proPanelSurface(
        tint: Color? = nil,
        radius: CGFloat = OpenClawProMetric.cardRadius,
        isProminent: Bool = false) -> some View
    {
        modifier(ProPanelSurfaceModifier(
            tint: tint,
            radius: radius,
            isProminent: isProminent))
    }

    @ViewBuilder
    func openClawGlassButton(prominent: Bool = false, tint: Color? = nil) -> some View {
        if #available(iOS 26.0, *) {
            if prominent {
                self
                    .font(OpenClawType.subheadSemiBold)
                    .buttonStyle(.glassProminent)
                    .tint(tint ?? OpenClawBrand.accentFill)
            } else {
                self
                    .font(OpenClawType.subheadSemiBold)
                    .buttonStyle(.glass)
                    .tint(tint)
            }
        } else if prominent {
            self
                .font(OpenClawType.subheadSemiBold)
                .buttonStyle(.borderedProminent)
                .tint(tint ?? OpenClawBrand.accentFill)
        } else {
            self
                .font(OpenClawType.subheadSemiBold)
                .buttonStyle(.bordered)
                .tint(tint)
        }
    }

    @ViewBuilder
    func openClawGlassSurface() -> some View {
        if #available(iOS 26.0, *) {
            self.glassEffect(.regular, in: .rect(cornerRadius: OpenClawProMetric.controlRadius))
        } else {
            self.background(
                .regularMaterial,
                in: RoundedRectangle(cornerRadius: OpenClawProMetric.controlRadius, style: .continuous))
        }
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
                let shape = RoundedRectangle(cornerRadius: self.radius, style: .continuous)
                shape
                    .fill(Color(uiColor: self.isProminent ? .systemBackground : .secondarySystemGroupedBackground))
                    .overlay {
                        shape.strokeBorder(self.borderStyle, lineWidth: 1)
                    }
            }
            .shadow(
                color: self.isProminent
                    ? (self.colorScheme == .dark ? .black.opacity(0.14) : .black.opacity(0.045))
                    : .clear,
                radius: self.isProminent ? 5 : 0,
                y: self.isProminent ? 2 : 0)
    }

    private var borderStyle: Color {
        if let tint {
            return tint.opacity(self.isProminent ? 0.18 : 0.10)
        }
        return Color(uiColor: .separator).opacity(self.colorScheme == .dark ? 0.22 : 0.12)
    }
}

struct ProIconBadge: View {
    let systemName: String
    let color: Color

    var body: some View {
        Image(systemName: self.systemName)
            .font(OpenClawType.captionSemiBold)
            .foregroundStyle(self.color)
            .frame(width: 30, height: 30)
            .background {
                RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous)
                    .fill(self.color.opacity(0.12))
            }
    }
}

struct OpenClawSidebarHeaderAction {
    let systemName: String
    let accessibilityLabel: OpenClawTextValue
    var accessibilityIdentifier: String?
    let action: () -> Void
}

struct OpenClawSidebarControlButton: View {
    let action: OpenClawSidebarHeaderAction

    var body: some View {
        self.identified(self.button.buttonStyle(.plain))
    }

    private var button: some View {
        Button(action: self.action.action) {
            self.icon
        }
        .frame(width: 44, height: 44)
        .contentShape(Rectangle())
        .accessibilityLabel(self.action.accessibilityLabel.text)
    }

    private var icon: some View {
        Image(systemName: self.action.systemName)
            .font(OpenClawType.subheadSemiBold)
            .foregroundStyle(OpenClawBrand.accent)
            .frame(
                width: OpenClawProMetric.compactControlSize,
                height: OpenClawProMetric.compactControlSize)
    }

    @ViewBuilder
    private func identified(_ button: some View) -> some View {
        if let accessibilityIdentifier = self.action.accessibilityIdentifier {
            button.accessibilityIdentifier(accessibilityIdentifier)
        } else {
            button
        }
    }
}

struct OpenClawSidebarToolbarItem: ToolbarContent {
    let action: OpenClawSidebarHeaderAction
    let placement: ToolbarItemPlacement

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if #available(iOS 26.0, *) {
            ToolbarItem(placement: self.placement) {
                OpenClawSidebarControlButton(action: self.action)
            }
            // Sidebar reveal is intentionally background-free in every host;
            // suppress the toolbar's automatic glass so it cannot reappear.
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: self.placement) {
                OpenClawSidebarControlButton(action: self.action)
            }
        }
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
    let title: OpenClawTextValue
    let message: OpenClawTextValue
    let ownerLabel: OpenClawTextValue
    let tint: Color
    var detail: OpenClawNoticeDetail?
    var primaryActionTitle: OpenClawTextValue?
    var onPrimaryAction: (() -> Void)?
    var secondaryActionTitle: OpenClawTextValue?
    var onSecondaryAction: (() -> Void)?

    var body: some View {
        ProCard(tint: self.tint, padding: 14) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 12) {
                    ProIconBadge(systemName: self.icon, color: self.tint)

                    VStack(alignment: .leading, spacing: 6) {
                        HStack(alignment: .firstTextBaseline, spacing: 8) {
                            self.title.text
                                .font(OpenClawType.subheadSemiBold)
                                .multilineTextAlignment(.leading)
                            Spacer(minLength: 0)
                            self.ownerLabel.text
                                .font(OpenClawType.captionSemiBold)
                                .foregroundStyle(.secondary)
                        }

                        self.message.text
                            .font(OpenClawType.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)

                        self.detailView
                    }
                }

                if self.onPrimaryAction != nil || self.onSecondaryAction != nil {
                    OpenClawGlassControlGroup {
                        HStack(spacing: 10) {
                            if let primaryActionTitle, let onPrimaryAction {
                                Button(action: onPrimaryAction) {
                                    primaryActionTitle.text
                                        .font(OpenClawType.captionSemiBold)
                                }
                                .font(OpenClawType.captionSemiBold)
                                .openClawGlassButton(prominent: true)
                                .controlSize(.small)
                            }
                            if let secondaryActionTitle, let onSecondaryAction {
                                Button(action: onSecondaryAction) {
                                    secondaryActionTitle.text
                                        .font(OpenClawType.captionSemiBold)
                                }
                                .font(OpenClawType.captionSemiBold)
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
                    .font(OpenClawType.captionMedium)
                    .foregroundStyle(self.tint)
                    .fixedSize(horizontal: false, vertical: true)
            case let .requestID(value):
                Text(verbatim: String(
                    format: String(localized: "Request ID: %@"),
                    value))
                    .font(OpenClawType.monoSmallMedium)
                    .foregroundStyle(.secondary)
                    .textSelection(.enabled)
            }
        }
    }
}

struct OpenClawAdaptiveHeaderRow<Leading: View, Accessory: View>: View {
    let title: OpenClawTextValue
    let subtitle: OpenClawTextValue?
    var titleFont: Font = OpenClawType.title3SemiBold
    var subtitleFont: Font = OpenClawType.subhead
    var subtitleLineLimit: Int? = 2
    @ViewBuilder let leading: Leading
    @ViewBuilder let accessory: Accessory

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
            self.title.text
                .font(self.titleFont)
                .lineLimit(2)
                .minimumScaleFactor(0.86)
                .fixedSize(horizontal: false, vertical: true)
            if let subtitle {
                subtitle.text
                    .font(self.subtitleFont)
                    .foregroundStyle(.secondary)
                    .lineLimit(self.subtitleLineLimit)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }
}

/// Shared switch indicator replacing the 3 duplicated capsule toggles.
/// Native Toggle only hits the switch edge on iOS 26; this full-width button approach
/// gives the whole row a tap target.
struct OpenClawToggleIndicator: View {
    let isOn: Bool

    var body: some View {
        Capsule()
            .fill(self.isOn ? OpenClawBrand.accentFill : Color.secondary.opacity(0.35))
            .frame(width: 52, height: 32)
            .overlay(alignment: self.isOn ? .trailing : .leading) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 28, height: 28)
                    .padding(2)
                    .shadow(color: Color.black.opacity(0.14), radius: 1, x: 0, y: 1)
            }
    }
}

enum OpenClawStatusTone {
    case ok
    case warn
    case accent
    case muted

    var color: Color {
        switch self {
        case .ok: OpenClawBrand.ok
        case .warn: OpenClawBrand.warn
        case .accent: OpenClawBrand.accent
        case .muted: OpenClawBrand.textSecondary
        }
    }
}

struct OpenClawStatusBadge: View {
    @Environment(\.colorScheme) private var colorScheme
    let label: OpenClawTextValue
    let tone: OpenClawStatusTone

    var body: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.tone.color)
                .frame(width: 7, height: 7)
                .shadow(color: self.tone.color.opacity(0.55), radius: 3)
            self.label.text
                .font(OpenClawType.caption2SemiBold)
                .foregroundStyle(self.tone.color)
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background {
            Capsule()
                .fill(self.tone.color.opacity(self.colorScheme == .dark ? 0.14 : 0.10))
        }
    }
}

struct OpenClawProMark: View {
    var size: CGFloat = 42
    var shadowRadius: CGFloat = 10
    /// Opt-in tap Easter eggs; leave off when the mark sits inside a control.
    var interactive = false
    var paused = false

    var body: some View {
        OpenClawMascotView(interactive: self.interactive, paused: self.paused)
            .frame(width: self.size, height: self.size)
            .shadow(color: OpenClawBrand.accent.opacity(0.18), radius: self.shadowRadius, y: self.shadowRadius / 3)
            .accessibilityLabel("OpenClaw")
    }
}

struct OpenClawGatewayCompactPill: View {
    @Environment(NodeAppModel.self) private var appModel

    var body: some View {
        let presentation = GatewayStatusBuilder.build(appModel: self.appModel).statusPresentation
        OpenClawStatusBadge(label: .verbatim(presentation.title), tone: presentation.tone)
            .accessibilityLabel(
                String(
                    format: String(localized: "Gateway %@"),
                    presentation.title))
    }
}

extension GatewayDisplayState {
    var statusPresentation: (title: String, tone: OpenClawStatusTone) {
        switch self {
        case .connected:
            (String(localized: "Online"), .ok)
        case .connecting:
            (String(localized: "Connecting"), .accent)
        case .error:
            (String(localized: "Attention"), .warn)
        case .disconnected:
            (String(localized: "Offline"), .muted)
        }
    }
}
