import SwiftUI
import Testing
@testable import OpenClawChatUI

@Suite("iOS completed chat bubble render gate")
@MainActor
struct ChatMessageBubbleEquatableTests {
    @Test func `identical render inputs compare equal`() {
        let message = Self.message(text: "A completed answer with **reasoning**.")

        #expect(Self.bubble(message: message) == Self.bubble(message: message))
    }

    @Test func `message and presentation changes invalidate the gate`() {
        let original = Self.message(text: "Original answer")
        let changed = Self.message(text: "Changed answer")
        let baseline = Self.bubble(message: original)

        #expect(baseline != Self.bubble(message: changed))
        #expect(baseline != Self.bubble(message: original, displayOptions: .assistantTrace))
        #expect(baseline != Self.bubble(message: original, contextWindowTokens: 200_000))
        #expect(baseline != Self.bubble(message: original, resolverReady: false))
    }

    @Test func `same answer still updates sources, metadata, and live tools`() throws {
        let message = Self.message(text: "Unchanged answer")
        let baseline = Self.bubble(message: message)
        let source = try ChatSourcePreview(
            url: #require(URL(string: "https://example.com")),
            title: "Example",
            domain: "example.com",
            excerpt: nil,
            excerptKind: nil)
        let tool = OpenClawChatPendingToolCall(
            toolCallId: "call-1", name: "web_fetch", args: nil, startedAt: 1, isError: nil)

        #expect(baseline != Self.bubble(message: message) { $0.sourcePreviews = [source] })
        #expect(baseline != Self.bubble(message: message) { $0.sourceContextRevision = UUID() })
        #expect(baseline != Self.bubble(message: message) { $0.sourceFaviconsEnabled = true })
        #expect(baseline != Self.bubble(message: message) {
            $0.metadata = ChatMessageMetadata(timestamp: 1, model: "model")
        })
        #expect(baseline != Self.bubble(message: message) { $0.liveToolCalls = [tool] })
    }

    @Test func `render gate is limited to assistant bubbles without dynamic content`() {
        let assistant = Self.message(text: "Stable answer")
        let user = OpenClawChatMessage(
            role: "user",
            content: assistant.content,
            timestamp: 1)
        let audio = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "audio",
                text: nil,
                mimeType: "audio/mpeg",
                fileName: "reply.mp3",
                content: nil)],
            timestamp: 1)

        #expect(Self.bubble(message: assistant).canUseIOSRenderGate)
        #expect(!Self.bubble(message: user).canUseIOSRenderGate)
        #expect(!Self.bubble(message: audio).canUseIOSRenderGate)
    }

    private static func message(text: String) -> OpenClawChatMessage {
        OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "text",
                text: text,
                mimeType: nil,
                fileName: nil,
                content: nil)],
            timestamp: 1)
    }

    private static let sourceContextRevision = UUID()

    private static func bubble(
        message: OpenClawChatMessage,
        displayOptions: OpenClawChatDisplayOptions = [],
        contextWindowTokens: Int? = nil,
        resolverReady: Bool = true,
        configure: (inout ChatMessageBubble) -> Void = { _ in }) -> ChatMessageBubble
    {
        var bubble = ChatMessageBubble(
            message: message,
            sourceContextRevision: Self.sourceContextRevision,
            style: .standard,
            markdownVariant: .standard,
            userAccent: nil,
            displayOptions: displayOptions,
            assistantName: "OpenClaw",
            assistantAvatarText: "OC",
            assistantAvatarTint: nil,
            showsAssistantAvatar: false,
            isClean: true,
            contextWindowTokens: contextWindowTokens,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetResolverReady: resolverReady,
            inlineWidgetResourceResolver: { _, _ in nil },
            mediaArtifactResolverReady: resolverReady,
            mediaPlaybackAllowed: { true },
            loadMediaArtifact: { _, _, _ in nil })
        configure(&bubble)
        return bubble
    }
}
