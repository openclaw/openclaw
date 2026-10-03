#if os(macOS)
import SwiftUI

struct ChatSidebarOnlineSection: View {
    @Environment(\.openClawSidebarPeople) private var people
    @Environment(\.openClawSidebarPeopleActions) private var actions
    @AppStorage("openclaw.chat.sidebar.onlineCollapsed") private var collapsed = false
    @State private var selectedPersonID: String?
    @State private var explicitPersonID: String?
    @State private var lastOpenedAt = Date.distantPast
    let viewModel: OpenClawChatViewModel

    var body: some View {
        Group {
            if let people, !people.people.isEmpty || people.presenceFailed {
                Section {
                    if !self.collapsed {
                        ForEach(people.online(expanded: true)) { person in
                            ChatSidebarPersonRow(
                                person: person,
                                people: people,
                                viewModel: self.viewModel,
                                selectedPersonID: self.$selectedPersonID,
                                explicitPersonID: self.$explicitPersonID,
                                lastOpenedAt: self.$lastOpenedAt)
                                .selectionDisabled()
                        }
                        if people.presenceFailed {
                            Button("Could not load online people. Retry") { self.actions?.retry() }
                                .selectionDisabled()
                        } else if people.countsFailed {
                            Button("Counts may be out of date. Retry") { self.actions?.retry() }
                                .selectionDisabled()
                        }
                    }
                } header: {
                    Button {
                        self.selectedPersonID = nil
                        self.collapsed.toggle()
                    } label: {
                        HStack(spacing: 6) {
                            Image(systemName: self.collapsed ? "chevron.right" : "chevron.down")
                            Text("Online")
                            if self.collapsed {
                                ChatSidebarPeopleFacepile(people: people.online(expanded: false), maximum: 2)
                            }
                        }
                        .font(OpenClawChatTypography.caption)
                    }
                    .buttonStyle(.plain)
                    .accessibilityValue(self.collapsed ? String(localized: "Collapsed") : String(localized: "Expanded"))
                    .accessibilityIdentifier("chat-sidebar-online-toggle")
                }
            }
        }
        .onChange(of: self.people.map(ObjectIdentifier.init)) { self.selectedPersonID = nil }
    }
}

struct ChatSidebarSessionViewers: View {
    @Environment(\.openClawSidebarPeople) private var people
    let sessionKey: String
    var excludingProfileIDs: Set<String> = []

    var body: some View {
        if let people {
            // ui/src/components/app-sidebar-session-row-render.ts:280 excludes only identities already rendered by the row.
            ChatSidebarPeopleFacepile(
                people: people.viewers(for: self.sessionKey, excludingProfileIDs: self.excludingProfileIDs), maximum: 3)
        }
    }
}

private struct ChatSidebarPeopleFacepile: View {
    let people: [OpenClawChatSidebarPeople.Person]
    let maximum: Int

    var body: some View {
        HStack(spacing: -4) {
            ForEach(self.people.prefix(self.maximum)) { person in
                ChatSidebarPersonAvatar(person: person, size: 18).help(person.label)
            }
            if self.people.count > self.maximum {
                Text(verbatim: "+\(self.people.count - self.maximum)")
                    .font(OpenClawChatTypography.caption)
                    .padding(.leading, 6)
                    .help(self.people.dropFirst(self.maximum).map(\.label).joined(separator: "\n"))
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Text(verbatim: self.people.map(\.label).joined(separator: ", ")))
    }
}

struct ChatSidebarPersonAvatar: View {
    @Environment(\.openClawSidebarPeopleActions) private var actions
    @State private var image: NSImage?
    let person: OpenClawChatSidebarPeople.Person
    let size: CGFloat

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                ChatAgentAvatar(text: self.initials, name: self.person.label, tint: nil, size: self.size)
            }
        }
        .frame(width: self.size, height: self.size)
        .clipShape(Circle())
        .accessibilityHidden(true)
        .task(id: [self.person.id, self.person.user.avatarUrl ?? ""]) {
            self.image = nil
            guard let profileID = self.person.profileID,
                  let data = await self.actions?.avatar(profileID, self.person.user.avatarUrl),
                  !Task.isCancelled else { return }
            self.image = NSImage(data: data)
        }
    }

    private var initials: String {
        (self.person.user.name ?? self.person.user.email ?? self.person.user.id)
            .split(whereSeparator: \.isWhitespace).prefix(2).compactMap(\.first).map(String.init).joined().uppercased()
    }
}

