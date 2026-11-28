import OpenClawChatUI
import OpenClawKit
import SwiftUI

/// The chat header's "more" menu. Its chat items make the same writes as the row menus in the sidebar and on
/// the Sessions screen; the session roster follows them through its session events.
struct ChatActionsMenu: View {
    enum Item: Hashable {
        case newChat
        case pin
        case rename
        case moveToGroup
        case contextUsage
        case archive
        case delete
    }

    /// The menu's sections, in order. A chat the server doesn't have yet (a new chat before its first message)
    /// has nothing to pin, rename, move, archive or delete.
    nonisolated static func sections(
        isMainChat: Bool,
        isSaved: Bool,
        hasContextUsage: Bool,
        canArchive: Bool,
        canDelete: Bool) -> [[Item]]
    {
        let sections: [[Item]] = [
            isMainChat ? [] : [.newChat],
            isSaved ? [.pin, .rename, .moveToGroup] : [],
            hasContextUsage ? [.contextUsage] : [],
            (isSaved && canArchive ? [.archive] : []) + (isSaved && canDelete ? [.delete] : []),
        ]
        return sections.filter { !$0.isEmpty }
    }

    private enum Editor {
        case rename
        case newGroup
    }

    @Environment(NodeAppModel.self) private var appModel
    let viewModel: OpenClawChatViewModel?
    let isMainChat: Bool
    let isDisabled: Bool
    let newChat: () -> Void

    @State private var editor: Editor?
    @State private var draftText = ""
    @State private var confirmsDelete = false
    @State private var errorText: String?

    private var session: OpenClawChatSessionEntry? {
        guard let viewModel, !viewModel.isNewChatDraft else { return nil }
        guard let row = viewModel.currentSessionEntry() else { return nil }
        return self.appModel.displayedSidebarPins?.project(row) ?? row
    }

    private var sections: [[Item]] {
        let mainKey = self.appModel.mainSessionKey
        let session = self.session
        return Self.sections(
            isMainChat: self.isMainChat,
            isSaved: session != nil,
            hasContextUsage: self.viewModel?.contextUsage != nil,
            canArchive: session.map { ChatSessionSidebarModel.canArchiveSession($0, mainSessionKey: mainKey) }
                ?? false,
            canDelete: session.map { ChatSessionSidebarModel.canDeleteSession(key: $0.key, mainSessionKey: mainKey) }
                ?? false)
    }

    var body: some View {
        Menu {
            ForEach(Array(self.sections.enumerated()), id: \.offset) { _, section in
                Section {
                    ForEach(section, id: \.self) { item in
                        self.view(for: item)
                    }
                }
            }
        } label: {
            Image(systemName: "ellipsis")
                .font(.system(size: 16, weight: .semibold))
                .foregroundStyle(.primary)
                .openClawToolbarGlyphScale()
                .frame(width: OpenClawProMetric.compactControlSize, height: OpenClawProMetric.compactControlSize)
                .openClawToolbarHitTarget()
                .contentShape(Rectangle())
        }
        .menuIndicator(.hidden)
        .buttonStyle(.plain)
        .tint(.primary)
        .accessibilityLabel("Chat actions")
        .glassEffect(.regular.interactive(), in: Circle())
        .alert(self.editorTitle, isPresented: self.editorBinding) {
            TextField(self.editorPlaceholder, text: self.$draftText)
            Button(self.editor == .rename ? String(localized: "Save") : String(localized: "Create")) {
                self.commitEditor()
            }
            .disabled(self.editor == .newGroup && self.draftText.trimmedNonEmpty == nil)
            Button(String(localized: "Cancel"), role: .cancel) { self.editor = nil }
        }
        .confirmationDialog(
            String(localized: "Delete chat?"),
            isPresented: self.$confirmsDelete,
            titleVisibility: .visible)
        {
            Button(String(localized: "Delete chat"), role: .destructive) {
                guard let session = self.session else { return }
                self.perform(leavesChat: true) { try await $0.deleteSession(key: session.key) }
            }
            Button(String(localized: "Cancel"), role: .cancel) {}
        } message: {
            Text("This permanently deletes the chat and its messages.")
        }
        .alert(String(localized: "Couldn’t update this chat"), isPresented: self.errorBinding) {
                Button(String(localized: "OK"), role: .cancel) { self.errorText = nil }
            } message: {
                Text(verbatim: self.errorText ?? "")
            }
    }

