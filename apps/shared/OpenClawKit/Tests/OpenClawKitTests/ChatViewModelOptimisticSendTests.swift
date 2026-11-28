import Foundation
import OpenClawKit
import Testing
@testable import OpenClawChatUI

@Suite(.timeLimit(.minutes(1)))
@MainActor
struct ChatViewModelOptimisticSendTests {
    private static func photo(id: UUID = UUID()) -> OpenClawPendingAttachment {
        OpenClawPendingAttachment(
            url: nil,
            data: Data([1, 2, 3]),
            fileName: "photo.jpg",
            mimeType: "image/jpeg",
            type: "image",
            preview: nil,
            id: id)
    }

    private static func userRows(_ vm: OpenClawChatViewModel) -> [OpenClawChatMessage] {
        vm.messages.filter { $0.role == "user" }
    }

    private static func waitForSentKeys(_ transport: OutboxTestTransport) async throws -> [String] {
        for _ in 0..<500 {
            let keys = await transport.state.sentIdempotencyKeys
            if !keys.isEmpty { return keys }
            try await Task.sleep(for: .milliseconds(10))
        }
        return []
    }

    private static func loadedViewModel(
        _ transport: OutboxTestTransport,
        outbox: any OpenClawChatCommandOutbox) async -> OpenClawChatViewModel
    {
        let vm = await makeOutboxViewModel(transport: transport, outbox: outbox)
        vm.load()
        await vm.bootstrapTask?.value
        await waitForObservedState { vm.hasRestoredOutboxMessages }
        return vm
    }

    @Test func `the message leaves the composer at the tap and keeps its row once queued`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = OutboxTestTransport(healthy: true)
        let vm = await Self.loadedViewModel(transport, outbox: store)
        vm.input = "look at this"
        vm.attachments = [Self.photo()]

        let send = try #require(vm.send())
        // Nothing has been checked, saved or sent yet.
        #expect(vm.input.isEmpty)
        #expect(vm.composerAttachments.isEmpty)
        #expect(!vm.hasDraftToSend)
        let row = try #require(Self.userRows(vm).last)
        #expect(row.content.compactMap(\.text).joined() == "look at this")
        #expect(row.content.contains { $0.fileName == "photo.jpg" && $0.content != nil })
        #if os(iOS)
        #expect(ChatUserSendPresentation(message: row, viewModel: vm)?.phase == .uploading)
        #endif

        await send.value
        #expect(Self.userRows(vm).map(\.id) == [row.id])
        #expect(vm.outboxState(for: row.id) != nil)
        #expect(vm.attachments.isEmpty)
        let keys = try await Self.waitForSentKeys(transport)
        #expect(keys.count == 1)
        #expect(row.idempotencyKey == keys.first.map { "\($0):user" })
        #expect(await transport.state.sentAttachmentFileNames == [["photo.jpg"]])
    }

    @Test func `a send the queue refuses goes back above what was typed since`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        for index in 0..<OpenClawChatSQLiteTranscriptCache.maxQueuedCommands {
            #expect(await store.enqueueCommand(outboxTestCommand(
                id: "prefill-\(index)",
                text: "m\(index)",
                createdAt: Date().timeIntervalSince1970,
                sessionKey: "other")))
        }
        let transport = OutboxTestTransport(healthy: false)
        let vm = await makeOutboxViewModel(transport: transport, outbox: store)
        vm.input = "does not fit"
        vm.attachments = [Self.photo()]

        let send = try #require(vm.send())
        #expect(Self.userRows(vm).count == 1)
        vm.input = "typed meanwhile"
        await send.value

        #expect(vm.errorText != nil)
        #expect(Self.userRows(vm).isEmpty)
        #expect(vm.input == "does not fit\n\ntyped meanwhile")
        #expect(vm.composerAttachments.map(\.fileName) == ["photo.jpg"])
        #expect(vm.canSend)
    }

    #if os(iOS)
    @Test func `send takes a tile still preparing and delivers it once staged`() async throws {
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let transport = OutboxTestTransport(healthy: true)
        let vm = await Self.loadedViewModel(transport, outbox: store)
        let sendGate = OutboxTestGate()
        await transport.state.update { $0.sendGate = sendGate }
        vm.input = "this one"
        let tile = try #require(vm.beginAttachmentPreparation(fileName: "photo.jpg", mimeType: "image/jpeg"))
        vm.beginAttachmentStaging()
        #expect(vm.canSend)

        let send = try #require(vm.send())
        #expect(vm.input.isEmpty)
        #expect(vm.composerPreparingAttachments.isEmpty)
        let row = try #require(Self.userRows(vm).last)
        #expect(row.content.contains { $0.fileName == "photo.jpg" && $0.content == nil })
        #expect(ChatUserSendPresentation(message: row, viewModel: vm)?.phase == .uploading)

        // Staging finishes: the attachment takes the tile's id, as stageAttachment does.
        vm.preparingAttachments.removeAll { $0.id == tile }
        vm.attachments.append(Self.photo(id: tile))
        vm.endAttachmentStaging()
        await send.value

        // Queued, and still the row shown at the tap, now with the photo's bytes.
        let queued = try #require(Self.userRows(vm).first)
        #expect(Self.userRows(vm).count == 1)
        #expect(queued.id == row.id)
        #expect(queued.content.contains { $0.fileName == "photo.jpg" && $0.content != nil })
        #expect(vm.outboxState(for: row.id) != nil)
        #expect(vm.attachments.isEmpty)
        await sendGate.release()
        #expect(try await Self.waitForSentKeys(transport).count == 1)
        #expect(await transport.state.sentAttachmentFileNames == [["photo.jpg"]])
    }

    @Test func `a tile that fails while the send waits gives the message back`() async throws {
        let transport = OutboxTestTransport(healthy: true)
        let (store, _, directory) = try makeOutboxStore()
        defer { try? FileManager.default.removeItem(at: directory) }
        let vm = await Self.loadedViewModel(transport, outbox: store)
        vm.input = "this one"
        let tile = try #require(vm.beginAttachmentPreparation(fileName: "photo.jpg", mimeType: "image/jpeg"))

        let send = try #require(vm.send())
        #expect(Self.userRows(vm).count == 1)
        vm.reportAttachmentFailure("Couldn’t attach photo.jpg.", preparation: tile)
        await send.value

        #expect(Self.userRows(vm).isEmpty)
        #expect(vm.input == "this one")
        #expect(vm.composerPreparingAttachments.map(\.failure) == ["Couldn’t attach photo.jpg."])
        #expect(!vm.canSend)
        #expect(await transport.state.sentIdempotencyKeys.isEmpty)
    }
    #endif
}