private struct ChatSidebarPersonRow: View {
    @Environment(\.openClawSidebarPeopleActions) private var actions
    @State private var hovered = false
    @State private var cardHovered = false
    @State private var cardFocused = false
    @State private var suppressFocusOpen = false
    @State private var cardIdentity = UUID()
    @State private var closeDelay: Duration = .milliseconds(220)
    @FocusState private var focused: Bool
    let person: OpenClawChatSidebarPeople.Person
    let people: OpenClawChatSidebarPeople
    let viewModel: OpenClawChatViewModel
    @Binding var selectedPersonID: String?
    @Binding var explicitPersonID: String?
    @Binding var lastOpenedAt: Date

    private var explicitHold: Bool {
        self.explicitPersonID == self.person.id
    }

    private var isPresented: Binding<Bool> {
        Binding(get: { self.selectedPersonID == self.person.id }, set: { if !$0 { self.dismiss() } })
    }

    var body: some View {
        let workload = self.people.workload(for: self.person)
        let activity = self.person.activity(at: self.people.activityTime)
        Button {
            if let id = self.person.profileID {
                self.dismiss()
                self.actions?.activity(id, self.person.label)
            } else {
                if self.explicitHold {
                    self.dismiss()
                } else {
                    self.explicitPersonID = self.person.id
                    self.present()
                }
            }
        } label: {
            HStack(spacing: 8) {
                ChatSidebarPersonAvatar(person: self.person, size: 24)
                    .overlay(alignment: .bottomTrailing) {
                        // ui/src/styles/layout.css:2594: unknown is a ring, not an idle indication.
                        Circle()
                            .fill(activity == .unknown ? Color(nsColor: .windowBackgroundColor) :
                                activity == .active ? OpenClawChatTheme.success : OpenClawChatTheme.warning)
                            .overlay(Circle().strokeBorder(
                                OpenClawChatTheme.success,
                                lineWidth: activity == .unknown ? 1 : 0))
                            .frame(width: 6, height: 6)
                    }
                Text(verbatim: self.person.label).lineLimit(1)
                Spacer(minLength: 0)
                if let workload {
                    if workload.running > 0 {
                        HStack(spacing: 3) {
                            ProgressView().controlSize(.mini)
                            Text(workload.running.formatted())
                        }
                        .help(String(format: String(localized: "%lld running"), workload.running))
                    }
                    if workload._open > 0 {
                        Label(workload._open.formatted(), systemImage: "bubble.left")
                            .help(String(format: String(localized: "%lld open"), workload._open))
                    }
                }
            }
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .focused(self.$focused)
        .onHover { self.hovered = $0
            if $0 { self.suppressFocusOpen = false }
            self.closeDelay = .milliseconds(220)
        }
        .onChange(of: self.focused) { _, focused in
            if !focused { self.suppressFocusOpen = false }
        }
        .accessibilityLabel(self.person.profileID == nil
            ? String(format: String(localized: "Details for %@"), self.person.label)
            : String(format: String(localized: "Activity for %@"), self.person.label))
        .accessibilityValue(activity.label + " · " + (workload.map {
            String(format: String(localized: "%lld open sessions, %lld running"), $0._open, $0.running)
        } ?? String(localized: "Session counts unavailable")))
        .help(workload == nil ? String(localized: "Session counts unavailable") : self.person.label)
        .popover(isPresented: self.isPresented, arrowEdge: .trailing) {
            ChatSidebarPersonCard(
                person: self.person,
                people: self.people,
                viewModel: self.viewModel,
                focused: self.$cardFocused,
                dismiss: self.dismiss)
                .id(self.cardIdentity)
                .onHover { self.cardHovered = $0
                    self.closeDelay = .milliseconds(100)
                }
        }
        .task(id: [
            self.hovered,
            self.focused && !self.suppressFocusOpen,
            self.cardHovered,
            self.cardFocused,
            self.explicitHold,
            self.explicitPersonID == nil,
        ]) {
            await self.updatePresentation()
        }
        .onChange(of: self.selectedPersonID) { previous, current in
            if previous == self.person.id, current != self.person.id {
                self.lastOpenedAt = .now
                self.dismiss()
            }
        }
        .onChange(of: self.viewModel.currentSessionTarget) { self.dismiss() }
        .onDisappear { self.dismiss() }
        .onExitCommand { self.dismiss() }
    }

    private func updatePresentation() async {
        guard !Task.isCancelled else { return }
        let held = self.hovered || (self.focused && !self.suppressFocusOpen) ||
            self.cardHovered || self.cardFocused || self.explicitHold
        // sidebar-people.runtime.ts:94 and portaled-hovercard.ts:132: bridge the pointer gap without sticky cards.
        if held {
            guard self.explicitPersonID == nil || self.explicitHold || self.focused else { return }
            guard self.selectedPersonID != self.person.id else { return }
            if !self.focused, !self.explicitHold {
                let warm = self.selectedPersonID != nil || Date.now.timeIntervalSince(self.lastOpenedAt) < 0.3
                do { try await Task.sleep(for: .milliseconds(warm ? 80 : 450)) } catch { return }
            }
            self.present()
        } else if self.selectedPersonID == self.person.id {
            do { try await Task.sleep(for: self.closeDelay) } catch { return }
            if self.selectedPersonID == self.person.id { self.selectedPersonID = nil }
        }
    }

    private func dismiss() {
        if self.selectedPersonID == self.person.id { self.selectedPersonID = nil }
        self.hovered = false
        self.cardHovered = false
        self.cardFocused = false
        // Native popovers restore keyboard focus to their trigger; do not immediately reopen on that focus.
        self.suppressFocusOpen = true
        if self.explicitHold { self.explicitPersonID = nil }
    }

    private func present() {
        self.cardIdentity = UUID()
        self.selectedPersonID = self.person.id
        self.lastOpenedAt = .now
    }
}

struct ChatSidebarPersonCard: View {
    @Environment(\.openClawSidebarPeopleActions) private var actions
    @State private var recentKeys: [String]?
    @FocusState private var focusedControl: String?
    let person: OpenClawChatSidebarPeople.Person
    let people: OpenClawChatSidebarPeople
    let viewModel: OpenClawChatViewModel
    @Binding var focused: Bool
    let dismiss: () -> Void

