import Foundation
import Observation
import OpenClawIPC
import SwiftUI

/// Onboarding talks to Crestodian over the gateway `crestodian.chat` RPC.
/// The conversation is the setup: no wizard steps, no forms. Crestodian works
/// before any model is configured, so this page functions on a fresh machine.
@MainActor
@Observable
final class CrestodianOnboardingChatModel {
    struct Message: Identifiable, Equatable {
        enum Role {
            case assistant
            case user
        }

        let id = UUID()
        let role: Role
        let text: String
    }

    private(set) var messages: [Message] = []
    private(set) var isSending = false
    private(set) var errorMessage: String?
    var input = ""
    /// Set when Crestodian hands off to the normal agent ("talk to agent").
    var onAgentHandoff: (() -> Void)?
    /// Called after every assistant reply (setup may have applied config).
    var onReplyReceived: (() -> Void)?

    private let sessionId = "mac-onboarding-\(UUID().uuidString)"
    private var started = false

    private struct ChatResult: Decodable {
        let sessionId: String
        let reply: String
        let action: String
    }

    func startIfNeeded() async {
        guard !self.started else { return }
        self.started = true
        await self.requestReply(message: nil)
    }

    func send() {
        let text = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !self.isSending else { return }
        self.input = ""
        self.messages.append(Message(role: .user, text: text))
        Task { await self.requestReply(message: text) }
    }

    func retryWelcome() {
        self.started = false
        Task { await self.startIfNeeded() }
    }

    private func requestReply(message: String?) async {
        self.isSending = true
        self.errorMessage = nil
        defer { self.isSending = false }
        do {
            var params: [String: AnyCodable] = [
                "sessionId": AnyCodable(self.sessionId),
                "welcomeVariant": AnyCodable("onboarding"),
            ]
            if let message {
                params["message"] = AnyCodable(message)
            }
            let data = try await GatewayConnection.shared.request(
                method: "crestodian.chat",
                params: params,
                timeoutMs: 120_000)
            let result = try JSONDecoder().decode(ChatResult.self, from: data)
            self.messages.append(Message(role: .assistant, text: result.reply))
            self.onReplyReceived?()
            if result.action == "open-agent" {
                self.onAgentHandoff?()
            }
        } catch {
            self.errorMessage = error.localizedDescription
        }
    }
}

struct CrestodianOnboardingChatView: View {
    @Bindable var model: CrestodianOnboardingChatModel

    var body: some View {
        VStack(spacing: 8) {
            ScrollViewReader { proxy in
                ScrollView {
                    LazyVStack(alignment: .leading, spacing: 10) {
                        ForEach(self.model.messages) { message in
                            CrestodianChatBubble(message: message)
                                .id(message.id)
                        }
                        if self.model.isSending {
                            HStack(spacing: 8) {
                                ProgressView()
                                    .controlSize(.small)
                                Text("Crestodian is working…")
                                    .font(.caption)
                                    .foregroundStyle(.secondary)
                            }
                            .padding(.leading, 4)
                        }
                    }
                    .padding(10)
                }
                .onChange(of: self.model.messages) { _, messages in
                    if let last = messages.last {
                        withAnimation { proxy.scrollTo(last.id, anchor: .bottom) }
                    }
                }
            }

            if let error = self.model.errorMessage {
                HStack(spacing: 8) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .foregroundStyle(.orange)
                    Text(error)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(2)
                    Spacer(minLength: 0)
                    Button("Retry") { self.model.retryWelcome() }
                        .buttonStyle(.link)
                }
                .padding(.horizontal, 10)
            }

            HStack(spacing: 8) {
                TextField("Reply to Crestodian… (yes sets everything up)", text: self.$model.input)
                    .textFieldStyle(.roundedBorder)
                    .onSubmit { self.model.send() }
                Button {
                    self.model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(self.model.isSending ||
                    self.model.input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
            }
            .padding([.horizontal, .bottom], 10)
        }
    }
}

private struct CrestodianChatBubble: View {
    let message: CrestodianOnboardingChatModel.Message

    var body: some View {
        HStack {
            if self.message.role == .user {
                Spacer(minLength: 40)
            }
            Text(self.attributedText)
                .font(.callout)
                .textSelection(.enabled)
                .padding(.horizontal, 10)
                .padding(.vertical, 7)
                .background(
                    RoundedRectangle(cornerRadius: 10, style: .continuous)
                        .fill(self.message.role == .user
                            ? Color.accentColor.opacity(0.22)
                            : Color(NSColor.controlBackgroundColor)))
            if self.message.role == .assistant {
                Spacer(minLength: 40)
            }
        }
    }

    private var attributedText: AttributedString {
        // Crestodian replies use light markdown (headings, bold, backticks).
        // Parse per line so multi-line replies keep their structure.
        var result = AttributedString()
        let lines = self.message.text.split(separator: "\n", omittingEmptySubsequences: false)
        for (index, line) in lines.enumerated() {
            var text = String(line)
            var isHeading = false
            if text.hasPrefix("## ") {
                text = String(text.dropFirst(3))
                isHeading = true
            }
            var piece = (try? AttributedString(markdown: text)) ?? AttributedString(text)
            if isHeading {
                piece.font = .headline
            }
            result.append(piece)
            if index < lines.count - 1 {
                result.append(AttributedString("\n"))
            }
        }
        return result
    }
}
