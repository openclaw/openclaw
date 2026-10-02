#if os(macOS)
import OpenClawProtocol
import SwiftUI

struct ChatSidebarOwnership {
    typealias Actor = OpenClawChatSessionEntry.CreatedActor
    let facet: [Actor]?
    let owners: [Actor]
    let selfID: String?
    let showsFilters: Bool
    let showsAvatars: Bool
    var peopleAvailable: Bool {
        self.facet.map { $0.count >= 2 } ?? true
    }

    init(facet: [Actor]?, selfOwner: Actor?, rows: [OpenClawChatSessionEntry]) {
        self.facet = facet
        self.selfID = selfOwner?.id
        // ui/src/components/app-sidebar-session-ownership.ts:59: complete facets plus authenticated self, never row owners.
        let includeSelf = selfOwner != nil && !((facet ?? []).contains { $0.id == selfOwner?.id && $0.type == "agent" })
        self.owners = includeSelf ? [selfOwner!] + (facet ?? []).filter { $0.id != selfOwner?.id } : facet ?? []
        var identities = Set<String>(), humans = Set<String>()
        func observe(_ identity: AnyCodable, human: Bool) {
            let key = ChatSessionSidebarModel.identityKey(identity)
            identities.insert(key)
            if human { humans.insert(key) }
        }
        for owner in self.owners {
            if let id = owner.id {
                observe(
                    owner.identity ?? AnyCodable(["type": owner.type == "human" ? "profile" : "agent", "id": id]),
                    human: owner.type == "human")
            }
        }
        var overflow = false
        for row in rows {
            if humans.count >= 2 { break }
            let participants = row.participants ?? []
            for participant in participants {
                let identity = participant.identity
                let type = ChatSessionSidebarModel.identityField(identity, "type")
                let human = type == "profile" ||
                    (type == "observation" && ChatSessionSidebarModel
                        .identityField(identity, "senderKind") == "human") ||
                    (type == "legacy" && ChatSessionSidebarModel.identityField(identity, "actorType") == "human")
                observe(identity, human: human)
            }
            overflow = overflow || (row.participantCount ?? participants.count) > participants.count
        }
        self.showsFilters = identities.count >= 2 || overflow
        self.showsAvatars = humans.count >= 2
    }

    func activeOwnerID(_ selection: String?) -> String? {
        guard let selection, !selection.isEmpty else { return nil }
        return self.facet == nil || self.owners.contains { $0.id == selection } ? selection : nil
    }

    struct Attribution {
        let actor: Actor
        let label: String
        let viewing: Bool?
        let participants: [OpenClawChatSessionEntry.Participant]
        let participantCount: Int
        var renderedProfileIDs: Set<String> {
            let identities = [self.actor.identity] +
                (self.participantCount == 1 ? self.participants.prefix(1).map(\.identity) : [])
            return Set(identities.compactMap { identity in
                guard let identity,
                      ChatSessionSidebarModel.identityField(identity, "type") == "profile" else { return nil }
                return ChatSessionSidebarModel.identityField(identity, "id")
            })
        }
    }

    func attribution(
        for row: OpenClawChatSessionEntry,
        options: ChatSessionSidebarModel.ViewOptions,
        isChild: Bool,
        decorated: Bool,
        viewingProfileIDs: Set<String>) -> Attribution?
    {
        guard self.showsAvatars, !isChild, !decorated,
              let actor = options.status == .archived ? row.archivedBy : row.owner?.actor,
              let id = ChatPayloadDecoding.trimmedNonEmptyString(actor.id) else { return nil }
        let profile = actor.identity.flatMap {
            ChatSessionSidebarModel.identityField($0, "type") == "profile" ? ChatSessionSidebarModel.identityField(
                $0,
                "id") : nil
        }
        let viewing = profile.map(viewingProfileIDs.contains)
        let count = row.participantCount ?? row.participants?.count ?? 0
        // ui/src/components/app-sidebar-session-row-render.ts:204,211: headers and solo self filters own durable attribution.
        if options.status != .archived {
            if profile != nil, profile == self.selfID, count == 0,
               options.involvingMe || options.ownerID == id { return nil }
            if options.effectiveGrouping(peopleAvailable: self.peopleAvailable) == .person,
               row.pinned != true, viewing != true { return nil }
        }
        let name = actor.label ?? id
        let label = options.status == .archived ? String(format: String(localized: "Archived by %@"), name) :
            row.owner?.assignedAt != nil ? String(format: String(localized: "Owned by %@"), name) :
            String(format: String(localized: "Created by %@"), name)
        return Attribution(
            actor: actor,
            label: label,
            viewing: viewing,
            participants: row.participants ?? [],
            participantCount: count)
    }
}