    var sessionRows: [OpenClawChatSessionEntry] {
        // ui/src/components/person-activity-card.ts:46 reads loaded roster pages, not the conversation's first page.
        if let owner = self.viewModel.sidebarData, let state = owner.queryState, state.page != nil {
            return owner.project(state.pageIDs)
        }
        return self.viewModel.sessions
    }

    var body: some View {
        let sessions = self.people.cardSessions(
            for: self.person, sessions: self.sessionRows, recentKeys: self.recentKeys)
        let canCapture = self.viewModel.hasAppliedLiveSessions || !self.sessionRows.isEmpty
        TimelineView(.periodic(from: .now, by: 1)) { context in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    HStack {
                        ChatSidebarPersonAvatar(person: self.person, size: 32)
                        VStack(alignment: .leading) {
                            Text(verbatim: self.person.label).font(OpenClawChatTypography.body)
                            Text(self.person.activity(at: context.date).label).foregroundStyle(.secondary)
                        }
                    }
                    if self.person.user.id == "gateway-owner" {
                        Text("Connected with the Gateway token or over a tunnel, not a personal sign-in.")
                    }
                    if let since = self.person.onlineSince {
                        LabeledContent("Online for") {
                            self.elapsed(Double(since), now: context.date, minimumMinute: true)
                        }
                    }
                    if !self.person.connections.isEmpty || !self.person.reportedTimeZones.isEmpty {
                        LabeledContent("Where") {
                            VStack(alignment: .trailing) {
                                ForEach(self.person.connections, id: \.self) { Text(verbatim: $0) }
                                ForEach(self.person.reportedTimeZones, id: \.self) { zone in
                                    Text(String(format: String(localized: "Reported time zone: %@"), zone))
                                        .foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                    LabeledContent("Last interaction") {
                        if let activity = self.person.lastActivity {
                            HStack(spacing: 3) {
                                self.elapsed(Double(activity), now: context.date)
                                Text("ago")
                            }
                        } else {
                            Text("Activity unavailable")
                        }
                    }
                    if !sessions.viewing.isEmpty {
                        self.sessionLinks(
                            sessions.viewing, keys: sessions.viewingKeys, title: "Viewing now", now: context.date)
                    }
                    self.sessionLinks(
                        sessions.recent,
                        keys: sessions.recentKeys,
                        title: "Recent sessions",
                        now: context.date)
                    if let id = self.person.profileID {
                        Button("View Activity") {
                            self.dismiss()
                            self.actions?.activity(id, self.person.label)
                        }
                        .focused(self.$focusedControl, equals: "activity")
                    }
                }
                .padding(16)
            }
            .frame(width: 320)
            .frame(maxHeight: 480)
        }
        .font(OpenClawChatTypography.caption)
        .onChange(of: canCapture ? sessions.recentKeys : nil, initial: true) { _, keys in self.recentKeys = keys }
        .onChange(of: self.focusedControl) { _, control in self.focused = control != nil }
        .onExitCommand(perform: self.dismiss)
    }

    private func elapsed(
        _ timestamp: Double, now: Date, minimumMinute: Bool = false, singleUnit: Bool = false) -> some View
    {
        Text(verbatim: ChatSidebarPersonPresentation.elapsed(
            milliseconds: now.timeIntervalSince1970 * 1000 - timestamp,
            minimumMinute: minimumMinute,
            singleUnit: singleUnit))
            .help(Date(timeIntervalSince1970: timestamp / 1000).formatted())
            .accessibilityLabel(Date(timeIntervalSince1970: timestamp / 1000).formatted())
    }

    private func sessionLinks(
        _ sessions: [OpenClawChatSessionEntry], keys: [String], title: LocalizedStringKey, now: Date) -> some View
    {
        VStack(alignment: .leading, spacing: 6) {
            Text(title).fontWeight(.semibold)
            if sessions.isEmpty { Text("No recent visible sessions.").foregroundStyle(.secondary) }
            ForEach(Array(zip(keys, sessions)), id: \.0) { identity, session in
                Button {
                    self.dismiss()
                    self.viewModel.switchSession(to: session.key, agentID: session.agentId)
                } label: {
                    HStack(alignment: .top) {
                        Label(ChatSessionSidebarModel.displayName(for: session), systemImage: "bubble.left")
                            .multilineTextAlignment(.leading)
                        Spacer(minLength: 4)
                        if let updated = session.updatedAt {
                            self.elapsed(updated, now: now, singleUnit: true).foregroundStyle(.secondary)
                        }
                    }
                }
                .buttonStyle(.plain)
                .focused(self.$focusedControl, equals: identity)
            }
        }
    }
}

enum ChatSidebarPersonPresentation {
    static func elapsed(milliseconds: Double, minimumMinute: Bool = false, singleUnit: Bool = false) -> String {
        // ui/src/components/elapsed-time.ts:55: online duration has a one-minute floor; session ages round to one unit.
        var elapsed = max(minimumMinute ? 60000 : 1000, milliseconds)
        if minimumMinute { elapsed = floor(elapsed / 60000) * 60000 }
        if singleUnit {
            var scale = 1000.0
            for next in [60000.0, 3_600_000, 86_400_000] {
                if (elapsed / scale).rounded() * scale < next { break }
                scale = next
            }
            elapsed = (elapsed / scale).rounded() * scale
        }
        return ChatWorkingDurationFormatter.compact(milliseconds: elapsed)
    }
}

extension OpenClawChatSidebarPeople.Person {
    var reportedTimeZones: [String] {
        Set(self.entries.compactMap { $0.timezone?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }).sorted()
    }

    var connections: [String] {
        // ui/src/components/person-activity-card.ts:116: duplicate tabs describe one reported environment.
        Set(self.entries.map { entry in
            let family = entry.devicefamily?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            var parts = (entry.platform ?? "").split(whereSeparator: \.isWhitespace).map(String.init)
            let name = parts.isEmpty ? "" : parts.removeFirst()
            let architectures = [
                "arm": "ARM",
                "arm64": "ARM",
                "aarch64": "ARM",
                "armv7l": "ARM",
                "armv8l": "ARM",
                "x64": "x64",
                "x86_64": "x64",
                "amd64": "x64",
                "x86": "x86",
                "i386": "x86",
                "i686": "x86",
            ]
            let suffix = parts.last.flatMap { architectures[$0.lowercased()] }
            if suffix != nil { parts.removeLast() }
            let mac = [
                "macarm": "ARM",
                "macarm64": "ARM",
                "arm64-apple-darwin": "ARM",
                "aarch64-apple-darwin": "ARM",
                "x86_64-apple-darwin": "Intel",
            ][name.lowercased()]
            let names = [
                "macos": "macOS",
                "darwin": "macOS",
                "win32": "Windows",
                "win64": "Windows",
                "windows": "Windows",
                "linux": "Linux",
                "freebsd": "FreeBSD",
                "openbsd": "OpenBSD",
                "netbsd": "NetBSD",
                "ios": "iOS",
                "ipados": "iPadOS",
                "watchos": "watchOS",
                "android": "Android",
                "web": "Web",
            ]
            let familyPlatform = family == "Mac" ? "macOS" : family == "iPad" ? "iPadOS" : family
            let label = name.lowercased() == "macintel" && ["Mac", "iPad"].contains(family)
                ? familyPlatform : mac != nil ? "macOS" : names[name.lowercased()] ??
                (name == name.lowercased() ? name.prefix(1).uppercased() + name.dropFirst() : name)
            let platform = ([label] + parts).joined(separator: " ")
            let client: String? = if entry.clientid == "openclaw-tui" {
                String(localized: "Terminal")
            } else if entry.mode == "webchat" ||
                ["openclaw-control-ui", "openclaw-browser-copilot", "webchat-ui", "webchat"]
                .contains(entry.clientid ?? "")
            {
                String(localized: "Web")
            } else if entry.mode == "cli" || entry.clientid == "cli" {
                String(localized: "Command line")
            } else if entry.mode == "ui" ||
                ["openclaw-macos", "openclaw-linux", "openclaw-ios", "openclaw-watchos", "openclaw-android"]
                .contains(entry.clientid ?? "")
            {
                String(localized: "App")
            } else {
                nil
            }
            var seen = Set<String>()
            return [family, platform == familyPlatform ? nil : platform, mac ?? suffix, client]
                .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
                .filter { !$0.isEmpty && seen.insert($0).inserted }.joined(separator: " · ")
        }.filter { !$0.isEmpty }).sorted()
    }
}
#endif
