#if os(macOS)
import AppKit
import Observation
import OpenClawProtocol
import SwiftUI

/// Per-window interaction owner; transport subscriptions remain connection-wide.
@MainActor @Observable
final class ChatHoverPresentation {
    struct OpenRequest: Equatable {
        let token = UUID()
        let row: UUID
        let keyboard: Bool
        let delay: Int
    }

    static let windows = NSMapTable<AnyObject, ChatHoverPresentation>.weakToStrongObjects()
    private(set) var selected: UUID?
    private(set) var pending: OpenRequest?
    private(set) var keyboardOpened = false
    private var lastOpened = Date.distantPast
    private var menus = Set<UUID>()
    private var suppressedFocus: (row: UUID, awaitingRestore: Bool)?
    var menuOpen: Bool {
        !self.menus.isEmpty
    }

    static func agentID(for session: OpenClawChatSessionEntry, selected: String?) -> String? {
        // session-progress-hovercard.runtime.ts:277 takes the key's owner before the sidebar's selected scope.
        OpenClawChatSessionKey.agentID(from: session.key) ?? session.agentId ?? selected
    }

    static func window(_ viewModel: OpenClawChatViewModel) -> ChatHoverPresentation {
        if let value = self.windows.object(forKey: viewModel) { return value }
        let value = ChatHoverPresentation()
        self.windows.setObject(value, forKey: viewModel)
        return value
    }

    func request(_ row: UUID, keyboard: Bool, now: Date = .now) {
        guard !self.menuOpen else { return }
        if keyboard, self.suppressedFocus?.row == row {
            self.suppressedFocus?.awaitingRestore = false
            return
        }
        self.pending = nil
        if self.selected == row {
            self.keyboardOpened = self.keyboardOpened || keyboard
            return
        }
        // session-progress-hovercard.runtime.ts:29,219: only real entry events mint an opening request.
        let warm = self.selected != nil || now.timeIntervalSince(self.lastOpened) < 0.3
        self.pending = OpenRequest(row: row, keyboard: keyboard, delay: keyboard ? 0 : warm ? 80 : 450)
    }

    func complete(_ request: OpenRequest, now: Date = .now) {
        guard self.pending == request, !self.menuOpen else { return }
        self.pending = nil
        self.selected = request.row
        self.keyboardOpened = request.keyboard
        self.lastOpened = now
    }

    func leaveFocus(_ row: UUID) {
        if self.suppressedFocus?.row == row, self.suppressedFocus?.awaitingRestore == false {
            self.suppressedFocus = nil
        }
    }

    func dismiss(
        _ row: UUID, explicit: Bool = false, restoreFocus: Bool = false, focused: Bool = false, now: Date = .now)
    {
        // Explicit exits retire the window's intent; stale row cleanup must leave newer rows alone.
        if explicit || restoreFocus || self.pending?.row == row { self.pending = nil }
        guard explicit || restoreFocus || self.selected == row else { return }
        if self.selected != nil { self.lastOpened = now }
        self.selected = nil
        if restoreFocus { self.suppressedFocus = (row, !focused) }
    }

    func setMenu(_ id: UUID, open: Bool, now: Date = .now) {
        if open {
            self.menus.insert(id)
            self.pending = nil
            if self.selected != nil { self.lastOpened = now }
            self.selected = nil
        } else { self.menus.remove(id) }
    }
}

struct ChatSessionSidebarHoverCard: ViewModifier {
    let session: OpenClawChatSessionEntry
    let error: String?
    let hovered: Bool
    let focused: Bool
    let rowHasFocus: Bool
    let viewModel: OpenClawChatViewModel
    let restoreFocus: () -> Void
    @State private var id = UUID()
    @State private var cardHovered = false
    @State private var cardFocused = false
    @State private var closeDelay = 100
    @State private var watch: (OpenClawChatSidebarHoverFacts, UUID)?

    private var presentation: ChatHoverPresentation {
        ChatHoverPresentation.window(self.viewModel)
    }

    private var source: OpenClawChatSidebarHoverFacts? {
        (self.viewModel.transport as? any OpenClawChatSidebarHoverTransport)?.sidebarHoverFacts
    }

    private var agentID: String? {
        ChatHoverPresentation.agentID(for: self.session, selected: self.viewModel.selectedAgentID)
    }

    private var open: Bool {
        self.presentation.selected == self.id
    }

