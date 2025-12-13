import Foundation
import SwiftUI

/// Context usage card shown at the top of the menubar menu.
struct ContextMenuCardView: View {
    private let width: CGFloat
    private let padding: CGFloat = 10
    private let barHeight: CGFloat = 4

    @State private var rows: [SessionRow] = []
    @State private var activeCount: Int = 0

    private let activeWindowSeconds: TimeInterval = 24 * 60 * 60

    init(width: CGFloat) {
        self.width = width
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

            if self.rows.isEmpty {
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
        .frame(width: self.width, alignment: .leading)
        .background {
            RoundedRectangle(cornerRadius: 12, style: .continuous)
                .fill(Color.white.opacity(0.04))
                .overlay {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.06), lineWidth: 1)
                }
        }
        .task { await self.reload() }
    }

    private var subtitle: String {
        let count = self.activeCount
        if count == 1 { return "1 session · 24h" }
        return "\(count) sessions · 24h"
    }

    private var contentWidth: CGFloat {
        max(1, self.width - (self.padding * 2))
    }

    @ViewBuilder
    private func sessionRow(_ row: SessionRow) -> some View {
        let width = self.contentWidth
        VStack(alignment: .leading, spacing: 4) {
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
            .frame(width: width)

            ContextUsageBar(
                usedTokens: row.tokens.total,
                contextTokens: row.tokens.contextTokens,
                width: width,
                height: self.barHeight)
        }
        .frame(width: width)
    }

    @MainActor
    private func reload() async {
        let hints = SessionLoader.configHints()
        let store = SessionLoader.resolveStorePath(override: hints.storePath)
        let defaults = SessionDefaults(
            model: hints.model ?? SessionLoader.fallbackModel,
            contextTokens: hints.contextTokens ?? SessionLoader.fallbackContextTokens)

        guard let loaded = try? await SessionLoader.loadRows(at: store, defaults: defaults) else {
            self.rows = []
            self.activeCount = 0
            return
        }

        let now = Date()
        let active = loaded.filter { row in
            guard let updatedAt = row.updatedAt else { return false }
            return now.timeIntervalSince(updatedAt) <= self.activeWindowSeconds
        }

        let main = loaded.first(where: { $0.key == "main" })
        var merged = active
        if let main, !merged.contains(where: { $0.key == "main" }) {
            merged.insert(main, at: 0)
        }

        merged.sort { lhs, rhs in
            if lhs.key == "main" { return true }
            if rhs.key == "main" { return false }
            return (lhs.updatedAt ?? .distantPast) > (rhs.updatedAt ?? .distantPast)
        }

        self.rows = merged
        self.activeCount = active.count
    }
}

