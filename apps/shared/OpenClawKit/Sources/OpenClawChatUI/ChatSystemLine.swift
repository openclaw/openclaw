import SwiftUI

struct ChatSystemLine: View {
    let systemImage: String
    let label: String
    let metric: String?

    var body: some View {
        ChatSystemRules { self.labelContent }
    }

    var labelContent: some View {
        HStack(spacing: 5) {
            Image(systemName: self.systemImage)
                .font(.system(size: 11, weight: .medium))
                .accessibilityHidden(true)
            Text(self.label.uppercased())
                .font(OpenClawChatTypography.captionSemiBold)
                .tracking(0.5)
            if let metric {
                Text("·")
                    .font(OpenClawChatTypography.caption)
                    .accessibilityHidden(true)
                Text(metric)
                    .font(OpenClawChatTypography.caption)
                    .monospacedDigit()
            }
        }
        .lineLimit(1)
        .minimumScaleFactor(0.75)
    }
}

struct ChatSystemRules<Label: View>: View {
    @ViewBuilder let label: Label

    var body: some View {
        HStack(spacing: 8) {
            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(height: 1)
            self.label
                // The rules take what the label leaves; equal thirds truncated any label longer than a third of the
                // row.
                    .layoutPriority(1)
            Rectangle()
                .fill(OpenClawChatTheme.divider)
                .frame(height: 1)
        }
    }
}
