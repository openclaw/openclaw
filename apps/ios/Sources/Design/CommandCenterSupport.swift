import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

struct CommandSessionRow: View {
    let item: CommandCenterTab.WorkItem

    var body: some View {
        HStack(alignment: .center, spacing: 12) {
            Image(systemName: self.item.icon)
                .font(OpenClawType.captionSemiBold)
                .foregroundStyle(self.item.color)
                .frame(width: 30, height: 30)
                .background {
                    RoundedRectangle(cornerRadius: OpenClawRadius.sm, style: .continuous)
                        .fill(self.item.color.opacity(0.12))
                }
            VStack(alignment: .leading, spacing: 4) {
                HStack(alignment: .firstTextBaseline, spacing: 8) {
                    if self.item.isUnread {
                        Circle()
                            .fill(OpenClawBrand.accent)
                            .frame(width: 7, height: 7)
                            .accessibilityHidden(true)
                    }
                    Text(verbatim: self.item.title)
                        .font(OpenClawType.subheadSemiBold)
                        .lineLimit(1)
                        .minimumScaleFactor(0.82)
                    Spacer(minLength: 6)
                    if self.item.isPinned {
                        Image(systemName: "pin.fill")
                            .font(OpenClawType.caption2Medium)
                            .foregroundStyle(OpenClawBrand.accent)
                            .accessibilityHidden(true)
                    }
                    Text(verbatim: "chat")
                        .font(OpenClawType.caption2Medium)
                        .foregroundStyle(.secondary)
                }
                HStack(spacing: 8) {
                    Text(verbatim: self.item.detail)
                        .font(OpenClawType.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                    Spacer(minLength: 6)
                    Text(self.stateLabel)
                        .font(OpenClawType.captionSemiBold)
                        .foregroundStyle(self.item.color)
                        .lineLimit(1)
                        .frame(width: 48, alignment: .trailing)
                }
            }
        }
        .padding(.horizontal, 4)
        .padding(.vertical, 6)
        .overlay(alignment: .leading) {
            OpenClawSessionColorStripe(color: self.item.sessionColor)
        }
        .contentShape(Rectangle())
    }

    private var stateLabel: String {
        switch self.item.state {
        case "open": String(localized: "open")
        case "default": String(localized: "default")
        case "recent": String(localized: "recent")
        default: self.item.state
        }
    }
}

struct CommandSessionActionsModifier: ViewModifier {
    typealias Mutation = (any OpenClawChatTransport) async throws -> Void

    @Environment(\.commandSessionMenuConnection) private var connection
    @Environment(NodeAppModel.self) private var appModel

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
    var select: (() -> Void)?
    var onArchived: ((OpenClawChatSessionEntry, OpenClawSessionMenuConnection) -> Void)?
    var moveUp: (() -> Void)?
    var moveDown: (() -> Void)?

    private struct PresentedMenu: Identifiable {
        let id = UUID()
        let kind: CommandSessionMenuPresentation
        let session: OpenClawChatSessionEntry
        let connection: OpenClawSessionMenuConnection
    }

    @State private var confirmsDelete = false
    @State private var confirmsStop = false
    @State private var presentation: PresentedMenu?
    @State private var confirmedTarget: PresentedMenu?
    @State private var copyMessage: String?

    private var archived: Bool {
        self.isArchived || self.session.isArchived
    }

    private func allows(_ action: OpenClawSessionMenuAction) -> Bool {
        self.connection?.allows(action, session: self.session) == true
    }

    func body(content: Content) -> some View {
        if self.isEnabled {
            self.managedContent(content)
        } else {
            content
        }
    }

