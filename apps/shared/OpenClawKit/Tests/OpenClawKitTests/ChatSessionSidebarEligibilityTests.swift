#if os(macOS)
import Foundation
import Testing
@testable import OpenClawChatUI

struct ChatSessionSidebarEligibilityTests {
    @Test(arguments: [
        (#"{"key":"agent:ops:root"}"#, false, true),
        (#"{"key":"agent:ops:root"}"#, true, false),
        (#"{"key":"agent:ops:root","archived":true}"#, false, false),
        (#"{"key":"agent:ops:subagent:run"}"#, false, false),
        (#"{"key":"subagent:run"}"#, false, false),
        (#"{"key":"agent:ops:child","spawnedBy":"agent:ops:root"}"#, false, false),
        (#"{"key":"agent:ops:child","parentSessionKey":"agent:ops:root"}"#, false, false),
        (#"{"key":"agent:ops:dashboard:task","parentSessionKey":"agent:ops:main"}"#, false, true),
        (#"{"key":"agent:ops:dashboard:task","parentSessionKey":"agent:other:main"}"#, false, false),
        (#"{"key":"agent:ops:root","spawnedBy":" ","parentSessionKey":" "}"#, false, true),
    ])
    func `sidebar pin actions apply root eligibility to gateway rows`(
        wire: String,
        isChild: Bool,
        expected: Bool) throws
    {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(wire.utf8))
        #expect(ChatSessionSidebarEligibility.canPin(session, isChild: isChild) == expected)
    }

    @Test(arguments: [
        (#"{"key":"agent:ops:task","sessionId":"session-task","status":"running","hasActiveRun":true}"#, true),
        (#"{"key":"agent:ops:task","sessionId":"session-task","hasActiveSubagentRun":true}"#, true),
        (#"{"key":"agent:ops:restored","archived":true}"#, true),
        (#"{"key":"main","sessionId":"main-id"}"#, false),
        (#"{"key":" GLOBAL ","sessionId":"global-id"}"#, false),
        (#"{"key":"unknown","sessionId":"unknown-id"}"#, false),
        (#"{"key":"agent:other:main","sessionId":"other-id"}"#, false),
        (#"{"key":"custom","kind":"global","sessionId":"custom-id"}"#, false),
        (#"{"key":"custom","kind":"unknown","sessionId":"custom-id"}"#, false),
        (#"{"key":"agent:ops:global","sessionId":"ordinary-id"}"#, true),
        (#"{"key":"agent:ops:task"}"#, false),
        (#"{"key":"agent:ops:task","sessionId":" "}"#, false),
    ])
    func `sidebar archive allows gateway draining and restore while protecting canonical roots`(
        wire: String, expected: Bool) throws
    {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(wire.utf8))
        #expect(ChatSessionSidebarEligibility.canArchive(session, mainSessionKey: "agent:ops:main") == expected)
    }

    @Test func `sidebar archive protects the configured main name across agents`() throws {
        let session = try JSONDecoder().decode(OpenClawChatSessionEntry.self, from: Data(
            #"{"key":"agent:other:primary","sessionId":"session-main"}"#.utf8))
        #expect(!ChatSessionSidebarEligibility.canArchive(session, mainSessionKey: "agent:ops:primary"))
    }
}
#endif
