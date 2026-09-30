#if os(macOS)
import SwiftUI

extension ChatSessionSidebar {
    var deleteDialogTitle: String {
        let name = self.sessionPendingDeletion.map(ChatSessionSidebarModel.displayName(for:)) ?? ""
        return String(format: String(localized: "Delete “%@”?"), name)
    }

    var isPresentingDeleteDialog: Binding<Bool> {
        Binding(
            get: { self.sessionPendingDeletion != nil },
            set: { if !$0 { self.sessionPendingDeletion = nil } })
    }

    var isPresentingRenameAlert: Binding<Bool> {
        Binding(
            get: { self.sessionPendingRename != nil },
            set: { if !$0 { self.sessionPendingRename = nil } })
    }

    @ViewBuilder
    func contextMenu(for session: OpenClawChatSessionEntry) -> some View {
        Button {
            self.inspectedSession = session
        } label: {
            self.actionLabel(String(localized: "Get Info…"), systemImage: "info.circle")
        }
        Divider()
        Button {
            self.renameText = session.label ?? session.displayName ?? ""
            self.sessionPendingRename = session
        } label: {
            self.actionLabel(String(localized: "Rename…"), systemImage: "pencil")
        }
        Button {
            self.viewModel.setSessionPinned(key: session.key, pinned: session.pinned != true, agentID: session.agentId)
        } label: {
            self.actionLabel(
                session.pinned == true ? String(localized: "Unpin") : String(localized: "Pin"),
                systemImage: session.pinned == true ? "pin.slash" : "pin")
        }
        Button {
            Task {
                await self.viewModel.forkSession(
                    key: session.key,
                    fromLastCompleted: session.hasActiveRun == true,
                    agentID: session.agentId)
            }
        } label: {
            self.actionLabel(
                session.hasActiveRun == true
                    ? String(localized: "Fork from last completed message")
                    : String(localized: "Fork"),
                systemImage: "arrow.triangle.branch")
        }
        Button {
            self.viewModel.setSessionUnread(key: session.key, unread: session.unread != true, agentID: session.agentId)
        } label: {
            self.actionLabel(
                session.unread == true ? String(localized: "Mark Read") : String(localized: "Mark Unread"),
                systemImage: session.unread == true ? "envelope.open" : "envelope.badge")
        }
        if ChatSessionSidebarModel.canArchiveSession(
            session,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
        {
            Button {
                self.viewModel.setSessionArchived(session, archived: !session.isArchived)
            } label: {
                self.actionLabel(
                    session.isArchived ? String(localized: "Restore") : String(localized: "Archive"),
                    systemImage: session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
        }
        OpenClawSessionColorMenu(color: session.color) { color in
            Task { await self.viewModel.setSessionColor(key: session.key, color: color, agentID: session.agentId) }
        }
        Divider()
        Button {
            ChatPasteboard.copy(session.key)
        } label: {
            self.actionLabel(String(localized: "Copy Session Key"), systemImage: "doc.on.doc")
        }
        if ChatSessionSidebarModel.canDeleteSession(
            key: session.key,
            mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
        {
            Button(role: .destructive) {
                self.sessionPendingDeletion = session
            } label: {
                self.actionLabel(String(localized: "Delete Thread…"), systemImage: "trash")
            }
        }
    }

    private func actionLabel(_ title: String, systemImage: String) -> some View {
        Label(title, systemImage: systemImage)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    }
}
#endif
