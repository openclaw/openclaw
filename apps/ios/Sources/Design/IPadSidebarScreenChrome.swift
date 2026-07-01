import SwiftUI

struct IPadSidebarScreenChrome<Content: View>: View {
    @Environment(\.verticalSizeClass) private var verticalSizeClass
    let title: String
    let subtitle: String
    let headerLeadingAction: OpenClawSidebarHeaderAction?
    let gatewayAction: (() -> Void)?
    @ViewBuilder var content: Content

    init(
        title: String,
        subtitle: String,
        headerLeadingAction: OpenClawSidebarHeaderAction? = nil,
        gatewayAction: (() -> Void)? = nil,
        @ViewBuilder content: () -> Content)
    {
        self.title = title
        self.subtitle = subtitle
        self.headerLeadingAction = headerLeadingAction
        self.gatewayAction = gatewayAction
        self.content = content()
    }

    var body: some View {
        ZStack {
            OpenClawProBackground()
            ScrollView {
                VStack(alignment: .leading, spacing: self.isCompactHeight ? 10 : 16) {
                    OpenClawAdaptiveHeaderRow(
                        title: self.title,
                        subtitle: self.subtitle,
                        titleFont: self.isCompactHeight ? .headline.weight(.semibold) : .title2.weight(.semibold),
                        subtitleLineLimit: self.isCompactHeight ? 1 : 2)
                    {
                        if let headerLeadingAction {
                            OpenClawSidebarHeaderLeadingSlot(action: headerLeadingAction)
                        }
                    } accessory: {
                        self.gatewayPill
                    }
                    .padding(.horizontal, OpenClawProMetric.pagePadding)
                    self.content
                }
                .padding(.vertical, self.isCompactHeight ? 10 : 18)
            }
            .safeAreaPadding(.bottom, self.bottomScrollInset)
        }
    }

    private var isCompactHeight: Bool {
        self.verticalSizeClass == .compact
    }

    @ViewBuilder
    private var gatewayPill: some View {
        if let gatewayAction {
            Button(action: gatewayAction) {
                OpenClawGatewayCompactPill()
            }
            .buttonBorderShape(.capsule)
            .openClawGlassButton()
            .accessibilityHint("Opens Settings / Gateway")
        } else {
            OpenClawGatewayCompactPill()
        }
    }

    private var bottomScrollInset: CGFloat {
        self.isCompactHeight ? 150 : OpenClawProMetric.bottomScrollInset
    }
}
