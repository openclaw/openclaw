import OpenClawChatUI
import SwiftUI

enum OpenClawProMetric {
    static let pagePadding: CGFloat = 16
    static let cardRadius: CGFloat = 16
    static let controlRadius: CGFloat = 12
    static let compactControlSize: CGFloat = 36
    // periphery:ignore - DESIGN.md specifies this shared inset for clearance above persistent navigation.
    static let bottomScrollInset: CGFloat = 96
}

enum OpenClawRadius {
    static let xs: CGFloat = 8
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
        OpenClawBrand.canvas
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
    @ViewBuilder
    func openClawToolbarGlyphScale() -> some View {
        if #available(iOS 27.1, *) {
            self.modifier(OpenClawVerticalToolbarGlyphScale())
        } else {
            self
        }
    }

    @ViewBuilder
    func openClawToolbarHitTarget(preservesIntrinsicWidth: Bool = false) -> some View {
        if #available(iOS 27.1, *) {
            self.modifier(OpenClawToolbarHitTarget(preservesIntrinsicWidth: preservesIntrinsicWidth))
        } else if preservesIntrinsicWidth {
            self.frame(minHeight: 44)
        } else {
            self.frame(width: 44, height: 44)
        }
    }

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
    }
}

@available(iOS 27.1, *)
private struct OpenClawVerticalToolbarGlyphScale: ViewModifier {
    @Environment(\.toolbarVerticalEdge) private var verticalEdge

    func body(content: Content) -> some View {
        // Enlarge only the artwork inside its matching 52pt target. Follow
        // the system bar's actual axis instead of guessing from screen width.
        content.scaleEffect(
            self.verticalEdge != nil && UIDevice.current.userInterfaceIdiom == .phone ? 1.3 : 1)
    }
}

@available(iOS 27.1, *)
private struct OpenClawToolbarHitTarget: ViewModifier {
    @Environment(\.toolbarVerticalEdge) private var verticalEdge
    let preservesIntrinsicWidth: Bool

    func body(content: Content) -> some View {
        let isSideToolbar = self.verticalEdge != nil && UIDevice.current.userInterfaceIdiom == .phone
        let size: CGFloat = isSideToolbar ? 52 : 44
        content.frame(
            minWidth: isSideToolbar || !self.preservesIntrinsicWidth ? size : nil,
            maxWidth: isSideToolbar || !self.preservesIntrinsicWidth ? size : nil,
            minHeight: size,
            maxHeight: self.preservesIntrinsicWidth && !isSideToolbar ? nil : size)
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
                    .fill(OpenClawBrand.surfaceRaised)
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
        return OpenClawBrand.border
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
    /// The drawer's reveal control stays in its toolbar slot while the drawer covers it.
    /// Only the button observes this presentation.
    var drawerPresentation: RootSidebarPresentation?
    var hasApprovalAttention = false
    let action: () -> Void

    /// Read only in the button to avoid rebuilding the destination or its toolbar.
    var isShown: Bool {
        self.drawerPresentation?.isPresented != true
    }
}

/// Builds `content` for a destination that owns the sidebar reveal control.
struct OpenClawSidebarRevealContent<Content: View>: View {
    let action: OpenClawSidebarHeaderAction?
    @ViewBuilder let content: (OpenClawSidebarHeaderAction) -> Content

    var body: some View {
        if let action = self.action {
            self.content(action)
        }
    }
}

/// Keeps navigation bar visibility tied to the destination's header configuration.
struct OpenClawSidebarRevealToolbarVisibility: ViewModifier {
    let action: OpenClawSidebarHeaderAction?
    let visibility: (_ hasRevealControl: Bool) -> Visibility

    func body(content: Content) -> some View {
        content.toolbar(self.visibility(self.action != nil), for: .navigationBar)
    }
}

struct OpenClawRoundNavigationButton<Glyph: View>: View {
    let action: () -> Void
    @ViewBuilder let glyph: () -> Glyph

    var body: some View {
        Button(action: self.action) {
            self.glyph().openClawToolbarHitTarget().contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .glassEffect(.regular.interactive(), in: Circle())
    }
}

struct OpenClawSidebarControlButton: View {
    let action: OpenClawSidebarHeaderAction
    var glass: Glass = .identity

    private static let chatMenuGlyph = UIGraphicsImageRenderer(size: CGSize(width: 16, height: 8)).image { _ in
        UIColor.black.setFill()
        UIBezierPath(roundedRect: CGRect(x: 0, y: 0, width: 16, height: 2), cornerRadius: 1).fill()
        UIBezierPath(roundedRect: CGRect(x: 0, y: 6, width: 10, height: 2), cornerRadius: 1).fill()
    }

    var body: some View {
        self.identified(self.button.buttonStyle(.plain))
            .glassEffect(self.glass, in: Circle())
            .opacity(self.action.isShown ? 1 : 0)
    }

    private var button: some View {
        Button(action: self.action.action) {
            Label {
                self.action.accessibilityLabel.text
                    .font(OpenClawType.body)
            } icon: {
                self.icon
            }
            .labelStyle(.iconOnly)
        }
        .openClawToolbarHitTarget()
        .contentShape(Rectangle())
        .accessibilityLabel(self.action.accessibilityLabel.text)
        .accessibilityValue(self.action.hasApprovalAttention
            ? String(localized: "Needs approval")
            : "")
    }

    private var icon: some View {
        Image(uiImage: Self.chatMenuGlyph)
            .renderingMode(.template)
            .foregroundStyle(Color(uiColor: .label))
            .openClawToolbarGlyphScale()
            .frame(width: OpenClawProMetric.compactControlSize, height: OpenClawProMetric.compactControlSize)
            .overlay(alignment: .topTrailing) {
                if self.action.hasApprovalAttention {
                    Circle()
                        .fill(OpenClawBrand.warn)
                        .frame(width: 7, height: 7)
                        .padding(7)
                        .allowsHitTesting(false)
                        .accessibilityHidden(true)
                }
            }
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
    var glass: Glass = .identity

    @ToolbarContentBuilder
    var body: some ToolbarContent {
        if #available(iOS 27.1, *) {
            self.item.axisBehavior(.verticalPreferred).visibilityPriority(.high)
        } else {
            self.item
        }
    }

    private var item: some ToolbarContent {
        ToolbarItem(placement: self.placement) {
            OpenClawSidebarControlButton(action: self.action, glass: self.glass)
        }
        // The button owns its background; do not add a second one in the toolbar.
        .sharedBackgroundVisibility(.hidden)
    }
}

struct OpenClawGlassControlGroup<Content: View>: View {
    @ViewBuilder let content: Content

    var body: some View {
        GlassEffectContainer(spacing: 8) {
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
        // The native switch's footprint (63x28 on iOS 26), so a Settings row with this indicator
        // is as tall as one with a system Toggle.
        Capsule()
            .fill(self.isOn ? OpenClawBrand.ok : Color.secondary.opacity(0.35))
            .frame(width: 63, height: 28)
            .overlay(alignment: self.isOn ? .trailing : .leading) {
                Circle()
                    .fill(Color.white)
                    .frame(width: 24, height: 24)
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
