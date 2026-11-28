import SwiftUI
import UIKit

/// The sidebar's Pinned and Sessions blocks while the first connection loads, built from the
/// list's own parts: the real section headings, then rows laid out exactly like
/// `RootSidebarSessionButton` (44-point minimum, 10-point inset, 4-point pitch). A row at rest is its
/// title alone, so each bar sits on the baseline of a blank title line and is as tall as the title's
/// capitals: the arriving list lands on the same lines. There is no motion.
struct RootSidebarSessionSkeleton: View {
    let pinsCollapsed: Bool
    let sessionsCollapsed: Bool

    /// The faintest ink that still reads on the sidebar surface in each appearance.
    static let ink = Color(uiColor: UIColor { traits in
        traits.userInterfaceStyle == .dark
            ? UIColor(white: 1, alpha: 0.07)
            : UIColor(white: 0, alpha: 0.055)
    })

    /// Cap height of the 15-point title face, scaled with Dynamic Type.
    @ScaledMetric(relativeTo: .subheadline) private var capHeight: CGFloat = 11
    /// Three title lengths, scaled with the text.
    @ScaledMetric(relativeTo: .subheadline) private var short: CGFloat = 84
    @ScaledMetric(relativeTo: .subheadline) private var medium: CGFloat = 120
    @ScaledMetric(relativeTo: .subheadline) private var long: CGFloat = 156

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.section(String(localized: "Pinned"), collapsed: self.pinsCollapsed) {
                self.row(self.medium)
                self.row(self.long)
                self.row(self.short)
            }
            self.section(String(localized: "Sessions"), collapsed: self.sessionsCollapsed) {
                self.row(self.long)
                self.row(self.medium)
                self.row(self.short)
                self.row(self.medium)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    private func section(
        _ title: String,
        collapsed: Bool,
        @ViewBuilder rows: () -> some View) -> some View
    {
        VStack(alignment: .leading, spacing: 4) {
            SessionSectionHeader(title: title, isCollapsed: .constant(collapsed), id: "")
                .allowsHitTesting(false)
            if !collapsed {
                rows()
            }
        }
    }

    private func row(_ width: CGFloat) -> some View {
        // A blank title in the title's font gives the bar the row's real line box and baseline.
        Text(verbatim: " ")
            .font(OpenClawType.subheadMedium)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .overlay(alignment: Alignment(horizontal: .leading, vertical: .firstTextBaseline)) {
                RoundedRectangle(cornerRadius: self.capHeight / 2.5, style: .continuous)
                    .fill(Self.ink)
                    .frame(width: width, height: self.capHeight)
                    .alignmentGuide(.firstTextBaseline) { $0[.bottom] }
            }
            .padding(.horizontal, 10)
    }
}
