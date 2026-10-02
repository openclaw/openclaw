#if os(macOS)
import SwiftUI

extension ChatSessionSidebar {
    var newThreadButton: some View {
        HStack(spacing: 0) {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                HStack(spacing: 8) {
                    Image(systemName: "square.and.pencil")
                    Text("New Thread")
                    Spacer(minLength: 4)
                    Text(verbatim: "⇧⌘N")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.tertiary)
                }
                .padding(.leading, 12)
                .padding(.trailing, 8)
                .frame(height: 38)
                .contentShape(Rectangle())
            }
            .help(String(localized: "New thread"))
            .accessibilityIdentifier("chat-new-thread")
            Divider()
                .frame(height: 16)
            Button {
                self.isPresentingNewSessionOptions = true
            } label: {
                Image(systemName: "chevron.down")
                    .font(.system(size: 10, weight: .semibold))
                    .frame(width: 30, height: 38)
                    .contentShape(Rectangle())
            }
            .accessibilityLabel(String(localized: "New thread options"))
            .help(String(localized: "New thread options"))
            .popover(isPresented: self.$isPresentingNewSessionOptions) {
                ChatNewSessionOptionsPopover(viewModel: self.viewModel) {
                    self.isPresentingNewSessionOptions = false
                }
            }
        }
        .font(OpenClawChatTypography.body(size: 13, weight: .medium, relativeTo: .body))
        .buttonStyle(.plain)
        .background(.quaternary.opacity(0.5), in: RoundedRectangle(cornerRadius: 10))
        .overlay {
            RoundedRectangle(cornerRadius: 10)
                .strokeBorder(.primary.opacity(0.08), lineWidth: 1)
        }
        .disabled(self.viewModel.isCreatingSession)
    }

    func threadsHeading(ownership: ChatSidebarOwnership) -> some View {
        HStack(alignment: .firstTextBaseline) {
            Text("Threads")
                .font(OpenClawChatTypography.body(size: 12, weight: .semibold, relativeTo: .body))
            Spacer(minLength: 8)
            Text(verbatim: self.showsAllAgents ? String(localized: "All agents") :
                self.viewModel.selectedAgent?.displayName ?? self.viewModel.selectedAgentID ?? "")
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
            Button { self.isPresentingFilters.toggle() } label: {
                HStack(spacing: 3) {
                    Image(systemName: "line.3.horizontal.decrease")
                    if self.filterOptions.filterCount > 0 {
                        Text(self.filterOptions.filterCount, format: .number).monospacedDigit()
                    }
                }
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .frame(minWidth: 22, minHeight: 22)
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .help(String(localized: "View options"))
            .accessibilityLabel(String(localized: "View options"))
            .accessibilityIdentifier("chat-sidebar-view-options")
            .popover(isPresented: self.$isPresentingFilters) {
                ChatSessionSidebarFilters(options: self.filterBinding, ownership: ownership)
                    .onExitCommand { self.isPresentingFilters = false }
            }
        }
        .padding(.top, 14)
        .padding(.bottom, 2)
        .listRowSeparator(.hidden)
        .listRowBackground(Color.clear)
        .selectionDisabled()
        .accessibilityElement(children: .contain)
    }

    func agentRow(_ agent: OpenClawChatAgentChoice, now: Date) -> some View {
        let isSelected = agent.id.lowercased() == self.viewModel.selectedAgentID
        let summary = ChatSessionSidebarModel.agentSummary(
            for: agent.id, sessions: self.viewModel.sessions, now: now.timeIntervalSince1970 * 1000)
        let attention = self.attentionSummary(
            sessions: self.viewModel.sessions.filter {
                ChatSessionSidebarModel.isSessionInActiveAgentScope(
                    key: $0.key, agentID: $0.agentId, activeAgentID: agent.id)
            },
            agentID: agent.id,
            now: now)
        return HStack(spacing: 4) {
            Button {
                self.viewModel.switchAgent(to: agent.id)
            } label: {
                HStack(spacing: 8) {
                    ChatSidebarAgentAvatar(agent: agent, size: 24)
                    VStack(alignment: .leading, spacing: 2) {
                        Text(verbatim: agent.displayName)
                            .font(OpenClawChatTypography.body(
                                size: 13,
                                weight: isSelected ? .medium : .regular,
                                relativeTo: .body))
                            .lineLimit(1)
                        if self.viewModel.healthOK, let summary, let activity = summary.activity {
                            Label(self.agentSubtitle(summary, activity: activity), systemImage: activity.symbol)
                                .font(OpenClawChatTypography.body(size: 10, weight: .regular, relativeTo: .caption))
                                .foregroundStyle(summary.attentionCount > 0 ? OpenClawChatTheme.warning : .secondary)
                                .lineLimit(1)
                        }
                    }
                    Spacer(minLength: 0)
                    if let unread = summary?.unreadCount, unread > 0 {
                        Text(unread, format: .number)
                            .font(OpenClawChatTypography.body(size: 10, weight: .semibold, relativeTo: .caption))
                            .monospacedDigit()
                            .padding(.horizontal, 6)
                            .padding(.vertical, 2)
                            .background(.quaternary, in: Capsule())
                            .accessibilityLabel(unread == 1
                                ? String(localized: "1 unread thread")
                                : String(format: String(localized: "%lld unread threads"), unread))
                    } else if isSelected {
                        Image(systemName: "checkmark")
                            .font(.system(size: 11, weight: .semibold))
                            .foregroundStyle(.secondary)
                    }
                }
                .contentShape(Rectangle())
            }
            .buttonStyle(.plain)
            .accessibilityIdentifier("chat-agent-\(agent.id)")
            .accessibilityAddTraits(isSelected ? [.isSelected] : [])
            .help(String(format: String(localized: "Open %@"), agent.displayName))
            self.attentionBadge(summary: attention, targetID: "agent:\(agent.id)")
        }
        .padding(.horizontal, 8)
        .padding(.vertical, 5)
        .background(isSelected ? Color.primary.opacity(0.06) : Color.clear, in: RoundedRectangle(cornerRadius: 8))
        .accessibilityElement(children: .contain)
    }

    private func agentSubtitle(
        _ summary: ChatSessionSidebarModel.AgentSummary,
        activity: ChatSessionSidebarModel.Activity) -> String
    {
        if summary.attentionCount > 1 {
            return String(format: String(localized: "%lld need attention"), summary.attentionCount)
        }
        if summary.runningCount > 1 {
            return String(format: String(localized: "%lld working · %@"), summary.runningCount, activity.text)
        }
        if summary.queuedCount > 1 {
            return String(format: String(localized: "%lld queued"), summary.queuedCount)
        }
        return activity.text
    }

    var connectionFooter: some View {
        HStack(spacing: 6) {
            Circle()
                .fill(self.viewModel.healthOK ? .green : .orange)
                .frame(width: 7, height: 7)
            Text(self.viewModel.healthOK
                ? String(localized: "Gateway connected")
                : String(localized: "Connecting…"))
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
            Spacer(minLength: 0)
            if self.groupLoadFailed {
                Button {
                    self.groupRefreshNonce += 1
                } label: {
                    Image(systemName: "arrow.clockwise")
                }
                .buttonStyle(.borderless)
                .help(String(localized: "Retry thread groups"))
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 12)
        .background(.bar)
    }
}

struct ChatSidebarAgentAvatar: View {
    let agent: OpenClawChatAgentChoice
    var size: CGFloat = 28
    @Environment(\.sidebarAgentAvatarProvider) private var provider
    @State private var image: NSImage?
    @State private var loadedRequest: Request?

    private struct Request: Equatable {
        let scope: ChatSidebarAgentAvatarProvider.Scope?
        let agentID: String
        let source: String?
    }

    var body: some View {
        let request = Request(scope: self.provider?.scope, agentID: self.agent.id, source: self.agent.avatar)
        ZStack {
            if self.loadedRequest == request, let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                Text(verbatim: self.agent.avatarText)
                    .font(OpenClawChatTypography.navigationAvatar(size: self.size * 0.5))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
            }
        }
        .frame(width: self.size, height: self.size)
        .background(.quaternary)
        .clipShape(RoundedRectangle(cornerRadius: self.size * 0.3))
        .accessibilityHidden(true)
        .task(id: request) {
            self.image = nil
            self.loadedRequest = nil
            guard let provider, let source = request.source else { return }
            let data: Data? = if let inline = OpenClawSidebarAgentAvatarSource.inlineData(source) {
                inline
            } else {
                await provider.transport.loadSidebarAgentAvatar(source)
            }
            guard let data, !Task.isCancelled else { return }
            self.image = NSImage(data: data)
            self.loadedRequest = request
        }
    }
}
#endif
