#if os(macOS)
import AppKit
import SwiftUI
import UniformTypeIdentifiers

/// Native macOS chat window with a sessions sidebar and conversation toolbar.
/// Draft controls belong to the composer; the compact menu-bar panel keeps
/// using `OpenClawChatView` directly.
@MainActor
public struct OpenClawChatWindowShell: View {
    public nonisolated static let assistantTraceDefaultsKey = "openclaw.webchat.showAssistantTrace"
    public nonisolated static let assistantReasoningDefaultsKey = "openclaw.webchat.showAssistantReasoning"
    public nonisolated static let assistantToolActivityDefaultsKey = "openclaw.webchat.showAssistantToolActivity"

    @State private var viewModel: OpenClawChatViewModel
    @Environment(\.colorScheme) private var colorScheme
    /// Keep absent keys available to the app's legacy trace-preference migration.
    @AppStorage(OpenClawChatWindowShell.assistantReasoningDefaultsKey)
    private var storedShowsReasoning: Bool?
    @AppStorage(OpenClawChatWindowShell.assistantToolActivityDefaultsKey)
    private var storedShowsToolActivity: Bool?
    @State private var sessionQuery = ""
    @State private var isConfirmingClearHistory = false
    @State private var isPresentingSessions = false
    @State private var isRenamingSession = false
    @State private var isPresentingNewSessionOptions = false
    @State private var renameSessionTarget: OpenClawChatSessionTarget?
    @State private var renameText = ""
    private let userAccent: Color?
    private let displayOptions: OpenClawChatDisplayOptions
    private let emptyAssistantIntro: String?
    private let emptyAssistantPrompts: [OpenClawChatView.StarterPrompt]
    private let talkControl: OpenClawChatTalkControl?
    private let voiceNoteControl: OpenClawChatVoiceNoteControl?
    private let speech: OpenClawChatSpeechController?
    private let mediaPlaybackAllowed: @MainActor @Sendable () -> Bool

    /// `showsAssistantTrace` remains as a source-compatible convenience that sets both display options.
    public init(
        viewModel: OpenClawChatViewModel,
        userAccent: Color? = nil,
        displayOptions: OpenClawChatDisplayOptions? = nil,
        showsAssistantTrace: Bool = false,
        emptyAssistantIntro: String? = nil,
        emptyAssistantPrompts: [OpenClawChatView.StarterPrompt] = [],
        talkControl: OpenClawChatTalkControl? = nil,
        voiceNoteControl: OpenClawChatVoiceNoteControl? = nil,
        speech: OpenClawChatSpeechController? = nil,
        mediaPlaybackAllowed: @escaping @MainActor @Sendable () -> Bool = { true })
    {
        _viewModel = State(initialValue: viewModel)
        self.userAccent = userAccent
        self.displayOptions = displayOptions ?? .assistantTrace(showsAssistantTrace)
        self.emptyAssistantIntro = emptyAssistantIntro
        self.emptyAssistantPrompts = emptyAssistantPrompts
        self.talkControl = talkControl
        self.voiceNoteControl = voiceNoteControl
        self.speech = speech
        self.mediaPlaybackAllowed = mediaPlaybackAllowed
    }

