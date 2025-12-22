import SwiftUI

@MainActor
public struct ClawdisChatView: View {
    public enum Style {
        case standard
        case onboarding
    }

    @State private var viewModel: ClawdisChatViewModel
    @State private var scrollerBottomID = UUID()
    @State private var showSessions = false
    @State private var hasPerformedInitialScroll = false
    private let showsSessionSwitcher: Bool
    private let style: Style

    private enum Layout {
        #if os(macOS)
        static let outerPadding: CGFloat = 6
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 6
        static let messageListPaddingTop: CGFloat = 2
        static let messageListPaddingBottom: CGFloat = 4
        static let messageListPaddingHorizontal: CGFloat = 6
        #else
        static let outerPadding: CGFloat = 6
        static let stackSpacing: CGFloat = 6
        static let messageSpacing: CGFloat = 12
        static let messageListPaddingTop: CGFloat = 4
        static let messageListPaddingBottom: CGFloat = 6
        static let messageListPaddingHorizontal: CGFloat = 8
        #endif
    }

    public init(
        viewModel: ClawdisChatViewModel,
        showsSessionSwitcher: Bool = false,
        style: Style = .standard)
    {
        self._viewModel = State(initialValue: viewModel)
        self.showsSessionSwitcher = showsSessionSwitcher
        self.style = style
    }

    public var body: some View {
        ZStack {
            ClawdisChatTheme.background
                .ignoresSafeArea()

            VStack(spacing: Layout.stackSpacing) {
                self.messageList
                ClawdisChatComposer(viewModel: self.viewModel, style: self.style)
            }
            .padding(.horizontal, Layout.outerPadding)
            .padding(.vertical, Layout.outerPadding)
            .frame(maxWidth: .infinity)
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

    private var messageList: some View {
        ScrollViewReader { proxy in
            ZStack {
                ScrollView {
                    LazyVStack(spacing: Layout.messageSpacing) {
                        ForEach(self.visibleMessages) { msg in
                            ChatMessageBubble(message: msg, style: self.style)
                                .frame(
                                    maxWidth: .infinity,
                                    alignment: msg.role.lowercased() == "user" ? .trailing : .leading)
                        }

                        if self.viewModel.pendingRunCount > 0 {
                            ChatTypingIndicatorBubble(style: self.style)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        if !self.viewModel.pendingToolCalls.isEmpty {
                            ChatPendingToolsBubble(toolCalls: self.viewModel.pendingToolCalls)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        if let text = self.viewModel.streamingAssistantText, !text.isEmpty {
                            ChatStreamingAssistantBubble(text: text)
                                .frame(maxWidth: .infinity, alignment: .leading)
                        }

                        Color.clear
                            .frame(height: 1)
                            .id(self.scrollerBottomID)
                    }
                    .padding(.top, Layout.messageListPaddingTop)
                    .padding(.bottom, Layout.messageListPaddingBottom)
                    .padding(.horizontal, Layout.messageListPaddingHorizontal)
                }

                if self.viewModel.isLoading {
                    ProgressView()
                        .controlSize(.large)
                        .frame(maxWidth: .infinity, maxHeight: .infinity)
                }
            }
            .onChange(of: self.viewModel.isLoading) { _, isLoading in
                guard !isLoading, !self.hasPerformedInitialScroll else { return }
                proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                self.hasPerformedInitialScroll = true
            }
            .onChange(of: self.viewModel.messages.count) { _, _ in
                guard self.hasPerformedInitialScroll else { return }
                withAnimation(.snappy(duration: 0.22)) {
                    proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                }
            }
            .onChange(of: self.viewModel.pendingRunCount) { _, _ in
                guard self.hasPerformedInitialScroll else { return }
                withAnimation(.snappy(duration: 0.22)) {
                    proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                }
            }
        }
    }

    private var visibleMessages: [ClawdisChatMessage] {
        guard self.style == .onboarding else { return self.viewModel.messages }
        guard let first = self.viewModel.messages.first else { return [] }
        guard first.role.lowercased() == "user" else { return self.viewModel.messages }
        return Array(self.viewModel.messages.dropFirst())
    }
}
