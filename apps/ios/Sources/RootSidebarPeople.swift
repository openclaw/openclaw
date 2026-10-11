import Foundation
import Observation
import OpenClawChatUI
import OpenClawKit
import OpenClawProtocol
import SwiftUI

/// Presence and owner counts have a separate, small contract from the session roster.
/// This owner has no polling timer and never requests roster pages or conversation history.
@MainActor
@Observable
final class RootSidebarPeopleModel {
    let people = OpenClawChatSidebarPeople()
    private(set) var isLoading = false
    private(set) var isConnected = false
    @ObservationIgnored private var generation = 0
    @ObservationIgnored private var countsLoading = false
    @ObservationIgnored private let countsRefresh = OpenClawChatSessionRefreshCoordinator()

    isolated deinit { self.countsRefresh.cancel() }

    func observe(appModel: NodeAppModel) async {
        self.generation += 1
        let generation = self.generation
        self.countsRefresh.cancel()
        self.countsLoading = false
        self.people.beginConnection(
            defaultAgentID: appModel.gatewayDefaultAgentId ?? "main",
            mainSessionKey: appModel.mainSessionKey)
        self.isConnected = true
        // Register before the initial read: presence arriving while it loads must not be lost.
        let subscription = await appModel.operatorSession.makeServerEventSubscription { frame in
            ["presence", "sessions.changed", "seqGap"].contains(frame.event)
        }
        defer {
            subscription.cancel()
            if self.generation == generation {
                self.countsRefresh.cancel()
                self.people.disconnect()
                self.isConnected = false
                self.isLoading = false
            }
        }
        // Keep reading events during the snapshot RPC; the shared presence revision rejects stale reads.
        let initial = Task { @MainActor in await self.reloadPresence(appModel: appModel) }
        defer { initial.cancel() }
        for await event in subscription.events {
            guard !Task.isCancelled, self.generation == generation else { return }
            switch event.event {
            case "presence":
                guard let payload = event.payload else { continue }
                do {
                    let changed = try self.people.receivePresence(JSONEncoder().encode(payload))
                    if changed || self.people.counts == nil {
                        self.scheduleCounts(appModel: appModel)
                    }
                } catch {
                    await self.reloadPresence(appModel: appModel)
                }
            case "seqGap":
                self.countsRefresh.cancel()
                self.people.beginConnection(
                    defaultAgentID: appModel.gatewayDefaultAgentId ?? "main",
                    mainSessionKey: appModel.mainSessionKey)
                await self.reloadPresence(appModel: appModel)
            case "sessions.changed":
                self.scheduleCounts(appModel: appModel)
            default:
                break
            }
        }
    }

    func retry(appModel: NodeAppModel) async {
        guard self.isConnected else { return }
        if self.people.presenceFailed {
            await self.reloadPresence(appModel: appModel)
        } else {
            self.scheduleCounts(appModel: appModel)
        }
    }

    private func reloadPresence(appModel: NodeAppModel) async {
        guard let route = await appModel.operatorSession.currentRoute() else { return }
        self.isLoading = true
        let generation = self.generation
        await self.people.resynchronizePresence {
            try await appModel.operatorSession.request(
                method: "system-presence", paramsJSON: nil, timeoutSeconds: 12, ifCurrentRoute: route)
        }
        guard !Task.isCancelled, generation == self.generation else { return }
        self.isLoading = false
        self.scheduleCounts(appModel: appModel)
    }

    private func scheduleCounts(appModel: NodeAppModel) {
        guard self.isConnected else { return }
        let generation = self.generation
        self.countsRefresh.scheduleLoad(
            isLoading: self.countsLoading, coalescing: true, debounce: .milliseconds(
                400))
        { [weak self, weak appModel] in
            guard let self, let appModel, generation == self.generation, self.isConnected,
                  let route = await appModel.operatorSession.currentRoute() else { return }
            self.countsLoading = true
            defer {
                if generation == self.generation {
                    self.countsLoading = false
                    self.countsRefresh.finishLoad()
                }
            }
            await self.people.refreshCounts {
                let data = try await appModel.operatorSession.request(
                    OpenClawChatSidebarPeople.ownerCountsRequest, ifCurrentRoute: route)
                return try OpenClawChatGatewayPayloadCodec.decodeSessionsList(data, agentID: nil).ownerSessionCounts
            }
        }
    }
}