    public var body: some View {
        NavigationSplitView {
            ChatSessionSidebar(
                viewModel: self.viewModel,
                query: self.$sessionQuery)
                .navigationSplitViewColumnWidth(min: 220, ideal: 260, max: 360)
        } detail: {
            OpenClawChatView(
                viewModel: self.viewModel,
                drawsBackground: false,
                userAccent: self.userAccent,
                displayOptions: self.displayOptions,
                assistantName: self.viewModel.selectedAgent?.displayName,
                assistantAvatarText: self.viewModel.selectedAgent?.emoji,
                showsAssistantAvatars: false,
                composerChrome: .clean,
                messagePlaceholder: self.viewModel.selectedAgent.map {
                    String(format: String(localized: "Message %@…"), $0.displayName)
                },
                emptyAssistantIntro: self.emptyAssistantIntro,
                emptyAssistantPrompts: self.emptyAssistantPrompts,
                talkControl: self.talkControl,
                voiceNoteControl: self.voiceNoteControl,
                speech: self.speech,
                mediaPlaybackAllowed: self.mediaPlaybackAllowed)
                .environment(\.openClawChatDesktopLayout, true)
                .navigationTitle(self.activeSessionTitle)
                .toolbar { self.detailToolbar }
                .background(self.keyboardShortcutHandlers)
                .background(OpenClawChatTheme.desktopCanvas(in: self.colorScheme))
        }
        .task { await self.viewModel.refreshAgents() }
        .confirmationDialog(
            "Clear this thread's history?",
            isPresented: self.$isConfirmingClearHistory)
        {
            Button(role: .destructive) {
                self.viewModel.requestSessionReset()
            } label: {
                Text("Clear History")
                    .font(OpenClawChatTypography.body)
            }
        } message: {
            Text(verbatim: String(
                format: String(localized: """
                This resets the conversation for %@. The session key stays the same.
                """),
                self.activeSessionTitle))
                .font(OpenClawChatTypography.body)
        }
        .alert(String(localized: "Rename Thread"), isPresented: self.$isRenamingSession) {
                TextField(String(localized: "Thread name"), text: self.$renameText)
                Button(String(localized: "Rename")) {
                    guard let target = self.renameSessionTarget else { return }
                    self.viewModel.renameSession(
                        key: target.sessionKey,
                        label: self.renameText,
                        agentID: target.agentID)
                    self.renameSessionTarget = nil
                }
                Button(String(localized: "Cancel"), role: .cancel) {
                    self.renameSessionTarget = nil
                }
            }
            .sheet(isPresented: self.$isPresentingSessions) {
                ChatSessionsSheet(viewModel: self.viewModel)
            }
            .onChange(of: self.viewModel.pendingRunCount) { previous, current in
                // Run completion changes timestamps/token totals; pull them once
                // per run instead of polling.
                if previous > 0, current == 0 {
                    self.viewModel.refreshSessions(limit: 200)
                }
            }
    }

