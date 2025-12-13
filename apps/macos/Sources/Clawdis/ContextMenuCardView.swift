import Foundation
import SwiftUI

/// Context usage card shown at the top of the menubar menu.
struct ContextMenuCardView: View {
    private let rows: [SessionRow]
    private let statusText: String?
    private let padding: CGFloat = 10
    private let barHeight: CGFloat = 3

    init(
        rows: [SessionRow],
        statusText: String? = nil
    ) {
        self.rows = rows
        self.statusText = statusText
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(alignment: .firstTextBaseline) {
                Text("Context")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 10)
                Text(self.subtitle)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }

            if let statusText {
                Text(statusText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else if self.rows.isEmpty {
                Text("No active sessions")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                VStack(alignment: .leading, spacing: 8) {
                    ForEach(self.rows) { row in
                        self.sessionRow(row)
                    }
                }
            }
        }
        .padding(self.padding)
        .frame(minWidth: 300, maxWidth: .infinity, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
                }
        }
    }

    private var subtitle: String {
        let count = self.rows.count
        if count == 1 { return "1 session · 24h" }
        return "\(count) sessions · 24h"
    }

    @ViewBuilder
    private func sessionRow(_ row: SessionRow) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            ContextUsageBar(
                usedTokens: row.tokens.total,
                contextTokens: row.tokens.contextTokens,
                height: self.barHeight)

            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(row.key)
                    .font(.caption.weight(row.key == "main" ? .semibold : .regular))
                    .lineLimit(1)
                    .truncationMode(.middle)
                    .layoutPriority(1)
                Spacer(minLength: 8)
                Text(row.tokens.contextSummaryShort)
                    .font(.caption.monospacedDigit())
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .fixedSize(horizontal: true, vertical: false)
                    .layoutPriority(2)
            }
        }
    }
}
