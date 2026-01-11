import SwiftUI

struct UsageMenuLabelView: View {
    let row: UsageRow
    let width: CGFloat
    var showsChevron: Bool = false
    @Environment(\.menuItemHighlighted) private var isHighlighted
    private let paddingLeading: CGFloat = 22
    private let paddingTrailing: CGFloat = 14
    private let barHeight: CGFloat = 6

    private var primaryTextColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor) : .primary
    }

    private var secondaryTextColor: Color {
        self.isHighlighted ? Color(nsColor: .selectedMenuItemTextColor).opacity(0.85) : .secondary
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if let used = row.usedPercent {
                ContextUsageBar(
                    usedTokens: Int(round(used)),
                    contextTokens: 100,
                    width: max(1, self.width - (self.paddingLeading + self.paddingTrailing)),
                    height: self.barHeight)
            }

            HStack(alignment: .firstTextBaseline, spacing: 6) {
                Text(self.row.titleText)
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(self.primaryTextColor)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)

                Spacer(minLength: 4)

                if !self.row.hasError {
                    Text(self.row.detailText())
                        .font(.caption.monospacedDigit())
                        .foregroundStyle(self.secondaryTextColor)
                        .lineLimit(1)
                        .truncationMode(.tail)
                        .layoutPriority(2)
                }

                if self.showsChevron {
                    Image(systemName: "chevron.right")
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(self.secondaryTextColor)
                        .padding(.leading, 2)
                }
            }

            if let error = self.row.error?.nonEmpty {
                Text(error)
                    .font(.caption)
                    .foregroundStyle(self.secondaryTextColor)
                    .multilineTextAlignment(.leading)
                    .lineLimit(2)
                    .truncationMode(.tail)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 10)
        .padding(.leading, self.paddingLeading)
        .padding(.trailing, self.paddingTrailing)
    }
}