    private func managedContent(_ content: Content) -> some View {
        content
            .contextMenu {
                if let select {
                    self.actionButton("Select Sessions…", systemImage: "checkmark.circle", action: select)
                    Divider()
                }
                if ChatSessionSidebarActions.canPin(self.session), !self.archived {
                    self.actionButton(
                        self.session.pinned == true ? .localized("Unpin") : .localized("Pin"),
                        systemImage: self.session.pinned == true ? "pin.slash" : "pin")
                    { self.patch(pinned: self.session.pinned != true) }
                        .disabled(!self.allows(.pin))
                }
                if let moveUp { self.actionButton("Move Up", systemImage: "arrow.up", action: moveUp) }
                if let moveDown { self.actionButton("Move Down", systemImage: "arrow.down", action: moveDown) }
                self.actionButton("Rename…", systemImage: "pencil") { self.present(.rename) }
                    .disabled(!self.allows(.rename))
                self.actionButton(
                    self.session.unread == true ? .localized("Mark as Read") : .localized("Mark as Unread"),
                    systemImage: self.session.unread == true ? "envelope.open" : "envelope.badge")
                { self.patch(unread: self.session.unread != true) }
                    .disabled(!self.allows(.unread))
                if self.connection?.hello.policy["hasMultipleSessionSharingIdentities"]?.value as? Bool == true,
                   let hidden = self.session.hiddenFromInvolvingMe
                {
                    self.actionButton(
                        hidden ? .localized("Show in Involving Me") : .localized("Hide from Involving Me"),
                        systemImage: hidden ? "eye" : "eye.slash")
                    {
                        if let id = self.session.sessionId {
                            self.mutate(
                                .involvement,
                                fields: ["hidden": .init(!hidden), "expectedSessionId": .init(id)])
                        }
                    }.disabled(!self.allows(.involvement))
                }
                if self.canSnooze { self.snoozeMenu.disabled(!self.allows(.snooze)) }
                if self.canArchive {
                    self.actionButton(
                        self.archived ? .localized("Unarchive") : .localized("Archive"), systemImage: "archivebox")
                    { self.patch(archived: self.archived ? false : self.archivesSession()) }
                        .disabled(!self.allows(.archive))
                }
                Divider()
                self.actionButton("Icon & Color…", systemImage: "paintpalette") {
                    self.present(.appearance)
                }.disabled(!self.allows(.appearance))
                if ChatSessionSidebarActions.canMoveToGroup(self.session, mainKeys: [self.mainSessionKey]) {
                    self.groupMenu.disabled(!self.allows(.group))
                }
                self.actionButton("Assign to…", systemImage: "person.2") {
                    self.present(.assignment)
                }.disabled(!self.allows(.assignOwner))
                Divider()
                self.actionButton(
                    self.session.hasActiveRun == true
                        ? .localized("Fork from Last Completed Message") : .localized("Fork Conversation"),
                    systemImage: "arrow.triangle.branch",
                    action: self.fork)
                    .disabled(!self.allows(.fork))
                self.copyMenu
                self.actionButton("Open in…", systemImage: "arrow.up.forward.app") {
                    self.present(.open)
                }.disabled(self.connection?.isCurrent() != true)
                if ChatSessionSidebarActions.canStopCloudWorker(self.session), self.allows(.reclaim) {
                    self.actionButton("Stop Cloud Worker…", systemImage: "stop.circle") {
                        self.captureConfirmationTarget()
                        self.confirmsStop = true
                    }
                }
                if self.canDelete { Divider()
                    self.deleteButton.disabled(!self.allows(.delete))
                }
            }
            .sheet(item: self.$presentation) { presentation in
                CommandSessionMenuSheet(
                    presentation: presentation.kind,
                    session: presentation.session,
                    connection: presentation.connection,
                    didMutate: { self.performMutation(nil) { _ in } })
                    .environment(self.appModel)
            }
            .alert("Copy", isPresented: Binding(
                get: { self.copyMessage != nil }, set: { if !$0 { self.copyMessage = nil } }))
            {
                Button { self.copyMessage = nil } label: { Text("OK").font(OpenClawType.subheadSemiBold) }
            } message: { Text(self.copyMessage ?? "").font(OpenClawType.body) }
                .confirmationDialog("Stop Cloud Worker?", isPresented: self.$confirmsStop, titleVisibility: .visible) {
                    Button(role: .destructive) { self.mutate(.reclaim, fields: [:], target: self.confirmedTarget)
                    } label: {
                        Text("Stop Cloud Worker").font(OpenClawType.subheadSemiBold)
                    }
                    Button(role: .cancel) {} label: { Text("Cancel").font(OpenClawType.subheadSemiBold) }
                } message: {
                    Text("Capture the workspace and stop this session’s cloud worker.").font(OpenClawType.body)
                }
                .confirmationDialog(
                    "Delete Session?",
                    isPresented: self.$confirmsDelete,
                    titleVisibility: .visible)
                {
                    Button(role: .destructive) {
                        self.mutate(
                            .delete,
                            fields: ["deleteTranscript": .init(true)],
                            removing: true,
                            target: self.confirmedTarget)
                    } label: {
                        Text("Delete Session")
                            .font(OpenClawType.subheadSemiBold)
                    }
                    Button(role: .cancel) {} label: {
                        Text("Cancel")
                            .font(OpenClawType.subheadSemiBold)
                    }
                } message: {
                    Text("This permanently deletes the session and its transcript.")
                        .font(OpenClawType.caption)
                }
    }

    private func present(_ kind: CommandSessionMenuPresentation) {
        guard let connection, connection.isCurrent() else { return }
        self.presentation = PresentedMenu(kind: kind, session: self.session, connection: connection)
    }

    private func captureConfirmationTarget() {
        guard let connection else { return }
        self.confirmedTarget = PresentedMenu(kind: .appearance, session: self.session, connection: connection)
    }

