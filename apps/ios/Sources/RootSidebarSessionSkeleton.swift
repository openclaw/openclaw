import SwiftUI

/// Mirrors the sidebar's two 32-point section headings, 44-point rows and section spacing.
/// The neutral bars are deliberately static, including when Reduce Motion is off.
struct RootSidebarSessionSkeleton: View {
    let pinsCollapsed: Bool
    let sessionsCollapsed: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.section(headingWidth: 46, collapsed: self.pinsCollapsed) {
                self.row(title: 122)
                self.row(title: 168, subtitle: 80)
            }
            self.section(headingWidth: 58, collapsed: self.sessionsCollapsed) {
                self.row(title: 148)
                self.row(title: 106, subtitle: 66)
                self.row(title: 154)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, 10)
    }

    private func section(headingWidth: CGFloat, collapsed: Bool, @ViewBuilder rows: () -> some View) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            self.bar(width: headingWidth, height: 6, opacity: 0.07)
                .frame(minHeight: 32)
            if !collapsed { rows() }
        }
    }

    private func row(title: CGFloat, subtitle: CGFloat? = nil) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            self.bar(width: title, height: 10, opacity: 0.09)
            if let subtitle { self.bar(width: subtitle, height: 6, opacity: 0.06) }
        }
        .frame(minHeight: 44)
    }

    private func bar(width: CGFloat, height: CGFloat, opacity: Double) -> some View {
        RoundedRectangle(cornerRadius: height / 2, style: .continuous)
            .fill(Color.primary.opacity(opacity))
            .frame(maxWidth: width)
            .frame(height: height)
    }
}
