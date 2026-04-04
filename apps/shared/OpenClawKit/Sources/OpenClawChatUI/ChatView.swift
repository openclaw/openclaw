import Foundation
import SwiftUI
#if canImport(UIKit)
import UIKit
#endif

@MainActor
public struct OpenClawChatView: View {
    public enum Style {
        case standard
        case onboarding
        case workspace
    }

    @State private var viewModel: OpenClawChatViewModel
    @State private var scrollerBottomID = UUID()
    @State private var scrollPosition: UUID?
    @State private var showSessions = false
    @State private var hasPerformedInitialScroll = false
    @State private var isPinnedToBottom = true
    @State private var lastUserMessageID: UUID?
    private let showsSessionSwitcher: Bool
    private let style: Style
    private let markdownVariant: ChatMarkdownVariant
    private let userAccent: Color?
    private let showsAssistantTrace: Bool

    private enum Layout {
        static func outerPaddingHorizontal(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 0 : 6
            #else
            6
            #endif
        }

        static func outerPaddingVertical(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 0 : 0
            #else
            6
            #endif
        }

        static func composerPaddingHorizontal(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 0 : 0
            #else
            6
            #endif
        }

        static func stackSpacing(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 0 : 0
            #else
            6
            #endif
        }

        static func messageSpacing(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 12 : 6
            #else
            12
            #endif
        }

        static func messageListPaddingTop(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 4 : 12
            #else
            10
            #endif
        }

        static func messageListPaddingBottom(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 10 : 16
            #else
            6
            #endif
        }

        static func messageListPaddingHorizontal(for style: Style) -> CGFloat {
            #if os(macOS)
            style == .workspace ? 0 : 6
            #else
            8
            #endif
        }
    }

    public init(
        viewModel: OpenClawChatViewModel,
        showsSessionSwitcher: Bool = false,
        style: Style = .standard,
        markdownVariant: ChatMarkdownVariant = .standard,
        userAccent: Color? = nil,
        showsAssistantTrace: Bool = false)
    {
        self._viewModel = State(initialValue: viewModel)
        self.showsSessionSwitcher = showsSessionSwitcher
        self.style = style
        self.markdownVariant = markdownVariant
        self.userAccent = userAccent
        self.showsAssistantTrace = showsAssistantTrace
    }

    public var body: some View {
        Group {
            if self.style == .workspace {
                self.workspaceBody
            } else {
                self.standardBody
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { self.viewModel.load() }
        .sheet(isPresented: self.$showSessions) {
            if self.showsSessionSwitcher {
                ChatSessionsSheet(viewModel: self.viewModel)
            } else {
                EmptyView()
            }
        }
    }

    private var standardBody: some View {
        ZStack {
            if self.style == .standard {
                OpenClawChatTheme.background
                    .ignoresSafeArea()
            }

            VStack(spacing: Layout.stackSpacing(for: self.style)) {
                self.messageList
                    .padding(.horizontal, Layout.outerPaddingHorizontal(for: self.style))
                OpenClawChatComposer(
                    viewModel: self.viewModel,
                    style: self.style,
                    showsSessionSwitcher: self.showsSessionSwitcher)
                    .padding(.horizontal, Layout.composerPaddingHorizontal(for: self.style))
            }
            .padding(.vertical, Layout.outerPaddingVertical(for: self.style))
            .frame(maxWidth: .infinity)
            .frame(maxHeight: .infinity, alignment: .top)
        }
    }

    private var workspaceBody: some View {
        GeometryReader { proxy in
            let width = max(proxy.size.width, 0)
            let usesCompactLayout = self.workspaceUsesCompactLayout(for: width)

            ZStack {
                OpenClawChatTheme.workspaceBackground
                    .ignoresSafeArea()

                Group {
                    if usesCompactLayout {
                        VStack(alignment: .leading, spacing: 12) {
                            self.workspaceHeader
                            self.workspaceCompactSummaryPanel
                            self.workspaceTranscriptPanel
                            OpenClawChatComposer(
                                viewModel: self.viewModel,
                                style: self.style,
                                showsSessionSwitcher: self.showsSessionSwitcher)
                        }
                    } else {
                        HStack(alignment: .top, spacing: 16) {
                            self.workspaceSidebar
                                .frame(width: self.workspaceSidebarWidth(for: width))
                            self.workspaceMainColumn
                        }
                    }
                }
                .padding(width < 880 ? 12 : 16)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            }
        }
    }

    private var workspaceMainColumn: some View {
        VStack(alignment: .leading, spacing: 16) {
            self.workspaceHeader
            self.workspaceTranscriptPanel
            OpenClawChatComposer(
                viewModel: self.viewModel,
                style: self.style,
                showsSessionSwitcher: self.showsSessionSwitcher)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var workspaceHeader: some View {
        WorkspacePanel {
            VStack(alignment: .leading, spacing: 14) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 16) {
                        self.workspaceHeaderLead
                        Spacer(minLength: 0)
                        self.workspaceHeaderTarget(isTrailing: true)
                    }

                    VStack(alignment: .leading, spacing: 12) {
                        self.workspaceHeaderLead
                        self.workspaceHeaderTarget(isTrailing: false)
                    }
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        WorkspaceTag(text: self.connectionLabel, tint: self.connectionTint)
                        WorkspaceTag(text: self.runStatusLabel, tint: self.runStatusTint)
                        WorkspaceInlinePill(
                            systemImage: "cpu.fill",
                            title: "Model",
                            value: self.modelSummaryLabel)
                        WorkspaceInlinePill(
                            systemImage: "paperplane",
                            title: "Draft",
                            value: self.draftCompactLabel)
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        HStack(spacing: 8) {
                            WorkspaceTag(text: self.connectionLabel, tint: self.connectionTint)
                            WorkspaceTag(text: self.runStatusLabel, tint: self.runStatusTint)
                        }

                        HStack(spacing: 8) {
                            WorkspaceInlinePill(
                                systemImage: "cpu.fill",
                                title: "Model",
                                value: self.modelSummaryLabel)
                            WorkspaceInlinePill(
                                systemImage: "paperplane",
                                title: "Draft",
                                value: self.draftCompactLabel)
                        }
                    }
                }
            }
        }
    }

