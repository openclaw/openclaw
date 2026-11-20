import SwiftUI
#if os(macOS)
import AppKit
#endif
#if canImport(UIKit)
import UIKit
#endif

private struct ChatTurnRecapObservation: Equatable {
    let sessionKey: String
    let indicatorVisible: Bool
    let row: ChatTurnRecapSessionRow?
}

@MainActor
public struct OpenClawChatView: View {
    // The caller owns model lifetime; transport replacement can preserve presentation identity.
    private let viewModel: OpenClawChatViewModel
    private let resolveComposerModel: (@MainActor () -> OpenClawChatViewModel?)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @State private var contentWidth: CGFloat = 0
    @State private var scrollerBottomID = UUID()
    @State private var scrollCommand = ChatScrollCommand()
    @State private var dismissedProgressCards: Set<String> = []
    @State private var scroll = ChatScrollFollowState()
    @State private var hasPerformedInitialScroll = false
    @State private var lastTurnStartID: UUID?
    #if os(iOS)
    @State private var readerHistorySnapshot: ChatReaderHistorySnapshot?
    @State private var olderHistory = ChatOlderHistoryReader()
    #endif
    @State private var isKeyboardVisible = false
    @State private var hoveredMessageID: UUID?
    @State private var expandedUserMessageIDs: Set<UUID> = []
    @State private var searchMessageID: UUID?
    @State private var isSearchPresented = false
    @State private var composerFocusRequest = 0
    @State private var isOnScreen = false
    #if os(macOS)
    @Environment(\.openClawChatWindowCommands) private var windowCommands
    #endif
    @State private var fullMessageRequest: ChatFullMessageReaderRequest?
    @State private var reactionPickerMessage: OpenClawChatMessage?
    #if os(iOS)
    @State private var selectTextMessage: OpenClawChatMessage?
    #endif
    @State private var turnRecapResolver = ChatTurnRecapResolver()
    @State private var turnRecap: ChatTurnRecap?
    @State private var turnRecapSessionKey: String?
    private let showsSessionSwitcher: Bool
    private let drawsBackground: Bool
    private let style: Style
    private let markdownVariant: ChatMarkdownVariant
    private let userAccent: Color?
    private let displayOptions: OpenClawChatDisplayOptions
    private let assistantName: String?
    private let assistantAvatarText: String?
    private let assistantAvatarTint: Color?
    private let showsAssistantAvatars: Bool
    private let composerChrome: ComposerChrome
    private let showsComposer: Bool
    private let isComposerEnabled: Bool
    private let isAttachmentInputEnabled: Bool
    private let messagePlaceholder: String?
    private let emptyAssistantIntro: String?
    private let emptyAssistantPrompts: [StarterPrompt]
    private let talkControl: OpenClawChatTalkControl?
    private let dictationControl: OpenClawChatDictationControl?
    private let voiceNoteControl: OpenClawChatVoiceNoteControl?
    private let speech: OpenClawChatSpeechController?
    private let mediaPlaybackAllowed: @MainActor @Sendable () -> Bool

    private enum Layout {
        static let newTurnAnchor = UnitPoint(x: 0.5, y: ChatReadingPolicy.turnAnchor)
        static let liveEdgeThreshold: CGFloat = 48
        #if os(macOS)
        static let outerPaddingVertical: CGFloat = 0
        static let swarmPaddingVertical: CGFloat = 8
        static let stackSpacing: CGFloat = 0
        static let messageSpacing: CGFloat = 6
        static let messageListPaddingTop: CGFloat = 12
        static let messageListPaddingBottom: CGFloat = 16
        #else
        static let outerPaddingVertical: CGFloat = 6
        static let swarmPaddingVertical: CGFloat = 0
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 12
        static let messageListPaddingTop: CGFloat = 10
        static let messageListPaddingBottom: CGFloat = 6
        #endif
    }

    private var collapsesCompletedWork: Bool {
        #if os(iOS)
        true
        #else
        self.isDesktopLayout
        #endif
    }

    /// `showsAssistantTrace` remains as a source-compatible convenience that sets both display options.
    public init(
        viewModel: OpenClawChatViewModel,
        resolveComposerModel: (@MainActor () -> OpenClawChatViewModel?)? = nil,
        drawsBackground: Bool = true,
        showsSessionSwitcher: Bool = false,
        style: Style = .standard,
        markdownVariant: ChatMarkdownVariant = .standard,
        userAccent: Color? = nil,
        displayOptions: OpenClawChatDisplayOptions? = nil,
        showsAssistantTrace: Bool = false,
        assistantName: String? = nil,
        assistantAvatarText: String? = nil,
        assistantAvatarTint: Color? = nil,
        showsAssistantAvatars: Bool = true,
        composerChrome: ComposerChrome = .full,
        showsComposer: Bool = true,
        isComposerEnabled: Bool = true,
        isAttachmentInputEnabled: Bool? = nil,
        messagePlaceholder: String? = nil,
        emptyAssistantIntro: String? = nil,
        emptyAssistantPrompts: [StarterPrompt] = [],
        talkControl: OpenClawChatTalkControl? = nil,
        dictationControl: OpenClawChatDictationControl? = nil,
        voiceNoteControl: OpenClawChatVoiceNoteControl? = nil,
        speech: OpenClawChatSpeechController? = nil,
        mediaPlaybackAllowed: @escaping @MainActor @Sendable () -> Bool = { true })
    {
        self.viewModel = viewModel
        self.resolveComposerModel = resolveComposerModel
        self.drawsBackground = drawsBackground
        self.showsSessionSwitcher = showsSessionSwitcher
        self.style = style
        self.markdownVariant = markdownVariant
        self.userAccent = userAccent
        self.displayOptions = displayOptions ?? .assistantTrace(showsAssistantTrace)
        self.assistantName = assistantName
        self.assistantAvatarText = assistantAvatarText
        self.assistantAvatarTint = assistantAvatarTint
        self.showsAssistantAvatars = showsAssistantAvatars
        self.composerChrome = composerChrome
        self.showsComposer = showsComposer
        self.isComposerEnabled = isComposerEnabled
        self.isAttachmentInputEnabled = isAttachmentInputEnabled ?? isComposerEnabled
        self.messagePlaceholder = messagePlaceholder
        self.emptyAssistantIntro = emptyAssistantIntro
        self.emptyAssistantPrompts = emptyAssistantPrompts
        self.talkControl = talkControl
        self.dictationControl = dictationControl
        self.voiceNoteControl = voiceNoteControl
        self.speech = speech
        self.mediaPlaybackAllowed = mediaPlaybackAllowed
    }

