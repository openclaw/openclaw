#if os(macOS)
import SwiftUI

extension ChatSessionSidebar {
    func row(
        for node: ChatSessionSidebarModel.Node,
        now: Date,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        let session = node.session
        let attention = self.attentionSummary(sessions: node.previewSessions, now: now)
        let targetID = "session:\(session.key)"
        let presentation = ChatSessionRowPresentation(
            session: session,
            isConnected: self.viewModel.healthOK,
            preview: self.rowPreview(for: session, previewRequest: previewRequest),
            showPreview: self.showMessagePreview,
            now: now)
        let hasSubtitle = presentation.subtitle != nil
        let trailingLayout = hasSubtitle
            ? AnyLayout(VStackLayout(alignment: .trailing, spacing: 6))
            : AnyLayout(HStackLayout(alignment: .center, spacing: 6))
        return HStack(alignment: hasSubtitle ? .top : .center, spacing: 8) {
            VStack(alignment: .leading, spacing: 4) {
                Text(ChatSessionSidebarModel.displayName(for: session))
                    .font(OpenClawChatTypography.body(
                        size: 13, weight: session.unread == true ? .medium : .regular, relativeTo: .body))
                    .lineLimit(1)
                if let subtitle = presentation.subtitle {
                    Text(subtitle)
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            trailingLayout {
                if let timestamp = presentation.timestamp {
                    Text(verbatim: timestamp)
                        .font(OpenClawChatTypography.body(size: 10, weight: .regular, relativeTo: .caption))
                        .foregroundStyle(.tertiary)
                        .lineLimit(1)
                }
                HStack(spacing: 5) {
                    self.attentionBadge(summary: attention, targetID: targetID)
                    ChatSidebarSessionBadges(
                        node: node,
                        isConnected: self.viewModel.healthOK,
                        isCurrentSession: self.viewModel.matchesCurrentSessionKey(
                            incoming: node.session.key, current: self.viewModel.sessionKey))
                }
            }
        }
        .padding(.vertical, 4)
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: session.color)
                .offset(x: -6)
        }
        // The tag type must equal the List selection type (String?) exactly.
        .tag(Optional(session.key))
        .contextMenu { self.contextMenu(for: session) }
        .modifier(ChatSidebarAttentionAccessibility(
            title: ChatSessionSidebarModel.displayName(for: session),
            targetID: targetID,
            summary: attention,
            metadata: [presentation.subtitle, presentation.timestamp].compactMap(\.self),
            presentation: self.$presentedAttention,
            isOutlineHeading: !node.children.isEmpty))
    }

    func attentionSummary(
        sessions: [OpenClawChatSessionEntry],
        agentID: String? = nil,
        now: Date) -> OpenClawChatAttentionSummary?
    {
        let requests = self.viewModel.pendingQuestionAttentionRequests + self.additionalAttentionRequests
        return ChatSessionSidebarModel.attentionSummary(
            requests: requests,
            sessions: sessions,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey,
            activeAgentID: agentID ?? self.viewModel.selectedAgentID,
            sessionRoutingContract: self.viewModel.agentCatalog?.sessionRoutingContract ??
                self.viewModel.sessionRoutingContract,
            now: now)
    }

    @ViewBuilder
    func attentionBadge(summary: OpenClawChatAttentionSummary?, targetID: String) -> some View {
        if let summary {
            OpenClawChatAttentionBadge(
                summary: summary, targetID: targetID, presentation: self.$presentedAttention)
        }
    }

    private func rowPreview(
        for session: OpenClawChatSessionEntry,
        previewRequest: ChatSessionSidebarPreviews.Request) -> String?
    {
        if self.viewModel.matchesCurrentSessionKey(
            incoming: session.key, agentId: session.agentId, current: self.viewModel.sessionKey),
            let current = ChatSessionSidebarModel.messagePreview(from: self.viewModel.messages)
        { return current }
        return self.previews.text(for: session, in: previewRequest)
    }
}

