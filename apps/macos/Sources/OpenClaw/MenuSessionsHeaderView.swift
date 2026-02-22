import SwiftUI

struct MenuSessionsHeaderView: View {
    let count: Int
    let statusText: String?

    private let paddingTop: CGFloat = 5
    private let paddingBottom: CGFloat = 3
    private let paddingTrailing: CGFloat = 10
    private let paddingLeading: CGFloat = 12

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                Image(systemName: "list.bullet")
                    .font(.system(size: 13, weight: .regular))
                    .foregroundStyle(.primary)
                    .frame(width: 16, height: 16, alignment: .center)
                Text("Context")
                    .font(.system(size: 13))
                    .foregroundStyle(.primary)
                Spacer(minLength: 10)
                Text(self.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let statusText, !statusText.isEmpty {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .truncationMode(.tail)
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
        if self.count == 1 { return "1 session · 24h" }
        return "\(self.count) sessions · 24h"
    }
}