    /// Key equivalents only fire for installed views; buttons inside a closed
    /// toolbar Menu are not built yet, so the shortcuts live here and the menu
    /// items carry matching labels for discoverability.
    private var keyboardShortcutHandlers: some View {
        Group {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                Text("New Thread")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("n", modifiers: [.command])
            .focusable(false)

            Button {
                self.viewModel.refresh()
                self.viewModel.refreshSessions(limit: 200)
            } label: {
                Text("Refresh")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("r", modifiers: [.command])
            .focusable(false)

            Button {
                self.exportTranscript()
            } label: {
                Text("Export Transcript")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .focusable(false)
            .disabled(self.viewModel.messages.isEmpty)

            Button {
                self.isPresentingSessions = true
            } label: {
                Text("Threads")
                    .font(OpenClawChatTypography.body)
            }
            .keyboardShortcut("s", modifiers: [.command, .shift])
            .focusable(false)
        }
        .opacity(0)
        .frame(width: 0, height: 0)
        .accessibilityHidden(true)
    }

    private var activeSessionTitle: String {
        if let entry = self.activeSessionEntry {
            return ChatSessionSidebarModel.displayName(for: entry)
        }
        return ChatSessionSidebarModel.displayName(forKey: self.viewModel.sessionKey)
    }

    private var activeSessionEntry: OpenClawChatSessionEntry? {
        self.viewModel.currentSessionEntry()
    }

    private var activeSessionKey: String {
        self.activeSessionEntry?.key ?? self.viewModel.sessionKey
    }

    @ToolbarContentBuilder
    private var detailToolbar: some ToolbarContent {
        if #available(macOS 26.0, *) {
            ToolbarItem(placement: .principal) {
                self.conversationIdentity
            }
            .sharedBackgroundVisibility(.hidden)
        } else {
            ToolbarItem(placement: .principal) {
                self.conversationIdentity
            }
        }
        ToolbarItem(placement: .primaryAction) {
            self.sessionActionsMenu
        }
    }

    private var conversationIdentity: some View {
        TimelineView(.periodic(from: .now, by: 30)) { context in
            HStack(spacing: 8) {
                if let agent = self.viewModel.selectedAgent {
                    ChatSidebarAgentAvatar(agent: agent, size: 24)
                }
                VStack(alignment: .leading, spacing: 2) {
                    Text(self.activeSessionTitle)
                        .font(OpenClawChatTypography.body(size: 13, weight: .semibold, relativeTo: .headline))
                    HStack(spacing: 6) {
                        if let agent = self.viewModel.selectedAgent {
                            Text(verbatim: agent.displayName)
                        }
                        if let status = self.conversationStatus(at: context.date) {
                            Text(verbatim: "·").accessibilityHidden(true)
                            Label(status.title, systemImage: status.symbol)
                                .labelStyle(.titleAndIcon)
                                .foregroundStyle(status.tint)
                        }
                    }
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                }
                .lineLimit(1)
            }
            .padding(.horizontal, 4)
            .padding(.vertical, 6)
            .accessibilityElement(children: .combine)
            .accessibilityIdentifier("chat-conversation-identity")
        }
    }

    private func conversationStatus(at date: Date) -> (title: String, symbol: String, tint: Color)? {
        if !self.viewModel.healthOK {
            return (String(localized: "Connecting…"), "network", .secondary)
        }
        if self.viewModel.composerModelAvailabilityMessage != nil {
            return (String(localized: "Sign-in needed"), "key", OpenClawChatTheme.warning)
        }
        if self.viewModel.visibleQuestionCards.contains(where: { $0.status(at: date) == .pending }) {
            return (String(localized: "Needs you"), "bubble.left", OpenClawChatTheme.warning)
        }
        let activity = self.activeSessionEntry.flatMap {
            ChatSessionSidebarModel.activity(for: $0, now: date.timeIntervalSince1970 * 1000)
        }
        if activity?.kind == .attention {
            return (String(localized: "Needs you"), "exclamationmark.bubble", OpenClawChatTheme.warning)
        }
        if activity?.kind == .queued {
            return (String(localized: "Queued"), "hourglass", .secondary)
        }
        if self.viewModel.hasBlockingRunActivity {
            return (String(localized: "Working"), "circle.dotted", .secondary)
        }
        guard let activity else { return nil }
        switch activity.kind {
        case .attention:
            return (String(localized: "Needs you"), "exclamationmark.bubble", OpenClawChatTheme.warning)
        case .running:
            return (String(localized: "Working"), "circle.dotted", .secondary)
        case .queued:
            return (String(localized: "Queued"), "hourglass", .secondary)
        case .failed:
            return (String(localized: "Failed"), "exclamationmark.triangle", OpenClawChatTheme.warning)
        case .finished:
            return (String(localized: "Finished"), "checkmark", .secondary)
        case .idle:
            return (String(localized: "Ready"), "circle", .secondary)
        case .unknown:
            return nil
        }
    }

    private var sessionActionsMenu: some View {
        Menu {
            Button {
                Task { await self.viewModel.startNewSession() }
            } label: {
                chatWindowActionLabel("New Thread", systemImage: "square.and.pencil")
            }
            .keyboardShortcut("n", modifiers: [.command])

            Button {
                self.isPresentingNewSessionOptions = true
            } label: {
                chatWindowActionLabel("New Thread Options…", systemImage: "slider.horizontal.3")
            }

            Button {
                self.viewModel.refresh()
                self.viewModel.refreshSessions(limit: 200)
            } label: {
                chatWindowActionLabel("Refresh", systemImage: "arrow.clockwise")
            }
            .keyboardShortcut("r", modifiers: [.command])

            Button {
                self.isPresentingSessions = true
            } label: {
                chatWindowActionLabel("Threads…", systemImage: "rectangle.stack")
            }
            .keyboardShortcut("s", modifiers: [.command, .shift])

            Divider()

            Button {
                self.renameSessionTarget = self.viewModel.currentSessionTarget
                self.renameText = self.activeSessionEntry?.label ?? self.activeSessionTitle
                self.isRenamingSession = true
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(String(localized: "Rename Thread…")),
                    systemImage: "pencil")
            }

            Button {
                let target = self.viewModel.currentSessionTarget
                Task { await self.viewModel.forkSession(key: target.sessionKey, agentID: target.agentID) }
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(
                        self.activeSessionEntry?.hasActiveRun == true
                            ? String(localized: "Fork from last completed message")
                            : String(localized: "Fork")),
                    systemImage: "arrow.triangle.branch")
            }

            Button {
                self.viewModel.setSessionPinned(
                    key: self.activeSessionKey,
                    pinned: self.activeSessionEntry?.pinned != true,
                    agentID: self.viewModel.currentSessionTarget.agentID)
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(self.activeSessionEntry?.pinned == true
                        ? String(localized: "Unpin")
                        : String(localized: "Pin")),
                    systemImage: self.activeSessionEntry?.pinned == true ? "pin.slash" : "pin")
            }