/// Sidebar and palette render the same preformatted timestamp and subtitle.
/// SwiftUI's date-formatted Text uses different relative-time rounding.
struct ChatSessionRowPresentation {
    let timestamp: String?
    let subtitle: String?

    init(
        session: OpenClawChatSessionEntry,
        isConnected: Bool,
        preview: @autoclosure () -> String?,
        showPreview: Bool = true,
        now: Date)
    {
        self.timestamp = ChatSessionSidebarModel.activityTimestamp(for: session).map {
            Date(timeIntervalSince1970: $0 / 1000).formatted(.relative(
                presentation: .named, unitsStyle: .abbreviated))
        }
        let activity = ChatSessionSidebarModel.activity(for: session, now: now.timeIntervalSince1970 * 1000)
        if let activity, activity.kind == .attention {
            self.subtitle = activity.text
        } else if isConnected, let activity, [.running, .queued].contains(activity.kind),
                  showPreview || activity.kind == .queued
        {
            self.subtitle = activity.text
        } else if let activity, activity.kind == .failed,
                  session.unread == true || (session.lastReadAt ?? 0) < (session.endedAt ?? session.updatedAt ?? 0)
        {
            self.subtitle = activity.text
        } else if !showPreview {
            // Like session-row-subtitle.ts, hide ambient text after attention;
            // native queued status and unread failures also retain their existing slot.
            self.subtitle = nil
        } else if let preview = preview() {
            self.subtitle = preview
        } else {
            let workSubtitle = ChatSessionSidebarModel.workSubtitle(for: session)
            self.subtitle = if !isConnected, let activity, [.running, .queued].contains(activity.kind) {
                workSubtitle
            } else {
                ChatSessionSidebarModel.subtitle(
                    for: session,
                    workSubtitle: workSubtitle,
                    now: now.timeIntervalSince1970 * 1000)
            }
        }
    }
}

struct ChatSidebarSessionBadges: View {
    let node: ChatSessionSidebarModel.Node
    let isConnected: Bool
    let isCurrentSession: Bool

    var body: some View {
        if self.isConnected, self.node.badges.queuedCount > 0 {
            Image(systemName: "hourglass")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Thread queued"))
        }
        if self.isConnected, self.node.badges.runningCount > 0 {
            ProgressView()
                .controlSize(.small)
                .accessibilityLabel(String(localized: "Thread running"))
        }
        if self.node.badges.failedCount > 0 {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(OpenClawChatTheme.warning)
                .accessibilityLabel(String(localized: "Thread failed"))
        }
        if self.node.children.contains(where: \.badges.hasUnread) ||
            (self.node.session.unread == true && !self.isCurrentSession)
        {
            Circle()
                .fill(.tint)
                .frame(width: 7, height: 7)
                .accessibilityLabel(String(localized: "Unread"))
        }
    }
}

struct ChatSidebarAttentionAccessibility: ViewModifier {
    let title: String
    let targetID: String
    let summary: OpenClawChatAttentionSummary?
    let metadata: [String]
    @Binding var presentation: OpenClawChatAttentionPresentation?
    var isOutlineHeading = true

    func body(content: Content) -> some View {
        if self.isOutlineHeading {
            content
                .accessibilityElement(children: .combine)
                .accessibilityLabel(Text(verbatim: self.title))
                .accessibilityValue(Text(verbatim: (
                    self.metadata + [self.summary?.accessibilityText].compactMap(\.self)).joined(separator: ". ")))
                .accessibilityIdentifier("chat-attention-host:\(self.targetID)")
                .accessibilityActions {
                    if let summary = self.summary {
                        Button("Show pending request details") {
                            self.presentation = OpenClawChatAttentionPresentation(
                                targetID: self.targetID, requestID: summary.disclosureIdentity)
                        }
                    }
                }
        } else {
            content.accessibilityElement(children: .contain)
        }
    }
}
#endif