    func body(content: Content) -> some View {
        content
            .popover(
                isPresented: Binding(get: { self.open }, set: { if !$0 { self.dismiss() } }),
                arrowEdge: .trailing)
            {
                ChatSessionHoverCard(
                    session: self.session,
                    error: self.error,
                    agentID: self.agentID,
                    source: self.source,
                    channelAvatar: {
                        await (self.viewModel.transport as? any OpenClawChatSidebarHoverTransport)?
                            .sidebarHoverChannelAvatar(session: self.session, sessionAgentID: self.agentID)
                    },
                    agentAvatar: { id, url in
                        await (self.viewModel.transport as? any OpenClawChatSidebarHoverTransport)?
                            .sidebarHoverAgentAvatar(
                                session: self.session, sessionAgentID: self.agentID, agentID: id, advertised: url)
                    },
                    keyboardOpened: self.presentation.keyboardOpened,
                    dismiss: { self.dismiss(explicit: true) },
                    exit: { self.dismiss(returnFocus: true) },
                    focused: self.$cardFocused)
                    .onHover { self.cardHovered = $0 }
                    .onExitCommand { self.dismiss(returnFocus: true) }
            }
            .onChange(of: self.hovered) { _, value in
                    self.closeDelay = 220
                    if value {
                        self.presentation.request(self.id, keyboard: false)
                    } else if !self.open, !self.focused { self.presentation.dismiss(self.id) }
                }
                .onChange(of: self.focused) { _, value in
                    self.closeDelay = 100
                    if value {
                        self.presentation.request(self.id, keyboard: true)
                    } else {
                        self.presentation.leaveFocus(self.id)
                        if !self.open, !self.hovered { self.presentation.dismiss(self.id) }
                    }
                }
                .onChange(of: self.rowHasFocus) { self.closeDelay = 100 }
                .onChange(of: self.cardHovered) { self.closeDelay = 100 }
                .onChange(of: self.cardFocused) { self.closeDelay = 100 }
                .task(id: self.presentation.pending) {
                    guard let request = self.presentation.pending, request.row == self.id else { return }
                    do { try await Task.sleep(for: .milliseconds(request.delay)) } catch { return }
                    guard !Task.isCancelled, self.hovered || self.focused else { return }
                    self.presentation.complete(request)
                }
                .task(id: [
                    self.hovered,
                    self.focused,
                    self.rowHasFocus,
                    self.cardHovered,
                    self.cardFocused,
                    self.open,
                    self.presentation.menuOpen,
                ]) {
                    let held = self.hovered || self.focused || (self.open && self.rowHasFocus) ||
                        self.cardHovered || self.cardFocused
                    if self.presentation.menuOpen {
                        self.dismiss()
                    } else if !held {
                        // portaled-hovercard.ts:132: bridge the pointer gap only after a card has opened.
                        if self.open {
                            do { try await Task.sleep(for: .milliseconds(self.closeDelay)) } catch { return }
                        }
                        self.dismiss()
                    }
                }
                .onChange(of: self.open) { _, value in
                    self.releaseWatch()
                    if value, let source {
                        self.watch = (source, source.watch(sessionKey: self.session.key, agentID: self.agentID))
                    }
                }
                .onChange(of: self.viewModel.currentSessionTarget) { self.dismiss() }
                .onChange(of: self.session.sessionId) { self.dismiss() }
                .simultaneousGesture(TapGesture().onEnded { self.dismiss() })
                .onExitCommand { self.dismiss(returnFocus: true) }
                .onDisappear { self.dismiss() }
    }

    private func releaseWatch() {
        if let (source, owner) = self.watch { source.unwatch(owner) }
        self.watch = nil
    }

    private func dismiss(returnFocus: Bool = false, explicit: Bool = false) {
        self.presentation.dismiss(self.id, explicit: explicit, restoreFocus: returnFocus, focused: self.focused)
        self.cardHovered = false
        self.cardFocused = false
        self.releaseWatch()
        if returnFocus { self.restoreFocus() }
    }
}

struct ChatSidebarPullRequestMenu<Content: View>: View {
    let session: OpenClawChatSessionEntry
    let viewModel: OpenClawChatViewModel
    @State private var menuID = UUID()
    @State private var appearances = 0
    @ViewBuilder let content: () -> Content
    @State private var watch: (OpenClawChatSidebarHoverFacts, UUID)?
    private var source: OpenClawChatSidebarHoverFacts? {
        (self.viewModel.transport as? any OpenClawChatSidebarHoverTransport)?.sidebarHoverFacts
    }

    private var agentID: String? {
        ChatHoverPresentation.agentID(for: self.session, selected: self.viewModel.selectedAgentID)
    }