struct RootSidebarPeopleSection: View {
    @Environment(NodeAppModel.self) private var appModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var model = RootSidebarPeopleModel()
    @AppStorage("sidebar.people.collapsed") private var collapsed = false
    @State private var status: OpenClawChatSidebarPeople.StatusFilter = .all
    @State private var sort: OpenClawChatSidebarPeople.SortMode = .presence
    @State private var selectedPerson: OpenClawChatSidebarPeople.Person?

    let sessions: [OpenClawChatSessionEntry]
    let isActive: Bool
    let openSession: (OpenClawChatSessionEntry) -> Void
    let openActivity: (String, String) -> Void

    private var observing: Bool {
        self.isActive && self.scenePhase == .active && self.appModel.isOperatorGatewayConnected
    }

    var body: some View {
        let people = self.model.people
        VStack(alignment: .leading, spacing: 2) {
            if !people.people.isEmpty || people.presenceFailed || self.model.isLoading {
                self.header
                if !self.collapsed {
                    let visible = people.online(status: self.status, sort: self.sort)
                    ForEach(visible) { person in self.personRow(person) }
                    if visible.isEmpty {
                        Text(self.model.isLoading ? "Loading people…" :
                            (self.status == .running && people.counts == nil
                                ? "Session counts unavailable" : "No matching people"))
                            .font(OpenClawType.captionMedium)
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                            .padding(.horizontal, 10)
                            .frame(minHeight: 44)
                    }
                    if people.presenceFailed || people.countsFailed {
                        Button {
                            Task { await self.model.retry(appModel: self.appModel) }
                        } label: {
                            Text(people.presenceFailed
                                ? "Could not load online people. Retry" : "Counts may be out of date. Retry")
                                .font(OpenClawType.captionMedium)
                                .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
                                .contentShape(Rectangle())
                        }
                        .buttonStyle(.plain)
                        .foregroundStyle(OpenClawBrand.warn)
                        .padding(.horizontal, 10)
                    }
                }
            }
        }
        .task(id: "\(self.observing):\(self.appModel.connectedGatewayID ?? "")") {
            guard self.observing else { return }
            await self.model.observe(appModel: self.appModel)
        }
        .task(id: self.observing ? people.nextActivityDeadline(after: people.activityTime) : nil) {
            guard self.observing, let deadline = people.nextActivityDeadline(after: people.activityTime) else { return }
            do { try await Task.sleep(for: .seconds(max(0, deadline.timeIntervalSinceNow))) } catch { return }
            guard !Task.isCancelled else { return }
            people.refreshActivity()
        }
        .onChange(of: self.observing) { _, active in
            if !active { self.selectedPerson = nil }
        }
        .onChange(of: people.people.map(\.id)) { _, ids in
            if let selected = self.selectedPerson, !ids.contains(selected.id) { self.selectedPerson = nil }
        }
        .sheet(item: self.$selectedPerson) { person in
            RootSidebarPersonDetails(
                person: people.people.first(where: { $0.id == person.id }) ?? person,
                people: people,
                sessions: self.sessions,
                openSession: { session in self.selectedPerson = nil
                    self.openSession(session)
                },
                openActivity: { id, name in self.selectedPerson = nil
                    self.openActivity(id, name)
                })
        }
    }