struct ChatSessionSidebarFilters: View {
    @Binding var options: ChatSessionSidebarModel.ViewOptions
    let ownership: ChatSidebarOwnership
    @State private var ownerSearch = ""
    @FocusState private var statusFocused: Bool

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack {
                Text("Filters").fontWeight(.semibold)
                Spacer()
                if self.options.isChanged(peopleAvailable: self.ownership.peopleAvailable) {
                    Button("Reset") {
                        self.options.reset(peopleAvailable: self.ownership.peopleAvailable)
                        self.statusFocused = true
                    }
                }
            }
            if self.ownership.showsFilters || !self.options.ownerFilter.isEmpty {
                DisclosureGroup {
                    TextField(String(localized: "Search owners"), text: self.$ownerSearch)
                        .textFieldStyle(.roundedBorder)
                    ScrollView {
                        VStack(alignment: .leading, spacing: 6) {
                            self.ownerChoice("", label: String(localized: "All owners"))
                            self.ownerChoice("involving-me", label: String(localized: "Involving me"))
                            ForEach(self.ownership.owners, id: \.id) { owner in
                                if let id = owner.id {
                                    self.ownerChoice(
                                        "owner:\(id)",
                                        label: id == self.ownership.selfID
                                            ? String(format: String(localized: "%@ (You)"), owner.label ?? id) : owner
                                            .label ?? id)
                                }
                            }
                            if let id = self.options.ownerID, !self.ownership.owners.contains(where: { $0.id == id }) {
                                self.ownerChoice("owner:\(id)", label: id)
                            }
                        }
                    }.frame(maxHeight: 130)
                } label: {
                    HStack {
                        Text("Owners")
                        Spacer()
                        Text(verbatim: self.selectedOwnerLabel).foregroundStyle(.secondary).lineLimit(1)
                    }
                }
            }
            Picker("Status", selection: self.$options.status) {
                Text("Active").tag(OpenClawChatSidebarStatus.active)
                Text("Archived").tag(OpenClawChatSidebarStatus.archived)
                Text("All").tag(OpenClawChatSidebarStatus.all)
            }.pickerStyle(.segmented).focused(self.$statusFocused)
            Toggle("Show automation sessions", isOn: self.$options.showAutomation)
            Toggle("Show system sessions", isOn: self.$options.showSystem)
            Divider()
            Text("Display").fontWeight(.semibold)
            Picker("Group by", selection: Binding(
                get: { self.options.effectiveGrouping(peopleAvailable: self.ownership.peopleAvailable) },
                set: { self.options.grouping = $0 }))
            {
                Text("Category").tag(ChatSessionSidebarModel.Grouping.category)
                Text("Project").tag(ChatSessionSidebarModel.Grouping.project)
                if self.ownership.peopleAvailable { Text("Person").tag(ChatSessionSidebarModel.Grouping.person) }
                Text("None").tag(ChatSessionSidebarModel.Grouping.none)
            }
            Picker("Sort", selection: self.$options.sort) {
                Text("Created").tag(ChatSessionSidebarModel.Sort.created)
                Text("Last updated").tag(ChatSessionSidebarModel.Sort.updated)
                if self.ownership.peopleAvailable { Text("People").tag(ChatSessionSidebarModel.Sort.people) }
            }
            Picker("Hide empty groups", selection: self.$options.emptyGroups) {
                Text("When filtering").tag(ChatSessionSidebarModel.EmptyGroups.filtering)
                Text("Always").tag(ChatSessionSidebarModel.EmptyGroups.always)
                Text("Never").tag(ChatSessionSidebarModel.EmptyGroups.never)
            }
            Toggle("Show message preview", isOn: self.$options.showMessagePreview)
        }
        .font(OpenClawChatTypography.body(size: 12, weight: .regular, relativeTo: .body))
        .padding(16).frame(width: 330)
        .accessibilityIdentifier("chat-sidebar-filters")
    }

    private var selectedOwnerLabel: String {
        if self.options.involvingMe { return String(localized: "Involving me") }
        guard let id = self.options.ownerID else { return String(localized: "All owners") }
        let name = self.ownership.owners.first { $0.id == id }?.label ?? id
        return id == self.ownership.selfID ? String(format: String(localized: "%@ (You)"), name) : name
    }

    @ViewBuilder private func ownerChoice(_ value: String, label: String) -> some View {
        if self.ownerSearch.isEmpty || label.localizedStandardContains(self.ownerSearch) {
            Button { self.options.ownerFilter = value } label: {
                HStack {
                    Text(verbatim: label).lineLimit(1)
                    Spacer()
                    if self.options.ownerFilter == value { Image(systemName: "checkmark") }
                }.contentShape(Rectangle())
            }.buttonStyle(.plain)
        }
    }
}
#endif
