#if os(macOS)
import Foundation
import SwiftUI
import Testing
@testable import OpenClawChatUI

@MainActor
struct ChatSessionSidebarSelectionTests {
    @Test func `group siblings expose separate row tags that activate batch selection`() throws {
        let suite = "ChatSessionSidebarSelectionTests.\(UUID().uuidString)"
        let defaults = try #require(UserDefaults(suiteName: suite))
        let group = "Research \(UUID().uuidString)"
        let wire: [[String: Any]] = [
            [
                "key": "agent:selection:benchmarks", "agentId": "selection", "sessionId": "benchmarks",
                "label": "Benchmarks", "category": group,
                "childSessions": ["agent:selection:benchmark-child"],
            ],
            [
                "key": "agent:selection:roadmap", "agentId": "selection", "sessionId": "roadmap",
                "label": "Roadmap notes", "category": group,
            ],
            [
                "key": "agent:selection:benchmark-child", "agentId": "selection", "sessionId": "child",
                "label": "Benchmark details", "spawnedBy": "agent:selection:benchmarks",
            ],
        ]
        let rows = try JSONDecoder().decode(
            [OpenClawChatSessionEntry].self,
            from: JSONSerialization.data(withJSONObject: wire))
        let model = OpenClawChatViewModel(
            sessionKey: rows[0].key,
            transport: SidebarSelectionTransport(),
            activeAgentId: "selection",
            modelPickerStore: ChatModelPickerStore(defaults: defaults))
        defer {
            model.detachTransport()
            defaults.removePersistentDomain(forName: suite)
        }
        model.sessions = rows
        let sidebar = ChatSessionSidebar(
            viewModel: model,
            query: .constant(""),
            groups: .constant([.init(name: group, position: 0)]),
            previews: ChatSessionSidebarPreviews(),
            menuActions: ChatSessionSidebarActions())
        let now = Date(timeIntervalSince1970: 2_000_000_000)
        let section = try #require(sidebar.interactionSections(now: now).first { $0.id == "group:\(group)" })
        #expect(section.nodes.count == 2)
        #expect(section.nodes.first { $0.session.key == rows[0].key }?.children.map(\.id) == [rows[2].key])
        let content = sidebar.sessionSection(
            section,
            now: now,
            ownership: sidebar.ownership(for: rows),
            previewRequest: .init(viewModel: model, sessions: rows))
        var renderedTags: [[String?]] = []
        /// Resolve the real section's direct children without creating an AppKit host or rendering controls.
        /// An OutlineGroup around the entire section exposes one child, so a selection-helper test misses it.
        func capture(_ sections: SectionCollection) -> some View {
            renderedTags = sections.map { $0.content.map { $0.containerValues.tag(for: String.self) } }
            return Color.clear.frame(width: 1, height: 1)
        }
        let renderer = ImageRenderer(content: Group(sections: content) { capture($0) }.defaultAppStorage(defaults))
        _ = try #require(renderer.cgImage)
        #expect(renderedTags.count == 1)
        let tags = try #require(renderedTags.first)
        #expect(tags.count == 2)
        #expect(tags.allSatisfy { $0 != nil })
        let identities = Set(tags.compactMap(\.self))
        let expected = Set(rows.prefix(2).map(OpenClawChatSessionSidebarData.identity))
        #expect(identities == expected)

        sidebar.batchSelectionBinding.wrappedValue = identities
        #expect(sidebar.batch.selection.active)
        #expect(sidebar.batchSelectionBinding.wrappedValue == expected)
        #expect(Set(sidebar.selectedBatchRows.map(\.key)) == Set(rows.prefix(2).map(\.key)))
        #expect(model.sessionKey == rows[0].key)
    }
}

private struct SidebarSelectionTransport: OpenClawChatTransport {
    func requestHistory(sessionKey _: String) async throws -> OpenClawChatHistoryPayload {
        throw CancellationError()
    }

    func requestHealth(timeoutMs _: Int) async throws -> Bool {
        false
    }

    func events() -> AsyncStream<OpenClawChatTransportEvent> {
        AsyncStream { $0.finish() }
    }

    func sendMessage(
        sessionKey _: String,
        message _: String,
        thinking _: String,
        idempotencyKey _: String,
        attachments _: [OpenClawChatAttachmentPayload]) async throws -> OpenClawChatSendResponse
    {
        throw CancellationError()
    }
}
#endif
