import OpenClawChatUI
import SwiftUI

/// Value equality isolates the session button from unrelated roster changes.
/// Attention badges remain outside this boundary so pending requests update independently.
struct RootSidebarSessionButton: View, Equatable {
    let node: ChatSessionSidebarModel.Node
    let isSelected: Bool
    let mainSessionKey: String
    let categories: [String]
    let isConnected: Bool
    /// Equality-only invalidation for relative-time labels.
    let minute: Int
    let open: (OpenClawChatSessionEntry) -> Void
    let performMutation: (String?, @escaping CommandSessionActionsModifier.Mutation) -> Void
    let fork: (OpenClawChatSessionEntry) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.node == rhs.node && lhs.isSelected == rhs.isSelected &&
            lhs.mainSessionKey == rhs.mainSessionKey && lhs.categories == rhs.categories &&
            lhs.isConnected == rhs.isConnected && lhs.minute == rhs.minute
    }

    var body: some View {
        let session = self.node.session
        let isSelected = self.isSelected
        Button {
            self.open(session)
        } label: {
            HStack(spacing: 9) {
                ZStack {
                    if self.node.badges.runningCount > 0 {
                        ProgressView()
                            .controlSize(.mini)
                            .tint(OpenClawSidebarPalette.accent)
                    } else {
                        Image(systemName: "bubble.left")
                            .font(OpenClawType.captionSemiBold)
                            .foregroundStyle(isSelected
                                ? OpenClawSidebarPalette.accent
                                : OpenClawSidebarPalette.muted)
                    }
                }
                .frame(width: 18)

                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: CommandCenterTab.sessionTitle(session))
                        .font(OpenClawType.subheadSemiBold)
                        .foregroundStyle(isSelected
                            ? OpenClawSidebarPalette.accent
                            : OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                    // Web-parity subtitle: the work line (repo/branch) names the
                    // session; recency moves to the trailing metadata slot.
                    if let subtitle = ChatSessionSidebarModel.subtitle(
                        for: session,
                        workSubtitle: ChatSessionSidebarModel.workSubtitle(for: session))
                    {
                        Text(verbatim: subtitle)
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .lineLimit(1)
                    }
                }

                Spacer(minLength: 4)
                if session.pinned == true {
                    Image(systemName: "pin.fill")
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(OpenClawSidebarPalette.accent)
                        .accessibilityHidden(true)
                }
                Text(verbatim: CommandCenterTab.sessionDetail(session))
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(OpenClawSidebarPalette.muted)
                    .lineLimit(1)
                if session.unread == true {
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                }
            }
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .background(isSelected ? OpenClawSidebarPalette.selection : Color.clear, in: RoundedRectangle(
            cornerRadius: OpenClawProMetric.controlRadius,
            style: .continuous))
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: session.color)
        }
        .commandSessionActions(
            session: session,
            mainSessionKey: self.mainSessionKey,
            categories: self.categories,
            isEnabled: self.isConnected,
            canArchive: ChatSessionSidebarModel.canArchiveSession(
                session,
                mainSessionKey: self.mainSessionKey),
            canDelete: ChatSessionSidebarModel.canDeleteSession(
                key: session.key,
                mainSessionKey: self.mainSessionKey),
            performMutation: self.performMutation,
            fork: { self.fork(session) })
        .accessibilityValue(RootSidebar.sessionAccessibilityValue(
            isPinned: session.pinned == true,
            isUnread: session.unread == true))
    }
}
