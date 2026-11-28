import OpenClawKit
import SwiftUI
import UIKit
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
final class ChatReaderHistoryRetentionTests: XCTestCase {
    func testHarnessContextLeavesVisibleRowsAndReadAnchorUnchanged() throws {
        let history = try JSONDecoder().decode([OpenClawChatMessage].self, from: Data(#"""
        [
          {"role":"user","content":"Keep the riverside path.","timestamp":1},
          {"role":"assistant","content":[{"type":"toolCall","id":"read-map","name":"read"}],
           "timestamp":2,"provider":"openai","model":"route-model","__openclaw":{"id":"map","runId":"route"}},
          {"role":"user","content":"Keep the riverside path.","timestamp":3,
           "provenance":{"kind":"internal_system","sourceTool":"cli_harness_context"}},
          {"role":"assistant","content":"The route is ready.","timestamp":4,"phase":"final_answer","provider":"openai","model":"route-model",
           "__openclaw":{"id":"answer","runId":"route"}},
          {"role":"user","content":"Map review finished.","timestamp":5,
           "provenance":{"kind":"internal_system","sourceTool":"claude_cli_task_notification"}}
        ]
        """#.utf8))
        let vm = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { vm.detachTransport() }
        vm.replaceMessages(Array(history.prefix(2)))
        let initial = ChatTranscriptRow.build(from: vm.transcriptMessages)
        vm.handleTransportEvent(.sessionMessage(.init(
            sessionKey: "main", message: history[2], messageId: "summary", messageSeq: 3)))
        XCTAssertEqual(vm.transcriptMessages.count, 3, "The live event must reach the transcript owner")
        XCTAssertEqual(ChatTranscriptRow.build(from: vm.transcriptMessages), initial)

        let expected = ChatTranscriptRow.build(from: [history[0], history[1], history[3], history[4]])
        let actual = ChatTranscriptRow.build(from: history)
        XCTAssertEqual(actual.map(\.timestamp), [1, 2, 4, 5])
        XCTAssertEqual(actual, expected)
        guard case let .systemNotice(background) = actual.last else { return XCTFail("Missing background notice") }
        XCTAssertEqual(background.label, "System · background task")
        XCTAssertTrue(background.collapsesBody)
        let grouped = ChatTranscriptRow.collapseCompletedWork(expected, runWorking: false)
        guard case let .completedWork(work) = grouped[1] else { return XCTFail("Expected the map lookup to fold") }
        XCTAssertEqual(work.messages.map(\.timestamp), [2])
        XCTAssertEqual(ChatTranscriptRow.collapseCompletedWork(actual, runWorking: false), grouped)
    }

    func testLiveHarnessContextPreservesLoadedTranscriptViewport() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appleReviewDemo)
        for index in 0..<15 {
            _ = try await transport.sendMessage(
                sessionKey: "main", message: "Map step \(index)", thinking: "auto",
                idempotencyKey: "route-\(index)", attachments: [])
        }
        let model = OpenClawChatViewModel(sessionKey: "main", transport: transport)
        let host = UIHostingController(rootView: OpenClawChatView(viewModel: model, showsComposer: false))
        let window = UIWindow(frame: CGRect(x: 0, y: 0, width: 390, height: 680))
        window.rootViewController = host
        window.makeKeyAndVisible()
        defer {
            window.isHidden = true
            model.detachTransport()
        }
        func list(in view: UIView) -> UICollectionView? {
            if let collection = view as? UICollectionView { return collection }
            return view.subviews.lazy.compactMap { list(in: $0) }.first
        }
        func settle() async throws {
            for _ in 0..<5 {
                host.view.layoutIfNeeded()
                try await Task.sleep(for: .milliseconds(20))
            }
        }
        for _ in 0..<30 where model.isLoading || model.messages.count < 30 {
            try await settle()
        }
        XCTAssertGreaterThanOrEqual(model.messages.count, 30)
        try await settle()
        let collection = try XCTUnwrap(list(in: host.view))
        let offset = collection.contentOffset.y
        let height = collection.contentSize.height
        let visible = collection.indexPathsForVisibleItems.sorted()
        XCTAssertGreaterThan(offset, 0, "The long history must load at its latest end")
        XCTAssertFalse(visible.isEmpty)
        let summary = OpenClawChatMessage(
            role: "user", content: [.init(type: "text", text: "Synthetic continuation")],
            timestamp: Date().timeIntervalSince1970 * 1000,
            provenance: .init(kind: "internal_system", sourceTool: "cli_harness_context"))
        let count = model.messages.count
        model.handleTransportEvent(.sessionMessage(.init(
            sessionKey: "main", message: summary, messageId: "compact", messageSeq: nil)))
        XCTAssertEqual(model.messages.count, count + 1)
        try await settle()
        XCTAssertEqual(collection.contentOffset.y, offset, accuracy: 1)
        XCTAssertEqual(collection.contentSize.height, height, accuracy: 1)
        XCTAssertEqual(collection.indexPathsForVisibleItems.sorted(), visible)
    }

    func testCanceledPrefixStaysAbsentAndGenuineTrimIsRetained() {
        let vm = OpenClawChatViewModel(
            sessionKey: "main",
            transport: IOSGatewayChatTransport(gateway: GatewayNodeSession()))
        defer { vm.detachTransport() }
        let a = OpenClawChatMessage(
            role: "user",
            content: [.init(type: "text", text: "Canceled queued input")],
            timestamp: 1)
        let b = OpenClawChatMessage(role: "user", content: [.init(type: "text", text: "Surviving input")], timestamp: 2)
        vm.replaceMessages([a, b])
        let snapshot = ChatReaderHistorySnapshot(
            messages: vm.transcriptMessages,
            deletionRevision: vm.readerHistoryDeletionRevision)
        vm.replaceMessages([b])
        XCTAssertEqual(
            snapshot.presentation(current: vm.transcriptMessages, deletionRevision: vm.readerHistoryDeletionRevision)
                .map(\.id),
            [a.id, b.id])
        vm.replaceMessages([a, b])
        vm.removeCanceledOutboxMessage(a.id)
        XCTAssertEqual(
            snapshot.presentation(current: vm.transcriptMessages, deletionRevision: vm.readerHistoryDeletionRevision)
                .map(\.id),
            [b.id])
    }
}
