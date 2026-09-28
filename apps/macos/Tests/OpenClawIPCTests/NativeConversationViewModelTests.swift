import AppKit
import Foundation
import OpenClawKit
import SwiftUI
import Testing
@testable import OpenClawChatUI

@Suite(.serialized)
@MainActor
struct NativeConversationViewModelTests {
    @Test func `probing and web modes keep roster but never use native conversation owners`() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        for mode in [OpenClawWebConversation.Mode.probing, .web] {
            fixture.model.setWebConversationMode(mode)
            fixture.model.load()
            await fixture.model.bootstrapTask?.value
            fixture.model.handleTransportEvent(.routeChanged)
            await fixture.model.bootstrapTask?.value
            fixture.model.handleTransportEvent(.sessionsChanged(.init(
                sessionKey: Fixture.session, agentId: "main", phase: "message")))
            fixture.model.input = "native draft must not dispatch"
            #expect(!fixture.model.canSend)
            fixture.model.send()
            #expect(!fixture.model.isSubmittingDraft)
        }
        #expect(await fixture.transport.rosterCount > 0)
        #expect(fixture.model.sessions.count == 1)
        #expect(await fixture.transport.historyCount == 0)
        #expect(await fixture.transport.subscriptionCount == 0)
        #expect(await fixture.transport.sendCount == 0)
        #expect(await fixture.transport.readAckCount == 0)
        #expect(fixture.model.messages.isEmpty)
    }

    @Test func `native navigation forwards once and web route changes update selection without echo`() throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        var destinations: [NativeConversationContext] = []
        var sources: [OpenClawWebConversation.NavigationSource] = []
        fixture.owner.navigate = { context, source in
            destinations.append(context)
            sources.append(source)
        }
        let sidebar = NativeConversationContext(agentId: "main", sessionKey: "agent:main:sidebar")
        fixture.model.switchSession(to: sidebar.sessionKey)
        #expect(destinations == [sidebar])
        #expect(sources == [.user])
        let fork = NativeConversationContext(agentId: "main", sessionKey: "agent:main:fork")
        fixture.model.acceptWebRoute(fork)
        #expect(fixture.model.sessionKey == fork.sessionKey)
        #expect(destinations == [sidebar])
        let state = try JSONDecoder().decode(NativeConversationState.self, from: Data("""
        {"revision":2,"context":{"agentId":"main","sessionKey":"agent:main:fork"},
         "title":"Fork title","run":{"active":true},"connection":"connected"}
        """.utf8))
        fixture.model.acceptWebConversation(state)
        #expect(fixture.owner.state == state)
        #expect(destinations == [sidebar])
        fixture.model.syncSession(to: "agent:main:synchronized")
        #expect(sources == [.user, .synchronization])
    }

    @Test func `unsupported conversation fallback restores native history subscription and read ownership`() async throws {
        let fixture = try Fixture()
        defer { fixture.close() }
        fixture.model.load()
        await fixture.model.bootstrapTask?.value
        #expect(await fixture.transport.historyCount == 0)
        fixture.model.setWebConversationMode(.native)
        await fixture.model.bootstrapTask?.value
        #expect(!fixture.model.usesWebConversation)
        #expect(await fixture.transport.historyCount == 1)
        #expect(await fixture.transport.subscriptionCount > 0)
        #expect(await fixture.transport.readAckCount == 1)
        fixture.model.input = "native draft"
        #expect(fixture.model.canSend)
    }

    /// Rendered only in the disposable macOS runner, never on the operator desktop.
    @Test func `web detail shares the titlebar and native fallback restores its toolbar`() async throws {
        try await AppKitTestSupport.startApplication()
        let fixture = try Fixture()
        defer { fixture.close() }
        let detail = NSView()
        detail.setAccessibilityElement(true)
        detail.setAccessibilityRole(.group)
        detail.setAccessibilityIdentifier("conversation-detail-fixture")
        let hosting = NSHostingController(rootView: OpenClawChatWindowShell(
            viewModel: fixture.model,
            detailHost: AnyView(ConversationDetailFixture(view: detail)))
            .defaultAppStorage(fixture.defaults))
        let window = NSWindow(
            contentRect: NSRect(x: 0, y: 0, width: 1000, height: 700),
            styleMask: [.titled, .closable, .resizable, .fullSizeContentView],
            backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.toolbar = NSToolbar(identifier: "ConversationTitlebarFixture")
        window.toolbarStyle = .unified
        window.titlebarSeparatorStyle = .none
        window.contentViewController = hosting
        hosting.sceneBridgingOptions = [.toolbars]
        window.makeKeyAndOrderFront(nil)
        defer { window.close() }

        for mode in [OpenClawWebConversation.Mode.native, .web, .native] {
            fixture.model.setWebConversationMode(mode)
            _ = try await AppKitTestSupport.waitForAccessibilityElement(
                in: window, description: "the \(mode) conversation layout")
            { elements in
                let identity = elements.first { $0.accessibilityIdentifier?() == "chat-conversation-identity" }
                guard mode == .web else {
                    let menu = elements.first {
                        let role = $0.accessibilityRole?()
                        let names = [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)]
                        return (role == .button || role == .popUpButton || role == .menuButton) &&
                            (names.contains("Thread") || names.contains("More"))
                    }
                    return menu == nil ? nil : identity
                }
                guard identity == nil, detail.window === window,
                      detail.bounds.width > 0, detail.bounds.height > 0 else { return nil }
                return elements.first { $0.accessibilityIdentifier?() == "conversation-detail-fixture" }
            }
            let elements = try await AppKitTestSupport.accessibilityElements(in: window)
            let toolbar = try #require(elements.first { $0.accessibilityRole?() == .toolbar })
            let controls = try await AppKitTestSupport.accessibilityElements(in: toolbar)
            let names = controls.flatMap {
                [$0.accessibilityLabel?(), AppKitTestSupport.accessibilityTitle(of: $0)].compactMap(\.self)
            }
            if mode == .web {
                #expect(!names.contains("New Thread"))
                #expect(!names.contains("Thread"))
                #expect(!names.contains("More"))
                let content = try #require(window.contentView)
                #expect(abs(detail.convert(detail.bounds, to: nil).maxY -
                        content.convert(content.bounds, to: nil).maxY) < 1)
            } else {
                #expect(names.contains("Thread") || names.contains("More"))
            }
        }
    }

    @MainActor
    private final class Fixture {
        static let session = "agent:main:thread"
        let suiteName = "NativeConversationViewModelTests.\(UUID().uuidString)"
        let defaults: UserDefaults
        let owner = OpenClawWebConversation()
        let transport = NativeConversationTestTransport()
        let model: OpenClawChatViewModel

        init() throws {
            self.defaults = try #require(UserDefaults(suiteName: self.suiteName))
            self.model = OpenClawChatViewModel(
                sessionKey: Self.session, transport: self.transport, webConversation: self.owner,
                activeAgentId: "main", modelPickerStore: ChatModelPickerStore(defaults: self.defaults))
        }

        func close() {
            self.owner.navigate = nil
            self.model.detachTransport()
            self.defaults.removePersistentDomain(forName: self.suiteName)
        }
    }
}

