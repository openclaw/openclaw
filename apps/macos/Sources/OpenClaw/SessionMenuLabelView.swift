import SwiftUI

extension EnvironmentValues {
    @Entry var menuItemHighlighted: Bool = false
}

struct SessionMenuLabelView: View {
    let row: SessionRow
    let width: CGFloat
    private let paddingLeading: CGFloat = 12
    private let paddingTrailing: CGFloat = 14
    private let barHeight: CGFloat = 6

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            ContextUsageBar(
                usedTokens: self.row.tokens.total,
                contextTokens: self.row.tokens.contextTokens,
                width: max(1, self.width - (self.paddingLeading + self.paddingTrailing)),
                height: self.barHeight)

            HStack(alignment: .firstTextBaseline, spacing: 2) {
                Text(self.row.label)
                    .font(.caption.weight(self.row.key == "main" ? .semibold : .regular))
                    .foregroundStyle(Color.primary)
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)

                Spacer(minLength: 4)

                Text("\(self.row.tokens.contextSummaryShort) · \(self.row.ageText)")
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(Color.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)

                Image(systemName: "chevron.right")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(Color.secondary)
                    .padding(.leading, 2)
            }
        }
        .padding(.vertical, 6)
        .padding(.leading, self.paddingLeading)
        .padding(.trailing, self.paddingTrailing)
    }
}