    public var body: some View {
        ZStack {
            if self.drawsBackground, self.style == .standard {
                OpenClawChatTheme.background
                    .ignoresSafeArea()
            }

            self.content
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear {
            self.isOnScreen = true
            self.viewModel.refreshSourceContext()
            self.viewModel.load()
        }
        .onChange(of: ObjectIdentifier(self.viewModel)) { _, _ in
            self.viewModel.refreshSourceContext()
        }
        .modifier(ChatPresentationActivity(viewModel: self.viewModel, isOnScreen: self.isOnScreen))
        .onChange(of: self.turnRecapObservation, initial: true) { _, observation in
            self.updateTurnRecap(observation)
        }
        .sheet(item: self.$reactionPickerMessage) {
            ChatMessageReactionPicker(viewModel: self.viewModel, message: $0)
        }
        .sheet(item: self.$fullMessageRequest) { request in
            ChatFullMessageReader(
                request: request,
                markdownVariant: self.markdownVariant)
        }
        #if os(iOS)
        .sheet(item: self.$selectTextMessage) {
            ChatSelectableTextSheet(text: ChatMessageVisibleText.copyText(in: $0))
        }
        #endif
    }
}

extension OpenClawChatView {
    private var content: some View {
        let transcript = self.transcriptPresentation
        let column = self.columnLayout
        // The width rule owns horizontal geometry only; macOS keeps its window's bottom inset.
        #if os(macOS)
        let composerBottom: CGFloat = self.isDesktopLayout ? 12 : Layout.outerPaddingVertical
        #else
        let composerBottom = column.margin / 2
        #endif
        return VStack(spacing: 0) {
            self.messageList(transcript: transcript)
                #if os(macOS)
                    .modifier(ChatTranscriptSearch(
                        rows: transcript.rows,
                        sessionKey: self.viewModel.sessionKey,
                        isEnabled: self.isDesktopLayout && self.showsComposer,
                        focusRequest: self.windowCommands?.findRequest ?? 0,
                        selectedMessageID: self.$searchMessageID,
                        isPresented: self.$isSearchPresented,
                        onSelect: self.revealSearchMessage))
                    .onChange(of: self.windowCommands?.composerFocusRequest) { _, _ in
                        self.composerFocusRequest += 1
                    }
                    .onChange(of: self.searchMessageID) { previousID, _ in
                        self.scrollCommand.cancel(targetID: previousID)
                    }
                    .onChange(of: self.isSearchPresented) { wasPresented, isPresented in
                        if wasPresented, !isPresented { self.composerFocusRequest += 1 }
                    }
                #endif
            if !self.usesInlineProgressCard {
                // The composer draws its surface on the column, so the card shares its edges.
                self.progressCard
                    .chatColumn(column)
                    .padding(.top, Layout.stackSpacing)
            }
            if self.showsComposer {
                self.turnRecapRow
                    .chatColumn(column)
            }
            self.swarmProgress
                .chatColumn(column)
                .padding(.vertical, Layout.swarmPaddingVertical)
                .padding(.top, Layout.stackSpacing)
            if self.showsComposer {
                self.composer
                    .chatBehaviorProbe(.composer)
                    .chatColumn(
                        column,
                        inset: OpenClawChatComposer.surfaceInset(style: self.style, chrome: self.composerChrome))
                    .padding(.top, Layout.stackSpacing)
                    .padding(.bottom, composerBottom)
            }
        }
        .padding(.top, Layout.outerPaddingVertical)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { self.contentWidth = $0 }
        .environment(\.openClawChatColumn, column)
        // Leaves read these; rows never take them as inputs, so a change redraws only the leaves.
        .environment(\.openClawChatGateway, self.gatewayResources)
        .environment(\.openClawChatUserAccent, self.userAccent)
        .environment(\.openClawAssistantIdentity, ChatAssistantIdentity(
            name: self.assistantName,
            avatarText: self.assistantAvatarText,
            avatarTint: self.assistantAvatarTint))
        .environment(
            \.openClawOpenChatSession,
            ChatOpenSessionAction(owner: ObjectIdentifier(self.viewModel)) { [viewModel = self.viewModel] in
                viewModel.switchSession(to: $0)
            })
    }

    @ViewBuilder
    private var progressCard: some View {
        if let progressCard = self.viewModel.progressCard {
            // Dismissal lasts until the card changes: an update is worth showing again.
            let signature = String(describing: progressCard)
            if !self.dismissedProgressCards.contains(signature) {
                ChatProgressCard(
                    steps: progressCard.steps ?? [],
                    markdown: progressCard.markdown,
                    isInline: self.usesInlineProgressCard,
                    isRefreshing: self.viewModel.progressCardRefreshPending,
                    onRefresh: self.viewModel.progressCardRefreshAvailable
                        ? { self.viewModel.requestProgressCardRefresh() } : nil,
                    onClearSaved: self.viewModel.progressCardStoreAvailable == true
                        ? { self.viewModel.clearSavedProgressCard() } : nil,
                    onDismiss: { self.dismissedProgressCards.insert(signature) })
            }
        }
    }

    private var usesInlineProgressCard: Bool {
        guard !self.showsComposer else { return false }
        if let steps = self.viewModel.progressCard?.steps, !steps.isEmpty {
            return steps.allSatisfy { $0.status == .completed }
        }
        return !self.viewModel.hasBlockingRunActivity
    }

    @ViewBuilder
    private var swarmProgress: some View {
        let groups = self.viewModel.activeSwarmGroups
        if !groups.isEmpty {
            OpenClawChatSwarmProgressView(groups: groups)
        }
    }

    private var composer: some View {
        OpenClawChatComposer(
            viewModel: self.viewModel,
            style: self.style,
            showsSessionSwitcher: self.showsSessionSwitcher,
            userAccent: self.userAccent,
            composerChrome: self.composerChrome,
            isComposerEnabled: self.isComposerEnabled
                && !self.viewModel.isSendingAttachmentDraft,
            isAttachmentInputEnabled: self.isAttachmentInputEnabled
                && !self.viewModel.isSendingAttachmentDraft,
            messagePlaceholder: self.messagePlaceholder,
            talkControl: self.talkControl,
            dictationControl: self.dictationControl,
            voiceNoteControl: self.voiceNoteControl,
            focusRequest: self.composerFocusRequest,
            resolveInputModel: self.resolveComposerModel)
    }

    /// The turn has ended, but a helper it started is still running.
    @ViewBuilder
    private var subagentWaitRow: some View {
        if let wait = self.viewModel.subagentWait {
            HStack(spacing: 7) {
                ChatWorkingClawView(seed: "subagent-wait", parked: true)
                VStack(alignment: .leading, spacing: 1) {
                    Text("Waiting on subagents")
                        .font(OpenClawChatTypography.caption)
                        .foregroundStyle(.secondary)
                    if let child = wait.child {
                        Button {
                            self.viewModel.switchSession(to: child.key)
                        } label: {
                            Text(child.name)
                                .font(OpenClawChatTypography.caption)
                                .underline()
                        }
                        .buttonStyle(.plain)
                        .accessibilityIdentifier("chat-subagent-wait-child")
                    }
                }
                Spacer(minLength: 0)
            }
        }
    }