private actor NativeConversationTestTransport: OpenClawChatTransport {
    private(set) var historyCount = 0
    private(set) var sendCount = 0
    private(set) var subscriptionCount = 0
    private(set) var rosterCount = 0
    private(set) var readAckCount = 0

    func requestHistory(sessionKey: String) async throws -> OpenClawChatHistoryPayload {
        self.historyCount += 1
        return .init(sessionKey: sessionKey, sessionId: nil, messages: [], thinkingLevel: "off")
    }

    func sendMessage(
        sessionKey _: String, message _: String, thinking _: String, idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        self.sendCount += 1
        return .init(runId: "native-run", status: "ok")
    }

    func listSessions(
        limit _: Int?, search _: String?, archived _: Bool) async throws -> OpenClawChatSessionsListResponse
    {
        self.rosterCount += 1
        return try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: Data("""
        {"sessions":[{"key":"agent:main:thread","agentId":"main","unread":true,"updatedAt":1700000001000}]}
        """.utf8))
    }

    func patchSession(
        key _: String, expectedSessionID _: String?, label _: String??, category _: String??, color _: String??,
        pinned _: Bool?, archived _: Bool?, unread: Bool?) async throws
    {
        if unread == false { self.readAckCount += 1 }
    }

    func setActiveSessionKey(_: String) async throws {
        self.subscriptionCount += 1
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        true
    }

    nonisolated func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }
}

private struct ConversationDetailFixture: NSViewRepresentable {
    let view: NSView

    func makeNSView(context _: Context) -> NSView {
        self.view
    }

    func updateNSView(_: NSView, context _: Context) {}
}
