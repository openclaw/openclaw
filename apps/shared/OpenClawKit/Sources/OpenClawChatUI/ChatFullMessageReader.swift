import SwiftUI

struct ChatFullMessageReaderRequest: Identifiable, Sendable {
    let target: OpenClawChatSessionTarget
    let messageID: String
    private let transport: any OpenClawChatTransport

    @MainActor
    init(viewModel: OpenClawChatViewModel, messageID: String) {
        self.target = viewModel.currentSessionTarget
        self.messageID = messageID
        let transport = viewModel.transport
        self.transport = if viewModel.explicitSessionAgentID == nil, let agentID = self.target.agentID {
            transport.scoped(toAgentID: agentID) ?? transport
        } else {
            transport
        }
    }

    var id: String {
        "\(self.target.agentID ?? "")\u{0}\(self.target.sessionKey)\u{0}\(self.messageID)"
    }

    func load() async throws -> OpenClawChatMessage? {
        try await self.transport.requestFullMessage(sessionKey: self.target.sessionKey, messageID: self.messageID)
    }
}

@MainActor
struct ChatFullMessageReader: View {
    private enum Phase {
        case loading
        case loaded(String)
        case failed(String)
    }

    let request: ChatFullMessageReaderRequest
    let markdownVariant: ChatMarkdownVariant

    @Environment(\.dismiss) private var dismiss
    @State private var phase: Phase = .loading

    var body: some View {
        NavigationStack {
            Group {
                switch self.phase {
                case .loading:
                    VStack(spacing: 10) {
                        ProgressView()
                        Text("Loading full message…")
                            .font(OpenClawChatTypography.body)
                            .foregroundStyle(.secondary)
                    }
                case let .loaded(markdown):
                    ScrollView {
                        ChatMarkdownRenderer(
                            text: markdown,
                            context: .assistant,
                            variant: self.markdownVariant,
                            textColor: OpenClawChatTheme.assistantText)
                            .textSelection(.enabled)
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .padding(20)
                    }
                case let .failed(message):
                    ContentUnavailableView(
                        String(localized: "Full message unavailable"),
                        systemImage: "doc.text.magnifyingglass",
                        description: Text(message))
                }
            }
            .frame(maxWidth: .infinity, maxHeight: .infinity)
            .navigationTitle("Full Message")
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Close") { self.dismiss() }
                }
            }
        }
        #if os(macOS)
        .frame(minWidth: 560, minHeight: 420)
        #endif
        .task(id: self.request.id) {
            await self.loadMessage()
        }
    }

    private func loadMessage() async {
        self.phase = .loading
        do {
            guard let message = try await self.request.load() else {
                self.phase = .failed(String(localized: "The full message is no longer available."))
                return
            }
            let markdown = ChatMessageVisibleText.visibleText(in: message)
            guard !markdown.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
                self.phase = .failed(String(localized: "The full message has no readable text."))
                return
            }
            self.phase = .loaded(markdown)
        } catch is CancellationError {
            return
        } catch {
            self.phase = .failed(String(localized: "The full message could not be loaded."))
        }
    }
}