    private var header: some View {
        Button { self.collapsed.toggle() } label: {
            HStack(spacing: 8) {
                Image(systemName: self.collapsed ? "chevron.right" : "chevron.down")
                Text("Online").textCase(.uppercase)
                Spacer(minLength: 0)
                if self.status != .all || self.sort != .presence {
                    Text(self.status == .running ? "Running" : self.sortLabel(self.sort))
                        .textCase(nil)
                }
                if self.collapsed {
                    HStack(spacing: -5) {
                        ForEach(self.model.people.online(expanded: false).prefix(2)) { person in
                            RootSidebarPersonAvatar(person: person, size: 22)
                        }
                    }
                    .accessibilityHidden(true)
                }
            }
            .font(OpenClawType.captionSemiBold)
            .foregroundStyle(OpenClawSidebarPalette.muted)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Menu {
                Picker(selection: self.$status) {
                    Text("All").font(OpenClawType.subhead).tag(OpenClawChatSidebarPeople.StatusFilter.all)
                    Text("Running").font(OpenClawType.subhead).tag(OpenClawChatSidebarPeople.StatusFilter.running)
                } label: { Text("Status").font(OpenClawType.subhead) }
                    .pickerStyle(.inline)
            } label: { Text("Status").font(OpenClawType.subhead) }
            Menu {
                Picker(selection: self.$sort) {
                    ForEach(OpenClawChatSidebarPeople.SortMode.allCases, id: \.self) { mode in
                        Text(self.sortLabel(mode)).font(OpenClawType.subhead).tag(mode)
                    }
                } label: { Text("Sort By").font(OpenClawType.subhead) }
                    .pickerStyle(.inline)
            } label: { Text("Sort By").font(OpenClawType.subhead) }
            if self.status != .all || self.sort != .presence {
                Button {
                    self.status = .all
                    self.sort = .presence
                } label: { Label("Reset View", systemImage: "arrow.counterclockwise").font(OpenClawType.subhead) }
            }
        }
        .accessibilityIdentifier("RootTabs.Sidebar.People")
        .accessibilityValue(self.collapsed ? "Collapsed" : "Expanded")
        .accessibilityHint("Touch and hold to filter or sort people")
    }

    private func sortLabel(_ mode: OpenClawChatSidebarPeople.SortMode) -> String {
        switch mode {
        case .presence: String(localized: "Presence")
        case .running: String(localized: "Running sessions")
        case .open: String(localized: "Total sessions")
        case .name: String(localized: "Name")
        }
    }

    private func personRow(_ person: OpenClawChatSidebarPeople.Person) -> some View {
        let workload = self.model.people.workload(for: person)
        return Button {
            if let id = person.profileID {
                self.openActivity(id, person.label)
            } else {
                self.selectedPerson = person
            }
        } label: {
            HStack(spacing: 9) {
                RootSidebarPersonAvatar(person: person, size: 28)
                Text(verbatim: person.label)
                    .font(OpenClawType.subheadSemiBold)
                    .foregroundStyle(OpenClawSidebarPalette.textStrong)
                    .lineLimit(1)
                Spacer(minLength: 4)
                if let workload {
                    if workload.running > 0 {
                        Label(workload.running.formatted(), systemImage: "arrow.trianglehead.2.clockwise.rotate.90")
                            .foregroundStyle(OpenClawSidebarPalette.accent)
                    }
                    if workload._open > 0 {
                        Label(workload._open.formatted(), systemImage: "bubble.left")
                            .foregroundStyle(OpenClawSidebarPalette.muted)
                    }
                }
            }
            .font(OpenClawType.captionMedium)
            .frame(maxWidth: .infinity, minHeight: 44, alignment: .leading)
            .padding(.horizontal, 10)
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .contextMenu {
            Button("Details", systemImage: "person.crop.circle") { self.selectedPerson = person }
            if let id = person.profileID {
                Button("View Activity", systemImage: "clock.arrow.circlepath") {
                    self.openActivity(id, person.label)
                }
            }
            let links = self.model.people.cardSessions(for: person, sessions: self.sessions)
            if !links.viewing.isEmpty {
                Section("Viewing now") {
                    ForEach(links.viewing, id: \.key) { session in
                        Button(ChatSessionSidebarModel.displayName(for: session), systemImage: "bubble.left") {
                            self.openSession(session)
                        }
                    }
                }
            }
            if !links.recent.isEmpty {
                Section("Recent sessions") {
                    ForEach(links.recent, id: \.key) { session in
                        Button(ChatSessionSidebarModel.displayName(for: session), systemImage: "bubble.left") {
                            self.openSession(session)
                        }
                    }
                }
            }
        }
        .accessibilityIdentifier("RootTabs.Sidebar.Person.\(person.id)")
        .accessibilityLabel(person.label)
        .accessibilityValue(person.activity(at: self.model.people.activityTime).label + " · " + (workload.map {
            String(format: String(localized: "%lld open sessions, %lld running"), $0._open, $0.running)
        } ?? String(localized: "Session counts unavailable")))
        .accessibilityHint("Touch and hold for details and session links")
    }
}

private struct RootSidebarPersonAvatar: View {
    let person: OpenClawChatSidebarPeople.Person
    let size: CGFloat

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Text(verbatim: AgentIdentityPresentation.badge(avatarText: nil, displayName: self.person.label))
                .font(OpenClawType.caption2Bold)
                .foregroundStyle(OpenClawSidebarPalette.textStrong)
                .frame(width: self.size, height: self.size)
                .background(OpenClawSidebarPalette.elevated, in: Circle())
                .overlay(Circle().strokeBorder(OpenClawSidebarPalette.hairline, lineWidth: 1))
            Circle().fill(OpenClawBrand.ok)
                .frame(width: 7, height: 7)
                .overlay(Circle().strokeBorder(OpenClawSidebarPalette.background, lineWidth: 1))
        }
        .accessibilityHidden(true)
    }
}

