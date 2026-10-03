#if os(macOS)
import OpenClawKit
import SwiftUI

extension ChatSessionSidebar {
    func row(
        for node: ChatSessionSidebarModel.Node,
        isChild: Bool,
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        let session = node.session
        let pageAgent = self.showsAllAgents && self.query.isEmpty && !isChild && session.pinned == true
            ? self.sessionAgentID(session)
            .map { id in self.viewModel.agentChoices.first { $0.id == id } ?? .init(id: id) } : nil
        let pageSummary = pageAgent.map { _ in ChatSidebarTreeSummary(
            page: node, expanded: self.childExpansion(node).wrappedValue, isConnected: self.viewModel.healthOK) }
        let attention = self.attentionSummary(
            sessions: pageSummary?.sessions ?? node.previewSessions,
            agentID: self.sessionAgentID(session),
            now: now)
        let targetID = "session:\(session.key)"
        let agentID = OpenClawChatSessionKey.agentID(from: session.key) ??
            self.viewModel.sessionMutationTarget(key: session.key, agentID: session.agentId).agentID
        let facts = ChatSessionSidebarRowFacts(
            node: node,
            isChild: isChild,
            attention: attention,
            showPreview: self.showMessagePreview,
            isConnected: self.viewModel.healthOK,
            webFacts: agentID.flatMap { self.viewModel.webConversation?.sidebarFacts(
                for: .init(agentId: $0, sessionKey: session.key)) },
            preview: self.rowPreview(for: session, previewRequest: previewRequest),
            now: now)
        let viewers = Set((self.sidebarPeople?.people ?? []).filter { $0.watchedSessions.contains(session.key) }
            .compactMap(\.profileID))
        let attribution = ownership.attribution(
            for: session,
            options: self.filterOptions,
            isChild: isChild,
            decorated: facts
                .glyph != nil || (attention != nil && !session.isArchived),
            viewingProfileIDs: viewers)
        let content = ChatSidebarRow(
            viewModel: self.viewModel,
            node: node,
            isChild: isChild,
            facts: facts,
            attribution: attribution,
            wakeDescription: (self.sessionStatus == .snoozed || self.sessionStatus == .all) &&
                session.isSnoozed(at: now) ? session.snoozedUntil.map {
                    OpenClawChatSessionSnooze.wakeDescription(Date(timeIntervalSince1970: $0 / 1000), now: now)
                } : nil,
            attention: attention,
            pageAgent: pageAgent,
            pageSummary: pageSummary,
            now: now,
            connected: self.viewModel.healthOK,
            mainSessionKey: self.sessionAgentID(session).map { self.viewModel.mainSessionKey(forAgent: $0) } ?? self
                .viewModel.selectedAgentMainSessionKey,
            pin: {
                self.viewModel.setSessionPinned(
                    key: session.key,
                    pinned: session.pinned != true,
                    agentID: session.agentId)
            },
            archive: { self.viewModel.setSessionArchived(session, archived: !session.isArchived) },
            presentedAttention: self.$presentedAttention)
        return self.interactionRow(content, session: session, isChild: isChild)
            .overlay(alignment: .leading) {
                OpenClawSessionColorStripe(color: session.color)
                    .offset(x: -6)
            }
            .tag(self.interactionIdentity(session))
            .contextMenu {
                if self.selectedBatchRows.count > 1,
                   self.batch.selection.keys.contains(self.interactionIdentity(session))
                {
                    self.batchMenu.disabled(self.batch.busy)
                } else {
                    self.contextMenu(for: session, isChild: isChild, now: now)
                }
            }
            .modifier(ChatSidebarAttentionAccessibility(
                title: ChatSessionSidebarModel.sidebarDisplayName(for: session),
                targetID: targetID,
                summary: attention,
                metadata: [
                    facts.channelLabel,
                    facts.subtitle,
                    !session.isArchived && (pageSummary.map { $0.unread > 0 } ?? node.badges.hasUnread)
                        ? String(localized: "Unread") : nil,
                    (pageSummary.map { $0.failed > 0 } ?? facts.failedDescendants)
                        ? String(localized: "Thread failed") : nil,
                ]
                    .compactMap(\.self) + facts.badges.map(\.label),
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
            mainSessionKey: agentID.map { self.viewModel.mainSessionKey(forAgent: $0) } ?? self.viewModel
                .selectedAgentMainSessionKey,
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
        if let preview = ChatPayloadDecoding.trimmedNonEmptyString(session.lastMessagePreview) { return preview }
        if !self.viewModel.usesWebConversation, self.viewModel.matchesCurrentSessionKey(
            incoming: session.key, agentId: session.agentId, current: self.viewModel.sessionKey),
            let current = ChatSessionSidebarModel.messagePreview(from: self.viewModel.messages)
        { return current }
        return self.previews.text(for: session, in: previewRequest)
    }
}

private struct ChatSidebarRow: View {
    let viewModel: OpenClawChatViewModel
    let node: ChatSessionSidebarModel.Node
    let isChild: Bool
    let facts: ChatSessionSidebarRowFacts
    let attribution: ChatSidebarOwnership.Attribution?
    let wakeDescription: String?
    let attention: OpenClawChatAttentionSummary?
    let pageAgent: OpenClawChatAgentChoice?
    let pageSummary: ChatSidebarTreeSummary?
    let now: Date
    let connected: Bool
    let mainSessionKey: String
    let pin: () -> Void
    let archive: () -> Void
    @Binding var presentedAttention: OpenClawChatAttentionPresentation?
    @State private var hovered = false
    @FocusState private var focus: Focus?
    private enum Focus: Hashable { case row, pin, archive }

    var body: some View {
        HStack(alignment: self.facts.subtitle == nil && self.facts.channelLabel == nil ? .center : .top, spacing: 8) {
            self.leading.frame(width: 22, height: 22)
            VStack(alignment: .leading, spacing: 4) {
                Text(verbatim: ChatSessionSidebarModel.sidebarDisplayName(for: self.node.session))
                    .font(OpenClawChatTypography.body(
                        size: 13, weight: self.node.session.unread == true ? .medium : .regular, relativeTo: .body))
                    .lineLimit(1)
                // ui/src/components/app-sidebar-session-row-render.ts:480 keeps
                // linked-channel identity visible independently of ambient previews.
                if self.facts.channelLabel != nil || self.facts.subtitle != nil {
                    Text(verbatim: [self.facts.channelLabel, self.facts.subtitle].compactMap(\.self)
                        .joined(separator: " · "))
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            Spacer(minLength: 0)
            HStack(spacing: 5) {
                if let pageSummary {
                    ChatSidebarSummarySignals(
                        summary: pageSummary,
                        attention: self.attention,
                        now: self.now,
                        targetID: "session:\(self.node.id)",
                        presentedAttention: self.$presentedAttention)
                }
                ChatSidebarSessionViewers(
                    sessionKey: self.node.session.key,
                    excludingProfileIDs: self.attribution?.renderedProfileIDs ?? [])
                if self.pageAgent == nil, self.facts.unreadDescendants { self.unreadDot }
                if self.pageAgent == nil, self.facts.failedDescendants {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(OpenClawChatTheme.danger)
                        .help(String(localized: "Thread failed"))
                        .accessibilityLabel(String(localized: "Thread failed"))
                }
                ForEach(self.facts.badges.indices, id: \.self) { index in
                    let badge = self.facts.badges[index]
                    HStack(spacing: 2) {
                        self.graphic(badge.glyph)
                        if let count = badge.count { Text(verbatim: String(count)).monospacedDigit() }
                    }
                    .foregroundStyle(self.color(badge.tone))
                    .help(badge.label)
                    .accessibilityElement(children: .ignore)
                    .accessibilityLabel(badge.label)
                }
                if self.isChild, self.node.session.runtimeMs != nil || self.node.session.startedAt != nil {
                    ChatSidebarRuntime(session: self.node.session, isConnected: self.connected)
                }
                if let wakeDescription = self.wakeDescription {
                    Text(String(format: String(localized: "Wakes %@"), wakeDescription))
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }
            }
            .font(OpenClawChatTypography.caption)
            self.actions
        }
        .padding(.vertical, 4)
        .contentShape(Rectangle())
        .onHover { self.hovered = $0 }
        .focusable()
        .focused(self.$focus, equals: .row)
        .focusEffectDisabled()
        .modifier(ChatSessionSidebarHoverCard(
            session: self.node.session,
            error: self.facts.glyphTone == .danger ? self.facts.attentionLabel : nil,
            hovered: self.hovered,
            focused: self.focus == .row,
            rowHasFocus: self.focus != nil,
            viewModel: self.viewModel,
            restoreFocus: { self.focus = .row }))
    }

    private var leading: some View {
        ZStack {
            if self.facts.running, self.pageAgent == nil {
                if self.facts.queued {
                    Circle().strokeBorder(.tint, style: StrokeStyle(lineWidth: 1.5, dash: [2, 2]))
                        .accessibilityLabel(String(localized: "Thread queued"))
                        .accessibilityValue(self.leadingUnreadValue)
                } else {
                    ProgressView().controlSize(.small)
                        .accessibilityLabel(String(localized: "Thread running"))
                        .accessibilityValue(self.leadingUnreadValue)
                }
            }
            if let pageAgent = self.pageAgent {
                // app-sidebar-session-row-render.ts:226,307 keeps roster-mode avatar and activity in separate slots.
                ChatSidebarAgentAvatar(agent: pageAgent, size: 22).help(pageAgent.displayName)
            } else if let attention = self.attention, !self.node.session.isArchived {
                OpenClawChatAttentionBadge(
                    summary: attention, targetID: "session:\(self.node.id)", presentation: self.$presentedAttention)
                    .accessibilityValue(self.leadingUnreadValue)
            } else if let glyph = self.facts.glyph {
                self.graphic(glyph)
                    .font(.system(size: 12))
                    .foregroundStyle(self.color(self.facts.glyphTone))
                    .help(self.facts.attentionLabel ?? self.facts.idleLabel ?? "")
                    .accessibilityLabel(self.facts.attentionLabel ?? self.facts.idleLabel ?? "")
                    .accessibilityHidden(self.facts.attentionLabel == nil && self.facts.idleLabel == nil)
            } else if let attribution = self.attribution {
                ChatSidebarAttribution(attribution: attribution)
            }
            if self.facts.unread, self.facts.glyph == nil, self.attribution == nil, self.pageAgent == nil {
                self.unreadDot
            }
        }
        .overlay(alignment: .bottomTrailing) {
            if self.pageAgent == nil, self.facts.unread,
               self.facts.glyph != nil || self.attribution != nil { self.unreadDot }
        }
    }

    private var unreadDot: some View {
        Circle().fill(.tint).frame(width: 7, height: 7)
            .accessibilityLabel(String(localized: "Unread"))
    }

    private var leadingUnreadValue: String {
        // session-leading-indicator.ts:33 keeps unread describable while the run hides its dot.
        self.node.session.unread == true && !self.facts.unread ? String(localized: "Unread") : ""
    }

    private var actions: some View {
        // ui/src/styles/components.css:5740 exposes inline actions on hover or focus.
        HStack(spacing: 1) {
            if ChatSessionSidebarEligibility.canPin(self.node.session, isChild: self.isChild) {
                Button(action: self.pin) {
                    Image(systemName: self.node.session.pinned == true ? "pin.slash" : "pin")
                }
                .help(self.node.session.pinned == true ? String(localized: "Unpin") : String(localized: "Pin"))
                .accessibilityLabel(self.node.session
                    .pinned == true ? String(localized: "Unpin") : String(localized: "Pin"))
                .focused(self.$focus, equals: .pin)
                .disabled(!self.connected)
            }
            Button(action: self.archive) {
                Image(systemName: self.node.session.isArchived ? "tray.and.arrow.up" : "archivebox")
            }
            .help(self.node.session.isArchived ? String(localized: "Restore") : String(localized: "Archive"))
            .accessibilityLabel(self.node.session
                .isArchived ? String(localized: "Restore") : String(localized: "Archive"))
            .focused(self.$focus, equals: .archive)
            .disabled(!self.connected || !ChatSessionSidebarEligibility.canArchive(
                self.node.session, mainSessionKey: self.mainSessionKey))
        }
        .buttonStyle(.borderless)
        .font(.system(size: 12))
        .opacity(self.hovered || self.focus != nil ? 1 : 0)
        .allowsHitTesting(self.hovered || self.focus != nil)
    }

    @ViewBuilder private func graphic(_ glyph: ChatSessionSidebarRowFacts.Glyph) -> some View {
        switch glyph {
        case let .symbol(name): Image(systemName: name)
        case let .emoji(value): Text(verbatim: value)
        }
    }

    private func color(_ tone: ChatSessionSidebarRowFacts.Tone) -> Color {
        switch tone {
        case .secondary: .secondary
        case .accent: OpenClawChatTheme.accent
        case .success: OpenClawChatTheme.success
        case .warning: OpenClawChatTheme.warning
        case .danger: OpenClawChatTheme.danger
        }
    }
}

private struct ChatSidebarRuntime: View {
    let session: OpenClawChatSessionEntry
    let isConnected: Bool
    @State private var sampledAt = Date()

    var body: some View {
        TimelineView(.periodic(from: .now, by: 1)) { context in
            if let text = ChatSessionSidebarRowFacts.runtimeText(
                self.session, sampledAt: self.sampledAt, now: context.date, isConnected: self.isConnected)
            {
                Text(verbatim: text).monospacedDigit().foregroundStyle(.secondary)
            }
        }
        .onChange(of: ChatSessionSidebarRowFacts.RuntimeSample(self.session)) { _, _ in
            self.sampledAt = Date()
        }
        // Reconnection must not add disconnected wall time to the recorded runtime.
        .onChange(of: self.isConnected) { _, _ in self.sampledAt = Date() }
    }
}

/// The palette retains its preformatted timestamp and subtitle.
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

private struct ChatSidebarAttribution: View {
    let attribution: ChatSidebarOwnership.Attribution

    var body: some View {
        HStack(spacing: -8) {
            if self.attribution.participantCount == 1, let participant = self.attribution.participants.first {
                ChatSidebarOwnerAvatar(actor: .init(
                    type: "human",
                    id: ChatSessionSidebarModel.identityField(
                        participant.identity,
                        "id"),
                    label: participant.label,
                    avatarUrl: participant.avatarUrl,
                    identity: participant.identity))
                    .help(participant.label ?? "")
            } else if self.attribution.participantCount > 0 {
                Text(verbatim: "+\(self.attribution.participantCount)").font(.system(size: 8, weight: .medium))
                    .frame(width: 18, height: 18).background(.quaternary, in: Circle())
            }
            ChatSidebarOwnerAvatar(actor: self.attribution.actor)
                .saturation(self.attribution.viewing == false ? 0.3 : 1)
        }
        .help(self.label).accessibilityElement(children: .ignore).accessibilityLabel(self.label)
    }

    private var label: String {
        var label = self.attribution.label
        if self.attribution.viewing == true { label += " · " + String(localized: "Viewing now") }
        if self.attribution.participantCount == 1, let participant = self.attribution.participants.first {
            label += " · " + String(
                format: String(localized: "With %@"),
                participant.label ??
                    ChatSessionSidebarModel.identityField(participant.identity, "id") ?? "")
        } else if self.attribution.participantCount > 0 {
            label += " · " + String(
                format: String(localized: "With %lld participants"), self.attribution.participantCount)
        }
        return label
    }
}

private struct ChatSidebarOwnerAvatar: View {
    @Environment(\.openClawSidebarPeopleActions) private var actions
    @State private var image: NSImage?
    let actor: OpenClawChatSessionEntry.CreatedActor

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                let name = self.actor.label ?? self.actor.id ?? ""
                let initials = name.components(separatedBy: "@").first?.components(separatedBy:
                    CharacterSet.whitespacesAndNewlines.union(CharacterSet(charactersIn: "._-")))
                    .filter { !$0.isEmpty }.prefix(2).compactMap(\.first).map(String.init).joined().uppercased() ?? ""
                ChatAgentAvatar(text: initials, name: name, tint: nil, size: 18)
            }
        }
        .frame(width: 18, height: 18).clipShape(Circle())
        .task(id: self.actor) {
            self.image = nil
            guard let identity = self.actor.identity,
                  ChatSessionSidebarModel.identityField(identity, "type") == "profile",
                  let id = ChatSessionSidebarModel.identityField(identity, "id"),
                  let data = await self.actions?.avatar(id, self.actor.avatarUrl), !Task.isCancelled else { return }
            self.image = NSImage(data: data)
        }
    }
}
#endif