    private var workspaceTranscriptPanel: some View {
        WorkspacePanel {
            VStack(alignment: .leading, spacing: 0) {
                HStack(alignment: .top, spacing: 16) {
                    VStack(alignment: .leading, spacing: 4) {
                        Text("Live Transcript")
                            .font(.headline)
                        Text(self.transcriptDetail)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }

                    Spacer(minLength: 0)

                    if self.isPinnedToBottom {
                        WorkspaceTag(text: "Following latest", tint: .blue)
                    } else {
                        WorkspaceTag(text: "Scrolled up", tint: .orange)
                    }
                }
                .padding(.horizontal, 18)
                .padding(.top, 18)
                .padding(.bottom, 12)

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        WorkspaceInlinePill(
                            systemImage: "text.bubble",
                            title: "Messages",
                            value: "\(self.visibleMessages.count)")
                        WorkspaceInlinePill(
                            systemImage: "paperplane",
                            title: "Draft",
                            value: self.draftCompactLabel)
                        WorkspaceInlinePill(
                            systemImage: "point.topleft.down.curvedto.point.bottomright.up",
                            title: "Flow",
                            value: self.isPinnedToBottom ? "Live" : "Reviewing history")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        WorkspaceInlinePill(
                            systemImage: "text.bubble",
                            title: "Messages",
                            value: "\(self.visibleMessages.count)")
                        WorkspaceInlinePill(
                            systemImage: "paperplane",
                            title: "Draft",
                            value: self.draftCompactLabel)
                        WorkspaceInlinePill(
                            systemImage: "point.topleft.down.curvedto.point.bottomright.up",
                            title: "Flow",
                            value: self.isPinnedToBottom ? "Live" : "Reviewing history")
                    }
                }
                .padding(.horizontal, 18)
                .padding(.bottom, 14)

                Rectangle()
                    .fill(OpenClawChatTheme.workspaceDivider)
                    .frame(height: 1)
                    .padding(.horizontal, 18)

                self.messageList
                    .padding(.horizontal, 18)
                    .padding(.bottom, 18)
                    .padding(.top, 8)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
    }

