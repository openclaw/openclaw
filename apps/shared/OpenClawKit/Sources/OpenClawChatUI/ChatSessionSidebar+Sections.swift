#if os(macOS)
import SwiftUI

extension ChatSessionSidebar {
    var filterOptions: ChatSessionSidebarModel.ViewOptions {
        .init(
            sort: self.sessionSort,
            showAutomation: self.showAutomationSessions,
            showSystem: self.showSystemSessions,
            grouping: self.sessionGrouping,
            emptyGroups: self.emptyGroups,
            status: self.sessionStatus,
            ownerFilter: self.sessionOwnerFilter,
            showMessagePreview: self.showMessagePreview)
    }

    var filterBinding: Binding<ChatSessionSidebarModel.ViewOptions> {
        Binding(get: { self.filterOptions }, set: { options in
            self.sessionSort = options.sort
            self.showAutomationSessions = options.showAutomation
            self.showSystemSessions = options.showSystem
            self.showMessagePreview = options.showMessagePreview
            self.sessionGrouping = options.grouping
            self.emptyGroups = options.emptyGroups
            self.sessionStatus = options.status
            self.sessionOwnerFilter = options.ownerFilter
        })
    }

    func ownership(for rows: [OpenClawChatSessionEntry] = []) -> ChatSidebarOwnership {
        let person = self.sidebarPeople?.people.first { $0.id == self.sidebarPeople?.selfKey }
        let selfOwner = person.flatMap { person in person.profileID.map { id in
            OpenClawChatSessionEntry.CreatedActor(
                type: "human",
                id: id,
                label: person.label,
                avatarUrl: person.user.avatarUrl,
                identity: .init([
                    "type": "profile",
                    "id": id,
                ]))
        } }
        return ChatSidebarOwnership(
            facet: self.rosterData?.owners,
            selfOwner: selfOwner,
            rows: rows)
    }

    func applySidebarFilters() {
        self.viewModel.updateSidebarQuery(
            search: self.query,
            status: self.sessionStatus,
            showAutomation: self.showAutomationSessions,
            showSystem: self.showSystemSessions)
        guard let data = self.rosterData else { return }
        var query = data.query
        query.ownerId = self.filterOptions.ownerID
        query.involvingMe = self.filterOptions.involvingMe ? true : nil
        if data.setQuery(query) { self.viewModel.refreshSidebarData() }
    }

    func reconcileOwnerFacet() {
        let ownership = self.ownership()
        if !ownership.peopleAvailable, self.sessionSort == .people { self.sessionSort = .created }
        // Presence recovery temporarily clears self; do not erase a saved self filter during that gap.
        if self.sidebarPeople?.selfKey != nil, self.filterOptions.ownerID != nil,
           ownership.activeOwnerID(self.filterOptions.ownerID) == nil
        {
            self.sessionOwnerFilter = ""
        }
    }

    func loadSidebarGroups() async throws {
        let lease = try await self.viewModel.sessionGroupsRouteLease()
        let response = try await lease.listGroups()
        guard !Task.isCancelled else { return }
        self.groups = (response?.groups ?? []).sorted {
            $0.position == $1.position ? $0.name < $1.name : $0.position < $1.position
        }
        self.sectionOrder = response?.sectionOrder ?? []
    }

    @ViewBuilder func sessionSection(
        _ section: ChatSessionSidebarModel.Section,
        now: Date,
        ownership: ChatSidebarOwnership,
        previewRequest: ChatSessionSidebarPreviews.Request) -> some View
    {
        if section.id.hasPrefix("group:"), let title = section.title {
            let attention = self.attentionSummary(sessions: section.nodes.flatMap(\.previewSessions), now: now)
            Section {
                if !self.isGroupCollapsed(title) || !self.query
                    .trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
                {
                    self.rows(
                        section.nodes,
                        now: now,
                        ownership: ownership,
                        section: section.id,
                        previewRequest: previewRequest)
                }
            } header: {
                HStack(spacing: 6) {
                    Button {
                        self.toggleGroupCollapsed(title)
                    } label: {
                        HStack {
                            Image(systemName: self.isGroupCollapsed(title) ? "chevron.right" : "chevron.down")
                            Text(verbatim: title)
                                .font(OpenClawChatTypography.caption)
                        }
                    }
                    .buttonStyle(.plain)
                    Spacer(minLength: 0)
                    self.attentionBadge(summary: attention, targetID: section.id)
                }
                .contextMenu { self.groupMenu(title) }
                .modifier(ChatSidebarSectionInteraction(sidebar: self, section: section.id))
                .modifier(ChatSidebarAttentionAccessibility(
                    title: title,
                    targetID: section.id,
                    summary: attention,
                    metadata: [],
                    presentation: self.$presentedAttention))
            }
        } else if let title = section.title {
            Section {
                self.rows(
                    section.nodes, now: now, ownership: ownership, section: section.id, previewRequest: previewRequest)
            } header: {
                Text(verbatim: title)
                    .font(OpenClawChatTypography.caption)
                    .help(section.id.hasPrefix("project:") ? String(section.id.dropFirst(8)) : title)
                    .modifier(ChatSidebarSectionInteraction(sidebar: self, section: section.id))
            }
        } else {
            Section {
                self.rows(
                    section.nodes, now: now, ownership: ownership, section: section.id, previewRequest: previewRequest)
            }
        }
    }
}
#endif
