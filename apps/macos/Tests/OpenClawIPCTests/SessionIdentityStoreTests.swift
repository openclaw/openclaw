import Foundation
import Testing
@testable import OpenClaw

struct SessionIdentityStoreTests {
    @Test
    func resolvesMainAliasToPrimaryBotIdentity() throws {
        let snapshot = SessionIdentityStore.makeSnapshot(
            rows: [
                self.makeRow(
                    key: "agent:main:main",
                    displayName: "Main bot",
                    sessionId: "sess-main-1234"),
            ],
            mainSessionKey: "main")

        let identity = try #require(snapshot.resolve(sessionKey: "main"))
        #expect(identity.subjectID == "bot:main")
        #expect(identity.subjectRole == "primary-bot")
        #expect(identity.seatLabel == "Primary bot")
        #expect(identity.caseLabel == "Primary bot")
        #expect(identity.agentID == "main")
    }

    @Test
    func resolvesAgentScopedSessionToStableBotRecord() throws {
        let snapshot = SessionIdentityStore.makeSnapshot(
            rows: [
                self.makeRow(
                    key: "agent:watchdog:discord:channel:release-room",
                    displayName: "discord:#release-room",
                    sessionId: "sess-watchdog-5678"),
            ],
            mainSessionKey: "agent:main:main")

        let identity = try #require(snapshot.resolve(sessionKey: "agent:watchdog:discord:channel:release-room"))
        #expect(identity.subjectID == "bot:watchdog")
        #expect(identity.subjectRole == "bot")
        #expect(identity.seatLabel == "Bot: Watchdog")
        #expect(identity.caseLabel == "Watchdog")
        #expect(identity.contextLabel == "discord:#release-room")
        #expect(identity.agentID == "watchdog")
    }

    @Test
    func fallbackIdentityKeepsBotScopedSubjectWhenSessionListIsMissing() {
        let identity = SessionIdentityStore.fallbackIdentity(
            for: "agent:triage-bot:main",
            role: .other)

        #expect(identity.subjectID == "bot:triage-bot")
        #expect(identity.subjectRole == "bot")
        #expect(identity.seatLabel == "Bot: Triage Bot")
        #expect(identity.caseLabel == "Triage Bot")
    }

    private func makeRow(
        key: String,
        displayName: String?,
        sessionId: String?) -> SessionRow
    {
        SessionRow(
            id: key,
            key: key,
            kind: .direct,
            displayName: displayName,
            provider: "discord",
            subject: nil,
            room: nil,
            space: nil,
            updatedAt: Date(),
            sessionId: sessionId,
            thinkingLevel: nil,
            verboseLevel: nil,
            systemSent: false,
            abortedLastRun: false,
            tokens: SessionTokenStats(input: 0, output: 0, total: 0, contextTokens: 200_000),
            model: "gpt-5.1")
    }
}
