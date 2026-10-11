import Foundation
import OpenClawChatUI
import SwiftUI

/// The native drawer uses the shared sidebar projection and stores only view preferences locally.
enum RootSidebarPreferences {
    /// Adding view controls must not change the roster shown by existing iOS installs.
    static let defaultOptions = ChatSessionSidebarModel.ViewOptions(
        sort: .updated, showAutomation: true, showSystem: true)

    private static let prefix = "openclaw.ios.sidebar."

    static func load(defaults: UserDefaults = .standard) -> ChatSessionSidebarModel.ViewOptions {
        .init(
            sort: .init(rawValue: defaults.string(forKey: self.prefix + "sort") ?? "") ?? self.defaultOptions.sort,
            showAutomation: (defaults.object(forKey: self.prefix + "automation") as? Bool) ?? self.defaultOptions
                .showAutomation,
            showSystem: (defaults.object(forKey: self.prefix + "system") as? Bool) ?? self.defaultOptions.showSystem,
            grouping: .init(rawValue: defaults.string(forKey: self.prefix + "grouping") ?? "") ?? .category,
            emptyGroups: .init(rawValue: defaults.string(forKey: self.prefix + "emptyGroups") ?? "") ?? .filtering,
            status: .init(rawValue: defaults.string(forKey: self.prefix + "status") ?? "") ?? .active,
            ownerFilter: defaults.string(forKey: self.prefix + "owner") ?? "",
            showMessagePreview: defaults.bool(forKey: self.prefix + "preview"))
    }

    static func save(_ options: ChatSessionSidebarModel.ViewOptions, defaults: UserDefaults = .standard) {
        defaults.set(options.sort.rawValue, forKey: self.prefix + "sort")
        defaults.set(options.showAutomation, forKey: self.prefix + "automation")
        defaults.set(options.showSystem, forKey: self.prefix + "system")
        defaults.set(options.grouping.rawValue, forKey: self.prefix + "grouping")
        defaults.set(options.emptyGroups.rawValue, forKey: self.prefix + "emptyGroups")
        defaults.set(options.status.rawValue, forKey: self.prefix + "status")
        defaults.set(options.ownerFilter, forKey: self.prefix + "owner")
        defaults.set(options.showMessagePreview, forKey: self.prefix + "preview")
    }
}

struct RootSidebarSessionViewMenu: View {
    @Binding var options: ChatSessionSidebarModel.ViewOptions
    let owners: [OpenClawChatSessionEntry.CreatedActor]
    var showsAllAgents = false
    let selectOwner: () -> Void
    let selectSessions: () -> Void
    let createGroup: () -> Void

