import SwiftUI

@MainActor
public struct ClawdisChatView: View {
    @State private var viewModel: ClawdisChatViewModel
    @State private var scrollerBottomID = UUID()
    @State private var showSessions = false

    public init(viewModel: ClawdisChatViewModel) {
        self._viewModel = State(initialValue: viewModel)
    }

    public var body: some View {
        ZStack {
            ClawdisChatTheme.surface
                .ignoresSafeArea()

            VStack(spacing: 10) {
                self.messageList
                ClawdisChatComposer(viewModel: self.viewModel)
            }
            .padding(.horizontal, 12)
            .padding(.vertical, 12)
            .frame(maxWidth: .infinity)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .top)
        .onAppear { self.viewModel.load() }
        .sheet(isPresented: self.$showSessions) {
            ChatSessionsSheet(viewModel: self.viewModel)
        }
    }

    private var messageList: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 14) {
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
                .padding(.top, 40)
                .padding(.bottom, 10)
                .padding(.horizontal, 12)
            }
            .background(
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .fill(ClawdisChatTheme.card)
                    .shadow(color: .black.opacity(0.05), radius: 12, y: 6))
            .overlay(alignment: .topLeading) {
                HStack(spacing: 8) {
                    Circle()
                        .fill(self.viewModel.healthOK ? .green : .orange)
                        .frame(width: 7, height: 7)
                    Text(self.viewModel.sessionKey)
                        .font(.caption.weight(.semibold))
                    Text(self.viewModel.healthOK ? "Connected" : "Connecting…")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 0)

                    Button {
                        self.showSessions = true
                    } label: {
                        Image(systemName: "tray.full")
                    }
                    .buttonStyle(.borderless)
                    .help("Sessions")

                    Button {
                        self.viewModel.refresh()
                    } label: {
                        Image(systemName: "arrow.clockwise")
                    }
                    .buttonStyle(.borderless)
                    .help("Refresh")
                }
                .padding(.horizontal, 10)
                .padding(.vertical, 6)
                .background(ClawdisChatTheme.subtleCard)
                .clipShape(Capsule())
                .padding(10)
            }
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
