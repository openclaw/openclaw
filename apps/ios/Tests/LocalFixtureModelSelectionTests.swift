import OpenClawChatUI
import Testing
@testable import OpenClaw

struct LocalFixtureModelSelectionTests {
    @Test func `screenshot model changes preserve provider in patch and session readback`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appScreenshots)
        let changedResult = try await transport.patchSessionSettings(
            sessionKey: "main",
            agentID: "main",
            patch: OpenClawChatSessionSettingsPatch(model: .some("anthropic/claude-opus-4-1")))
        let changed = try #require(changedResult)
        #expect(changed.modelProvider == "anthropic")
        let sessions = try await transport.listSessions(limit: nil, search: nil, archived: false)
        #expect(sessions.sessions.first?.modelProvider == "anthropic")
        #expect(sessions.defaults?.modelProvider == "openai")

        let resetResult = try await transport.patchSessionSettings(
            sessionKey: "main",
            agentID: "main",
            patch: OpenClawChatSessionSettingsPatch(model: .some(nil)))
        let reset = try #require(resetResult)
        #expect(reset.modelProvider == "openai")
        #expect(reset.model == "gpt-5.6-sol")
        let restored = try await transport.listSessions(limit: nil, search: nil, archived: false)
        #expect(restored.sessions.first?.modelProvider == "openai")
    }

    @Test func `fixture effort overrides start inherited and can be cleared`() async throws {
        let transport = LocalFixtureChatTransport(fixture: .appScreenshots)
        let initial = try await transport.listSessions(limit: nil, search: nil, archived: false)
        #expect(initial.sessions.first?.thinkingLevel == nil)
        #expect(initial.defaults?.thinkingDefault == "auto")
        _ = try await transport.patchSessionSettings(
            sessionKey: "main",
            agentID: "main",
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some("high")))
        let changed = try await transport.listSessions(limit: nil, search: nil, archived: false)
        #expect(changed.sessions.first?.thinkingLevel == "high")
        _ = try await transport.patchSessionSettings(
            sessionKey: "main",
            agentID: "main",
            patch: OpenClawChatSessionSettingsPatch(thinkingLevel: .some(nil)))
        let cleared = try await transport.listSessions(limit: nil, search: nil, archived: false)
        #expect(cleared.sessions.first?.thinkingLevel == nil)
        #expect(cleared.defaults?.thinkingDefault == "auto")
    }
}