    var body: some View {
        Menu {
            Picker(selection: self.$options.status) {
                self.text("Active").tag(OpenClawChatSidebarStatus.active)
                self.text("Snoozed").tag(OpenClawChatSidebarStatus.snoozed)
                self.text("Archived").tag(OpenClawChatSidebarStatus.archived)
                self.text("All").tag(OpenClawChatSidebarStatus.all)
            } label: { self.label("Status", "line.3.horizontal.decrease") }
                .pickerStyle(.inline)
        } label: { self.label("Status", "line.3.horizontal.decrease") }
        Button(action: self.selectOwner) { self.label("Owner", "person.crop.circle") }
        Toggle(isOn: self.$options.showAutomation) { self.label("Show Automation Sessions", "timer") }
        Toggle(isOn: self.$options.showSystem) { self.label("Show System Sessions", "gearshape") }
        Divider()
        Menu {
            Picker(selection: self.$options.sort) {
                self.text("Created").tag(ChatSessionSidebarModel.Sort.created)
                self.text("Updated").tag(ChatSessionSidebarModel.Sort.updated)
                if !self.owners.isEmpty { self.text("People").tag(ChatSessionSidebarModel.Sort.people) }
            } label: { self.label("Sort By", "arrow.up.arrow.down") }
                .pickerStyle(.inline)
        } label: { self.label("Sort By", "arrow.up.arrow.down") }
        if !self.showsAllAgents {
            Menu {
                Picker(selection: self.$options.grouping) {
                    self.text("Group").tag(ChatSessionSidebarModel.Grouping.category)
                    self.text("Project").tag(ChatSessionSidebarModel.Grouping.project)
                    if !self.owners.isEmpty { self.text("Person").tag(ChatSessionSidebarModel.Grouping.person) }
                    self.text("None").tag(ChatSessionSidebarModel.Grouping.none)
                } label: { self.label("Group By", "folder") }
                    .pickerStyle(.inline)
            } label: { self.label("Group By", "folder") }
            Menu {
                Picker(selection: self.$options.emptyGroups) {
                    self.text("When Filtering").tag(ChatSessionSidebarModel.EmptyGroups.filtering)
                    self.text("Always").tag(ChatSessionSidebarModel.EmptyGroups.always)
                    self.text("Never").tag(ChatSessionSidebarModel.EmptyGroups.never)
                } label: { self.label("Hide Empty Groups", "folder.badge.questionmark") }
                    .pickerStyle(.inline)
            } label: { self.label("Hide Empty Groups", "folder.badge.questionmark") }
        }
        Toggle(isOn: self.$options.showMessagePreview) { self.label("Show Session Preview", "text.bubble") }
        Divider()
        Button(action: self.createGroup) { self.label("New Group…", "folder.badge.plus") }
        Button(action: self.selectSessions) { self.label("Select Sessions…", "checkmark.circle") }
        if self.options.isChanged(
            peopleAvailable: !self.owners.isEmpty,
            defaults: RootSidebarPreferences.defaultOptions)
        {
            Button {
                let grouping = self.options.grouping
                let emptyGroups = self.options.emptyGroups
                self.options.reset(
                    peopleAvailable: !self.owners.isEmpty,
                    defaults: RootSidebarPreferences.defaultOptions)
                if self.showsAllAgents {
                    self.options.grouping = grouping
                    self.options.emptyGroups = emptyGroups
                }
            } label: {
                self.label("Reset View", "arrow.counterclockwise")
            }
        }
    }

    private func text(_ key: LocalizedStringKey) -> some View {
        Text(key).font(OpenClawType.subhead)
    }

    private func label(_ key: LocalizedStringKey, _ symbol: String) -> some View {
        Label { self.text(key) } icon: { Image(systemName: symbol) }
    }
}

struct RootSidebarDashboardRoute: Identifiable {
    let path: String
    let title: String
    var queryItems: [URLQueryItem] = []
    var id: String {
        self.path + self.queryItems.map { "\($0.name)=\($0.value ?? "")" }.joined(separator: "&")
    }
}

struct RootSidebarSessionIcon: View {
    let icon: String?

    var body: some View {
        if let icon, ChatSessionSidebarActions.acceptsCustomEmoji(icon) {
            Text(verbatim: icon).font(OpenClawType.subhead)
        } else {
            Image(systemName: ChatSessionSidebarActions.iconGlyphs.first { $0.0 == self.icon }?.1 ?? "bubble.left")
        }
    }
}

struct RootSidebarOwnerFilter: View {
    @Environment(\.dismiss) private var dismiss
    @State private var search = ""
    @Binding var selection: String
    let owners: [OpenClawChatSessionEntry.CreatedActor]

    var body: some View {
        NavigationStack {
            List {
                self.row("All Owners", value: "")
                self.row("Involving Me", value: "involving-me")
                if self.selection.hasPrefix("owner:"),
                   !self.owners.contains(where: { "owner:" + ($0.id ?? "") == self.selection })
                {
                    self.row(String(self.selection.dropFirst(6)), value: self.selection)
                }
                ForEach(self.owners.filter { actor in
                    actor.id != nil && (self.search.isEmpty ||
                        (actor.label ?? actor.id ?? "").localizedCaseInsensitiveContains(self.search))
                }, id: \.id) { owner in
                    self.row(owner.label ?? owner.id ?? "", value: "owner:" + (owner.id ?? ""))
                }
            }
            .searchable(text: self.$search, prompt: Text("Search owners").font(OpenClawType.body))
            .navigationTitle(String(localized: "Owner"))
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button { self.dismiss() } label: { Text("Done").font(OpenClawType.subheadSemiBold) }
                }
            }
        }.openClawSheetChrome()
    }

    private func row(_ label: String, value: String) -> some View {
        Button {
            self.selection = value
            self.dismiss()
        } label: {
            HStack {
                Text(verbatim: label).font(OpenClawType.subhead)
                Spacer()
                if self.selection == value { Image(systemName: "checkmark") }
            }
        }
    }
}