    @ViewBuilder
    private var turnRecapRow: some View {
        if !self.showsWorkingIndicator,
           self.turnRecapSessionKey == self.viewModel.sessionKey,
           let turnRecap
        {
            ChatTurnRecapRow(recap: turnRecap)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func handleTranscriptDistanceChange(_ distanceFromBottom: CGFloat) {
        let isAtLiveEdge = distanceFromBottom <= Layout.liveEdgeThreshold
        guard self.scroll.isAtLiveEdge != isAtLiveEdge else { return }
        self.scroll.isAtLiveEdge = isAtLiveEdge
        #if os(iOS)
        self.scroll.hasNewerContentBelow = !isAtLiveEdge
        #endif
        #if !os(iOS)
        guard self.hasPerformedInitialScroll else { return }
        if isAtLiveEdge, !self.scroll.isUserScrolling, !self.isFollowingTurn, self.searchMessageID == nil {
            self.scroll.followTarget = .latest
            self.scroll.hasNewerContentBelow = false
        }
        #endif
    }

    private func messageListScrollContent(
        transcript: TranscriptPresentation,
        hasVisibleContent: Bool) -> some View
    {
        #if !os(iOS)
        let groups = self.runGroups(transcript)
        let latestTurn = ChatAssistantRunGroup.latestTurnStart(in: groups)
        let spacing = self.isDesktopLayout ? 16 : Layout.messageSpacing
        #endif
        return Group {
            #if os(iOS)
            List {
                ChatOlderHistoryBoundaryRow(viewModel: self.viewModel, load: self.loadOlderHistory)
                Group {
                    self.transcriptGroups(transcript: transcript, hasVisibleContent: hasVisibleContent)
                    if self.usesInlineProgressCard { self.progressCard }
                    if !self.showsComposer, !self.viewModel.hasBlockingRunActivity { self.turnRecapRow }
                    self.subagentWaitRow
                }
                .chatColumn(self.columnLayout)
                .listRowSeparator(.hidden)
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
                Color.clear
                    .frame(height: Layout.messageListPaddingBottom + 1)
                    .listRowSeparator(.hidden)
                    .listRowBackground(Color.clear)
            }
            .listStyle(.plain)
            .scrollContentBackground(.hidden)
            .environment(\.defaultMinListRowHeight, 0)
            .environment(\.openClawReadingPosition, self.scroll.readingPosition)
            .chatOlderHistoryTrigger(
                self.olderHistory,
                viewModel: self.viewModel,
                scroll: self.scroll,
                load: self.loadOlderHistory)
            #else
            ScrollView {
                LazyVStack(spacing: spacing) {
                    self.groupRows(groups[..<latestTurn], transcript: transcript)
                    VStack(spacing: spacing) {
                        self.messageListRows(
                            transcript: transcript,
                            groups: groups[latestTurn...],
                            hasVisibleContent: hasVisibleContent)
                        if self.usesInlineProgressCard { self.progressCard }
                        if !self.showsComposer, !self.viewModel.hasBlockingRunActivity { self.turnRecapRow }
                        self.subagentWaitRow
                    }

                    Color.clear
                        #if os(macOS)
                            .frame(height: Layout.messageListPaddingBottom)
                        #else
                            .frame(height: Layout.messageListPaddingBottom + 1)
                        #endif
                        .id(self.scrollerBottomID)
                }
                .padding(.top, self.isDesktopLayout ? 24 : Layout.messageListPaddingTop)
                .chatColumn(self.columnLayout)
            }
            #endif
        }
    }

    private func messageList(transcript: TranscriptPresentation) -> some View {
        let hasVisibleContent = !transcript.rows.isEmpty || self.hasVisibleTransientContent
        return ZStack {
            self.messageListScrollContent(transcript: transcript, hasVisibleContent: hasVisibleContent)
                .accessibilityIdentifier("chat-transcript")
                #if !os(macOS)
                .scrollDismissesKeyboard(.interactively)
                #endif
                .safeAreaInset(edge: .top, spacing: 0) {
                    self.messageListNoticeBanner(hasVisibleContent: hasVisibleContent)
                }
                // Let native layout follow a growing live bubble without issuing a command per word.
                #if !os(iOS)
                .defaultScrollAnchor(.bottom, for: .initialOffset)
                #endif
                .modifier(ChatScrollFollowAnchorModifier(scroll: self.scroll))
                // Lazy row sizing can cross the threshold repeatedly within one layout. Observe the
                // distance so a coalesced update still reconciles the stored live-edge state.
                .onScrollGeometryChange(for: CGFloat.self) { geometry in
                    geometry.contentSize.height - geometry.visibleRect.maxY
                } action: { _, distanceFromBottom in
                    self.handleTranscriptDistanceChange(distanceFromBottom)
                }
                .onScrollPhaseChange { _, phase in
                    self.handleTranscriptScrollPhase(phase)
                }
                .chatBehaviorProbeScroll()

            if self.viewModel.isLoading, self.composerChrome == .full {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            self.messageListOverlay(hasVisibleContent: hasVisibleContent)

            ChatJumpToLatestSlot(
                scroll: self.scroll,
                hasVisibleContent: hasVisibleContent,
                isLoading: self.viewModel.isLoading)
            {
                self.jumpToLatestButton
            }
        }
        #if os(iOS)
        .modifier(ChatScrollCommandModifier(
                command: self.$scrollCommand,
                currentSessionTarget: { self.viewModel.currentSessionTarget },
                shouldNavigate: { !self.scroll.readingPosition.isTurnRealized($0) }))
        #else
            .modifier(ChatScrollCommandModifier(
                command: self.$scrollCommand,
                currentSessionTarget: { self.viewModel.currentSessionTarget }))
        #endif
        // Ensure the message list claims vertical space on the first layout pass.
        .frame(maxHeight: .infinity, alignment: .top)
        .layoutPriority(1)
        .simultaneousGesture(
            TapGesture().onEnded {
                self.dismissKeyboardIfNeeded()
            })
        .onChange(of: self.viewModel.isLoading) { _, isLoading in
            guard !isLoading, !self.hasPerformedInitialScroll else { return }
            self.restoreInitialScrollPosition()
            self.hasPerformedInitialScroll = true
            self.lastTurnStartID = self.latestVisibleTurnStartID
        }
        .onChange(of: self.viewModel.currentSessionTarget) { _, _ in
            self.resetTranscriptSession()
        }
        .onChange(of: self.scenePhase) { _, newValue in
            if newValue == .background {
                self.speech?.stop()
            }
            guard newValue == .active else { return }
            self.viewModel.resumeFromForeground()
        }
        .onDisappear {
            self.isOnScreen = false
            self.viewModel.setComposerPresentationActive(false)
            self.speech?.stop()
            self.scrollCommand.cancel()
        }
        #if os(iOS)
        .onChange(of: self.viewModel.localSendRevision) { _, _ in
            guard self.hasPerformedInitialScroll, self.searchMessageID == nil else { return }
            self.readerHistorySnapshot = nil
            self.scroll.hasNewerContentBelow = false
            // The reading position moves once the new rows lay out.
            if self.isKeyboardVisible {
                self.scroll.followTarget = .latest
            } else if let turnID = self.latestVisibleTurnStartID {
                self.scroll.followTarget = .turn(turnID)
                self.moveScrollPosition(to: turnID, anchor: Layout.newTurnAnchor)
            }
        }
        #endif
        .onChange(of: self.viewModel.timelineRevision) { _, _ in
            self.handleTimelineChange()
        }
        #if canImport(UIKit) && !os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillChangeFrameNotification)) { _ in
            self.scroll.isKeyboardTransitioning = true
            self.scroll.readingPosition.keyboardFrameChanged()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidChangeFrameNotification)) { _ in
            self.scroll.isKeyboardTransitioning = false
            self.scroll.readingPosition.keyboardFrameChanged()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            self.isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            self.isKeyboardVisible = false
        }
        #endif
    }

    private func resetTranscriptSession() {
        #if os(iOS)
        self.readerHistorySnapshot = nil
        self.olderHistory.reset()
        self.scroll.isKeyboardTransitioning = false
        self.scroll.readingPosition.reset()
        #endif
        self.speech?.stop()
        self.scrollCommand.cancel()
        self.hasPerformedInitialScroll = false
        self.scroll.followTarget = .latest
        self.scroll.isAtLiveEdge = true
        self.scroll.isUserScrolling = false
        self.scroll.hasNewerContentBelow = false
        self.lastTurnStartID = nil
    }

    #if os(iOS)
    /// Older page from the reader's top sentinel or the retry row; the reading position stays put.
    private func loadOlderHistory() {
        self.olderHistory.load(self.viewModel, readingPosition: self.scroll.readingPosition)
    }
    #endif

    private func handleTranscriptScrollPhase(_ phase: ScrollPhase) {
        guard self.hasPerformedInitialScroll else { return }
        #if os(iOS)
        let keyboardTransition = self.scroll.isKeyboardTransitioning
        #else
        let keyboardTransition = false
        #endif
        if chatReaderScrollReleasesFollow(phase, keyboardTransition: keyboardTransition) {
            #if os(iOS)
            if self.readerHistorySnapshot == nil {
                self.readerHistorySnapshot = ChatReaderHistorySnapshot(
                    messages: self.viewModel.transcriptMessages,
                    deletionRevision: self.viewModel.readerHistoryDeletionRevision)
            }
            #endif
            self.scrollCommand.cancel()
            self.scroll.isUserScrolling = true
            self.scroll.followTarget = nil
        } else if phase == .idle, self.scroll.isUserScrolling {
            self.scroll.isUserScrolling = false
            if self.scroll.isAtLiveEdge {
                self.scroll.followTarget = .latest
                self.scroll.hasNewerContentBelow = false
                #if os(iOS)
                self.readerHistorySnapshot = nil
                #endif
            } else {
                self.scroll.hasNewerContentBelow = true
                #if os(iOS)
                self.scroll.readingPosition.readerSettled()
                #endif
            }
        }
    }

    /// Keep one grouping owner per platform so new turns do not recreate disclosure state.
    private func transcriptGroups(transcript: TranscriptPresentation, hasVisibleContent: Bool) -> some View {
        self.messageListRows(
            transcript: transcript,
            groups: self.runGroups(transcript)[...],
            hasVisibleContent: hasVisibleContent)
    }

    private func runGroups(_ transcript: TranscriptPresentation) -> [ChatAssistantRunGroup] {
        let liveRunIDs = Set(self.viewModel.liveAdvertisedRunIDs).union(self.viewModel.liveLocalRunIDs)
        return ChatAssistantRunGroup.build(
            transcript.rows,
            tools: self.displayOptions.contains(.toolActivity) ? self.viewModel.toolActivities : [],
            liveRunID: liveRunIDs.count == 1 ? liveRunIDs.first : nil,
            hasLiveContent: self.showsWorkingIndicator || self.hasVisibleStreamingAssistantText,
            searchActive: self.isSearchPresented)
    }

    @ViewBuilder
    private func messageListRows(
        transcript: TranscriptPresentation,
        groups shownGroups: ArraySlice<ChatAssistantRunGroup>,
        hasVisibleContent: Bool) -> some View
    {
        let inputs = self.rowPassInputs
        if let introText = visibleEmptyAssistantIntro {
            ChatAssistantIntroCard(
                text: introText,
                prompts: self.emptyAssistantPrompts,
                onPrompt: { prompt in
                    let model: OpenClawChatViewModel? = if let resolveComposerModel {
                        resolveComposerModel()
                    } else {
                        self.viewModel
                    }
                    model?.input = prompt.prompt
                    model?.send()
                })
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if self.showsCleanLoadingPlaceholder(hasVisibleContent: hasVisibleContent) {
            ChatLoadingBubble()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        #if os(iOS)
        ForEach(ChatAssistantListCell.cells(shownGroups)) { cell in
            Group {
                if cell.group.runID != nil {
                    ChatAssistantRunFrame(
                        showsAssistantAvatar: self.showsAssistantAvatars,
                        joinsAbove: cell.joinsAbove,
                        joinsBelow: cell.joinsBelow)
                    {
                        self.listCellContent(cell, transcript: transcript, inputs: inputs)
                    }
                } else {
                    self.listCellContent(cell, transcript: transcript, inputs: inputs)
                }
            }
            .padding(.top, cell.joinsAbove ? 0 : Layout.messageSpacing / 2)
            .padding(.bottom, cell.joinsBelow ? 0 : Layout.messageSpacing / 2)
            .background(ChatReadingRowMarker(key: ChatReadingRowKey(cell), owner: self.scroll.readingPosition))
            .environment(\.openClawReadingAnswerRun, ChatReadingRowKey(cell).answerRun)
        }
        #else
        self.groupRows(shownGroups, transcript: transcript)
        #endif
        OpenClawQuestionCards(viewModel: self.viewModel)
    }

    private func groupRows(
        _ groups: ArraySlice<ChatAssistantRunGroup>,
        transcript: TranscriptPresentation) -> some View
    {
        let inputs = self.rowPassInputs
        return ForEach(groups) { group in
            let parts = ForEach(group.parts) { part in
                self.runPart(
                    part,
                    metadata: transcript.metadata,
                    inputs: inputs,
                    isGrouped: group.runID != nil,
                    answerID: group.runID == nil ? nil : group.answerID)
            }
            if group.runID != nil {
                ChatAssistantRunFrame(showsAssistantAvatar: self.showsAssistantAvatars) {
                    parts
                    if group.includesLive { self.liveAssistantContent }
                }
            } else {
                parts
                if group.includesLive { self.liveAssistantContent }
            }
        }
    }

    #if os(iOS)
    @ViewBuilder
    private func listCellContent(
        _ cell: ChatAssistantListCell,
        transcript: TranscriptPresentation,
        inputs: ChatRowPassInputs) -> some View
    {
        if let part = cell.part {
            self.runPart(
                part,
                metadata: transcript.metadata,
                inputs: inputs,
                isGrouped: cell.group.runID != nil,
                answerID: cell.group.answerID)
        } else {
            self.liveAssistantContent
        }
    }
    #endif

    @ViewBuilder
    private func runPart(
        _ part: ChatAssistantRunGroup.Part,
        metadata: [UUID: ChatMessageMetadata],
        inputs: ChatRowPassInputs,
        isGrouped: Bool,
        answerID: UUID?) -> some View
    {
        switch part {
        case let .row(row):
            self.transcriptRow(
                row,
                metadata: metadata,
                inputs: inputs,
                isGrouped: isGrouped,
                answerID: answerID)
                .id(row.id)
                .chatBehaviorProbe(.row(row))
        case let .tool(tool):
            ChatToolActivityList(items: [ChatToolActivityItem(live: tool)])
                .padding(.vertical, 4)
        }
    }

    @ViewBuilder
    private func transcriptRow(
        _ row: ChatTranscriptRow,
        metadata: [UUID: ChatMessageMetadata],
        inputs: ChatRowPassInputs,
        isGrouped: Bool,
        answerID: UUID?) -> some View
    {
        switch row {
        case let .message(message):
            self.messageRow(
                for: message,
                metadata: message.presentationOwnsFooter ? metadata[message.id] : nil,
                inputs: inputs,
                showsActions: !isGrouped || message.presentationID == answerID)
                .background(
                    RoundedRectangle(cornerRadius: 12)
                        .fill(OpenClawChatTheme.accent.opacity(self.searchMessageID == message.id ? 0.08 : 0)))
                .overlay(
                    RoundedRectangle(cornerRadius: 12)
                        .strokeBorder(
                            OpenClawChatTheme.accent.opacity(self.searchMessageID == message.id ? 0.55 : 0),
                            lineWidth: 1))
        case let .systemNotice(notice):
            ChatSystemNoticeRow(notice: notice)
                .frame(maxWidth: .infinity)
        case let .historyDivider(divider):
            ChatHistoryDividerRow(divider: divider)
                .frame(maxWidth: .infinity)
        case let .completedWork(work):
            ChatCompletedWorkDisclosure(work: work) { message in
                self.messageRow(
                    for: message,
                    metadata: message.presentationOwnsFooter ? metadata[message.id] : nil,
                    inputs: inputs,
                    showsActions: !isGrouped)
            }
        }
    }

    @ViewBuilder
    private var liveAssistantContent: some View {
        // The transcript decides whether the bubble shows (from live-content shape), in the same
        // pass that adds the durable row replacing it. Deciding inside the bubble's own observation
        // scope removed it a layout pass early and collapsed the transcript for a frame.
        if self.hasVisibleStreamingAssistantText {
            ChatLiveAssistantText(viewModel: self.viewModel) { text in
                let preparedText = ChatStreamingAssistantText(
                    sourceText: text,
                    includesThinking: self.displayOptions.contains(.reasoning))
                if !preparedText.segments.isEmpty {
                    ChatStreamingAssistantBubble(
                        text: preparedText,
                        markdownVariant: self.markdownVariant,
                        showsAssistantAvatar: self.showsAssistantAvatars)
                        .equatable()
                        .frame(maxWidth: .infinity, alignment: .leading)
                        .chatBehaviorProbe(.live)
                }
            }
        }
        // Below the words, where the finished turn's recap appears: above them, its removal
        // shifted the whole reply up as the final row replaced the live bubble.
        ChatRunStatusContent {
            if self.showsWorkingIndicator {
                ChatTypingIndicatorBubble(
                    showsAssistantAvatar: self.showsAssistantAvatars,
                    runIdentity: self.viewModel.workingIndicatorIdentity,
                    outputTokens: self.viewModel.liveRunOutputTokens,
                    status: self.viewModel.runStartupStatus)
                    .equatable()
            }
        }
    }

    /// One value per view model. Its getters run in the leaf that calls them, so only media,
    /// widget and favicon views observe health and the source context.
    private var gatewayResources: ChatGatewayResources {
        ChatGatewayResources(
            owner: ObjectIdentifier(self.viewModel),
            isResolverReady: { [weak viewModel] in viewModel?.healthOK == true },
            faviconContext: { [weak viewModel] in
                viewModel?.sourcePreviewState.context.flatMap { $0.automaticallyFetchFavicons ? $0 : nil }
            },
            loadFavicon: { [weak viewModel] host in
                await viewModel?.transport.loadSourceFavicon(host: host)
            },
            resolveWidgetResource: { [weak viewModel] path, failedResource in
                await viewModel?.transport.resolveInlineWidgetResource(path: path, replacing: failedResource)
            },
            loadMedia: { [weak viewModel] artifactId, kind, playback in
                guard let viewModel else { return nil }
                return try await viewModel.transport.loadMediaArtifact(
                    sessionKey: viewModel.sessionKey,
                    artifactId: artifactId,
                    kind: kind,
                    playback: playback)
            })
    }

    private var rowPassInputs: ChatRowPassInputs {
        // Hidden tool activity never draws, so live tool updates must not reach the rows.
        let calls = self.displayOptions.contains(.toolActivity) ? self.viewModel.toolActivities : []
        return ChatRowPassInputs(
            contextWindowTokens: self.viewModel.contextUsage?.contextWindowTokens,
            liveToolCalls: ChatRowPassInputs.liveToolCallsByRun(calls))
    }

    @ViewBuilder
    private func messageRow(
        for msg: OpenClawChatMessage,
        metadata: ChatMessageMetadata?,
        inputs: ChatRowPassInputs,
        showsActions: Bool = true) -> some View
    {
        let actionMessage = msg.presentationBlockIndex == nil ? msg :
            self.viewModel.transcriptMessages.first(where: { $0.id == msg.id }) ?? msg
        let isUser = msg.role.lowercased() == "user"
        let bubble = ChatMessageBubble(
            message: msg,
            liveToolCalls: msg.workRunID.flatMap { inputs.liveToolCalls[$0] } ?? [],
            metadata: metadata,
            sourcePreviews: self.viewModel.sourcePreviews(for: msg),
            style: self.style,
            markdownVariant: self.markdownVariant,
            displayOptions: self.displayOptions,
            showsAssistantAvatar: self.showsAssistantAvatars,
            contextWindowTokens: inputs.contextWindowTokens,
            userMessageExpanded: self.expandedUserMessageIDs.contains(msg.id),
            onToggleUserMessageExpanded: {
                if self.expandedUserMessageIDs.contains(msg.id) {
                    self.expandedUserMessageIDs.remove(msg.id)
                } else {
                    self.expandedUserMessageIDs.insert(msg.id)
                }
            },
            inlineWidgetScope: ChatInlineWidgetScope(
                modelID: ObjectIdentifier(self.viewModel),
                sessionTarget: self.viewModel.currentSessionTarget,
                sessionGeneration: self.viewModel.sessionGeneration),
            mediaPlaybackAllowed: self.mediaPlaybackAllowed)
        let row = VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
            Group {
                #if os(iOS)
                // Streaming revisions invalidate the transcript container. Keep completed
                // iPhone bubbles out of that hot path unless their render inputs changed.
                if bubble.canUseIOSRenderGate {
                    bubble.equatable()
                } else {
                    bubble
                }
                #else
                bubble
                #endif
            }
            .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
            if msg.presentationOwnsFooter {
                ChatMessageReactions(viewModel: self.viewModel, message: msg)
            }
            if let outboxState = self.viewModel.outboxState(for: msg.id) {
                ChatOutboxStatusLabel(state: outboxState, queueMode: self.viewModel.outboxQueueMode(for: msg.id))
                    .padding(.trailing, 8)
            }
            if msg.presentationOwnsFooter, let speech = self.speech,
               let isPreparing = self.speechChipIsPreparing(speech, messageID: msg.id)
            {
                ChatSpeechStatusChip(isPreparing: isPreparing) { speech.stop() }
                    .padding(.leading, 8)
            }
            #if os(macOS)
            if self.isDesktopLayout, showsActions, isUser || self.isListenable(msg) {
                HStack(spacing: 12) {
                    self.copyMessageButton(for: actionMessage)
                        .help("Copy message")
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                    self.replyMessageButton(for: actionMessage)
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                    self.listenMessageButton(for: actionMessage)
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                    self.messageActionsMenu(for: actionMessage)
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                }
                .labelStyle(.iconOnly)
                .buttonStyle(.borderless)
                .font(OpenClawChatTypography.caption)
                .foregroundStyle(.secondary)
                .padding(.horizontal, 8)
                .padding(.bottom, 8)
                .accessibilityElement(children: .contain)
            }
            #endif
        }
        .frame(maxWidth: .infinity, alignment: isUser ? .trailing : .leading)
        .onHover { hovering in
            if hovering {
                self.hoveredMessageID = msg.id
            } else if self.hoveredMessageID == msg.id {
                self.hoveredMessageID = nil
            }
        }
        row.contextMenu { ChatDeferredContent { self.messageMenuActions(for: actionMessage) } }
    }

    private func messageActionsMenu(for message: OpenClawChatMessage) -> some View {
        Menu {
            ChatDeferredContent { self.messageMenuActions(for: message) }
        } label: {
            Label("Message Actions", systemImage: "ellipsis")
        }
        .menuIndicator(.hidden)
        .accessibilityIdentifier("chat-message-actions")
    }

    @ViewBuilder
    private func messageMenuActions(for message: OpenClawChatMessage) -> some View {
        ChatMessageReactionAction(viewModel: self.viewModel, message: message) {
            self.reactionPickerMessage = message
        }
        self.copyMessageButton(for: message)
        #if os(iOS)
        self.selectTextButton(for: message)
        #endif
        self.replyMessageButton(for: message)
        self.openFullMessageButton(for: message)
        self.messageSessionActions(for: message)
        self.listenMessageButton(for: message)
        if let outboxState = self.viewModel.outboxState(for: message.id) {
            ChatOutboxMessageActions(viewModel: self.viewModel, messageID: message.id, state: outboxState) {
                self.composerFocusRequest += 1
            }
        }
    }

    @ViewBuilder
    private func listenMessageButton(for message: OpenClawChatMessage) -> some View {
        if let speech = self.speech, self.isListenable(message) {
            Button {
                speech.toggle(messageID: message.id, text: ChatMessageVisibleText.visibleText(in: message))
            } label: {
                Label(
                    speech.isActive(message.id) ? "Stop Listening" : "Listen",
                    systemImage: speech.isActive(message.id) ? "stop.circle" : "speaker.wave.2")
            }
            .help(speech.isActive(message.id) ? "Stop listening" : "Listen")
        }
    }

    private func isListenable(_ msg: OpenClawChatMessage) -> Bool {
        msg.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() == "assistant"
            && ChatMessageVisibleText.hasVisibleText(in: msg)
    }

    private func speechChipIsPreparing(
        _ speech: OpenClawChatSpeechController,
        messageID: UUID) -> Bool?
    {
        switch speech.phase {
        case let .preparing(id) where id == messageID:
            true
        case let .speaking(id) where id == messageID:
            false
        default:
            nil
        }
    }

    private struct TranscriptPresentation {
        let rows: [ChatTranscriptRow]
        let metadata: [UUID: ChatMessageMetadata]
    }

    private var readerPresentationMessages: [OpenClawChatMessage] {
        let current = self.viewModel.transcriptMessages
        #if os(iOS)
        if let snapshot = self.readerHistorySnapshot {
            return snapshot.presentation(
                current: current, deletionRevision: self.viewModel.readerHistoryDeletionRevision)
        }
        #endif
        return current
    }

    private var transcriptPresentation: TranscriptPresentation {
        let messages = self.readerPresentationMessages
        let base: [OpenClawChatMessage]
        if self.style == .onboarding {
            guard let first = messages.first else { return TranscriptPresentation(rows: [], metadata: [:]) }
            base = first.role.lowercased() == "user" ? Array(messages.dropFirst()) : messages
        } else {
            base = messages
        }
        var rows = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: base))
        let runWorking = self.viewModel.hasBlockingRunActivity || self.viewModel.hasStreamingAssistantText
        let activeRunIDs = Set(self.viewModel.liveAdvertisedRunIDs).union(self.viewModel.liveLocalRunIDs)
        // One duration map serves the reply footers and the "Worked for" summaries.
        let runDurations = ChatTranscriptRow.runDurations(in: rows, activeRunIDs: activeRunIDs)
        // Footers and visible rows share the merged, onboarding-trimmed input, before work moves into disclosures.
        let metadata = ChatTranscriptRow.footerMetadata(
            in: rows,
            activeRunIDs: activeRunIDs,
            runWorking: runWorking,
            runDurations: runDurations,
            isMessageVisible: self.shouldDisplayMessage)
        if self.collapsesCompletedWork {
            rows = ChatTranscriptRow.collapseCompletedWork(
                rows,
                runWorking: runWorking,
                activeRunIDs: activeRunIDs,
                searchActive: self.isSearchPresented,
                runDurations: runDurations)
        }
        rows = rows.compactMap { row in
            switch row {
            case let .message(message):
                return self.shouldDisplayMessage(message) ? row : nil
            case let .completedWork(work):
                let visible = work.messages.filter(self.shouldDisplayMessage)
                return visible.isEmpty ? nil : .completedWork(work.replacingMessages(visible))
            default:
                return row
            }
        }
        return TranscriptPresentation(rows: rows, metadata: metadata)
    }