    var body: some View {
        self.content()
            .onAppear {
                self.appearances += 1
                guard self.appearances == 1 else { return }
                ChatHoverPresentation.window(self.viewModel).setMenu(self.menuID, open: true)
                guard self.watch == nil, let source else { return }
                self.watch = (source, source.watch(sessionKey: self.session.key, agentID: self.agentID))
            }
            .onDisappear {
                self.appearances -= 1
                guard self.appearances == 0 else { return }
                ChatHoverPresentation.window(self.viewModel).setMenu(self.menuID, open: false)
                if let (source, owner) = self.watch { source.unwatch(owner) }
                self.watch = nil
            }
        if let pr = self.source?.pullRequests(sessionKey: self.session.key, agentID: self.agentID)?
            .menuPullRequest,
            let url = URL(string: pr.url)
        {
            Link(destination: url) { Label("Open pull request", systemImage: "arrow.up.right") }
                .keyboardShortcut("g", modifiers: [])
        }
    }
}

private struct ChatSessionHoverCard: View {
    let session: OpenClawChatSessionEntry
    let error: String?
    let agentID: String?
    let source: OpenClawChatSidebarHoverFacts?
    let channelAvatar: () async -> Data?
    let agentAvatar: (String, String) async -> Data?
    let keyboardOpened: Bool
    let dismiss: () -> Void
    let exit: () -> Void
    @Binding var focused: Bool
    @State private var keyboardEngaged = false
    @Environment(\.openClawSidebarPeople) private var people
    @Environment(\.openClawSidebarPeopleActions) private var actions
    @FocusState private var focus: String?

    var body: some View {
        let card = self.source?.progress(sessionKey: self.session.key, agentID: self.agentID)
        let copy = ChatSessionHoverCardProjection.copy(self.session, card: card, error: self.error)
        let prs = self.source?.pullRequests(sessionKey: self.session.key, agentID: self.agentID)
        let channel = ChatSessionHoverCardProjection.channel(self.session)
        let attribution = ChatSessionHoverCardProjection.attribution(
            self.session,
            selfID: self.people?.people.first { $0.id == self.people?.selfKey }?.profileID)
        ScrollView {
            VStack(alignment: .leading, spacing: 10) {
                HStack(alignment: .top) {
                    VStack(alignment: .leading, spacing: 5) {
                        if let channel { Label(
                            String(format: String(localized: "Linked to %@"), channel.label),
                            systemImage: "link") }
                        HStack(spacing: 5) {
                            OpenClawSessionColorStripe(color: self.session.color).frame(width: 3)
                            Text(verbatim: copy.title)
                                .font(OpenClawChatTypography.body(size: 13, weight: .semibold, relativeTo: .body))
                        }
                        if let channel {
                            ForEach(channel.details, id: \.self) { Text(verbatim: $0).foregroundStyle(.secondary) }
                        }
                    }
                    Spacer(minLength: 4)
                    if let created = self.session.createdAt {
                        Text(verbatim: ChatSessionHoverCardProjection.age(created, now: Date()))
                            .foregroundStyle(.secondary)
                            .help(ChatSessionHoverCardProjection.age(created, now: Date(), suffix: true))
                    }
                }
                if channel == nil { self.attribution(attribution) }
                ForEach(
                    Array(ChatSessionHoverCardProjection.context(self.session).enumerated()),
                    id: \.offset)
                { _, item in
                    Label(item.text, systemImage: item.symbol).foregroundStyle(.secondary)
                        .help(item.detail ?? item.text)
                        .accessibilityLabel(item.label ?? item.text)
                }
                if let head = ChatSessionHoverCardProjection.headsUp(card, session: self.session) {
                    HStack {
                        Label(
                            head.step,
                            systemImage: head.paused ? "pause.circle" : head
                                .running ? "arrow.trianglehead.2.clockwise.rotate.90" : "clock")
                        Spacer()
                        Text(verbatim: "\(head.completed)/\(head.total)").foregroundStyle(.secondary)
                    }.accessibilityLabel(head.label)
                }
                if let prs { self.pullRequests(prs) }
                if let preview = copy.preview {
                    Divider()
                    Text(verbatim: preview).lineLimit(2)
                }
                if let error = copy.error { Divider()
                    Label(error, systemImage: "exclamationmark.triangle").foregroundStyle(OpenClawChatTheme.danger)
                }
                if let markdown = copy.notepad {
                    Divider()
                    Text("Agent notepad").fontWeight(.semibold).foregroundStyle(.secondary)
                    ChatMarkdownRenderer(
                        text: markdown,
                        context: .assistant,
                        variant: .compact,
                        textColor: OpenClawChatTheme.assistantText)
                }
                if channel != nil, attribution != nil {
                    Divider()
                    Text("In this session").foregroundStyle(.secondary)
                    self.attribution(attribution)
                }
            }.padding(14)
        }
        .font(OpenClawChatTypography.caption)
        .frame(width: 340).frame(maxHeight: 480)
        .onKeyPress(phases: .down) { _ in self.keyboardEngaged = true
            return .ignored
        }
        .background(ChatHoverFocusObserver(
            focused: self.$focused,
            keyboardEngaged: self.keyboardOpened || self.keyboardEngaged,
            exit: self.exit))
        .accessibilityIdentifier("chat-session-hovercard")
    }

