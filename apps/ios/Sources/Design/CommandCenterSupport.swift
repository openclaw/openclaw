import OpenClawChatUI
import OpenClawKit
import SwiftUI

struct CommandSessionActionsModifier: ViewModifier {
    typealias Mutation = (any OpenClawChatTransport) async throws -> Void

    private enum Editor {
        case rename
        case newGroup
    }

    let session: OpenClawChatSessionEntry
    let mainSessionKey: String
    let categories: [String]
    let isArchived: Bool
    let isEnabled: Bool
    let canArchive: Bool
    let canDelete: Bool
    let archivesSession: () -> Bool
    let performMutation: (String?, @escaping Mutation) -> Void
    let fork: () -> Void
    let preview: (() -> AnyView)?

    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.openClawToastPresenter) private var toastPresenter
    @State private var editor: Editor?
    @State private var draftText = ""
    @State private var confirmsDelete = false

    func body(content: Content) -> some View {
        if self.isEnabled {
            self.managedContent(content)
        } else {
            content
        }
    }

    private func managedContent(_ content: Content) -> some View {
        self.contextMenuContent(content)
            .alert(self.editorTitle, isPresented: self.editorBinding) {
                TextField(self.editorPlaceholder, text: self.$draftText)
                    .font(OpenClawType.body)
                Button {
                    self.commitEditor()
                } label: {
                    Text(self.editor == .rename
                        ? LocalizedStringKey("Save")
                        : LocalizedStringKey("Create"))
                        .font(OpenClawType.subheadSemiBold)
                }
                .disabled(self.editor == .newGroup && self.draftText.trimmedNonEmpty == nil)
                Button(role: .cancel) {
                    self.editor = nil
                } label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            }
            .tint(.primary)
            .confirmationDialog(
                "Delete Session?",
                isPresented: self.$confirmsDelete,
                titleVisibility: .visible)
            {
                Button(role: .destructive) {
                    self.run(
                        self.failureText(String(localized: "Couldn’t delete “%@”.")),
                        resetActiveSessionKey: self.session.key)
                    {
                        try await $0.deleteSession(key: self.session.key)
                    }
                } label: {
                    Text("Delete Session")
                        .font(OpenClawType.subheadSemiBold)
                }
                Button(role: .cancel) {} label: {
                    Text("Cancel")
                        .font(OpenClawType.subheadSemiBold)
                }
            } message: {
                Text("This permanently deletes the session and its chat history.")
                    .font(OpenClawType.caption)
            }
    }

    private func patch(
        label: String?? = nil,
        category: String?? = nil,
        color: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        let failure = switch (archived, pinned, label) {
        case (true?, _, _): self.failureText(String(localized: "Couldn’t archive “%@”."))
        case (false?, _, _): self.failureText(String(localized: "Couldn’t unarchive “%@”."))
        case (_, true?, _): self.failureText(String(localized: "Couldn’t pin “%@”."))
        case (_, false?, _): self.failureText(String(localized: "Couldn’t unpin “%@”."))
        case (_, _, .some): self.failureText(String(localized: "Couldn’t rename “%@”."))
        default: self.failureText(String(localized: "Couldn’t update “%@”."))
        }
        // The row leaves the list, so archiving says so and offers Undo. Unarchive in Sessions › Archived
        // is the other way back.
        let success = archived == true
            ? OpenClawToast(
                String(localized: "Archived"),
                systemImage: "archivebox",
                action: .undo { self.patch(archived: false) })
            : nil
        self.run(failure, resetActiveSessionKey: archived == true ? self.session.key : nil, success: success) {
            if let pinned {
                try await self.appModel.setPersonalSidebarPin(self.session.key, pinned: pinned)
                return
            }
            try await $0.patchSession(
                key: self.session.key,
                expectedSessionID: archived == nil ? nil : self.session.sessionId,
                label: label,
                category: category,
                color: color,
                pinned: nil,
                archived: archived,
                unread: unread)
        }
    }

    private func patchSnooze(_ snoozedUntil: OpenClawChatSnoozePatch) {
        let failure: String
        var success: OpenClawToast?
        switch snoozedUntil {
        case let .until(wakeAt):
            failure = self.failureText(String(localized: "Couldn’t snooze “%@”."))
            // The row leaves the list until then; Wake session in its menu is the other way back.
            success = OpenClawToast(
                String(
                    format: String(localized: "Snoozed until %@"),
                    OpenClawChatSessionSnooze.wakeDescription(wakeAt)),
                systemImage: "clock",
                action: .undo { self.patchSnooze(.wake) })
        case .wake:
            failure = self.failureText(String(localized: "Couldn’t wake “%@”."))
        }
        self.run(failure, resetActiveSessionKey: nil, success: success) {
            try await $0.patchSession(
                key: self.session.key,
                expectedSessionID: self.session.sessionId,
                snoozedUntil: snoozedUntil)
        }
    }

    private func failureText(_ format: String) -> String {
        String(format: format, SessionPresentation.title(self.session))
    }

    /// Runs a row action through the screen that owns the list. A failure is a toast with Try again,
    /// which repeats the same action; `success` shows once the action lands.
    private func run(
        _ failure: String,
        resetActiveSessionKey: String?,
        success: OpenClawToast? = nil,
        _ operation: @escaping Mutation)
    {
        let toasts = self.toastPresenter
        let perform = self.performMutation
        func attempt() {
            perform(resetActiveSessionKey) { transport in
                do {
                    try await operation(transport)
                } catch {
                    if !(error is CancellationError) {
                        await toasts?.post(.failure(failure, retry: attempt))
                    }
                    throw error
                }
                if let success { await toasts?.post(success) }
            }
        }
        attempt()
    }

    private var canSnooze: Bool {
        let key = self.session.key.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let agentID = OpenClawChatSessionKey.agentID(from: key)
        let sessionName = agentID == nil
            ? key
            : String(key.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)[2])
        let mainKey = self.mainSessionKey.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let configuredMain = OpenClawChatSessionKey.agentID(from: mainKey) == nil
            ? mainKey
            : String(mainKey.split(separator: ":", maxSplits: 2, omittingEmptySubsequences: false)[2])
        guard !self.isArchived, !self.session.isArchived, self.session.isMain != true,
              self.session.sessionId?.trimmedNonEmpty != nil,
              self.session.kind != "global", self.session.kind != "unknown",
              key != "main", key != "global", key != "unknown", sessionName != configuredMain,
              !sessionName.hasPrefix("subagent:"), self.session.spawnedBy?.trimmedNonEmpty == nil
        else { return false }
        guard let parent = self.session.parentSessionKey?.trimmedNonEmpty else { return true }
        // Ordinary dashboard conversations link to Home without becoming nested children.
        return agentID.map { parent == "agent:\($0):main" } ?? false
    }

    @ViewBuilder
    private var snoozeMenu: some View {
        let now = Date.now
        if self.session.isSnoozed(at: now), let snoozedUntil = self.session.snoozedUntil {
            let wakeDescription = OpenClawChatSessionSnooze.wakeDescription(
                Date(timeIntervalSince1970: snoozedUntil / 1000),
                now: now)
            self.actionButton(
                .verbatim(String(format: String(localized: "Wake session · %@"), wakeDescription)),
                systemImage: "clock")
            {
                self.patchSnooze(.wake)
            }
        } else {
            Menu {
                ForEach(OpenClawChatSessionSnooze.presets(now: now), id: \.id) { preset in
                    // "Next week" needs its weekday; the other titles already name the day.
                    let when = preset.id == "next-week"
                        ? OpenClawChatSessionSnooze.wakeDescription(preset.wakeAt, now: now)
                        : preset.wakeAt.formatted(date: .omitted, time: .shortened)
                    self.actionButton(.verbatim("\(preset.title) · \(when)"), systemImage: "clock") {
                        self.patchSnooze(.until(preset.wakeAt))
                    }
                }
            } label: {
                Label("Snooze", systemImage: "clock")
                    .font(OpenClawType.subhead)
            }
        }
    }

    @ViewBuilder
    private func contextMenuContent(_ content: Content) -> some View {
        if let preview = self.preview {
            content.contextMenu {
                self.menuItems
            } preview: {
                preview()
            }
            .tint(.primary)
        } else {
            content.contextMenu { self.menuItems }
                .tint(.primary)
        }
    }

    @ViewBuilder
    private var menuItems: some View {
        OpenClawSessionColorMenu(color: self.session.color) {
            self.patch(color: .some($0))
        }
        if !self.isArchived {
            self.actionButton(
                self.session.pinned == true
                    ? OpenClawTextValue.localized("Unpin")
                    : OpenClawTextValue.localized("Pin"),
                systemImage: self.session.pinned == true ? "pin.slash" : "pin")
            {
                self.patch(pinned: self.session.pinned != true)
            }
            if self.canSnooze {
                self.snoozeMenu
            }
            self.actionButton(
                self.session.unread == true
                    ? OpenClawTextValue.localized("Mark as Read")
                    : OpenClawTextValue.localized("Mark as Unread"),
                systemImage: self.session.unread == true ? "envelope.open" : "envelope.badge")
            {
                self.patch(unread: self.session.unread != true)
            }
            self.actionButton("Rename…", systemImage: "pencil") {
                self.beginRename()
            }
            self.actionButton("Fork chat", systemImage: "arrow.triangle.branch") {
                self.fork()
            }
            self.groupMenu
        }
        if self.canArchive {
            self.actionButton(
                self.isArchived ? .localized("Unarchive") : .localized("Archive"),
                systemImage: "archivebox")
            {
                self.patch(archived: self.archivesSession())
            }
        }
        if self.canDelete {
            self.deleteButton
        }
    }

    private var groupMenu: some View {
        Menu {
            ForEach(self.categories, id: \.self) { category in
                self.actionButton(.verbatim(category), systemImage: "folder") {
                    self.patch(category: .some(category))
                }
            }
            self.actionButton("New Group…", systemImage: "folder.badge.plus") {
                self.draftText = ""
                self.editor = .newGroup
            }
            if self.session.category?.trimmedNonEmpty != nil {
                self.actionButton("Remove from Group", systemImage: "folder.badge.minus") {
                    self.patch(category: .some(nil))
                }
            }
        } label: {
            Label("Move to Group", systemImage: "folder")
                .font(OpenClawType.subhead)
        }
    }

    private var deleteButton: some View {
        Button(role: .destructive) {
            self.confirmsDelete = true
        } label: {
            Label {
                Text("Delete…").font(OpenClawType.subhead)
            } icon: {
                if self.preview != nil, let trash = UIImage(systemName: "trash") {
                    Image(uiImage: trash.withTintColor(.systemRed, renderingMode: .alwaysOriginal))
                } else {
                    Image(systemName: "trash")
                }
            }
        }
    }

    private var editorBinding: Binding<Bool> {
        Binding(
            get: { self.editor != nil },
            set: { if !$0 { self.editor = nil } })
    }

    private var editorTitle: String {
        self.editor == .newGroup
            ? String(localized: "New Group")
            : String(localized: "Rename Session")
    }

    private var editorPlaceholder: String {
        self.editor == .newGroup
            ? String(localized: "Group name")
            : String(localized: "Session name")
    }

    private func actionButton(
        _ title: OpenClawTextValue,
        systemImage: String,
        action: @escaping () -> Void) -> some View
    {
        Button(action: action) {
            Label {
                title.text
                    .font(OpenClawType.subhead)
            } icon: {
                Image(systemName: systemImage)
            }
        }
    }

    private func beginRename() {
        self.draftText = self.session.label?.trimmedNonEmpty
            ?? self.session.displayName?.trimmedNonEmpty
            ?? ""
        self.editor = .rename
    }

    private func commitEditor() {
        let value = self.draftText.trimmedNonEmpty
        switch self.editor {
        case .rename:
            self.patch(label: .some(value))
        case .newGroup:
            if let value {
                // Web parity: only prompt-created groups join the stored list,
                // so they survive as empty sections after members leave.
                SessionGroupStore.remember(value)
                self.patch(category: .some(value))
            }
        case nil:
            break
        }
        self.editor = nil
    }
}