    private var latestVisibleTurnStartID: UUID? {
        self.transcriptPresentation.rows.last(where: \.startsTurn)?.id
    }

    private var isFollowingTurn: Bool {
        if case .turn = self.scroll.followTarget {
            return true
        }
        return false
    }

    private var jumpToLatestButton: some View {
        Button {
            self.isSearchPresented = false
            self.searchMessageID = nil
            self.scroll.followTarget = .latest
            self.scroll.hasNewerContentBelow = false
            #if os(iOS)
            self.readerHistorySnapshot = nil
            self.scroll.isUserScrolling = false
            self.scroll.readingPosition.jumpToLatest()
            #else
            self.moveScrollPosition(to: self.scrollerBottomID)
            #endif
        } label: {
            Image(systemName: "arrow.down")
                .font(.system(size: 15, weight: .semibold))
                .frame(width: 36, height: 36)
                .background(
                    Circle()
                        .fill(OpenClawChatTheme.subtleCard)
                        .shadow(color: .black.opacity(0.16), radius: 8, y: 3))
                // Padding keeps a ~44pt tap target around the compact visual circle.
                .padding(4)
                .contentShape(Circle())
        }
        .buttonStyle(.plain)
        .foregroundStyle(OpenClawChatTheme.assistantText)
        .accessibilityLabel("Jump to latest reply")
    }