    @ViewBuilder private func attribution(_ value: ChatSessionHoverCardProjection.Attribution?) -> some View {
        if let value {
            HStack(spacing: 5) {
                self.person(value.primary)
                if value.participantCount > 0, !value.others.isEmpty {
                    Menu {
                        ForEach(Array(value.others.enumerated()), id: \.offset) { _, person in self.person(person) }
                        if value.participantCount > value.others.count { Text(String(
                            format: String(localized: "%lld more participants"),
                            value.participantCount - value.others.count)) }
                    } label: {
                        Text(value.participantCount == 1 ? String(localized: "& 1 other") : String(
                            format: String(localized: "& %lld others"),
                            value.participantCount))
                    }.menuStyle(.borderlessButton).fixedSize().focused(self.$focus, equals: "participants")
                } else if value.participantCount > 0 {
                    Text(value.participantCount == 1 ? String(localized: "& 1 other") : String(
                        format: String(localized: "& %lld others"),
                        value.participantCount))
                }
                Spacer(minLength: 0)
                ForEach(Array(([value.primary] + value.visibleOthers).enumerated()), id: \.offset) { index, person in
                    let load = { () async -> Data? in
                        if index == 0, value.primaryIsCreator,
                           self.session.channelAvatarUrl != nil { return await self.channelAvatar() }
                        if let id = person.agentID, let url = person.avatarURL {
                            return await self.agentAvatar(id, url)
                        }
                        guard let id = person.profileID else { return nil }
                        return await self.actions?.avatar(id, person.avatarURL)
                    }
                    if let id = person.profileID, let actions {
                        Button { self.dismiss()
                            actions.activity(id, person.label)
                        } label: { ChatHoverAvatar(
                            person: person,
                            channelRevision: index == 0 ? self.session.channelAvatarUrl : nil,
                            generation: self.source?.avatarGeneration,
                            load: load) }
                            .buttonStyle(.plain).accessibilityLabel(person.label)
                            .accessibilityHidden(index == 0).focusable(index != 0)
                            .focused(self.$focus, equals: "avatar:\(index)")
                    } else { ChatHoverAvatar(
                        person: person,
                        channelRevision: index == 0 ? self.session.channelAvatarUrl : nil,
                        generation: self.source?.avatarGeneration,
                        load: load) }
                }
                if value.hiddenAvatarCount > 0 {
                    Text(verbatim: "+\(value.hiddenAvatarCount)").foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private func person(_ person: ChatSessionHoverCardProjection.Person) -> some View {
        if let id = person.profileID, let actions {
            Button(person.label) { self.dismiss()
                actions.activity(id, person.label)
            }
            .buttonStyle(.plain).focused(self.$focus, equals: "person:\(id)")
        } else {
            Text(verbatim: person.label)
        }
    }

    @ViewBuilder private func pullRequests(_ snapshot: OpenClawSessionPullRequestSnapshot) -> some View {
        if let pr = snapshot.pullRequests.first, let url = URL(string: pr.url) {
            Link(destination: url) {
                HStack {
                    Image(systemName: pr.state == "merged" ? "arrow.triangle.merge" : pr
                        .state == "closed" ? "xmark.circle" : "arrow.triangle.branch")
                        .foregroundStyle(pr.state == "merged" ? .purple : pr.state == "closed" ? .red : pr
                            .state == "draft" ? .secondary : .green)
                    Text(verbatim: "#\(pr.number) \(pr.title)").lineLimit(1)
                    Spacer(minLength: 0)
                    self.diff(pr.additions, pr.deletions)
                }
            }.focused(self.$focus, equals: "pr")
                .help([pr.stateLabel, pr.checks.map { ChatSessionHoverCardProjection.checksLabel($0.state) }]
                    .compactMap(\.self).joined(separator: " · "))
                .accessibilityLabel(pr.accessibilityLabel)
            if let checks = pr
                .checks
            { Text(ChatSessionHoverCardProjection.checksLabel(checks.state)).foregroundStyle(.secondary)
            }
            if snapshot.pullRequests.count > 1 { Text(String(
                format: String(localized: "+%lld more"),
                snapshot.pullRequests.count - 1)) }
        } else if let branch = snapshot.branch {
            HStack {
                Image(systemName: "arrow.triangle.branch")
                if let target = branch.createUrl, let url = URL(string: target) {
                    Link("Create PR", destination: url).focused(self.$focus, equals: "branch")
                } else { Text("Changes") }
                Spacer(minLength: 0)
                self.diff(branch.additions, branch.deletions)
            }
        }
        if let notice = ChatSessionHoverCardProjection.pullRequestNotice(snapshot.status) {
            Text(verbatim: notice).foregroundStyle(.secondary)
        }
    }

    private func diff(_ additions: Int?, _ deletions: Int?) -> some View {
        HStack(spacing: 4) {
            if let additions { Text(verbatim: "+\(additions.formatted())").foregroundStyle(OpenClawChatTheme.success) }
            if let deletions { Text(verbatim: "−\(deletions.formatted())").foregroundStyle(OpenClawChatTheme.danger) }
        }.monospacedDigit()
    }
}

private struct ChatHoverAvatar: View {
    let person: ChatSessionHoverCardProjection.Person
    let channelRevision: String?
    let generation: UUID?
    let load: () async -> Data?
    @State private var image: NSImage?

    var body: some View {
        Group {
            if let image {
                Image(nsImage: image).resizable().scaledToFill()
            } else {
                ChatAgentAvatar(
                    text: self.person.label.split(separator: " ").prefix(2).compactMap(\.first).map(String.init)
                        .joined(),
                    name: self.person.label,
                    tint: nil,
                    size: 18)
            }
        }
        .frame(width: 18, height: 18).clipShape(Circle()).help(self.person.label)
        .task(id: [
            self.person.profileID ?? self.person.agentID ?? "",
            self.person.avatarURL ?? "",
            self.channelRevision ?? "",
            self.generation?.uuidString ?? "",
        ]) {
            self.image = nil
            guard let data = await self.load(), !Task.isCancelled else { return }
            self.image = NSImage(data: data)
        }
    }
}

private struct ChatHoverFocusObserver: NSViewRepresentable {
    @Binding var focused: Bool
    let keyboardEngaged: Bool
    let exit: () -> Void
    func makeNSView(context: Context) -> Probe {
        Probe()
    }

    func updateNSView(_ view: Probe, context: Context) {
        view.changed = { self.focused = $0 }
        view.keyboardEngaged = self.keyboardEngaged
        view.exit = self.exit
    }

    final class Probe: NSView {
        var changed: ((Bool) -> Void)?
        var keyboardEngaged = false
        var exit: (() -> Void)?
        private var observer: NSObjectProtocol?
        private var keyMonitor: Any?
        private var held = false
        override func viewDidMoveToWindow() {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
            self.observer = nil
            self.keyMonitor = nil
            guard let window else { return }
            self.keyMonitor = NSEvent.addLocalMonitorForEvents(matching: .keyDown) { [weak self] event in
                guard let self, event.window === self.window, event.keyCode == 48 else { return event }
                let links = self.controls(in: self.window?.contentView)
                let edge = event.modifierFlags.contains(.shift) ? links.first : links.last
                // portaled-hovercard.ts:79: native accessibility order also includes Markdown's inline links.
                if edge?.isAccessibilityFocused() == true {
                    self.exit?()
                    return nil
                }
                return event
            }
            // The popover has its own window; Markdown links must hold it just like named SwiftUI controls.
            self.observer = NotificationCenter.default.addObserver(
                forName: NSWindow.didUpdateNotification,
                object: window,
                queue: .main)
            { [weak self] _ in
                Task { @MainActor [weak self] in
                    guard let self, let window = self.window else { return }
                    let held = self.keyboardEngaged && window.isKeyWindow &&
                        (window.firstResponder as? NSView)?.window === window
                    guard held != self.held else { return }
                    self.held = held
                    self.changed?(held)
                }
            }
        }

        private func controls(in object: Any?) -> [any NSAccessibilityProtocol] {
            guard let element = object as? any NSAccessibilityProtocol else { return [] }
            if [.link, .button, .popUpButton].contains(element.accessibilityRole()),
               element.isAccessibilityElement(), element.isAccessibilityEnabled() { return [element] }
            return (element.accessibilityChildrenInNavigationOrder() ?? element.accessibilityChildren() ?? [])
                .flatMap { self.controls(in: $0) }
        }

        isolated deinit {
            if let observer { NotificationCenter.default.removeObserver(observer) }
            if let keyMonitor { NSEvent.removeMonitor(keyMonitor) }
        }
    }
}

#endif