private struct RootSidebarPersonDetails: View {
    @Environment(\.dismiss) private var dismiss
    @State private var recentKeys: [String]?
    let person: OpenClawChatSidebarPeople.Person
    let people: OpenClawChatSidebarPeople
    let sessions: [OpenClawChatSessionEntry]
    let openSession: (OpenClawChatSessionEntry) -> Void
    let openActivity: (String, String) -> Void

    var body: some View {
        let links = self.people.cardSessions(for: self.person, sessions: self.sessions, recentKeys: self.recentKeys)
        NavigationStack {
            List {
                Section {
                    HStack(spacing: 12) {
                        RootSidebarPersonAvatar(person: self.person, size: 40)
                        VStack(alignment: .leading, spacing: 3) {
                            Text(verbatim: self.person.label).font(OpenClawType.headline)
                            Text(self.person.activity(at: self.people.activityTime).label)
                                .font(OpenClawType.captionMedium)
                                .foregroundStyle(.secondary)
                        }
                    }
                    if self.person.user.id == "gateway-owner" {
                        Text("Connected with the Gateway token or over a tunnel, not a personal sign-in.")
                    }
                    if let since = self.person.onlineSince {
                        LabeledContent("Online since") {
                            Text(Date(timeIntervalSince1970: Double(since) / 1000), style: .relative)
                        }
                    }
                    LabeledContent("Last interaction") {
                        if let activity = self.person.lastActivity {
                            Text(Date(timeIntervalSince1970: Double(activity) / 1000), style: .relative)
                        } else {
                            Text("Activity unavailable")
                        }
                    }
                    if let counts = self.people.workload(for: self.person) {
                        LabeledContent("Open sessions", value: counts._open.formatted())
                        LabeledContent("Running sessions", value: counts.running.formatted())
                    } else {
                        Text("Session counts unavailable").foregroundStyle(.secondary)
                    }
                }
                if !self.person.connections.isEmpty || !self.person.reportedTimeZones.isEmpty {
                    Section("Where") {
                        ForEach(self.person.connections, id: \.self) { Text(verbatim: $0) }
                        ForEach(self.person.reportedTimeZones, id: \.self) { zone in
                            Text(String(format: String(localized: "Reported time zone: %@"), zone))
                        }
                    }
                }
                if !links.viewing.isEmpty { self.sessionLinks(links.viewing, title: "Viewing now") }
                self.sessionLinks(links.recent, title: "Recent sessions")
                if let id = self.person.profileID {
                    Section {
                        Button("View Activity", systemImage: "clock.arrow.circlepath") {
                            self.dismiss()
                            self.openActivity(id, self.person.label)
                        }
                    }
                }
            }
            .font(OpenClawType.subhead)
            .navigationTitle("Person details")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { self.dismiss() }
                }
            }
        }
        .presentationDetents([.medium, .large])
        .onChange(of: links.recentKeys, initial: true) { _, keys in
            if !self.sessions.isEmpty { self.recentKeys = keys }
        }
    }

    private func sessionLinks(_ sessions: [OpenClawChatSessionEntry], title: LocalizedStringKey) -> some View {
        Section(title) {
            if sessions.isEmpty { Text("No recent visible sessions.").foregroundStyle(.secondary) }
            ForEach(sessions, id: \.key) { session in
                Button {
                    self.dismiss()
                    self.openSession(session)
                } label: {
                    Label(ChatSessionSidebarModel.displayName(for: session), systemImage: "bubble.left")
                }
            }
        }
    }
}