extension View {
    func commandSessionActions(
        session: OpenClawChatSessionEntry,
        mainSessionKey: String = "main",
        categories: [String],
        isArchived: Bool = false,
        isEnabled: Bool = true,
        canArchive: Bool = true,
        canDelete: Bool = true,
        archivesSession: @escaping () -> Bool = { true },
        performMutation: @escaping (String?, @escaping CommandSessionActionsModifier.Mutation) -> Void,
        fork: @escaping () -> Void,
        preview: (() -> AnyView)? = nil) -> some View
    {
        self.modifier(CommandSessionActionsModifier(
            session: session,
            mainSessionKey: mainSessionKey,
            categories: categories,
            isArchived: isArchived,
            isEnabled: isEnabled,
            canArchive: canArchive,
            canDelete: canDelete,
            archivesSession: archivesSession,
            performMutation: performMutation,
            fork: fork,
            preview: preview))
    }
}

struct CommandEmptyStateRow: View {
    let icon: String
    let title: OpenClawTextValue
    let detail: OpenClawTextValue

    var body: some View {
        HStack(spacing: 10) {
            Image(systemName: self.icon)
                .font(OpenClawType.captionBold)
                .foregroundStyle(OpenClawBrand.ok)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: OpenClawRadius.xs, style: .continuous)
                        .fill(OpenClawBrand.ok.opacity(0.10))
                }
            VStack(alignment: .leading, spacing: 2) {
                self.title.text
                    .font(OpenClawType.subheadSemiBold)
                    .lineLimit(1)
                self.detail.text
                    .font(OpenClawType.caption2Medium)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 0)
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
    }
}
