import OpenClawKit
import XCTest
@testable import OpenClaw
@testable import OpenClawChatUI

@MainActor
final class ChatReaderHistoryRetentionTests: XCTestCase {
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
