import OpenClawChatUI
import SwiftUI

/// Value equality isolates the session button from unrelated roster changes.
/// Question buttons stay outside this boundary; the approval label is a row input.
/// Actions must use the tapped session and reference or @State-backed state; equality excludes closures.
struct RootSidebarSessionButton: View, Equatable {
    @Environment(NodeAppModel.self) private var appModel
    /// Branded fonts are fixed-size fonts resolved when the body runs, and equality skips the body on a
    /// Dynamic Type change from the parent. Reading the size here re-runs the row when the text size changes.
    @Environment(\.dynamicTypeSize) private var dynamicTypeSize
    let node: ChatSessionSidebarModel.Node
    let isSelected: Bool
    let mainSessionKey: String
    let categories: [String]
    let isConnected: Bool
    var needsApproval: Bool = false
    let open: (OpenClawChatSessionEntry) -> Void
    let performMutation: (String?, @escaping CommandSessionActionsModifier.Mutation) -> Void
    let fork: (OpenClawChatSessionEntry) -> Void

    nonisolated static func == (lhs: Self, rhs: Self) -> Bool {
        lhs.node == rhs.node && lhs.isSelected == rhs.isSelected &&
            lhs.mainSessionKey == rhs.mainSessionKey && lhs.categories == rhs.categories &&
            lhs.isConnected == rhs.isConnected && lhs.needsApproval == rhs.needsApproval
    }

    var body: some View {
        let session = self.node.session
        let isSelected = self.isSelected
        Button {
            self.open(session)
        } label: {
            HStack(spacing: 10) {
                VStack(alignment: .leading, spacing: 2) {
                    Text(verbatim: CommandCenterTab.sessionTitle(session))
                        .font(OpenClawType.subheadMedium)
                        .foregroundStyle(OpenClawSidebarPalette.textStrong)
                        .lineLimit(1)
                        .modifier(RootSidebarApprovalLabel(isVisible: self.needsApproval))
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

                switch SessionRowActivityMark(
                    isWorking: self.node.badges.runningCount > 0,
                    isUnread: session.unread == true)
                {
                case .working:
                    ProgressView()
                        .controlSize(.mini)
                        .tint(OpenClawSidebarPalette.muted)
                case .unread:
                    Circle()
                        .fill(OpenClawSidebarPalette.accent)
                        .frame(width: 7, height: 7)
                        .accessibilityHidden(true)
                case .none:
                    EmptyView()
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
            fork: { self.fork(session) },
            preview: {
                AnyView(RootSidebarSessionPreview(session: session, appModel: self.appModel))
            })
        .accessibilityValue(RootSidebar.sessionAccessibilityValue(
            isPinned: session.pinned == true,
            isUnread: session.unread == true,
            needsApproval: self.needsApproval))
    }
}

/// Overlay the title rather than changing the width of the row or its other controls.
struct RootSidebarApprovalLabel: ViewModifier {
    let isVisible: Bool

    func body(content: Content) -> some View {
        content
            .frame(maxWidth: .infinity, alignment: .leading)
            .mask {
                if self.isVisible {
                    HStack(spacing: 0) {
                        Color.black
                        LinearGradient(colors: [.black, .clear], startPoint: .leading, endPoint: .trailing)
                            .frame(width: 22)
                        self.badge.opacity(0)
                    }
                } else {
                    Color.black
                }
            }
            .overlay(alignment: .trailing) {
                if self.isVisible {
                    self.badge
                        .accessibilityHidden(true)
                        .allowsHitTesting(false)
                }
            }
    }

    private var badge: some View {
        Text("Needs approval")
            .font(OpenClawType.caption2Medium)
            .lineLimit(1)
            .padding(.horizontal, 7)
            .padding(.vertical, 3)
            .foregroundStyle(OpenClawSidebarPalette.text)
            .background(OpenClawBrand.warn.opacity(0.16), in: Capsule())
    }
}

private struct RootSidebarSessionPreview: View {
    private enum LoadState {
        case loading
        case ready([OpenClawSessionPreviewItem])
        case unavailable
    }

    let session: OpenClawChatSessionEntry
    let appModel: NodeAppModel
    @State private var state: LoadState = .loading

    var body: some View {
        VStack(alignment: .leading, spacing: 9) {
            Text(verbatim: CommandCenterTab.sessionTitle(self.session))
                .font(OpenClawType.subheadSemiBold)
                .foregroundStyle(OpenClawBrand.textStrong)
                .lineLimit(2)

            switch self.state {
            case .loading:
                ProgressView()
                    .controlSize(.small)
                    .accessibilityLabel("Loading preview")
            case let .ready(items) where !items.isEmpty:
                ForEach(Array(items.enumerated()), id: \.offset) { _, item in
                    self.snippet(item)
                }
            case .ready:
                self.previewStatus("No messages yet")
            case .unavailable:
                self.previewStatus("Preview unavailable")
            }
        }
        .padding(14)
        .frame(width: 284, alignment: .leading)
        .fixedSize(horizontal: false, vertical: true)
        .background(OpenClawBrand.canvas)
        .task { await self.load() }
    }

    private func previewStatus(_ title: LocalizedStringKey) -> some View {
        Text(title)
            .font(OpenClawType.footnote)
            .foregroundStyle(OpenClawBrand.textSecondary)
    }

    private func snippet(_ item: OpenClawSessionPreviewItem) -> some View {
        let isUser = item.role == "user"
        let text = (try? AttributedString(
            markdown: item.text,
            options: .init(interpretedSyntax: .inlineOnlyPreservingWhitespace))) ?? AttributedString(item.text)
        return Text(text)
            .font(OpenClawType.footnote)
            .foregroundStyle(OpenClawBrand.text)
            .lineLimit(2)
            .multilineTextAlignment(.leading)
            .padding(.horizontal, isUser ? 9 : 0)
            .padding(.vertical, isUser ? 5 : 0)
            .background(isUser ? OpenClawBrand.accent.opacity(0.14) : .clear, in: RoundedRectangle(cornerRadius: 9))
            .padding(isUser ? .leading : .trailing, 22)
            .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
    }

    private func load() async {
        let owner = self.appModel.chatViewModelOwnerID
        let gateway = self.appModel.operatorSession
        let target = OpenClawChatSessionTarget.resolve(
            self.session.key,
            selectedAgentID: self.appModel.chatDeliveryAgentId,
            overrideAgentID: self.session.agentId,
            policy: .scopeBareKeysToSelectedAgent)
        guard let gatewayID = self.appModel.chatTranscriptCacheGatewayID,
              let route = await gateway.currentRoute(ifGatewayID: gatewayID)
        else {
            self.state = .unavailable
            return
        }
        do {
            let data = try await gateway.request(
                OpenClawChatGatewayRequests.sessionPreview(sessionKey: target.sessionKey),
                ifCurrentRoute: route)
            let payload = try JSONDecoder().decode(OpenClawSessionsPreviewPayload.self, from: data)
            guard !Task.isCancelled, owner == self.appModel.chatViewModelOwnerID else { return }
            guard let result = payload.previews.first(where: { $0.key == target.sessionKey }),
                  result.status == "ok" || result.status == "empty"
            else {
                self.state = .unavailable
                return
            }
            let messages = result.items.filter {
                ($0.role == "user" || $0.role == "assistant") &&
                    !$0.text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
            }
            self.state = result.status == "ok" && messages.isEmpty ? .unavailable : .ready(Array(messages.suffix(2)))
        } catch {
            if !Task.isCancelled { self.state = .unavailable }
        }
    }
}
