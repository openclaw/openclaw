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
    private(set) var expectsSensitiveReply = false
    var input = ""
    /// Set when Crestodian hands off to the normal agent ("talk to agent").
    var onAgentHandoff: (() -> Void)?
    /// Called after every assistant reply (setup may have applied config).
    var onReplyReceived: (() -> Void)?

    private let sessionId: String
    /// "onboarding" seeds the first-run setup proposal; nil gets the
    /// status/repair greeting (used by Settings → Crestodian).
    private let welcomeVariant: String?
    private var started = false

    init(welcomeVariant: String? = "onboarding", sessionPrefix: String = "mac-onboarding") {
        self.welcomeVariant = welcomeVariant
        self.sessionId = "\(sessionPrefix)-\(UUID().uuidString)"
    }

    private struct ChatResult: Decodable {
        let sessionId: String
        let reply: String
        let action: String
        let sensitive: Bool?
    }

    func startIfNeeded() async {
        guard !self.started else { return }
        self.started = true
        await self.requestReply(message: nil)
    }

    func send() {
        let text = self.input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty, !self.isSending, self.errorMessage == nil else { return }
        self.input = ""
        self.messages.append(Message(
            role: .user,
            text: self.expectsSensitiveReply ? "<redacted secret>" : text))
        Task { await self.requestReply(message: text) }
    }

    func restartAfterError() {
        Task { await self.requestReply(message: nil, reset: true) }
    }

    private func requestReply(message: String?, reset: Bool = false) async {
        self.isSending = true
        self.errorMessage = nil
        defer { self.isSending = false }
        do {
            var params: [String: AnyCodable] = [
                "sessionId": AnyCodable(self.sessionId),
            ]
            if let welcomeVariant = self.welcomeVariant {
                params["welcomeVariant"] = AnyCodable(welcomeVariant)
            }
            if let message {
                params["message"] = AnyCodable(message)
            }
            if reset {
                params["reset"] = AnyCodable(true)
            }
            let data = try await GatewayConnection.shared.request(
                method: "crestodian.chat",
                params: params,
                timeoutMs: 190_000,
                retryTransportFailures: false)
            let result = try JSONDecoder().decode(ChatResult.self, from: data)
            if reset {
                self.messages.removeAll()
                self.input = ""
            }
            self.expectsSensitiveReply = result.sensitive == true
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
                    Button("Restart") {
                        self.model.restartAfterError()
                    }
                    .buttonStyle(.link)
                }
                .padding(.horizontal, 10)
            }

            HStack(spacing: 8) {
                Group {
                    if self.model.expectsSensitiveReply {
                        SecureField("Enter secret…", text: self.$model.input)
                    } else {
                        TextField(
                            "Reply to Crestodian… (yes sets everything up)",
                            text: self.$model.input)
                    }
                }
                .textFieldStyle(.roundedBorder)
                .onSubmit { self.model.send() }
                .disabled(self.model.errorMessage != nil)
                Button {
                    self.model.send()
                } label: {
                    Image(systemName: "arrow.up.circle.fill")
                        .font(.title2)
                }
                .buttonStyle(.plain)
                .disabled(self.model.isSending ||
                    self.model.errorMessage != nil ||
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
