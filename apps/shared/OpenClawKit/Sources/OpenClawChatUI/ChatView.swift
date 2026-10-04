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

public struct OpenClawChatDisplayOptions: OptionSet, Sendable {
    public let rawValue: UInt8

    public init(rawValue: UInt8) {
        self.rawValue = rawValue
    }

    public static let reasoning = Self(rawValue: 1 << 0)
    public static let toolActivity = Self(rawValue: 1 << 1)
    public static let assistantTrace: Self = [.reasoning, .toolActivity]

    public static func assistantTrace(_ isVisible: Bool) -> Self {
        isVisible ? .assistantTrace : []
    }
}

@MainActor
public struct OpenClawChatView: View {
    public enum Style {
        case standard
        case onboarding
    }

    public enum ComposerChrome {
        case full
        case clean
    }

    public struct StarterPrompt: Hashable, Identifiable, Sendable {
        public let id: String
        public let title: String
        public let prompt: String

        public init(id: String, title: String, prompt: String) {
            self.id = id
            self.title = title
            self.prompt = prompt
        }
    }

    // The caller owns model lifetime; transport replacement can preserve presentation identity.
    private let viewModel: OpenClawChatViewModel
    private let resolveComposerModel: (@MainActor () -> OpenClawChatViewModel?)?
    @Environment(\.scenePhase) private var scenePhase
    @Environment(\.openClawChatDesktopLayout) private var isDesktopLayout
    @State private var contentWidth: CGFloat = 0
    @State private var scrollerBottomID = UUID()
    @State private var scrollCommand = ChatScrollCommand()
    @State private var scrollPosition = ScrollPosition(idType: UUID.self)
    @State private var historyScrollGeometry = ChatHistoryScrollGeometry()
    @State private var hasPerformedInitialScroll = false
    @State private var lastTurnStartID: UUID?
    @State private var lastLiveUserTurnRevision: UInt64 = 0
    @State private var hasNewerContentBelow = false
    @State private var followTarget: ScrollFollowTarget? = .latest
    @State private var isAtLiveEdge = true
    @State private var isUserScrolling = false
    @State private var isAtHistoryStart = false
    @State private var readerInteractionRevision: UInt64 = 0
    @State private var isKeyboardVisible = false
    @State private var hoveredMessageID: UUID?
    @State private var restoresLiveEdgeAfterKeyboardTransition = false
    @State private var expandedUserMessageIDs: Set<UUID> = []
    @State private var searchMessageID: UUID?
    @State private var isSearchPresented = false
    @State private var transcriptMemo = ChatTranscriptPresentationMemo()
    @State private var composerFocusRequest = 0
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
        static let eagerHistoryGroups = 8
        static let outerPaddingHorizontal: CGFloat = 6
        static let newTurnAnchor = UnitPoint(x: 0.5, y: 0.18)
        static let liveEdgeThreshold: CGFloat = 48
        #if os(macOS)
        static let outerPaddingVertical: CGFloat = 0
        static let composerPaddingHorizontal: CGFloat = 0
        static let swarmPaddingHorizontal: CGFloat = 12
        static let swarmPaddingVertical: CGFloat = 8
        static let stackSpacing: CGFloat = 0
        static let messageSpacing: CGFloat = 6
        static let messageListPaddingTop: CGFloat = 12
        static let messageListPaddingBottom: CGFloat = 16
        static let messageListPaddingHorizontal: CGFloat = 6
        #else
        static let outerPaddingVertical: CGFloat = 6
        static let composerPaddingHorizontal: CGFloat = 6
        static let swarmPaddingHorizontal: CGFloat = 6
        static let swarmPaddingVertical: CGFloat = 0
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 12
        static let messageListPaddingTop: CGFloat = 10
        static let messageListPaddingBottom: CGFloat = 6
        static let messageListPaddingHorizontal: CGFloat = 8
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
            self.viewModel.refreshSourceContext()
            if self.viewModel.bootstrapTask == nil { self.viewModel.load() }
        }
        .onChange(of: ObjectIdentifier(self.viewModel)) { _, _ in
            self.viewModel.refreshSourceContext()
        }
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
                    .padding(.horizontal, self.isTabletLayout ? 0 : Layout.outerPaddingHorizontal)
            if !self.usesInlineProgressCard {
                self.progressCard
                    .frame(maxWidth: self.readingColumnWidth)
                    .padding(.horizontal, self.composerHorizontalMargin)
                    .padding(.top, Layout.stackSpacing)
            }
            if self.showsComposer {
                self.turnRecapRow
                    .frame(maxWidth: self.readingColumnWidth)
            }
            self.swarmProgress
                .frame(maxWidth: self.readingColumnWidth)
                .padding(.horizontal, self.isTabletLayout ? self.tabletHorizontalMargin : Layout.swarmPaddingHorizontal)
                .padding(.vertical, Layout.swarmPaddingVertical)
                .padding(.top, Layout.stackSpacing)
            if self.showsComposer {
                self.composer
                    .frame(maxWidth: self.readingColumnWidth)
                    .padding(.horizontal, self.composerHorizontalMargin)
                    .padding(.top, Layout.stackSpacing)
                    .padding(.bottom, self.isTabletLayout || self.isDesktopLayout ? 12 : Layout.outerPaddingVertical)
            }
        }
        .padding(.top, Layout.outerPaddingVertical)
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onGeometryChange(for: CGFloat.self) { $0.size.width } action: { self.contentWidth = $0 }
        .environment(\.openClawAssistantUsesReadingColumn, self.isTabletLayout)
    }

    @ViewBuilder
    private var progressCard: some View {
        if let progressCard = self.viewModel.progressCard {
            ChatProgressCard(
                steps: progressCard.steps ?? [],
                markdown: progressCard.markdown,
                isInline: self.usesInlineProgressCard)
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

    @ViewBuilder
    private var turnRecapRow: some View {
        if !self.showsWorkingIndicator,
           self.turnRecapSessionKey == self.viewModel.sessionKey,
           let turnRecap
        {
            ChatTurnRecapRow(recap: turnRecap)
                .padding(.horizontal, Layout.outerPaddingHorizontal + Layout.messageListPaddingHorizontal)
                .padding(.vertical, 4)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private func messageList(transcript: ChatTranscriptPresentation) -> some View {
        let hasVisibleContent = !transcript.rows.isEmpty || self.hasVisibleTransientContent
        let liveRunIDs = Set(self.viewModel.liveAdvertisedRunIDs).union(self.viewModel.liveLocalRunIDs)
        let groups = ChatAssistantRunGroup.build(
            transcript.rows,
            tools: self.displayOptions.contains(.toolActivity) ? self.viewModel.toolActivities : [],
            liveRunID: liveRunIDs.count == 1 ? liveRunIDs.first : nil,
            hasLiveContent: self.showsWorkingIndicator || self.hasVisibleStreamingAssistantText,
            searchActive: self.isSearchPresented)
        let eagerStartIndex = ChatAssistantRunGroup.eagerHistoryStart(groups, warming: Layout.eagerHistoryGroups)
        return ZStack {
            ScrollView {
                // Native prepend preservation requires measured heights, not lazy estimates.
                VStack(spacing: self.isDesktopLayout ? 16 : Layout.messageSpacing) {
                    self.messageListHeader()
                    if eagerStartIndex > groups.startIndex {
                        self.messageListRows(groups: Array(groups[..<eagerStartIndex]), transcript: transcript)
                    }
                    VStack(spacing: self.isDesktopLayout ? 16 : Layout.messageSpacing) {
                        self.messageListRows(groups: Array(groups[eagerStartIndex...]), transcript: transcript)
                        OpenClawQuestionCards(viewModel: self.viewModel)
                        if self.usesInlineProgressCard { self.progressCard }
                        if !self.showsComposer, !self.viewModel.hasBlockingRunActivity { self.turnRecapRow }
                        Color.clear
                            #if os(macOS)
                                .frame(height: Layout.messageListPaddingBottom)
                            #else
                                .frame(height: Layout.messageListPaddingBottom + 1)
                            #endif
                            .id(self.scrollerBottomID)
                    }
                }
                .padding(.top, self.isDesktopLayout ? 24 : Layout.messageListPaddingTop)
                .frame(maxWidth: self.readingColumnWidth)
                .padding(
                    .horizontal,
                    self.isTabletLayout ? self.tabletHorizontalMargin :
                        (self.isDesktopLayout ? 16 : Layout.messageListPaddingHorizontal))
                .frame(maxWidth: .infinity)
                .coordinateSpace(name: self.historyScrollGeometry.contentSpace)
                #if os(iOS)
                .background(ChatNativePrependProbe(geometry: self.historyScrollGeometry))
                #endif
            }
            .scrollPosition(self.$scrollPosition)
            .accessibilityIdentifier("chat-transcript")
            #if !os(macOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            .safeAreaInset(edge: .top, spacing: 0) {
                self.messageListNoticeBanner(hasVisibleContent: hasVisibleContent)
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.visibleRect.minY <= 0
            } action: { _, isAtHistoryStart in
                self.isAtHistoryStart = isAtHistoryStart
                if isAtHistoryStart { self.loadEarlierHistoryIfNeeded() }
            }
            .onScrollGeometryChange(for: Bool.self) { geometry in
                geometry.contentSize.height - geometry.visibleRect.maxY <= Layout.liveEdgeThreshold
            } action: { _, isAtLiveEdge in
                self.isAtLiveEdge = isAtLiveEdge
                self.followOverflowingReplyIfNeeded()
            }
            .defaultScrollAnchor(
                self.followTarget == .latest && !self.isUserScrolling ? .bottom : nil,
                for: .sizeChanges)
            .onScrollPhaseChange { _, phase, context in
                self.handleScrollPhaseChange(phase, offset: context.geometry.contentOffset.y)
            }

            if self.showsCleanLoadingPlaceholder(hasVisibleContent: hasVisibleContent) {
                ChatLoadingBubble()
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .topLeading)
                    .padding(.top, Layout.messageListPaddingTop)
            }

            if self.viewModel.isLoading, self.composerChrome == .full {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            self.messageListOverlay(hasVisibleContent: hasVisibleContent)

            if self.showsJumpToLatest(hasVisibleContent: hasVisibleContent) {
                self.jumpToLatestButton
                    .padding(.bottom, 12)
                    .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .bottom)
                    .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
        .modifier(ChatScrollCommandModifier(
            command: self.$scrollCommand,
            position: self.$scrollPosition,
            bottomID: self.scrollerBottomID,
            geometry: self.historyScrollGeometry,
            historyRowGeometry: self.scrollCommand.historyGeometry,
            historyScrollTargets: ChatAssistantRunGroup.scrollTargets(groups)) { self.viewModel.currentSessionTarget })
        // Ensure the message list claims vertical space on the first layout pass.
        .frame(maxHeight: .infinity, alignment: .top)
        .layoutPriority(1)
        .simultaneousGesture(
            TapGesture().onEnded {
                self.dismissKeyboardIfNeeded()
            })
        .onChange(of: self.viewModel.isLoading, initial: true) { _, isLoading in
            if !isLoading, self.hasPerformedInitialScroll, self.followTarget == .latest,
               !self.isUserScrolling, self.searchMessageID == nil
            {
                self.moveScrollPosition(to: self.scrollerBottomID)
            } else {
                self.restoreInitialScrollIfReady()
            }
        }
        .onChange(of: self.viewModel.currentSessionTarget) { _, _ in
            self.handleSessionTargetChange()
        }
        .onChange(of: self.scenePhase) { _, newValue in
            if newValue == .background {
                self.speech?.stop()
            }
            guard newValue == .active else { return }
            self.viewModel.resumeFromForeground()
        }
        .onDisappear {
            self.speech?.stop()
            #if os(iOS)
            self.historyScrollGeometry.nativeViewport?.cancel()
            #endif
            self.scrollCommand.cancel()
        }
        .onChange(of: self.viewModel.timelineRevision) { _, _ in
            self.handleTimelineChange()
        }
        #if canImport(UIKit) && !os(macOS)
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillShowNotification)) { _ in
            self.restoresLiveEdgeAfterKeyboardTransition =
                self.followTarget == .latest && !self.isUserScrolling && self.searchMessageID == nil
            self.isKeyboardVisible = true
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidShowNotification)) { _ in
            self.restoreLiveEdgeAfterKeyboardTransition()
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardWillHideNotification)) { _ in
            self.restoresLiveEdgeAfterKeyboardTransition =
                (self.followTarget == .latest || self.isAtLiveEdge) &&
                !self.isUserScrolling && self.searchMessageID == nil
            self.isKeyboardVisible = false
        }
        .onReceive(NotificationCenter.default.publisher(for: UIResponder.keyboardDidHideNotification)) { _ in
            self.restoreLiveEdgeAfterKeyboardTransition()
        }
        #endif
    }

    private func handleSessionTargetChange() {
        self.speech?.stop()
        #if os(iOS)
        self.historyScrollGeometry.nativeViewport?.cancel()
        #endif
        self.scrollCommand.cancelSession(geometry: self.historyScrollGeometry)
        self.scrollPosition = ScrollPosition(idType: UUID.self)
        self.hasPerformedInitialScroll = false
        self.followTarget = .latest
        self.isAtLiveEdge = true
        self.isUserScrolling = false
        self.hasNewerContentBelow = false
        self.lastTurnStartID = nil
        self.lastLiveUserTurnRevision = self.viewModel.liveUserTurnRevision
        self.restoreInitialScrollIfReady()
    }

    @ViewBuilder
    private func messageListHeader() -> some View {
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

        if self.viewModel.hasEarlierHistory {
            Button {
                self.loadEarlierHistory(isExplicit: true)
            } label: {
                HStack(spacing: 8) {
                    if self.viewModel.isLoadingEarlierHistory { ProgressView().controlSize(.small) }
                    Text(self.viewModel.isLoadingEarlierHistory ? "Loading earlier messages" : "Load earlier messages")
                        .font(OpenClawChatTypography.captionSemiBold)
                }
                .frame(maxWidth: .infinity)
                .padding(.vertical, 8)
            }
            .buttonStyle(.plain)
            .disabled(self.viewModel.isLoadingEarlierHistory)
            .accessibilityIdentifier("chat-load-earlier-history")
        }
    }

    @ViewBuilder
    private func messageListRows(
        groups: [ChatAssistantRunGroup],
        transcript: ChatTranscriptPresentation) -> some View
    {
        let contextWindowTokens = self.viewModel.contextUsage?.contextWindowTokens
        ForEach(groups) { group in
            // Run ownership does not select another message renderer or wrapper.
            VStack(alignment: .leading, spacing: self.isDesktopLayout ? 16 : Layout.messageSpacing) {
                ForEach(group.parts) { part in
                    self.runPart(part, metadata: transcript.metadata, contextWindowTokens: contextWindowTokens)
                }
                if group.includesLive { self.liveAssistantContent }
            }
            .id(group.id)
        }
    }

    @ViewBuilder
    private func runPart(
        _ part: ChatAssistantRunGroup.Part,
        metadata: [UUID: ChatMessageMetadata],
        contextWindowTokens: Int?) -> some View
    {
        switch part {
        case let .row(row):
            self.transcriptRow(
                row,
                metadata: metadata,
                contextWindowTokens: contextWindowTokens)
                .id(row.id)
                .modifier(ChatScrollHistoryRowModifier(
                    rowID: row.id,
                    command: self.scrollCommand,
                    boundaryID: self.transcriptPresentation.historyAnchorID,
                    geometry: self.historyScrollGeometry,
                    preservationGeometry: self.$scrollCommand.historyGeometry))
        case let .tool(tool):
            ChatToolActivityList(items: [ChatToolActivityItem(live: tool)])
                .padding(4)
        }
    }

    @ViewBuilder
    private func transcriptRow(
        _ row: ChatTranscriptRow,
        metadata: [UUID: ChatMessageMetadata],
        contextWindowTokens: Int?) -> some View
    {
        switch row {
        case let .message(message):
            self.messageRow(
                for: message,
                metadata: metadata[message.id],
                contextWindowTokens: contextWindowTokens)
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
                    metadata: metadata[message.id],
                    contextWindowTokens: contextWindowTokens)
            }
        }
    }

    @ViewBuilder
    private var liveAssistantContent: some View {
        if self.showsWorkingIndicator {
            ChatTypingIndicatorBubble(
                style: self.style,
                assistantName: self.assistantName,
                assistantAvatarText: self.assistantAvatarText,
                assistantAvatarTint: self.assistantAvatarTint,
                showsAssistantAvatar: self.showsAssistantAvatars,
                isClean: self.composerChrome == .clean,
                runIdentity: self.viewModel.workingIndicatorIdentity,
                outputTokens: self.viewModel.liveRunOutputTokens)
                .equatable()
        }

        if let text = viewModel.streamingAssistantText {
            let preparedText = ChatStreamingAssistantText(
                sourceText: text,
                includesThinking: self.displayOptions.contains(.reasoning))
            if !preparedText.segments.isEmpty {
                ChatStreamingAssistantBubble(
                    text: preparedText,
                    markdownVariant: self.markdownVariant,
                    assistantName: self.assistantName,
                    assistantAvatarText: self.assistantAvatarText,
                    assistantAvatarTint: self.assistantAvatarTint,
                    showsAssistantAvatar: self.showsAssistantAvatars,
                    isClean: self.composerChrome == .clean)
                    .equatable()
                    .frame(maxWidth: .infinity, alignment: .leading)
            }
        }
    }

    @ViewBuilder
    private func messageRow(
        for msg: OpenClawChatMessage,
        metadata: ChatMessageMetadata?,
        contextWindowTokens: Int?,
        showsActions: Bool = true) -> some View
    {
        let isUser = msg.role.lowercased() == "user"
        let bubble = ChatMessageBubble(
            message: msg,
            liveToolCalls: self.viewModel.toolActivities.filter {
                $0.runID != nil && $0.runID == msg.workRunID
            },
            metadata: metadata,
            sourcePreviews: self.viewModel.sourcePreviews(for: msg),
            sourceContextRevision: self.viewModel.sourcePreviewState.revision,
            sourceFaviconsEnabled: self.viewModel.sourcePreviewState.context?.automaticallyFetchFavicons == true,
            loadSourceFavicon: { [weak viewModel] host in
                await viewModel?.transport.loadSourceFavicon(host: host)
            },
            style: self.style,
            markdownVariant: self.markdownVariant,
            userAccent: self.userAccent,
            displayOptions: self.displayOptions,
            assistantName: self.assistantName,
            assistantAvatarText: self.assistantAvatarText,
            assistantAvatarTint: self.assistantAvatarTint,
            showsAssistantAvatar: self.showsAssistantAvatars,
            isClean: self.composerChrome == .clean,
            contextWindowTokens: contextWindowTokens,
            userMessageExpanded: self.expandedUserMessageIDs.contains(msg.id),
            onToggleUserMessageExpanded: {
                if self.expandedUserMessageIDs.contains(msg.id) {
                    self.expandedUserMessageIDs.remove(msg.id)
                } else {
                    self.expandedUserMessageIDs.insert(msg.id)
                }
            },
            inlineWidgetResolverReady: self.viewModel.healthOK,
            inlineWidgetResourceResolver: { [weak viewModel] path, failedResource in
                await viewModel?.transport.resolveInlineWidgetResource(path: path, replacing: failedResource)
            },
            mediaArtifactResolverReady: self.viewModel.healthOK,
            mediaPlaybackAllowed: self.mediaPlaybackAllowed,
            loadMediaArtifact: { [weak viewModel] artifactId, kind, playback in
                guard let viewModel else { return nil }
                return try await viewModel.transport.loadMediaArtifact(
                    sessionKey: viewModel.sessionKey,
                    artifactId: artifactId,
                    kind: kind,
                    playback: playback)
            })
            .frame(
                maxWidth: .infinity,
                alignment: isUser ? .trailing : .leading)
        let row = VStack(alignment: isUser ? .trailing : .leading, spacing: 4) {
            bubble
            ChatMessageReactions(viewModel: self.viewModel, message: msg)
            if let outboxState = self.viewModel.outboxState(for: msg.id) {
                ChatOutboxStatusLabel(state: outboxState)
                    .padding(.trailing, 8)
            }
            if let speech = self.speech,
               let isPreparing = self.speechChipIsPreparing(speech, messageID: msg.id)
            {
                ChatSpeechStatusChip(isPreparing: isPreparing) { speech.stop() }
                    .padding(.leading, 8)
            }
            #if os(iOS)
            if !isUser, showsActions {
                self.messageActionsMenu(for: msg)
                    .labelStyle(.iconOnly)
                    .buttonStyle(.borderless)
                    .font(OpenClawChatTypography.caption)
                    .foregroundStyle(.secondary)
                    .frame(
                        width: CleanChatComposerMetrics.controlTouchSize,
                        height: CleanChatComposerMetrics.controlTouchSize)
                    .contentShape(Rectangle())
                    .padding(.leading, 8)
                    .padding(.bottom, 8)
            }
            #endif
            #if os(macOS)
            if self.isDesktopLayout, showsActions, isUser || self.isListenable(msg) {
                HStack(spacing: 12) {
                    self.copyMessageButton(for: msg)
                        .help("Copy message")
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                    self.replyMessageButton(for: msg)
                        .help("Reply")
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                    self.listenMessageButton(for: msg)
                        .modifier(ChatHoverAction(revealed: self.hoveredMessageID == msg.id))
                    self.messageActionsMenu(for: msg)
                        .help("Message actions")
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
        row.contextMenu { self.messageMenuActions(for: msg) }
    }

    private func messageActionsMenu(for message: OpenClawChatMessage) -> some View {
        Menu {
            self.messageMenuActions(for: message)
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
            if outboxState.isFailed {
                Button {
                    self.viewModel.retryOutboxMessage(message.id)
                } label: {
                    Label("Retry Send", systemImage: "arrow.clockwise")
                }
            }
            // In-flight sends may still reach canonical history; hiding them
            // would make a real send look as though it had been cancelled.
            if !outboxState.preventsDeletion {
                Button(role: .destructive) {
                    self.viewModel.deleteOutboxMessage(message.id)
                } label: {
                    Label("Delete", systemImage: "trash")
                }
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

    private var transcriptPresentation: ChatTranscriptPresentation {
        let runWorking = self.viewModel.hasBlockingRunActivity || self.viewModel.streamingAssistantText != nil
        let activeRunIDs = Set(self.viewModel.liveAdvertisedRunIDs).union(self.viewModel.liveLocalRunIDs)
        let key = ChatTranscriptPresentationKey(
            viewModel: ObjectIdentifier(self.viewModel),
            revision: self.viewModel.transcriptRevision,
            style: self.style,
            runWorking: runWorking,
            activeRunIDs: activeRunIDs,
            collapsesCompletedWork: self.collapsesCompletedWork,
            searchActive: self.isSearchPresented,
            preservedRowID: self.historyScrollGeometry.preservedRowID,
            displayOptions: self.displayOptions)
        return self.transcriptMemo.value(for: key) {
            self.buildTranscriptPresentation(runWorking: runWorking, activeRunIDs: activeRunIDs)
        }
    }

    private func buildTranscriptPresentation(
        runWorking: Bool,
        activeRunIDs: Set<String>) -> ChatTranscriptPresentation
    {
        let messages = self.viewModel.transcriptMessages
        let base: [OpenClawChatMessage]
        if self.style == .onboarding {
            guard let first = messages.first else { return ChatTranscriptPresentation(rows: [], metadata: [:]) }
            base = first.role.lowercased() == "user" ? Array(messages.dropFirst()) : messages
        } else {
            base = messages
        }
        var rows = ChatTranscriptRow.build(from: ChatTranscriptRow.mergeToolResults(in: base))
        // Footers and visible rows share the merged, onboarding-trimmed input, before work moves into disclosures.
        let metadata = ChatTranscriptRow.footerMetadata(
            in: rows,
            activeRunIDs: activeRunIDs,
            runWorking: runWorking,
            isMessageVisible: self.shouldDisplayMessage)
        if self.collapsesCompletedWork {
            rows = ChatTranscriptRow.collapseCompletedWork(
                rows,
                runWorking: runWorking,
                activeRunIDs: activeRunIDs,
                searchActive: self.isSearchPresented,
                preservedRowID: self.historyScrollGeometry.preservedRowID)
        }
        rows = rows.compactMap { row in
            switch row {
            case let .message(message):
                return self.shouldDisplayMessage(message) ? row : nil
            case let .completedWork(work):
                let visible = work.messages.filter(self.shouldDisplayMessage)
                return visible.isEmpty ? nil : .completedWork(.init(
                    anchorID: work.anchorID, messages: visible, durationMilliseconds: work.durationMilliseconds))
            default:
                return row
            }
        }
        return ChatTranscriptPresentation(rows: rows, metadata: metadata)
    }

    private var latestVisibleTurnStartID: UUID? {
        self.transcriptPresentation.rows.last(where: \.startsTurn)?.id
    }

    private func showsJumpToLatest(hasVisibleContent: Bool) -> Bool {
        chatReaderShowsJumpToLatest(
            hasNewerContentBelow: self.hasNewerContentBelow,
            isAtLiveEdge: self.isAtLiveEdge,
            hasVisibleContent: hasVisibleContent,
            isLoading: self.viewModel.isLoading)
    }

    private var jumpToLatestButton: some View {
        Button {
            self.isSearchPresented = false
            self.searchMessageID = nil
            self.followTarget = .latest
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
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
        guard let text = self.viewModel.streamingAssistantText else { return false }
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

    private func handleScrollPhaseChange(_ phase: ScrollPhase, offset: CGFloat) {
        if phase == .idle { self.historyScrollGeometry.settledOffset = offset }
        guard self.hasPerformedInitialScroll else { return }
        if phase == .interacting {
            self.restoresLiveEdgeAfterKeyboardTransition = false
        }
        if chatReaderScrollReleasesFollow(phase) {
            self.readerInteractionRevision &+= 1
            #if os(iOS)
            self.historyScrollGeometry.nativeViewport?.cancel()
            #endif
            self.historyScrollGeometry.pagingRowID = nil
            self.scrollCommand.cancel()
            self.scrollPosition = ScrollPosition(idType: UUID.self)
            self.isUserScrolling = true
            self.followTarget = nil
        } else if phase == .idle, self.isUserScrolling {
            self.isUserScrolling = false
            if self.isAtLiveEdge {
                self.followTarget = .latest
                self.hasNewerContentBelow = false
            } else {
                self.hasNewerContentBelow = true
            }
            self.loadEarlierHistoryIfNeeded()
        }
    }

    private func loadEarlierHistoryIfNeeded() {
        guard self.hasPerformedInitialScroll, self.isAtHistoryStart,
              !self.isUserScrolling, self.followTarget == nil, self.searchMessageID == nil
        else { return }
        self.loadEarlierHistory()
    }

    private func loadEarlierHistory(isExplicit: Bool = false) {
        guard self.viewModel.hasEarlierHistory,
              !self.viewModel.isLoadingEarlierHistory
        else { return }
        if isExplicit {
            self.scrollCommand.cancel()
            self.scrollPosition = ScrollPosition(idType: UUID.self)
            self.followTarget = nil
            self.hasNewerContentBelow = true
        }
        let target = self.viewModel.currentSessionTarget
        let interactionRevision = self.readerInteractionRevision
        #if os(iOS)
        let nativeViewport = self.historyScrollGeometry.nativeViewport
        nativeViewport?.capture()
        #endif
        let (firstRowID, offsetFromRow) = self.historyScrollGeometry
            .preserve(self.transcriptPresentation.historyAnchorID)
        Task { @MainActor in
            let loaded = await self.viewModel.loadEarlierHistory()
            #if os(iOS)
            if loaded, self.viewModel.currentSessionTarget == target,
               self.readerInteractionRevision == interactionRevision,
               let nativeViewport, nativeViewport.pageArrived()
            {
                return
            }
            nativeViewport?.cancel()
            #endif
            guard loaded,
                  self.viewModel.currentSessionTarget == target,
                  self.readerInteractionRevision == interactionRevision,
                  !self.isUserScrolling,
                  self.followTarget == nil, self.searchMessageID == nil,
                  let firstRowID
            else { return }
            // The new page precedes this boundary. Keep the reader on the content they were reading.
            if self.transcriptPresentation.historyAnchorID == firstRowID {
                self.loadEarlierHistory()
            } else {
                self.scrollCommand.enqueue(
                    to: firstRowID, anchor: .top, sessionTarget: target, offsetFromRow: offsetFromRow)
            }
        }
    }

    private func restoreInitialScrollIfReady() {
        guard !self.hasPerformedInitialScroll,
              !self.viewModel.isLoading || !self.transcriptPresentation.rows.isEmpty
        else { return }
        self.restoreInitialScrollPosition()
        self.hasPerformedInitialScroll = true
        self.lastTurnStartID = self.latestVisibleTurnStartID
        self.lastLiveUserTurnRevision = self.viewModel.liveUserTurnRevision
    }

    private func restoreInitialScrollPosition() {
        if chatReaderInitialRestorePolicy() == .latestTurn,
           let latestTurnStartID = self.latestVisibleTurnStartID
        {
            self.followTarget = nil
            self.hasNewerContentBelow = chatReaderHasNewerContent(
                after: latestTurnStartID,
                visibleIDs: self.transcriptPresentation.rows.map(\.id),
                hasTransientContent: self.hasVisibleTransientContent)
            self.moveScrollPosition(to: latestTurnStartID, anchor: Layout.newTurnAnchor)
        } else {
            self.followTarget = .latest
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
        }
    }

    private func handleTimelineChange() {
        guard self.hasPerformedInitialScroll else {
            self.restoreInitialScrollIfReady()
            return
        }
        // A search result is an explicit reading position. Incoming replies
        // must not pull the reader away until they leave Find.
        guard self.searchMessageID == nil else { return }
        if self.viewModel.messages.isEmpty,
           !self.viewModel.hasBlockingRunActivity,
           self.viewModel.pendingToolCalls.isEmpty,
           self.viewModel.streamingAssistantText == nil
        {
            self.lastTurnStartID = nil
            self.followTarget = .latest
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
            return
        }
        let transcriptRows = self.transcriptPresentation.rows
        let visibleTurnStartIDs = transcriptRows.compactMap { $0.startsTurn ? $0.id : nil }
        defer { self.lastLiveUserTurnRevision = self.viewModel.liveUserTurnRevision }
        switch chatReaderUserTransition(
            previousID: self.lastTurnStartID,
            visibleIDs: visibleTurnStartIDs,
            liveTurnID: self.viewModel.liveUserTurnRevision != self.lastLiveUserTurnRevision
                ? self.viewModel.liveUserTurnID : nil)
        {
        case let .removed(latestRemainingID):
            self.scrollCommand.cancel(targetID: self.lastTurnStartID)
            self.lastTurnStartID = latestRemainingID
            if case let .turn(messageID) = followTarget,
               !visibleTurnStartIDs.contains(messageID)
            {
                self.followTarget = .latest
                self.hasNewerContentBelow = false
            }
            if self.followTarget == .latest { self.moveScrollPosition(to: self.scrollerBottomID) }
            return
        case let .added(latestTurnStartID):
            self.lastTurnStartID = latestTurnStartID
            self.hasNewerContentBelow = false
            if self.isUserScrolling {
                self.followTarget = nil
                self.hasNewerContentBelow = true
                return
            }
            // The anchored-question layout assumes a viewport tall enough to read the turn
            // below the anchor. With the keyboard up that space is gone and the reply streams
            // straight past the fold (#108692), so follow the live edge instead.
            if self.isKeyboardVisible ||
                chatReaderHasAssistantReply(after: latestTurnStartID, rows: transcriptRows)
            {
                self.followTarget = .latest
                self.moveScrollPosition(to: self.scrollerBottomID)
            } else {
                self.followTarget = .turn(latestTurnStartID)
                self.moveScrollPosition(to: latestTurnStartID, anchor: Layout.newTurnAnchor)
            }
            return
        case .unchanged:
            self.lastTurnStartID = visibleTurnStartIDs.last
        }

        switch self.followTarget {
        case .latest:
            // One correction per actual transcript update; lazy geometry must never trigger another scroll.
            self.hasNewerContentBelow = false
            self.moveScrollPosition(to: self.scrollerBottomID)
        case let .turn(messageID):
            // Keep the question anchor until the growing reply exceeds the available viewport.
            if self.followOverflowingReplyIfNeeded() { return }
            // Reader policy stays on this turn after the one-shot scroll command completes. Reissuing
            // that target for every streaming delta can loop SwiftUI layout and starve interaction.
            self.hasNewerContentBelow = chatReaderHasNewerContent(
                after: messageID,
                visibleIDs: transcriptRows.map(\.id),
                hasTransientContent: self.hasVisibleTransientContent)
        case nil:
            self.hasNewerContentBelow = true
        }
    }

    @discardableResult
    private func followOverflowingReplyIfNeeded() -> Bool {
        guard !self.isUserScrolling, self.searchMessageID == nil,
              case let .turn(id) = self.followTarget,
              (!self.isAtLiveEdge && self.hasVisibleStreamingAssistantText) ||
              chatReaderHasAssistantReply(after: id, rows: self.transcriptPresentation.rows)
        else { return false }
        self.followTarget = .latest
        self.hasNewerContentBelow = false
        self.moveScrollPosition(to: self.scrollerBottomID)
        return true
    }

    private func moveScrollPosition(
        to id: UUID,
        anchor: UnitPoint = .bottom)
    {
        self.scrollCommand.enqueue(
            to: id,
            anchor: anchor,
            sessionTarget: self.viewModel.currentSessionTarget)
    }

    private func revealSearchMessage(_ messageID: UUID) {
        self.followTarget = nil
        self.hasNewerContentBelow = true
        self.expandedUserMessageIDs.insert(messageID)
        self.moveScrollPosition(to: messageID, anchor: .top)
    }

    private func restoreLiveEdgeAfterKeyboardTransition() {
        guard self.restoresLiveEdgeAfterKeyboardTransition else { return }
        self.restoresLiveEdgeAfterKeyboardTransition = false
        guard self.searchMessageID == nil else { return }
        self.isUserScrolling = false
        self.followTarget = .latest
        self.hasNewerContentBelow = false
        self.moveScrollPosition(to: self.scrollerBottomID)
    }

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
            return self.displayOptions.contains(.toolActivity)
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

        return self.displayOptions.contains(.toolActivity) &&
            message.content.contains { $0.isToolCall || $0.isToolResult }
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
    private var isTabletLayout: Bool {
        #if os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad
        #else
        false
        #endif
    }

    /// Measure the detail pane, not the screen: a visible sidebar and window resizing
    /// change the space available to chat independently of device orientation.
    private var tabletHorizontalMargin: CGFloat {
        min(24, max(12, (self.contentWidth - 480) / 20 + 12))
    }

    private var composerHorizontalMargin: CGFloat {
        self.isTabletLayout ? self.tabletHorizontalMargin :
            (self.isDesktopLayout ? 16 : Layout.composerPaddingHorizontal)
    }

    private var readingColumnWidth: CGFloat {
        #if os(macOS)
        self.isDesktopLayout ? 760 : .infinity
        #elseif os(iOS)
        UIDevice.current.userInterfaceIdiom == .pad ? 760 : .infinity
        #else
        .infinity
        #endif
    }
}