    private func patch(
        label: String?? = nil,
        category: String?? = nil,
        color: String?? = nil,
        pinned: Bool? = nil,
        archived: Bool? = nil,
        unread: Bool? = nil)
    {
        var fields: [String: OpenClawProtocol.AnyCodable] = [:]
        if let label { fields["label"] = label.map(OpenClawProtocol.AnyCodable.init) ?? .init(NSNull()) }
        if let category { fields["category"] = category.map(OpenClawProtocol.AnyCodable.init) ?? .init(NSNull()) }
        if let color { fields["color"] = color.map(OpenClawProtocol.AnyCodable.init) ?? .init(NSNull()) }
        fields["pinned"] = pinned.map(OpenClawProtocol.AnyCodable.init)
        fields["archived"] = archived.map(OpenClawProtocol.AnyCodable.init)
        fields["unread"] = unread.map(OpenClawProtocol.AnyCodable.init)
        let action: OpenClawSessionMenuAction = archived != nil ? .archive : pinned != nil ? .pin :
            label != nil ? .rename : category != nil ? .group : color != nil ? .appearance : .unread
        self.mutate(action, fields: fields, removing: archived == true)
    }

    private func mutate(
        _ action: OpenClawSessionMenuAction,
        fields: [String: OpenClawProtocol.AnyCodable],
        removing: Bool = false,
        target: PresentedMenu? = nil)
    {
        guard let connection = target?.connection ?? self.connection else { return }
        let session = target?.session ?? self.session
        self.performMutation(removing ? session.key : nil) { _ in
            guard connection.allows(action, session: session) else {
                throw OpenClawChatTransportSendError.notDispatched
            }
            let request = OpenClawChatGatewayRequests.sessionMenu(action.method, session: session, fields: fields)
            try await connection.request(.init(
                method: request.method,
                params: request.params,
                timeoutMs: action == .reclaim ? 0 : action == .archive || action == .delete ? 600_000 : request
                    .timeoutMs))
            if action == .archive, fields["archived"]?.value as? Bool == true {
                self.onArchived?(session, connection)
            }
        }
    }

    private func patchSnooze(_ snoozedUntil: OpenClawChatSnoozePatch) {
        let value: OpenClawProtocol.AnyCodable = switch snoozedUntil {
        case .wake: .init(NSNull())
        case let .until(date): .init(Int(date.timeIntervalSince1970 * 1000))
        }
        self.mutate(.snooze, fields: ["snoozedUntil": value])
    }

    private var copyMenu: some View {
        Menu {
            self.actionButton("Session Link", systemImage: "link") { self.copyLink(preview: false) }
                .disabled(self.connection?.link(self.session, false) == nil)
            self.actionButton("Session Preview Link", systemImage: "eye") { self.copyLink(preview: true) }
                .disabled(self.connection?.link(self.session, true) == nil)
            self.actionButton("Markdown", systemImage: "doc.plaintext") {
                guard let connection else { return }
                Task {
                    do {
                        let markdown = try await ChatSessionSidebarActions.markdown(
                            session: self.session,
                            connection: connection)
                        guard connection.isCurrent() else { return }
                        UIPasteboard.general.string = markdown
                        self.copyMessage = String(localized: "Markdown copied.")
                    } catch { self.copyMessage = error.localizedDescription }
                }
            }.disabled(!self.allows(.markdown))
            self.actionButton("Session ID", systemImage: "number") {
                UIPasteboard.general.string = self.session.sessionId
                self.copyMessage = String(localized: "Session ID copied.")
            }.disabled(self.session.sessionId?.trimmedNonEmpty == nil)
        } label: { Label("Copy", systemImage: "doc.on.doc").font(OpenClawType.subhead) }
    }

    private func copyLink(preview: Bool) {
        guard let connection, connection.isCurrent(), let url = connection.link(self.session, preview) else { return }
        UIPasteboard.general.string = url.absoluteString
        self.copyMessage = String(localized: "Link copied.")
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
        guard !self.archived, self.session.isMain != true,
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

    private var groupMenu: some View {
        Menu {
            ForEach(self.categories, id: \.self) { category in
                self.actionButton(
                    .verbatim(category),
                    systemImage: self.session.category == category ? "checkmark" : "folder")
                {
                    self.patch(category: .some(category))
                }.disabled(self.session.category == category)
            }
            self.actionButton("New Group…", systemImage: "folder.badge.plus") {
                self.present(.newGroup)
            }.disabled(self.appModel.sessionGroups.usesCatalog &&
                !self.appModel.sessionGroups.allows("sessions.groups.put"))
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
            self.captureConfirmationTarget()
            self.confirmsDelete = true
        } label: {
            Label("Delete…", systemImage: "trash")
                .font(OpenClawType.subhead)
        }
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
        select: (() -> Void)? = nil,
        onArchived: ((OpenClawChatSessionEntry, OpenClawSessionMenuConnection) -> Void)? = nil,
        moveUp: (() -> Void)? = nil,
        moveDown: (() -> Void)? = nil) -> some View
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
            select: select,
            onArchived: onArchived,
            moveUp: moveUp,
            moveDown: moveDown))
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
