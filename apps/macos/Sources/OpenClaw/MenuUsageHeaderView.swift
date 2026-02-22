import SwiftUI

struct MenuUsageHeaderView: View {
    let count: Int

    private let paddingTop: CGFloat = 5
    private let paddingBottom: CGFloat = 3
    private let paddingTrailing: CGFloat = 10
    private let paddingLeading: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: "bolt")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(.primary)
                    .frame(width: 16, height: 16, alignment: .center)
                Text("Usage")
                    .font(.system(size: 13))
                    .foregroundStyle(.primary)
                Spacer(minLength: 10)
                Text(self.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
        .padding(.top, self.paddingTop)
        .padding(.bottom, self.paddingBottom)
        .padding(.leading, self.paddingLeading)
        .padding(.trailing, self.paddingTrailing)
        .frame(minWidth: 300, maxWidth: .infinity, alignment: .leading)
        .transaction { txn in txn.animation = nil }
    }

    private var subtitle: String {
        if self.count == 1 { return "1 provider" }
        return "\(self.count) providers"
    }
}