    private var workspaceSidebar: some View {
        VStack(alignment: .leading, spacing: 14) {
            WorkspacePanel {
                VStack(alignment: .leading, spacing: 14) {
                    HStack(alignment: .center, spacing: 10) {
                        Text("Active bot")
                            .font(.headline)
                        Spacer(minLength: 0)
                        WorkspaceTag(text: self.connectionLabel, tint: self.connectionTint)
                    }

                    Text(self.activeSessionTitle)
                        .font(.title3.weight(.semibold))
                        .lineLimit(2)

                    Text(self.sessionContextLine)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)

                    VStack(alignment: .leading, spacing: 10) {
                        self.workspaceSidebarStatRow(
                            systemImage: "cpu.fill",
                            title: "Model",
                            value: self.modelSummaryLabel)
                        self.workspaceSidebarStatRow(
                            systemImage: "brain.head.profile",
                            title: "Thinking",
                            value: self.thinkingSummaryValue)
                        self.workspaceSidebarStatRow(
                            systemImage: "clock.arrow.circlepath",
                            title: "Updated",
                            value: self.sessionUpdateLine)
                    }

                    ViewThatFits(in: .horizontal) {
                        HStack(spacing: 8) {
                            WorkspaceInlinePill(systemImage: "text.bubble", title: "Msgs", value: "\(self.visibleMessages.count)")
                            WorkspaceInlinePill(systemImage: "bolt.horizontal", title: "Run", value: self.pendingSummaryLabel)
                            WorkspaceInlinePill(systemImage: "paperclip", title: "Files", value: "\(self.viewModel.attachments.count)")
                        }

                        VStack(alignment: .leading, spacing: 8) {
                            WorkspaceInlinePill(systemImage: "text.bubble", title: "Msgs", value: "\(self.visibleMessages.count)")
                            WorkspaceInlinePill(systemImage: "bolt.horizontal", title: "Run", value: self.pendingSummaryLabel)
                            WorkspaceInlinePill(systemImage: "paperclip", title: "Files", value: "\(self.viewModel.attachments.count)")
                        }
                    }
                }
            }

            WorkspacePanel {
                VStack(alignment: .leading, spacing: 12) {
                    Text("Next Move")
                        .font(.headline)

                    Text(self.suggestedMoveTitle)
                        .font(.subheadline.weight(.semibold))
                    Text(self.suggestedMoveDetail)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(3)

                    Button {
                        self.prefillPrompt(self.suggestedMovePrompt)
                    } label: {
                        HStack(spacing: 8) {
                            Image(systemName: "sparkles")
                            Text("Use Suggestion")
                            Spacer(minLength: 0)
                            Image(systemName: "arrow.up.right")
                                .font(.caption.weight(.semibold))
                        }
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                        .padding(.horizontal, 12)
                        .padding(.vertical, 11)
                        .background(
                            RoundedRectangle(cornerRadius: 14, style: .continuous)
                                .fill(OpenClawChatTheme.workspaceSoftFill)
                                .overlay(
                                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                                        .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
                    }
                    .buttonStyle(.plain)

                    Rectangle()
                        .fill(OpenClawChatTheme.workspaceDivider)
                        .frame(height: 1)

                    ForEach(self.workspacePromptOptions) { option in
                        self.workspacePromptButton(option)
                    }
                }
            }
        }
    }

    private var workspaceCompactSummaryPanel: some View {
        WorkspacePanel {
            VStack(alignment: .leading, spacing: 12) {
                ViewThatFits(in: .horizontal) {
                    HStack(alignment: .top, spacing: 12) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Active bot")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(self.activeSessionTitle)
                                .font(.title3.weight(.semibold))
                                .lineLimit(2)
                            Text(self.sessionContextLine)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }

                        Spacer(minLength: 0)

                        VStack(alignment: .trailing, spacing: 8) {
                            WorkspaceTag(text: self.connectionLabel, tint: self.connectionTint)
                            WorkspaceTag(text: self.runStatusLabel, tint: self.runStatusTint)
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        VStack(alignment: .leading, spacing: 6) {
                            Text("Active bot")
                                .font(.caption.weight(.semibold))
                                .foregroundStyle(.secondary)
                            Text(self.activeSessionTitle)
                                .font(.title3.weight(.semibold))
                                .lineLimit(2)
                            Text(self.sessionContextLine)
                                .font(.caption)
                                .foregroundStyle(.secondary)
                                .lineLimit(2)
                        }

                        HStack(spacing: 8) {
                            WorkspaceTag(text: self.connectionLabel, tint: self.connectionTint)
                            WorkspaceTag(text: self.runStatusLabel, tint: self.runStatusTint)
                        }
                    }
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 8) {
                        WorkspaceInlinePill(systemImage: "cpu.fill", title: "Model", value: self.modelSummaryLabel)
                        WorkspaceInlinePill(systemImage: "bolt.horizontal", title: "Run", value: self.pendingSummaryLabel)
                        WorkspaceInlinePill(systemImage: "paperclip", title: "Files", value: "\(self.viewModel.attachments.count)")
                    }

                    VStack(alignment: .leading, spacing: 8) {
                        WorkspaceInlinePill(systemImage: "cpu.fill", title: "Model", value: self.modelSummaryLabel)
                        WorkspaceInlinePill(systemImage: "bolt.horizontal", title: "Run", value: self.pendingSummaryLabel)
                        WorkspaceInlinePill(systemImage: "paperclip", title: "Files", value: "\(self.viewModel.attachments.count)")
                    }
                }

                Button {
                    self.prefillPrompt(self.suggestedMovePrompt)
                } label: {
                    HStack(spacing: 8) {
                        Image(systemName: "sparkles")
                        Text(self.suggestedMoveTitle)
                        Spacer(minLength: 0)
                        Image(systemName: "arrow.up.right")
                            .font(.caption.weight(.semibold))
                    }
                    .font(.subheadline.weight(.semibold))
                    .foregroundStyle(.primary)
                    .padding(.horizontal, 12)
                    .padding(.vertical, 11)
                    .background(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .fill(OpenClawChatTheme.workspaceSoftFill)
                            .overlay(
                                RoundedRectangle(cornerRadius: 14, style: .continuous)
                                    .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
                }
                .buttonStyle(.plain)

                ScrollView(.horizontal, showsIndicators: false) {
                    HStack(spacing: 10) {
                        ForEach(self.workspacePromptOptions) { option in
                            self.workspacePromptCompactChip(option)
                        }
                    }
                    .padding(.horizontal, 1)
                }
                .scrollIndicators(.hidden)
            }
        }
    }

    private var messageList: some View {
        ZStack {
            ScrollView {
                LazyVStack(spacing: Layout.messageSpacing(for: self.style)) {
                    self.messageListRows

                    Color.clear
                        #if os(macOS)
                        .frame(height: Layout.messageListPaddingBottom(for: self.style))
                        #else
                        .frame(height: Layout.messageListPaddingBottom(for: self.style) + 1)
                        #endif
                        .id(self.scrollerBottomID)
                }
                // Use scroll targets for stable auto-scroll without ScrollViewReader relayout glitches.
                .scrollTargetLayout()
                .padding(.top, Layout.messageListPaddingTop(for: self.style))
                .padding(.horizontal, Layout.messageListPaddingHorizontal(for: self.style))
            }
            #if !os(macOS)
            .scrollDismissesKeyboard(.interactively)
            #endif
            // Keep the scroll pinned to the bottom for new messages.
            .scrollPosition(id: self.$scrollPosition, anchor: .bottom)
            .onChange(of: self.scrollPosition) { _, position in
                guard let position else { return }
                self.isPinnedToBottom = position == self.scrollerBottomID
            }

            if self.viewModel.isLoading {
                ProgressView()
                    .controlSize(.large)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }

            self.messageListOverlay
            self.workspaceJumpToLatestButton
        }
        // Ensure the message list claims vertical space on the first layout pass.
        .frame(maxHeight: .infinity, alignment: .top)
        .layoutPriority(1)
        .simultaneousGesture(
            TapGesture().onEnded {
                self.dismissKeyboardIfNeeded()
            })
        .onChange(of: self.viewModel.isLoading) { _, isLoading in
            guard !isLoading, !self.hasPerformedInitialScroll else { return }
            self.scrollPosition = self.scrollerBottomID
            self.hasPerformedInitialScroll = true
            self.isPinnedToBottom = true
        }
        .onChange(of: self.viewModel.sessionKey) { _, _ in
            self.hasPerformedInitialScroll = false
            self.isPinnedToBottom = true
        }
        .onChange(of: self.viewModel.isSending) { _, isSending in
            // Scroll to bottom when user sends a message, even if scrolled up.
            guard isSending, self.hasPerformedInitialScroll else { return }
            self.isPinnedToBottom = true
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
        .onChange(of: self.viewModel.messages.count) { _, _ in
            guard self.hasPerformedInitialScroll else { return }
            if let lastMessage = self.viewModel.messages.last,
               lastMessage.role.lowercased() == "user",
               lastMessage.id != self.lastUserMessageID {
                self.lastUserMessageID = lastMessage.id
                self.isPinnedToBottom = true
                withAnimation(.snappy(duration: 0.22)) {
                    self.scrollPosition = self.scrollerBottomID
                }
                return
            }

            guard self.isPinnedToBottom else { return }
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
        .onChange(of: self.viewModel.pendingRunCount) { _, _ in
            guard self.hasPerformedInitialScroll, self.isPinnedToBottom else { return }
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
        .onChange(of: self.viewModel.streamingAssistantText) { _, _ in
            guard self.hasPerformedInitialScroll, self.isPinnedToBottom else { return }
            withAnimation(.snappy(duration: 0.22)) {
                self.scrollPosition = self.scrollerBottomID
            }
        }
    }

    @ViewBuilder
    private var messageListRows: some View {
        ForEach(self.visibleMessages) { msg in
            ChatMessageBubble(
                message: msg,
                style: self.style,
                markdownVariant: self.markdownVariant,
                userAccent: self.userAccent,
                showsAssistantTrace: self.showsAssistantTrace)
                .frame(
                    maxWidth: .infinity,
                    alignment: msg.role.lowercased() == "user" ? .trailing : .leading)
        }

        if self.viewModel.pendingRunCount > 0 {
            HStack {
                ChatTypingIndicatorBubble(style: self.style)
                    .equatable()
                Spacer(minLength: 0)
            }
        }

        if !self.viewModel.pendingToolCalls.isEmpty {
            ChatPendingToolsBubble(style: self.style, toolCalls: self.viewModel.pendingToolCalls)
                .equatable()
                .frame(maxWidth: .infinity, alignment: .leading)
        }

        if let text = self.viewModel.streamingAssistantText,
           AssistantTextParser.hasVisibleContent(in: text, includeThinking: self.showsAssistantTrace)
        {
            ChatStreamingAssistantBubble(
                style: self.style,
                text: text,
                markdownVariant: self.markdownVariant,
                showsAssistantTrace: self.showsAssistantTrace)
                .frame(maxWidth: .infinity, alignment: .leading)
        }
    }

    private var visibleMessages: [OpenClawChatMessage] {
        let base: [OpenClawChatMessage]
        if self.style == .onboarding {
            guard let first = self.viewModel.messages.first else { return [] }
            base = first.role.lowercased() == "user" ? Array(self.viewModel.messages.dropFirst()) : self.viewModel
                .messages
        } else {
            base = self.viewModel.messages
        }
        return self.mergeToolResults(in: base).filter(self.shouldDisplayMessage(_:))
    }

    @ViewBuilder
    private var messageListOverlay: some View {
        if self.viewModel.isLoading {
            EmptyView()
        } else if let error = self.activeErrorText {
            let presentation = self.errorPresentation(for: error)
            if self.hasVisibleMessageListContent {
                VStack(spacing: 0) {
                    ChatNoticeBanner(
                        systemImage: presentation.systemImage,
                        title: presentation.title,
                        message: error,
                        tint: presentation.tint,
                        dismiss: { self.viewModel.errorText = nil },
                        refresh: { self.viewModel.refresh() })
                    Spacer(minLength: 0)
                }
                .padding(.horizontal, 10)
                .padding(.top, 8)
                .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
            } else {
                ChatNoticeCard(
                    systemImage: presentation.systemImage,
                    title: presentation.title,
                    message: error,
                    tint: presentation.tint,
                    actionTitle: "Refresh",
                    action: { self.viewModel.refresh() })
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        } else if self.showsEmptyState {
            if self.style == .workspace {
                self.workspaceEmptyState
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            } else {
                ChatNoticeCard(
                    systemImage: "bubble.left.and.bubble.right.fill",
                    title: self.emptyStateTitle,
                    message: self.emptyStateMessage,
                    tint: .accentColor,
                    actionTitle: nil,
                    action: nil)
                    .padding(.horizontal, 24)
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
    }

    private var activeErrorText: String? {
        guard let text = self.viewModel.errorText?
            .trimmingCharacters(in: .whitespacesAndNewlines),
            !text.isEmpty
        else {
            return nil
        }
        return text
    }

    private var hasVisibleMessageListContent: Bool {
        if !self.visibleMessages.isEmpty {
            return true
        }
        if let text = self.viewModel.streamingAssistantText,
           AssistantTextParser.hasVisibleContent(in: text, includeThinking: self.showsAssistantTrace)
        {
            return true
        }
        if self.viewModel.pendingRunCount > 0 {
            return true
        }
        if !self.viewModel.pendingToolCalls.isEmpty {
            return true
        }
        return false
    }

    private var showsEmptyState: Bool {
        self.viewModel.messages.isEmpty &&
            !(self.viewModel.streamingAssistantText.map {
                AssistantTextParser.hasVisibleContent(in: $0, includeThinking: self.showsAssistantTrace)
            } ?? false) &&
            self.viewModel.pendingRunCount == 0 &&
            self.viewModel.pendingToolCalls.isEmpty
    }

    private var emptyStateTitle: String {
        if self.style == .workspace {
            return "Chat ready"
        }
        #if os(macOS)
        return "Web Chat"
        #else
        return "Chat"
        #endif
    }

    private var emptyStateMessage: String {
        if self.style == .workspace {
            return "Pick a start or type below."
        }
        #if os(macOS)
        return "Type a message below to start.\nReturn sends • Shift-Return adds a line break."
        #else
        return "Type a message below to start."
        #endif
    }

    private func errorPresentation(for error: String) -> (title: String, systemImage: String, tint: Color) {
        let lower = error.lowercased()
        if lower.contains("not connected") || lower.contains("socket") {
            return ("Disconnected", "wifi.slash", .orange)
        }
        if lower.contains("timed out") {
            return ("Timed out", "clock.badge.exclamationmark", .orange)
        }
        return ("Error", "exclamationmark.triangle.fill", .orange)
    }

    private func mergeToolResults(in messages: [OpenClawChatMessage]) -> [OpenClawChatMessage] {
        var result: [OpenClawChatMessage] = []
        result.reserveCapacity(messages.count)

        for message in messages {
            guard self.isToolResultMessage(message) else {
                result.append(message)
                continue
            }

            guard let toolCallId = message.toolCallId,
                  let last = result.last,
                  self.toolCallIds(in: last).contains(toolCallId)
            else {
                result.append(message)
                continue
            }

            let toolText = self.toolResultText(from: message)
            if toolText.isEmpty {
                continue
            }

            var content = last.content
            content.append(
                OpenClawChatMessageContent(
                    type: "tool_result",
                    text: toolText,
                    thinking: nil,
                    thinkingSignature: nil,
                    mimeType: nil,
                    fileName: nil,
                    content: nil,
                    id: toolCallId,
                    name: message.toolName,
                    arguments: nil))

            let merged = OpenClawChatMessage(
                id: last.id,
                role: last.role,
                content: content,
                timestamp: last.timestamp,
                toolCallId: last.toolCallId,
                toolName: last.toolName,
                usage: last.usage,
                stopReason: last.stopReason)
            result[result.count - 1] = merged
        }

        return result
    }

    private func isToolResultMessage(_ message: OpenClawChatMessage) -> Bool {
        let role = message.role.lowercased()
        return role == "toolresult" || role == "tool_result"
    }

    private func shouldDisplayMessage(_ message: OpenClawChatMessage) -> Bool {
        if self.hasInlineAttachments(in: message) {
            return true
        }

        let primaryText = self.primaryText(in: message)
        if !primaryText.isEmpty {
            if message.role.lowercased() == "user" {
                return true
            }
            if AssistantTextParser.hasVisibleContent(in: primaryText, includeThinking: self.showsAssistantTrace) {
                return true
            }
        }

        guard self.showsAssistantTrace else {
            return false
        }

        if self.isToolResultMessage(message) {
            return !primaryText.isEmpty
        }

        return !self.toolCalls(in: message).isEmpty || !self.inlineToolResults(in: message).isEmpty
    }

    private func primaryText(in message: OpenClawChatMessage) -> String {
        let parts = message.content.compactMap { content -> String? in
            let kind = (content.type ?? "text").lowercased()
            guard kind == "text" || kind.isEmpty else { return nil }
            return content.text
        }
        return parts.joined(separator: "\n").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    private func hasInlineAttachments(in message: OpenClawChatMessage) -> Bool {
        message.content.contains { content in
            switch content.type ?? "text" {
            case "file", "attachment":
                true
            default:
                false
            }
        }
    }

    private func toolCalls(in message: OpenClawChatMessage) -> [OpenClawChatMessageContent] {
        message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            if ["toolcall", "tool_call", "tooluse", "tool_use"].contains(kind) {
                return true
            }
            return content.name != nil && content.arguments != nil
        }
    }

    private func inlineToolResults(in message: OpenClawChatMessage) -> [OpenClawChatMessageContent] {
        message.content.filter { content in
            let kind = (content.type ?? "").lowercased()
            return kind == "toolresult" || kind == "tool_result"
        }
    }

    private func toolCallIds(in message: OpenClawChatMessage) -> Set<String> {
        var ids = Set<String>()
        for content in self.toolCalls(in: message) {
            if let id = content.id {
                ids.insert(id)
            }
        }
        if let toolCallId = message.toolCallId {
            ids.insert(toolCallId)
        }
        return ids
    }

    private func toolResultText(from message: OpenClawChatMessage) -> String {
        self.primaryText(in: message)
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

    private var activeSessionEntry: OpenClawChatSessionEntry? {
        self.viewModel.sessions.first(where: { $0.key == self.viewModel.sessionKey }) ??
            self.viewModel.sessionChoices.first(where: { $0.key == self.viewModel.sessionKey })
    }

    private var activeSessionTitle: String {
        let trimmed = self.activeSessionEntry?.displayName?
            .trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        return trimmed.isEmpty ? self.viewModel.sessionKey : trimmed
    }

    private var transcriptDetail: String {
        if self.viewModel.pendingRunCount > 0 {
            return "Streaming live."
        }
        return "Read the latest, then intervene only when direction must change."
    }

    private var connectionLabel: String {
        self.viewModel.healthOK ? "Connected" : "Reconnecting"
    }

    private var connectionTint: Color {
        self.viewModel.healthOK ? .green : .orange
    }

    private var runStatusLabel: String {
        if self.viewModel.pendingRunCount > 0 {
            return self.viewModel.pendingRunCount == 1 ? "1 active run" : "\(self.viewModel.pendingRunCount) active runs"
        }
        if !self.viewModel.pendingToolCalls.isEmpty {
            return self.viewModel.pendingToolCalls.count == 1
                ? "1 tool running"
                : "\(self.viewModel.pendingToolCalls.count) tools running"
        }
        return "Idle"
    }

    private var runStatusTint: Color {
        (self.viewModel.pendingRunCount > 0 || !self.viewModel.pendingToolCalls.isEmpty) ? .blue : .secondary
    }

    private var pendingSummaryLabel: String {
        if self.viewModel.pendingRunCount > 0 {
            return self.viewModel.pendingRunCount == 1 ? "1 run" : "\(self.viewModel.pendingRunCount) runs"
        }
        if !self.viewModel.pendingToolCalls.isEmpty {
            return self.viewModel.pendingToolCalls.count == 1 ? "1 tool" : "\(self.viewModel.pendingToolCalls.count) tools"
        }
        return "None"
    }

    private var modelSummaryLabel: String {
        if self.viewModel.modelSelectionID == OpenClawChatViewModel.defaultModelSelectionID {
            return self.viewModel.defaultModelLabel
        }
        if let match = self.viewModel.modelChoices.first(where: {
            $0.selectionID == self.viewModel.modelSelectionID || $0.modelID == self.viewModel.modelSelectionID
        }) {
            return match.displayLabel
        }
        return self.viewModel.modelSelectionID
    }

    private var thinkingSummaryValue: String {
        self.viewModel.thinkingLevel.uppercased()
    }

    private var thinkingSummaryLabel: String {
        "Think \(self.thinkingSummaryValue)"
    }

    private var sessionUpdateLine: String {
        guard let updatedAt = self.activeSessionEntry?.updatedAt else {
            return "Session key: \(self.viewModel.sessionKey)"
        }
        let seconds = updatedAt > 10_000_000_000 ? updatedAt / 1000 : updatedAt
        let date = Date(timeIntervalSince1970: seconds)
        return "Updated \(Self.relativeTimeFormatter.localizedString(for: date, relativeTo: Date()))"
    }

    private var workspaceEmptyState: some View {
        WorkspacePanel {
            VStack(alignment: .leading, spacing: 16) {
                HStack(spacing: 12) {
                    ZStack {
                        Circle()
                            .fill(Color.accentColor.opacity(0.14))
                        Image(systemName: "bubble.left.and.bubble.right.fill")
                            .font(.system(size: 22, weight: .semibold))
                            .foregroundStyle(Color.accentColor)
                    }
                    .frame(width: 52, height: 52)

                    VStack(alignment: .leading, spacing: 4) {
                        Text(self.emptyStateTitle)
                            .font(.headline)
                        Text(self.emptyStateMessage)
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                            .lineLimit(2)
                    }
                }

                ViewThatFits(in: .horizontal) {
                    HStack(spacing: 10) {
                        ForEach(self.workspacePromptOptions) { option in
                            self.workspaceEmptyStateActionCard(option)
                        }
                    }

                    VStack(alignment: .leading, spacing: 10) {
                        ForEach(self.workspacePromptOptions) { option in
                            self.workspaceEmptyStateActionCard(option)
                        }
                    }
                }
            }
        }
    }

    private func prefillPrompt(_ prompt: String) {
        let trimmed = self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard trimmed != prompt else { return }
        if trimmed.isEmpty {
            self.viewModel.input = prompt
        } else {
            self.viewModel.input = "\(trimmed)\n\n\(prompt)"
        }
        self.jumpToLatest()
    }

    private func jumpToLatest() {
        self.isPinnedToBottom = true
        withAnimation(.snappy(duration: 0.22)) {
            self.scrollPosition = self.scrollerBottomID
        }
    }

    private var workspacePromptOptions: [WorkspacePromptOption] {
        [
            WorkspacePromptOption(
                title: "Checkpoint",
                subtitle: "done • blocked • next",
                systemImage: "list.bullet.clipboard",
                prompt: "Give me a concise status update: what is done, what is blocked, what you are doing next, and whether you need any input from me."),
            WorkspacePromptOption(
                title: "Retry",
                subtitle: "fix the failure first",
                systemImage: "arrow.trianglehead.clockwise",
                prompt: "Retry the last failed step. Before you continue, explain the root cause, the fix you will apply, and the exact next action."),
            WorkspacePromptOption(
                title: "Refocus",
                subtitle: "one task only",
                systemImage: "scope",
                prompt: "Stop broad exploration. Focus only on the highest-priority blocking task, execute it end-to-end, and report any remaining risk briefly.")
        ]
    }

    private static let relativeTimeFormatter: RelativeDateTimeFormatter = {
        let formatter = RelativeDateTimeFormatter()
        formatter.unitsStyle = .full
        return formatter
    }()

    private var workspaceJumpToLatestButton: some View {
        Group {
            if self.style == .workspace, !self.isPinnedToBottom, self.hasVisibleMessageListContent {
                VStack {
                    Spacer(minLength: 0)
                    HStack {
                        Spacer(minLength: 0)
                        Button {
                            self.jumpToLatest()
                        } label: {
                            Label("Jump to latest", systemImage: "arrow.down.circle.fill")
                                .font(.subheadline.weight(.semibold))
                                .padding(.horizontal, 14)
                                .padding(.vertical, 10)
                                .background(
                                    Capsule(style: .continuous)
                                        .fill(OpenClawChatTheme.workspacePanel)
                                        .overlay(
                                            Capsule(style: .continuous)
                                                .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
                                .shadow(color: .black.opacity(0.12), radius: 14, y: 8)
                        }
                        .buttonStyle(.plain)
                    }
                    .padding(.horizontal, 16)
                    .padding(.bottom, 16)
                }
                .transition(.move(edge: .bottom).combined(with: .opacity))
            }
        }
    }

    private var operatorMessageCount: Int {
        self.visibleMessages.filter { $0.role.lowercased() == "user" }.count
    }

    private var agentMessageCount: Int {
        self.visibleMessages.count - self.operatorMessageCount
    }

    private var activeSessionKeyLabel: String {
        self.viewModel.sessionKey
    }

    private var sessionContextLine: String {
        let parts = [
            self.activeSessionEntry?.kind,
            self.activeSessionEntry?.surface,
            self.activeSessionEntry?.room,
            self.activeSessionEntry?.subject,
        ]
            .compactMap { $0?.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty }

        if parts.isEmpty {
            return self.sessionUpdateLine
        }
        return parts.prefix(2).joined(separator: " • ")
    }

    private var draftSummaryTitle: String {
        if self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty,
           self.viewModel.attachments.isEmpty
        {
            return "Ready"
        }
        return self.viewModel.canSend ? "Ready to send" : "Editing"
    }

    private var draftSummaryDetail: String {
        self.draftCompactLabel
    }

    private var draftCompactLabel: String {
        let trimmed = self.viewModel.input.trimmingCharacters(in: .whitespacesAndNewlines)
        let charCount = trimmed.count
        let attachmentCount = self.viewModel.attachments.count
        if charCount == 0 && attachmentCount == 0 {
            return "No draft"
        }

        var parts: [String] = []
        if charCount > 0 {
            parts.append("\(charCount) chars")
        }
        if attachmentCount > 0 {
            parts.append(attachmentCount == 1 ? "1 attachment" : "\(attachmentCount) attachments")
        }
        return parts.joined(separator: " • ")
    }

    private var suggestedMoveTitle: String {
        if !self.viewModel.healthOK {
            return "Wait for reconnect"
        }
        if self.viewModel.pendingRunCount > 0 {
            return "Hold while the run is active"
        }
        if self.visibleMessages.isEmpty {
            return "Ask for a checkpoint"
        }
        return "Send one precise change"
    }

    private var suggestedMoveDetail: String {
        if !self.viewModel.healthOK {
            return "Refresh or wait before sending."
        }
        if self.viewModel.pendingRunCount > 0 {
            return "Checkpoint first. Stop only if direction is clearly wrong."
        }
        if self.visibleMessages.isEmpty {
            return "Start with done, blocked, and next."
        }
        return "Change one thing only: retry, redirect, summarize, or stop."
    }

    private var suggestedMovePrompt: String {
        if !self.viewModel.healthOK {
            return "Refresh your connection status, then tell me whether this session can receive a new instruction right now."
        }
        if self.viewModel.pendingRunCount > 0 {
            return "Pause broad work and give me a checkpoint: what is currently running, what remains, and whether I should let it continue or stop it."
        }
        if self.visibleMessages.isEmpty {
            return "Give me a concise status update: what is done, what is blocked, what you are doing next, and whether you need any input from me."
        }
        return "Summarize the current state in three bullets, then wait for a single explicit next instruction before continuing."
    }

    private func workspaceUsesCompactLayout(for width: CGFloat) -> Bool {
        width < 1024
    }

    private func workspaceSidebarWidth(for width: CGFloat) -> CGFloat {
        min(max(228, width * 0.25), 264)
    }

    private var workspaceHeaderLead: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack(spacing: 10) {
                ZStack {
                    Circle()
                        .fill(Color.accentColor.opacity(0.14))
                    Image(systemName: "bubble.left.and.bubble.right.fill")
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
                .frame(width: 30, height: 30)

                Text("Intervention")
                    .font(.system(size: 28, weight: .bold, design: .rounded))
            }

            Text("One precise prompt to steer the active bot.")
                .font(.subheadline.weight(.medium))
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
    }

    @ViewBuilder
    private func workspaceHeaderTarget(isTrailing: Bool) -> some View {
        VStack(alignment: isTrailing ? .trailing : .leading, spacing: 5) {
            Text("Active bot")
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(self.activeSessionTitle)
                .font(.title3.weight(.semibold))
                .multilineTextAlignment(isTrailing ? .trailing : .leading)
                .lineLimit(2)
            Text(self.sessionUpdateLine)
                .font(.caption)
                .foregroundStyle(.secondary)
                .lineLimit(1)
        }
        .frame(maxWidth: 240, alignment: isTrailing ? .trailing : .leading)
    }

    @ViewBuilder
    private func workspaceSidebarStatRow(systemImage: String, title: String, value: String) -> some View {
        HStack(alignment: .center, spacing: 10) {
            ZStack {
                RoundedRectangle(cornerRadius: 11, style: .continuous)
                    .fill(OpenClawChatTheme.workspaceSoftFill)
                Image(systemName: systemImage)
                    .font(.system(size: 12, weight: .semibold))
                    .foregroundStyle(Color.accentColor)
            }
            .frame(width: 30, height: 30)

            VStack(alignment: .leading, spacing: 2) {
                Text(title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(value)
                    .font(.subheadline.weight(.semibold))
                    .lineLimit(2)
            }

            Spacer(minLength: 0)
        }
    }

    @ViewBuilder
    private func workspacePromptButton(_ option: WorkspacePromptOption) -> some View {
        Button {
            self.prefillPrompt(option.prompt)
        } label: {
            HStack(alignment: .center, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 12, style: .continuous)
                        .fill(Color.accentColor.opacity(0.12))
                    Image(systemName: option.systemImage)
                        .font(.system(size: 13, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
                .frame(width: 34, height: 34)

                VStack(alignment: .leading, spacing: 2) {
                    Text(option.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(option.subtitle)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                }

                Spacer(minLength: 0)

                Image(systemName: "plus")
                    .font(.caption.weight(.bold))
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity, alignment: .leading)
            .padding(12)
            .background(
                RoundedRectangle(cornerRadius: 14, style: .continuous)
                    .fill(OpenClawChatTheme.workspaceSoftFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: 14, style: .continuous)
                            .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func workspacePromptCompactChip(_ option: WorkspacePromptOption) -> some View {
        Button {
            self.prefillPrompt(option.prompt)
        } label: {
            HStack(spacing: 8) {
                Image(systemName: option.systemImage)
                    .font(.system(size: 12, weight: .semibold))
                Text(option.title)
                    .font(.caption.weight(.semibold))
                Image(systemName: "plus")
                    .font(.caption2.weight(.bold))
            }
            .foregroundStyle(.primary)
            .padding(.horizontal, 11)
            .padding(.vertical, 8)
            .background(
                Capsule(style: .continuous)
                    .fill(OpenClawChatTheme.workspaceSoftFill)
                    .overlay(
                        Capsule(style: .continuous)
                            .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
        }
        .buttonStyle(.plain)
    }

    @ViewBuilder
    private func workspaceEmptyStateActionCard(_ option: WorkspacePromptOption) -> some View {
        Button {
            self.prefillPrompt(option.prompt)
        } label: {
            VStack(alignment: .leading, spacing: 10) {
                ZStack {
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .fill(Color.accentColor.opacity(0.12))
                    Image(systemName: option.systemImage)
                        .font(.system(size: 15, weight: .semibold))
                        .foregroundStyle(Color.accentColor)
                }
                .frame(width: 40, height: 40)

                VStack(alignment: .leading, spacing: 3) {
                    Text(option.title)
                        .font(.subheadline.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(option.subtitle)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                }

                Spacer(minLength: 0)
            }
            .frame(maxWidth: .infinity, minHeight: 118, alignment: .topLeading)
            .padding(14)
            .background(
                RoundedRectangle(cornerRadius: 18, style: .continuous)
                    .fill(OpenClawChatTheme.workspaceSoftFill)
                    .overlay(
                        RoundedRectangle(cornerRadius: 18, style: .continuous)
                            .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
        }
        .buttonStyle(.plain)
    }
}

private struct ChatNoticeCard: View {
    let systemImage: String
    let title: String
    let message: String
    let tint: Color
    let actionTitle: String?
    let action: (() -> Void)?

    var body: some View {
        VStack(spacing: 12) {
            ZStack {
                Circle()
                    .fill(self.tint.opacity(0.16))
                Image(systemName: self.systemImage)
                    .font(.system(size: 24, weight: .semibold))
                    .foregroundStyle(self.tint)
            }
            .frame(width: 52, height: 52)

            Text(self.title)
                .font(.headline)

            Text(self.message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .lineLimit(4)
                .frame(maxWidth: 360)

            if let actionTitle, let action {
                Button(actionTitle, action: action)
                    .buttonStyle(.borderedProminent)
                    .controlSize(.small)
            }
        }
        .padding(18)
        .background(
            RoundedRectangle(cornerRadius: 18, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 18, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)))
        .shadow(color: .black.opacity(0.14), radius: 18, y: 8)
    }
}

private struct ChatNoticeBanner: View {
    let systemImage: String
    let title: String
    let message: String
    let tint: Color
    let dismiss: () -> Void
    let refresh: () -> Void

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: self.systemImage)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(self.tint)
                .padding(.top, 1)

            VStack(alignment: .leading, spacing: 3) {
                Text(self.title)
                    .font(.caption.weight(.semibold))

                Text(self.message)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }

            Spacer(minLength: 0)

            Button(action: self.refresh) {
                Image(systemName: "arrow.clockwise")
            }
            .buttonStyle(.bordered)
            .controlSize(.small)
            .help("Refresh")

            Button(action: self.dismiss) {
                Image(systemName: "xmark")
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .help("Dismiss")
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 10)
        .background(
            RoundedRectangle(cornerRadius: 14, style: .continuous)
                .fill(OpenClawChatTheme.subtleCard)
                .overlay(
                    RoundedRectangle(cornerRadius: 14, style: .continuous)
                        .strokeBorder(Color.white.opacity(0.12), lineWidth: 1)))
    }
}

private struct WorkspacePanel<Content: View>: View {
    let content: Content

    init(@ViewBuilder content: () -> Content) {
        self.content = content()
    }

    var body: some View {
        self.content
            .padding(18)
            .background(
                RoundedRectangle(cornerRadius: 22, style: .continuous)
                    .fill(OpenClawChatTheme.workspacePanel)
                    .overlay(
                        RoundedRectangle(cornerRadius: 22, style: .continuous)
                            .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
            .shadow(color: Color(red: 0.43, green: 0.57, blue: 0.72).opacity(0.12), radius: 26, y: 14)
            .shadow(color: .white.opacity(0.14), radius: 10, y: -3)
    }
}

private struct WorkspaceTag: View {
    let text: String
    let tint: Color

    var body: some View {
        Text(self.text)
            .font(.caption.weight(.semibold))
            .foregroundStyle(self.tint)
            .padding(.horizontal, 10)
            .padding(.vertical, 6)
            .background(
                Capsule(style: .continuous)
                    .fill(
                        LinearGradient(
                            colors: [
                                Color.white.opacity(0.64),
                                self.tint.opacity(0.14),
                            ],
                            startPoint: .topLeading,
                            endPoint: .bottomTrailing))
            )
            .overlay(
                Capsule(style: .continuous)
                    .strokeBorder(Color.white.opacity(0.50), lineWidth: 1)
            )
    }
}

private struct WorkspaceMetricTile: View {
    let title: String
    let value: String
    let detail: String

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            Text(self.title)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
            Text(self.value)
                .font(.system(size: 16, weight: .semibold, design: .rounded))
                .lineLimit(1)
            Text(self.detail)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(2)
        }
        .frame(maxWidth: .infinity, minHeight: 72, alignment: .topLeading)
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 16, style: .continuous)
                .fill(OpenClawChatTheme.workspaceSoftFill)
                .overlay(
                    RoundedRectangle(cornerRadius: 16, style: .continuous)
                        .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
        .shadow(color: Color(red: 0.43, green: 0.57, blue: 0.72).opacity(0.06), radius: 12, y: 8)
    }
}

private struct WorkspaceInlinePill: View {
    let systemImage: String
    let title: String
    let value: String

    var body: some View {
        HStack(spacing: 8) {
            Image(systemName: self.systemImage)
                .foregroundStyle(Color.accentColor)
            VStack(alignment: .leading, spacing: 1) {
                Text(self.title)
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.secondary)
                Text(self.value)
                    .font(.caption.weight(.semibold))
            }
        }
        .padding(.horizontal, 10)
        .padding(.vertical, 8)
        .background(
            Capsule(style: .continuous)
                .fill(OpenClawChatTheme.workspaceSoftFill)
                .overlay(
                    Capsule(style: .continuous)
                        .strokeBorder(OpenClawChatTheme.workspacePanelBorder, lineWidth: 1)))
    }
}

private struct WorkspaceKeyValueRow: View {
    let label: String
    let value: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Text(self.label)
                .font(.caption.weight(.semibold))
                .foregroundStyle(.secondary)
                .frame(width: 68, alignment: .leading)
            Text(self.value)
                .font(.subheadline)
                .multilineTextAlignment(.leading)
            Spacer(minLength: 0)
        }
    }
}

private struct WorkspaceChecklistRow: View {
    let text: String

    var body: some View {
        HStack(alignment: .top, spacing: 10) {
            Image(systemName: "checkmark.circle.fill")
                .foregroundStyle(Color.accentColor)
                .padding(.top, 1)
            Text(self.text)
                .font(.subheadline)
                .foregroundStyle(.primary)
                .fixedSize(horizontal: false, vertical: true)
        }
    }
}

private struct WorkspacePromptOption: Identifiable {
    let id = UUID()
    let title: String
    let subtitle: String
    let systemImage: String
    let prompt: String
}
