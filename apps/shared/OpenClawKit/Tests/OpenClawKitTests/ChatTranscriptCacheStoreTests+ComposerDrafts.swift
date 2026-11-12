import Foundation
import GRDB
import Testing
@testable import OpenClawChatUI

private func draftAttachment(_ name: String, bytes: Int) -> OpenClawChatOutboxAttachment {
    OpenClawChatOutboxAttachment(
        type: "file",
        mimeType: "application/octet-stream",
        fileName: name,
        data: Data(repeating: 7, count: bytes))
}

private func storedDraftAttachmentCount(_ databases: OpenClawClientDatabases, gatewayID: String) async throws -> Int {
    try await databases.stateQueue.read { db in
        try Int.fetchOne(
            db,
            sql: "SELECT COUNT(*) FROM composer_draft_attachments WHERE gateway_id = ?",
            arguments: [gatewayID]) ?? 0
    }
}

extension ChatTranscriptCacheStoreTests {
    @Test func `forget and an older builds forget trigger erase only that gateways drafts`() async throws {
        let stores = ["gw-a", "gw-b", "gw-c"].map { databases.store(gatewayID: $0) }
        for store in stores {
            await store.saveComposerDraftText(key: "agent:main:main", text: "draft \(store.gatewayID)", revision: 1)
            #expect(await store.insertComposerDraftAttachment(
                key: "agent:main:main",
                attachment: draftAttachment("photo.jpg", bytes: 3),
                revision: 1) == .inserted(position: 0))
        }

        try databases.removeGatewayData(gatewayID: "gw-a")
        // An older build's commit marks the irreversible phase without knowing the draft tables.
        try databases.stageGatewayRemoval(gatewayID: "gw-c")
        try await databases.stateQueue.write { db in
            try db.execute(
                sql: "UPDATE forgotten_gateways SET cleanup_phase = 2 WHERE gateway_id = ?",
                arguments: ["gw-c"])
        }
        // A facade retired by Forget cannot recreate the row with a late save.
        await stores[0].retire()
        await stores[0].saveComposerDraftText(key: "agent:main:main", text: "late", revision: 2)

        #expect(await databases.store(gatewayID: "gw-a").loadComposerDraft(key: "agent:main:main") == .empty)
        #expect(await stores[2].loadComposerDraft(key: "agent:main:main") == .empty)
        #expect(try await storedDraftAttachmentCount(databases, gatewayID: "gw-a") == 0)
        #expect(try await storedDraftAttachmentCount(databases, gatewayID: "gw-c") == 0)
        let kept = try #require(await stores[1].loadComposerDraft(key: "agent:main:main"))
        #expect(kept.text == "draft gw-b" && kept.attachments.map(\.attachment.fileName) == ["photo.jpg"])
    }

    @Test func `draft budget evicts only the oldest other drafts attachments`() async throws {
        let megabyte = 1_000_000
        for (key, megabytes) in [("agent:main:a", 20), ("agent:main:b", 20), ("agent:main:edited", 9)] {
            await store.saveComposerDraftText(key: key, text: "text \(key)", revision: 1)
            #expect(await store.insertComposerDraftAttachment(
                key: key,
                attachment: draftAttachment(key, bytes: megabytes * megabyte),
                revision: 1) == .inserted(position: 0))
        }

        #expect(await store.insertComposerDraftAttachment(
            key: "agent:main:edited",
            attachment: draftAttachment("second", bytes: 9 * megabyte),
            revision: 1) == .inserted(position: 1))
        // The edited draft alone may not pass what one queued command can carry.
        #expect(await store.insertComposerDraftAttachment(
            key: "agent:main:edited",
            attachment: draftAttachment("too much", bytes: 23 * megabyte),
            revision: 1) == .draftFull)

        let oldest = try #require(await store.loadComposerDraft(key: "agent:main:a"))
        let newer = try #require(await store.loadComposerDraft(key: "agent:main:b"))
        let edited = try #require(await store.loadComposerDraft(key: "agent:main:edited"))
        #expect(oldest.text == "text agent:main:a" && oldest.attachments.isEmpty)
        #expect(newer.text == "text agent:main:b" && newer.attachments.count == 1)
        #expect(edited.attachments.map(\.attachment.fileName) == ["agent:main:edited", "second"])
    }

    @Test func `an enqueue consumes only the revision and attachments it carried`() async throws {
        let key = "agent:main:main"
        await store.saveComposerDraftText(key: key, text: "newer typing", revision: 5)
        #expect(await store.insertComposerDraftAttachment(
            key: key, attachment: draftAttachment("sent.jpg", bytes: 4), revision: 5) == .inserted(position: 0))
        #expect(await store.insertComposerDraftAttachment(
            key: key, attachment: draftAttachment("kept.jpg", bytes: 4), revision: 5) == .inserted(position: 1))

        #expect(await store.enqueueCommand(
            outboxTestCommand(id: "older", text: "older typing", createdAt: 1),
            consumingComposerDraft: .init(draftKey: key, revision: 4, attachmentPositions: [0])))
        let afterOlderSend = try #require(await store.loadComposerDraft(key: key))
        #expect(afterOlderSend.text == "newer typing" && afterOlderSend.revision == 5)
        #expect(afterOlderSend.attachments.map(\.attachment.fileName) == ["kept.jpg"])

        #expect(await store.enqueueCommand(
            outboxTestCommand(id: "newer", text: "newer typing", createdAt: 2),
            consumingComposerDraft: .init(draftKey: key, revision: 5, attachmentPositions: [1])))
        #expect(await store.loadComposerDraft(key: key) == .empty)
        #expect(await store.loadCommands().map(\.id) == ["older", "newer"])
    }
}
