import Observation
import SwiftUI
import Testing
import UIKit
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
    }

    @Test func `same answer still updates sources, metadata, and live tools`() throws {
        let message = Self.message(text: "Unchanged answer")
        let baseline = Self.bubble(message: message)
        let source = try Self.source()
        let tool = OpenClawChatPendingToolCall(
            toolCallId: "call-1", name: "web_fetch", args: nil, startedAt: 1, isError: nil)

        #expect(baseline != Self.bubble(message: message) { $0.sourcePreviews = [source] })
        #expect(baseline != Self.bubble(message: message) {
            $0.metadata = ChatMessageMetadata(timestamp: 1, model: "model")
        })
        #expect(baseline != Self.bubble(message: message) { $0.liveToolCalls = [tool] })
    }

    @Test func `Gateway state changes leave the row environment equal`() throws {
        // Rows take no Gateway state. ChatView hands leaves one value per owner, and the leaves read
        // health and the source context through it, so a health flip or a source refresh changes
        // neither a row's inputs nor the environment value the rows sit in.
        let gateway = GatewayStateFixture()
        let offline = gateway.resources
        gateway.ready = true
        gateway.faviconContext = try Self.faviconContext()

        #expect(offline == gateway.resources)
        #expect(offline.isResolverReady())
        #expect(offline.faviconContext() != nil)
        #expect(offline != GatewayStateFixture().resources)
    }

    @Test(.timeLimit(.minutes(1))) func `media rows start loading when the Gateway turns healthy`() async {
        let gateway = GatewayStateFixture()
        let artifactId = "artifact_managed_image_11111111-1111-4111-8111-111111111111"
        let message = OpenClawChatMessage(
            role: "assistant",
            content: [OpenClawChatMessageContent(
                type: "image",
                text: nil,
                mimeType: "image/png",
                fileName: nil,
                artifactId: artifactId,
                url: "/api/chat/media/outgoing/main/11111111-1111-4111-8111-111111111111/full",
                alt: "Managed preview",
                playback: nil,
                content: nil)],
            timestamp: 1)
        let window = Self.host(Self.bubble(message: message)
            .environment(\.openClawChatGateway, gateway.resources))
        defer { window.isHidden = true }

        // No new row: the attachment observes readiness itself.
        gateway.ready = true
        var loads = gateway.loads.stream.makeAsyncIterator()
        #expect(await loads.next() == "media \(artifactId)")
    }

    @Test(.timeLimit(.minutes(1))) func `a gated row's favicons load when the source context arrives`() async throws {
        let gateway = GatewayStateFixture()
        let source = try Self.source()
        let bubble = Self.bubble(message: Self.message(text: "Answer citing a source.")) {
            $0.sourcePreviews = [source]
        }
        #expect(bubble.canUseIOSRenderGate)
        let window = Self.host(bubble.equatable()
            .environment(\.openClawChatGateway, gateway.resources))
        defer { window.isHidden = true }

        // The gated row stays put; its favicon leaf observes the context itself.
        gateway.faviconContext = try Self.faviconContext()
        var loads = gateway.loads.stream.makeAsyncIterator()
        #expect(await loads.next() == "favicon example.com")
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

    private static func source() throws -> ChatSourcePreview {
        try ChatSourcePreview(
            url: #require(URL(string: "https://example.com")),
            title: "Example",
            domain: "example.com",
            excerpt: nil,
            excerptKind: nil)
    }

    private static func faviconContext() throws -> OpenClawChatSourceContext {
        try OpenClawChatSourceContext(
            gatewayURL: #require(URL(string: "https://gateway.example.com")),
            basePath: "",
            automaticallyFetchFavicons: true)
    }

    private static func host(_ view: some View) -> UIWindow {
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 393, height: 600))
        window.rootViewController = UIHostingController(rootView: view)
        window.makeKeyAndVisible()
        window.rootViewController?.view.layoutIfNeeded()
        return window
    }

    private static func bubble(
        message: OpenClawChatMessage,
        displayOptions: OpenClawChatDisplayOptions = [],
        contextWindowTokens: Int? = nil,
        configure: (inout ChatMessageBubble) -> Void = { _ in }) -> ChatMessageBubble
    {
        var bubble = ChatMessageBubble(
            message: message,
            style: .standard,
            markdownVariant: .standard,
            displayOptions: displayOptions,
            showsAssistantAvatar: false,
            contextWindowTokens: contextWindowTokens,
            userMessageExpanded: false,
            onToggleUserMessageExpanded: {},
            inlineWidgetScope: ChatInlineWidgetScope(
                modelID: ObjectIdentifier(Self.self),
                sessionTarget: OpenClawChatSessionTarget(sessionKey: "main", agentID: nil),
                sessionGeneration: 0),
            mediaPlaybackAllowed: { true })
        configure(&bubble)
        return bubble
    }
}

/// Stands in for the view model behind ChatView's Gateway resources: observable health and source
/// context, and loaders that report each request.
@MainActor
@Observable
private final class GatewayStateFixture {
    var ready = false
    var faviconContext: OpenClawChatSourceContext?
    let loads = AsyncStream<String>.makeStream()

    var resources: ChatGatewayResources {
        let loads = self.loads.continuation
        return ChatGatewayResources(
            owner: ObjectIdentifier(self),
            isResolverReady: { self.ready },
            faviconContext: { self.faviconContext },
            loadFavicon: { host in
                loads.yield("favicon \(host)")
                return nil
            },
            resolveWidgetResource: { _, _ in nil },
            loadMedia: { artifactId, _, _ in
                loads.yield("media \(artifactId)")
                return nil
            })
    }
}
