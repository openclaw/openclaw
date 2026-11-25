import SwiftUI

/// The fold control above Pinned and Recent in the sidebar, and above every group of the Sessions list.
struct SessionSectionHeader: View {
    let title: String
    @Binding var isCollapsed: Bool
    let id: String

    var body: some View {
        Button {
            self.isCollapsed.toggle()
        } label: {
            HStack(spacing: 6) {
                Text(verbatim: self.title)
                    .font(OpenClawType.captionMedium)
                Image(systemName: self.isCollapsed ? "chevron.right" : "chevron.down")
                    .font(.system(size: 9, weight: .semibold))
                    .accessibilityHidden(true)
            }
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .frame(maxWidth: .infinity, minHeight: 32, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(.isHeader)
        .accessibilityValue(self.isCollapsed ? Text("Collapsed") : Text("Expanded"))
        .accessibilityIdentifier(self.id)
    }
}