            Button {
                self.viewModel.setSessionUnread(
                    key: self.activeSessionKey,
                    unread: self.activeSessionEntry?.unread != true,
                    agentID: self.viewModel.currentSessionTarget.agentID)
            } label: {
                chatWindowActionLabel(
                    LocalizedStringKey(self.activeSessionEntry?.unread == true
                        ? String(localized: "Mark Read")
                        : String(localized: "Mark Unread")),
                    systemImage: self.activeSessionEntry?.unread == true ? "envelope.open" : "envelope.badge")
            }

            if self.activeSessionEntry.map({
                ChatSessionSidebarModel.canArchiveSession(
                    $0,
                    mainSessionKey: self.viewModel.selectedAgentMainSessionKey)
            }) == true {
                Button {
                    if let activeSessionEntry = self.activeSessionEntry {
                        self.viewModel.setSessionArchived(
                            activeSessionEntry,
                            archived: !activeSessionEntry.isArchived)
                    }
                } label: {
                    chatWindowActionLabel(
                        LocalizedStringKey(self.activeSessionEntry?.isArchived == true
                            ? String(localized: "Restore")
                            : String(localized: "Archive")),
                        systemImage: self.activeSessionEntry?.isArchived == true
                            ? "tray.and.arrow.up"
                            : "archivebox")
                }
            }

            OpenClawSessionColorMenu(color: self.activeSessionEntry?.color) { color in
                let target = self.viewModel.currentSessionTarget
                Task {
                    await self.viewModel.setSessionColor(
                        key: target.sessionKey,
                        color: color,
                        agentID: target.agentID)
                }
            }

            Divider()

            Button {
                self.copyToPasteboard(self.viewModel.sessionKey)
            } label: {
                chatWindowActionLabel("Copy Session Key", systemImage: "doc.on.doc")
            }

            Button {
                self.exportTranscript()
            } label: {
                chatWindowActionLabel("Export Transcript…", systemImage: "square.and.arrow.up")
            }
            .keyboardShortcut("e", modifiers: [.command, .shift])
            .disabled(self.viewModel.messages.isEmpty)

            Toggle(isOn: Binding(
                get: { self.displayOptions.contains(.reasoning) },
                set: { self.storedShowsReasoning = $0 }))
            {
                chatWindowActionLabel(
                    "Show Reasoning",
                    systemImage: "brain.head.profile")
            }

            Toggle(isOn: Binding(
                get: { self.displayOptions.contains(.toolActivity) },
                set: { self.storedShowsToolActivity = $0 }))
            {
                chatWindowActionLabel(
                    "Show Tool Activity",
                    systemImage: "hammer")
            }

            Divider()

            Button {
                self.viewModel.requestSessionCompact()
            } label: {
                chatWindowActionLabel("Compact Thread", systemImage: "arrow.down.right.and.arrow.up.left")
            }
            .disabled(self.viewModel.hasBlockingRunActivity)

            Button(role: .destructive) {
                self.isConfirmingClearHistory = true
            } label: {
                chatWindowActionLabel("Clear History…", systemImage: "trash")
            }
        } label: {
            chatWindowActionLabel("Thread", systemImage: "ellipsis.circle")
        }
        .popover(isPresented: self.$isPresentingNewSessionOptions) {
            ChatNewSessionOptionsPopover(viewModel: self.viewModel) {
                self.isPresentingNewSessionOptions = false
            }
        }
        .menuIndicator(.hidden)
        .help("Thread actions")
    }

    private func copyToPasteboard(_ string: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(string, forType: .string)
    }

    private func exportTranscript() {
        let markdown = self.viewModel.exportTranscriptMarkdown()
        let panel = NSSavePanel()
        panel.allowedContentTypes = [UTType(filenameExtension: "md") ?? .plainText]
        panel.nameFieldStringValue = ChatTranscriptExporter.filename(
            sessionTitle: self.activeSessionTitle,
            sessionKey: self.viewModel.sessionKey)
        panel.begin { response in
            guard response == .OK, let url = panel.url else { return }
            try? markdown.write(to: url, atomically: true, encoding: .utf8)
        }
    }
}

func chatWindowActionLabel(_ title: LocalizedStringKey, systemImage: String) -> some View {
    Label {
        Text(title)
            .font(OpenClawChatTypography.body(size: 13, weight: .regular, relativeTo: .body))
    } icon: {
        Image(systemName: systemImage)
    }
}
#endif
