import SwiftUI

@MainActor
public struct ClawdisChatView: View {
    @State private var viewModel: ClawdisChatViewModel
    @State private var scrollerBottomID = UUID()
    @State private var showSessions = false
    private let showsSessionSwitcher: Bool

    public init(viewModel: ClawdisChatViewModel, showsSessionSwitcher: Bool = false) {
        self._viewModel = State(initialValue: viewModel)
        self.showsSessionSwitcher = showsSessionSwitcher
    }

    public var body: some View {
        ZStack {
            ClawdisChatTheme.surface
                .ignoresSafeArea()

            VStack(spacing: 6) {
                self.messageList
                ClawdisChatComposer(viewModel: self.viewModel)
            }
            .padding(.horizontal, 6)
            .padding(.vertical, 6)
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
            ScrollView {
                LazyVStack(spacing: 12) {
                    ForEach(self.viewModel.messages) { msg in
                        ChatMessageBubble(message: msg)
                            .frame(
                                maxWidth: .infinity,
                                alignment: msg.role.lowercased() == "user" ? .trailing : .leading)
                    }

                    if self.viewModel.pendingRunCount > 0 {
                        ChatTypingIndicatorBubble()
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
                .padding(.top, 4)
                .padding(.bottom, 6)
                .padding(.horizontal, 8)
            }
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(ClawdisChatTheme.card)
                    .shadow(color: .black.opacity(0.05), radius: 12, y: 6))
            .onChange(of: self.viewModel.messages.count) { _, _ in
                withAnimation(.snappy(duration: 0.22)) {
                    proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                }
            }
            .onChange(of: self.viewModel.pendingRunCount) { _, _ in
                withAnimation(.snappy(duration: 0.22)) {
                    proxy.scrollTo(self.scrollerBottomID, anchor: .bottom)
                }
            }
        }
    }
}