    @ViewBuilder
    private func messageListOverlay(hasVisibleContent: Bool) -> some View {
        if !self.viewModel.isLoading, self.visibleEmptyAssistantIntro == nil {
            if let error = activeErrorText {
                if !hasVisibleContent {
                    let presentation = self.errorPresentation(for: error)
                    ChatNoticeCard(
                        systemImage: presentation.systemImage,
                        title: presentation.title,
                        message: presentation.message,
                        actionTitle: "Refresh",
                        action: { self.viewModel.refresh() })
                        .padding(.horizontal, 24)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            } else if self.showsEmptyState {
                ChatNoticeCard(
                    systemImage: "bubble.left.and.bubble.right.fill",
                    title: self.emptyStateTitle,
                    message: self.emptyStateMessage,
                    actionTitle: nil,
                    action: nil)
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var activeErrorText: String? {
        let showsContextualSignIn = self.showsComposer && self.isDesktopLayout && self.composerChrome == .clean
        let activeError = showsContextualSignIn
            ? self.viewModel.errorText
            : self.viewModel.composerModelAvailabilityMessage ?? self.viewModel.errorText
        return ChatPayloadDecoding.trimmedNonEmptyString(activeError)
    }

    private var hasVisibleStreamingAssistantText: Bool {
        guard let text = self.viewModel.liveAssistantTextShape else { return false }
        return AssistantTextParser.hasVisibleContent(
            in: text,
            includeThinking: self.displayOptions.contains(.reasoning))
    }

    private var showsWorkingIndicator: Bool {
        self.viewModel.hasBlockingRunActivity &&
            (!self.hasVisibleStreamingAssistantText || self.viewModel.liveUsageRunID != nil)
    }

    private var turnRecapObservation: ChatTurnRecapObservation {
        let row = self.viewModel.currentSessionEntry().map(ChatTurnRecapSessionRow.init)
        return ChatTurnRecapObservation(
            sessionKey: self.viewModel.sessionKey,
            indicatorVisible: self.showsWorkingIndicator,
            row: row)
    }

    private func updateTurnRecap(_ observation: ChatTurnRecapObservation) {
        var resolver = self.turnRecapResolver
        let recap = resolver.resolve(
            sessionKey: observation.sessionKey,
            indicatorVisible: observation.indicatorVisible,
            row: observation.row)
        self.turnRecapResolver = resolver
        self.turnRecap = recap
        self.turnRecapSessionKey = recap == nil ? nil : observation.sessionKey
    }

    private var hasVisibleTransientContent: Bool {
        self.viewModel.hasBlockingRunActivity ||
            (self.displayOptions.contains(.toolActivity) && !self.viewModel.pendingToolCalls.isEmpty) ||
            self.hasVisibleStreamingAssistantText ||
            !self.viewModel.visibleQuestionCards.isEmpty
    }

    @ViewBuilder
    private func messageListNoticeBanner(hasVisibleContent: Bool) -> some View {
        if let error = activeErrorText,
           hasVisibleContent,
           !self.viewModel.isLoading,
           visibleEmptyAssistantIntro == nil
        {
            let presentation = self.errorPresentation(for: error)
            ChatNoticeBanner(
                systemImage: presentation.systemImage,
                title: presentation.title,
                message: error,
                tint: presentation.tint,
                dismiss: { self.viewModel.errorText = nil },
                refresh: { self.viewModel.refresh() })
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .padding(.bottom, 8)
        }
    }

    private func showsCleanLoadingPlaceholder(hasVisibleContent: Bool) -> Bool {
        self.composerChrome == .clean &&
            self.viewModel.isLoading &&
            self.visibleEmptyAssistantIntro == nil &&
            self.activeErrorText == nil &&
            !hasVisibleContent
    }

    private var visibleEmptyAssistantIntro: String? {
        guard self.composerChrome == .clean,
              self.showsEmptyState,
              !self.viewModel.isLoading,
              self.activeErrorText == nil,
              self.isComposerEnabled
        else {
            return nil
        }
        return ChatPayloadDecoding.trimmedNonEmptyString(self.emptyAssistantIntro)
    }

    private var showsEmptyState: Bool {
        self.viewModel.messages.isEmpty &&
            !self.hasVisibleStreamingAssistantText &&
            !self.viewModel.hasBlockingRunActivity &&
            self.viewModel.pendingToolCalls.isEmpty
    }

    private var emptyStateTitle: String {
        #if os(macOS)
        "Start a Conversation"
        #else
        "Chat"
        #endif
    }

    private var emptyStateMessage: String {
        #if os(macOS)
        "Message your agent to get started.\nReturn sends • Shift-Return adds a line break • / shows commands."
        #else
        "Type a message below to start."
        #endif
    }
}

extension OpenClawChatView {
    private func errorPresentation(
        for error: String) -> (title: String, message: String, systemImage: String, tint: Color)
    {
        let lower = error.lowercased()
        if lower.contains("not connected") || lower.contains("socket") {
            return ("Disconnected", "Reconnect to your gateway to continue.", "wifi.slash", .orange)
        }
        if lower.contains("timed out") {
            return ("Timed out", "The gateway took too long to respond.", "clock.badge.exclamationmark", .orange)
        }
        // Unknown errors: keep the raw text as the description so it stays actionable.
        return ("Something went wrong", error, "exclamationmark.triangle.fill", .orange)
    }

    private func restoreInitialScrollPosition() {
        if chatReaderInitialRestorePolicy() == .latestTurn,
           let latestTurnStartID = self.latestVisibleTurnStartID
        {
            self.scroll.followTarget = nil
            self.scroll.hasNewerContentBelow = chatReaderHasNewerContent(
                after: latestTurnStartID,
                visibleIDs: self.transcriptPresentation.rows.map(\.id),
                hasTransientContent: self.hasVisibleTransientContent)
            #if !os(iOS)
            self.moveScrollPosition(to: latestTurnStartID, anchor: Layout.newTurnAnchor)
            #endif
        } else {
            // iOS: the reading position pins the bottom once the first page lays out.
            self.scroll.followTarget = .latest
            self.scroll.hasNewerContentBelow = false
            #if !os(iOS)
            self.moveScrollPosition(to: self.scrollerBottomID)
            #endif
        }
    }

    private func handleTimelineChange() {
        guard self.hasPerformedInitialScroll else {
            // A chat's cached or live rows paint while the rest of its load (sessions, models,
            // health) is still running. Hold them at the initial position instead of the top;
            // the load's completion still settles it.
            #if !os(iOS)
            if !self.viewModel.messages.isEmpty { self.restoreInitialScrollPosition() }
            #endif
            return
        }
        // A search result is an explicit reading position. Incoming replies
        // must not pull the reader away until they leave Find.
        guard self.searchMessageID == nil else { return }
        if self.viewModel.messages.isEmpty,
           !self.viewModel.hasBlockingRunActivity,
           self.viewModel.pendingToolCalls.isEmpty,
           !self.viewModel.hasStreamingAssistantText
        {
            self.lastTurnStartID = nil
            self.scroll.followTarget = .latest
            self.scroll.hasNewerContentBelow = false
            #if os(iOS)
            self.readerHistorySnapshot = nil
            #else
            self.moveScrollPosition(to: self.scrollerBottomID)
            #endif
            return
        }
        let transcriptRows = self.transcriptPresentation.rows
        let visibleTurnStartIDs = transcriptRows.compactMap { $0.startsTurn ? $0.id : nil }
        switch chatReaderUserTransition(
            previousID: self.lastTurnStartID,
            visibleIDs: visibleTurnStartIDs)
        {
        case let .removed(latestRemainingID):
            self.scrollCommand.cancel(targetID: self.lastTurnStartID)
            self.lastTurnStartID = latestRemainingID
            if case let .turn(messageID) = self.scroll.followTarget,
               !visibleTurnStartIDs.contains(messageID)
            {
                self.scroll.followTarget = nil
                self.scroll.hasNewerContentBelow = false
            }
            return
        case let .added(latestTurnStartID):
            self.lastTurnStartID = latestTurnStartID
            #if !os(iOS)
            self.scroll.hasNewerContentBelow = false
            // The anchored-question layout assumes a viewport tall enough to read the turn
            // below the anchor. With the keyboard up that space is gone and the reply streams
            // straight past the fold (#108692), so follow the live edge instead.
            if self.isKeyboardVisible {
                self.scroll.followTarget = .latest
                self.moveScrollPosition(to: self.scrollerBottomID)
            } else {
                self.scroll.followTarget = .turn(latestTurnStartID)
                self.moveScrollPosition(to: latestTurnStartID, anchor: Layout.newTurnAnchor)
            }
            return
            #endif
        case .unchanged:
            break
        }

        switch self.scroll.followTarget {
        case .latest:
            self.scroll.hasNewerContentBelow = false
            #if !os(iOS)
            self.moveScrollPosition(to: self.scrollerBottomID)
            #endif
        case let .turn(messageID):
            // Reader policy stays on this turn after the one-shot scroll command completes. Reissuing
            // that target for every streaming delta can loop SwiftUI layout and starve interaction.
            self.scroll.hasNewerContentBelow = chatReaderHasNewerContent(
                after: messageID,
                visibleIDs: transcriptRows.map(\.id),
                hasTransientContent: self.hasVisibleTransientContent)
        case nil:
            self.scroll.hasNewerContentBelow = true
        }
    }

    private func moveScrollPosition(
        to id: UUID,
        anchor: UnitPoint = .bottom)
    {
        // Explicit initial/jump/new-user-turn navigation must realize a recycled target.
        // Streaming does not enqueue commands; the follow anchor owns continuous following.
        self.scrollCommand.enqueue(
            to: id,
            anchor: anchor,
            sessionTarget: self.viewModel.currentSessionTarget)
    }

    #if !os(iOS)
    private func revealSearchMessage(_ messageID: UUID) {
        self.scroll.followTarget = nil
        self.scroll.hasNewerContentBelow = true
        self.expandedUserMessageIDs.insert(messageID)
        self.moveScrollPosition(to: messageID, anchor: .top)
    }
    #endif

    private func dismissKeyboardIfNeeded() {
        #if canImport(UIKit)
        UIApplication.shared.sendAction(
            #selector(UIResponder.resignFirstResponder),
            to: nil,
            from: nil,
            for: nil)
        #endif
    }

    private func shouldDisplayMessage(_ message: OpenClawChatMessage) -> Bool {
        let primaryText = ChatMessageVisibleText.displayText(
            in: message,
            includeThinking: self.displayOptions.contains(.reasoning))
        if message.content.contains(where: \.isInlineAttachment) {
            return true
        }

        if message.isToolResult {
            return self.displayOptions.contains(.toolActivity) && message.hasDisplayableToolActivity
        }

        if !primaryText.isEmpty {
            if message.role.lowercased() == "user" {
                return true
            }
            if AssistantTextParser.hasVisibleContent(
                in: primaryText,
                includeThinking: self.displayOptions.contains(.reasoning))
            {
                return true
            }
        }

        return self.displayOptions.contains(.toolActivity) && message.hasDisplayableToolActivity
    }

    @ViewBuilder
    private func copyMessageButton(for message: OpenClawChatMessage) -> some View {
        let text = ChatMessageVisibleText.copyText(in: message)
        if !text.isEmpty {
            Button {
                ChatPasteboard.copy(text)
            } label: {
                chatActionLabel(Text("Copy Message"), systemImage: "doc.on.doc")
            }
        }
    }

    #if os(iOS)
    @ViewBuilder
    private func selectTextButton(for message: OpenClawChatMessage) -> some View {
        if !ChatMessageVisibleText.copyText(in: message).isEmpty {
            Button {
                self.selectTextMessage = message
            } label: {
                chatActionLabel(Text("Select Text"), systemImage: "text.cursor")
            }
        }
    }
    #endif

    @ViewBuilder
    private func openFullMessageButton(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if role == "assistant",
           message.isTruncated,
           let messageID = message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines),
           !messageID.isEmpty
        {
            Button {
                self.fullMessageRequest = ChatFullMessageReaderRequest(
                    viewModel: self.viewModel,
                    messageID: messageID)
            } label: {
                chatActionLabel(Text("Open Full Message"), systemImage: "doc.text.magnifyingglass")
            }
        }
    }

    @ViewBuilder
    private func messageSessionActions(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        if self.showsComposer, role == "user",
           message.transcriptMessageID?.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty == false
        {
            Button {
                Task { await self.viewModel.rewindToMessage(message) }
            } label: {
                chatActionLabel(Text("Rewind to Here"), systemImage: "arrow.uturn.backward")
            }
            .disabled(!self.viewModel.canPerformMessageSessionAction)

            Button {
                Task { await self.viewModel.forkAtMessage(message) }
            } label: {
                chatActionLabel(Text("Fork from Here"), systemImage: "arrow.triangle.branch")
            }
            .disabled(!self.viewModel.canPerformMessageSessionAction)
        }
    }

    @ViewBuilder
    private func replyMessageButton(for message: OpenClawChatMessage) -> some View {
        let role = message.role.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let text = ChatReplyQuote.targetText(ChatMessageVisibleText.visibleText(in: message))
        if self.showsComposer, role == "user" || role == "assistant", !text.isEmpty {
            Button {
                self.viewModel.setReplyTarget(
                    messageID: message.id,
                    text: text,
                    senderLabel: self.replySenderLabel(forRole: role))
            } label: {
                chatActionLabel(Text(String(localized: "Reply")), systemImage: "arrowshape.turn.up.left")
            }
        }
    }

    private func replySenderLabel(forRole role: String) -> String {
        guard role == "assistant" else { return String(localized: "You") }
        let name = self.assistantName?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return name.isEmpty ? String(localized: "Assistant") : name
    }
}

extension OpenClawChatView {
    /// Measure the detail pane, not the screen: a visible sidebar and window resizing
    /// change the space available to chat independently of device orientation.
    private var columnLayout: ChatColumnLayout {
        ChatColumnLayout(paneWidth: self.contentWidth)
    }
}

/// The one width rule of the chat pane: a margin and a centred reading column derived from the
/// measured pane width, shared by transcript rows, cards and the composer.
struct ChatColumnLayout: Equatable {
    static let maxColumnWidth: CGFloat = 768

    let margin: CGFloat
    let columnWidth: CGFloat

    /// An unmeasured pane (width 0, before its first layout) assumes the widest column.
    init(paneWidth: CGFloat) {
        let width = paneWidth > 0 ? paneWidth : .infinity
        self.margin = width < 700 ? 16 : 24
        self.columnWidth = max(0, min(Self.maxColumnWidth, width - 2 * self.margin))
    }

    /// Phone columns give a long user message most of the line; wide ones keep a short measure.
    var userBubbleMaxWidth: CGFloat {
        (self.columnWidth < 600 ? 0.82 : 0.68) * self.columnWidth
    }
}

extension EnvironmentValues {
    @Entry var openClawChatColumn = ChatColumnLayout(paneWidth: 0)
}

/// Row inputs read from the view model once per transcript pass, not once per row.
struct ChatRowPassInputs {
    let contextWindowTokens: Int?
    /// Each row looks up its own run instead of filtering every live call.
    let liveToolCalls: [String: [OpenClawChatPendingToolCall]]

    static func liveToolCallsByRun(_ calls: [OpenClawChatPendingToolCall]) -> [String: [OpenClawChatPendingToolCall]] {
        var byRun: [String: [OpenClawChatPendingToolCall]] = [:]
        for call in calls {
            guard let runID = call.runID else { continue }
            byRun[runID, default: []].append(call)
        }
        return byRun
    }
}

/// Applies drawer and scene visibility to the model. It reads `openClawChatIsObscured` itself, so
/// opening or closing the sidebar drawer updates stream pacing and composer presentation without
/// re-running the transcript.
private struct ChatPresentationActivity: ViewModifier {
    let viewModel: OpenClawChatViewModel
    let isOnScreen: Bool
    @Environment(\.openClawChatIsObscured) private var isObscured
    #if os(macOS)
    @Environment(\.appearsActive) private var appearsActive
    #else
    @Environment(\.scenePhase) private var scenePhase
    #endif

    /// A rejected message returns to the composer only while the user can see it.
    private var isComposerPresentationActive: Bool {
        #if os(macOS)
        self.isOnScreen && self.appearsActive && !self.isObscured
        #else
        self.isOnScreen && self.scenePhase == .active && !self.isObscured
        #endif
    }

    func body(content: Content) -> some View {
        content
            .onChange(of: ObjectIdentifier(self.viewModel)) { _, _ in
                self.viewModel.streamPacing.interval = self.isObscured ? 0.5 : 0.15
                self.viewModel.setComposerPresentationActive(self.isComposerPresentationActive)
            }
            .onChange(of: self.isComposerPresentationActive, initial: true) { _, active in
                self.viewModel.setComposerPresentationActive(active)
            }
            .onChange(of: self.isObscured, initial: true) { _, obscured in
                self.viewModel.streamPacing.interval = obscured ? 0.5 : 0.15
            }
    }
}

extension View {
    /// Centres content on the reading column. `inset` widens the frame for chrome that draws its
    /// visible surface that far inside it (the composer), so the surface itself spans the column.
    /// Padding by the margin, rather than framing to the measured column, never collapses the
    /// column while the pane is still unmeasured.
    func chatColumn(_ layout: ChatColumnLayout, inset: CGFloat = 0) -> some View {
        self.frame(maxWidth: ChatColumnLayout.maxColumnWidth + 2 * inset)
            .padding(.horizontal, layout.margin - inset)
            .frame(maxWidth: .infinity)
    }
}

/// Keep frequently changing run telemetry outside the transcript's observation scope.
private struct ChatRunStatusContent<Content: View>: View {
    @ViewBuilder var content: () -> Content

    var body: some View {
        self.content()
    }
}

/// Owns the observation of the paced words; its parent only observes live-content shape.
private struct ChatLiveAssistantText<Content: View>: View {
    let viewModel: OpenClawChatViewModel
    @ViewBuilder var content: (String) -> Content

    var body: some View {
        if let text = self.viewModel.displayedStreamingAssistantText {
            self.content(text)
        }
    }
}