    @ViewBuilder
    private func view(for item: Item) -> some View {
        switch item {
        case .newChat:
            Button(action: self.newChat) {
                Label("New Chat", systemImage: "plus.bubble")
            }
            .disabled(self.isDisabled)
        case .pin:
            let isPinned = self.session?.pinned == true
            Button {
                if let key = self.session?.key {
                    self.perform(leavesChat: false) { _ in
                        try await self.appModel.setPersonalSidebarPin(key, pinned: !isPinned)
                    }
                }
            } label: {
                Label(
                    isPinned ? String(localized: "Unpin") : String(localized: "Pin"),
                    systemImage: isPinned ? "pin.slash" : "pin")
            }
            .disabled(self.isDisabled)
        case .rename:
            Button {
                self.draftText = self.session?.label?.trimmedNonEmpty
                    ?? self.session?.displayName?.trimmedNonEmpty
                    ?? ""
                self.editor = .rename
            } label: {
                Label("Rename…", systemImage: "pencil")
            }
            .disabled(self.isDisabled)
        case .moveToGroup:
            self.groupMenu.disabled(self.isDisabled)
        case .contextUsage:
            if let viewModel, let usage = viewModel.contextUsage {
                Menu {
                    OpenClawChatContextUsageMenuItems(
                        usage: usage,
                        canCompact: viewModel.canRequestSessionCompact,
                        onCompact: viewModel.requestSessionCompact)
                } label: {
                    Label("Context usage", systemImage: "gauge.with.dots.needle.33percent")
                }
                .accessibilityIdentifier("chat-context-usage")
            }
        case .archive:
            Button {
                self.patch(archived: true)
            } label: {
                Label("Archive", systemImage: "archivebox")
            }
            .disabled(self.isDisabled)
        case .delete:
            Button(role: .destructive) {
                self.confirmsDelete = true
            } label: {
                Label("Delete…", systemImage: "trash")
            }
            .disabled(self.isDisabled)
        }
    }

    private var groupMenu: some View {
        let current = self.session?.category?.trimmedNonEmpty
        return Menu {
            ForEach(self.appModel.sessionGroups.names(for: self.viewModel?.sessions ?? []), id: \.self) { group in
                Button {
                    self.patch(category: .some(group))
                } label: {
                    Label(group, systemImage: group == current ? "checkmark" : "folder")
                }
            }
            Button {
                self.draftText = ""
                self.editor = .newGroup
            } label: {
                Label("New group…", systemImage: "folder.badge.plus")
            }
            if current != nil {
                Button {
                    self.patch(category: .some(nil))
                } label: {
                    Label("Remove from group", systemImage: "folder.badge.minus")
                }
            }
        } label: {
            Label("Move to group", systemImage: "folder")
        }
    }

    private func patch(label: String?? = nil, category: String?? = nil, archived: Bool? = nil) {
        guard let session = self.session else { return }
        self.perform(leavesChat: archived == true) { transport in
            try await transport.patchSession(
                key: session.key,
                expectedSessionID: archived == nil ? nil : session.sessionId,
                label: label,
                category: category,
                color: nil,
                pinned: nil,
                archived: archived,
                unread: nil)
        }
    }

    /// Archiving or deleting the open chat returns to the main chat, as the row menus do.
    private func perform(
        leavesChat: Bool,
        _ operation: @escaping (any OpenClawChatTransport) async throws -> Void)
    {
        Task {
            do {
                try await operation(self.appModel.makeChatTransport())
                if leavesChat {
                    self.appModel.focusChatSession(nil)
                }
                self.viewModel?.refreshSessions()
            } catch {
                self.errorText = error.localizedDescription
            }
        }
    }

    private func commitEditor() {
        let value = self.draftText.trimmedNonEmpty
        switch self.editor {
        case .rename:
            self.patch(label: .some(value))
        case .newGroup:
            if let value {
                // As in the row menus: a group created here joins the stored list.
                SessionGroupStore.remember(value)
                self.patch(category: .some(value))
            }
        case nil:
            break
        }
        self.editor = nil
    }

    private var editorTitle: String {
        self.editor == .newGroup ? String(localized: "New group") : String(localized: "Rename chat")
    }

    private var editorPlaceholder: String {
        self.editor == .newGroup ? String(localized: "Group name") : String(localized: "Chat name")
    }

    private var editorBinding: Binding<Bool> {
        Binding(get: { self.editor != nil }, set: { if !$0 { self.editor = nil } })
    }

    private var errorBinding: Binding<Bool> {
        Binding(get: { self.errorText != nil }, set: { if !$0 { self.errorText = nil } })
    }
}
