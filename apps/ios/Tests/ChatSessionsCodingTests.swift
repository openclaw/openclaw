import Foundation
import OpenClawChatUI
import OpenClawKit
import Testing

struct ChatSessionsCodingTests {
    private struct ExecutorProbe: Decodable, Sendable {
        let decodedOnMainThread: Bool
        let mainActorRespondedDuringDecode: Bool

        init(from decoder: any Decoder) throws {
            _ = try decoder.singleValueContainer().decode(Int.self)
            self.decodedOnMainThread = Thread.isMainThread
            guard !self.decodedOnMainThread else {
                self.mainActorRespondedDuringDecode = false
                return
            }
            let responded = DispatchSemaphore(value: 0)
            Task { @MainActor in responded.signal() }
            // Bound failure without sleeping or polling. The decoder is still running
            // when MainActor acknowledges, so an inherited-actor task cannot pass.
            self.mainActorRespondedDuringDecode = responded.wait(timeout: .now() + 2) == .success
        }
    }

    @Test @MainActor func `RPC decoding leaves MainActor responsive during synchronous decode`() async throws {
        let probe = try await GatewayPayloadDecoding.decode(ExecutorProbe.self, from: Data("1".utf8))

        #expect(!probe.decodedOnMainThread)
        #expect(probe.mainActorRespondedDuringDecode)
    }

    @Test @MainActor func `cancelled RPC decoding does not detach from its caller`() async {
        let task = Task {
            withUnsafeCurrentTask { $0?.cancel() }
            return try await GatewayPayloadDecoding.decode(ExecutorProbe.self, from: Data("1".utf8))
        }
        await #expect(throws: CancellationError.self) { try await task.value }
    }

    @Test func `decodes gateway model selection target from session defaults`() throws {
        let data = Data(#"""
        {
            "defaults": {
                "modelProvider": "openai",
                "model": "gpt-5.6-luna",
                "contextTokens": 200000,
                "modelSelectionTarget": "agent"
            },
            "sessions": []
        }
        """#.utf8)

        let response = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)

        #expect(response.defaults?.modelSelectionTarget == "agent")
    }

    @Test func `older gateway session defaults remain decodable without a target`() throws {
        let data = Data(#"""
        {
            "defaults": {
                "model": "gpt-5.6-luna",
                "contextTokens": 200000
            },
            "sessions": []
        }
        """#.utf8)

        let response = try JSONDecoder().decode(OpenClawChatSessionsListResponse.self, from: data)

        #expect(response.defaults?.modelSelectionTarget == nil)
    }

    @Test func `decodes session organization and read state fields`() throws {
        let data = Data(#"""
        {
            "key":"agent:main:telegram:group:1",
            "label":"Release room",
            "autoLabel":"Device fallback",
            "category":"Operations",
            "pinned":true,
            "archived":false,
            "unread":true,
            "lastReadAt":1720000000000,
            "markedUnreadAt":1720000002500,
            "lastActivityAt":1720000005000
        }
        """#.utf8)

        let entry = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: data)

        #expect(entry.label == "Release room")
        #expect(entry.autoLabel == "Device fallback")
        #expect(entry.category == "Operations")
        #expect(entry.pinned == true)
        #expect(entry.archived == false)
        #expect(entry.unread == true)
        #expect(entry.lastReadAt == 1_720_000_000_000)
        #expect(entry.markedUnreadAt == 1_720_000_002_500)
        #expect(entry.lastActivityAt == 1_720_000_005_000)
    }
}
