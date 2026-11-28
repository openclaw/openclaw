#if os(iOS)
import SwiftUI

/// Rows and reader use the dock's existing session-scoped snapshot and view model. Opening info does not subscribe.
public struct OpenClawChatInfoPullRequests: View {
    private let model: OpenClawChatViewModel
    private let rows: [ChatActivityPullRequest]
    public static func checkoutBranch(for model: OpenClawChatViewModel) -> OpenClawSessionPullRequestSnapshot.Branch? {
        model.sessionPullRequests.flatMap { $0.key == model.sessionKey ? $0.snapshot.branch : nil }
    }

    public var isEmpty: Bool {
        self.rows.isEmpty
    }

    @State private var selection: ChatActivitySheet?
    @ScaledMetric(relativeTo: .body) private var mark: CGFloat = 19

    public init(model: OpenClawChatViewModel) {
        self.model = model
        self.rows = model.linkedPullRequests
    }

    public var body: some View {
        VStack(spacing: 0) {
            ForEach(self.rows, id: \.url) { row in
                if row.url != self.rows.first?.url { Divider().padding(.leading, 28 + self.mark) }
                let state = row.details.flatMap { ChatPullRequestState(rawValue: $0.state) }
                Button { self.selection = .pullRequest(row.id) } label: {
                    HStack(spacing: 12) {
                        if let state {
                            ChatPRStateGlyph(state: state, size: self.mark)
                        } else {
                            Image(systemName: "link").foregroundStyle(OpenClawChatTheme.muted).frame(width: self.mark)
                        }
                        VStack(alignment: .leading, spacing: 2) {
                            if let title = row.title {
                                Text(verbatim: title).font(OpenClawChatTypography.settingsBody)
                            }
                            Text(verbatim: "\(row.repo) · #\(row.number)")
                                .font(OpenClawChatTypography.settingsFootnote).foregroundStyle(OpenClawChatTheme.muted)
                        }
                        .fixedSize(horizontal: false, vertical: true)
                        Spacer(minLength: 0)
                        Image(systemName: "chevron.right").font(.caption.weight(.semibold))
                            .foregroundStyle(OpenClawChatTheme.placeholder)
                    }
                    .multilineTextAlignment(.leading)
                    .padding(.horizontal, 16).padding(.vertical, 10)
                    .frame(maxWidth: .infinity, minHeight: 52, alignment: .leading).contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityLabel(Text(verbatim: [
                    state.map { ChatActivityRules.pullRequestStateLabel($0.rawValue) }
                        ?? String(localized: "Pull request, status unavailable"),
                    row.title,
                    row.repo,
                    "#\(row.number)",
                ]
                    .compactMap(\.self).joined(separator: ", ")))
                .accessibilityIdentifier("chat-info-pr-\(row.id)")
            }
        }
        .sheet(item: self.$selection) { sheet in
            ChatActivitySheetView(viewModel: self.model, sheet: sheet, onOpenChild: { _, _ in }, onHideProgress: {})
                .openClawSheetHeaderEdge()
        }
    }
}
#endif
