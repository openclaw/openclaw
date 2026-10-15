import { createDeferred } from "openclaw/plugin-sdk/extension-shared";
import { vi } from "vitest";
import { defineDiscordVoiceTests } from "./voice-test-harness.test-support.js";

const { sendMessageDiscord } = vi.hoisted(() => ({ sendMessageDiscord: vi.fn() }));
vi.mock("../send.outbound.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../send.outbound.js")>()),
  sendMessageDiscord,
}));

defineDiscordVoiceTests(
  ({
    expect,
    it,
    agentCommandMock,
    agentCommandArgsAt,
    beginSpeakerTurn,
    createJoinedAgentProxyFixture,
    lastRealtimeBridge,
    loggerWarnMock,
    realtimeSessionMock,
    resolveVoiceIngressWithParticipantsMock,
  }) => {
    it.each(["reply", "cancel", "permission", "shutdown", "revoked", "replacement"] as const)(
      "handles %s after a call closes without redirecting or duplicating the reply",
      async (outcome) => {
        const started = createDeferred<void>();
        const answer = createDeferred<{ payloads: Array<{ text: string }> }>();
        agentCommandMock.mockImplementationOnce(() => {
          started.resolve();
          return answer.promise;
        });
        sendMessageDiscord.mockReset();
        sendMessageDiscord.mockImplementation(async (_to, _text, options) => {
          options.assertPlatformSendAuthorized();
          if (outcome === "permission") {
            throw new Error("Missing Permissions: SendMessages");
          }
        });
        const { manager, entry, bridgeParams } = await createJoinedAgentProxyFixture({
          config: { voice: { agentSession: { mode: "target", target: "channel:2002" } } },
        });
        beginSpeakerTurn(entry).close();
        const source = lastRealtimeBridge();
        const consult = (callId: string) =>
          bridgeParams.onToolCall!(
            {
              name: "openclaw_agent_consult",
              callId,
              itemId: callId,
              args: { question: "Check the ticket." },
            },
            source.session,
          );
        const first = consult("first");
        const duplicate = consult("duplicate");
        try {
          await started.promise;
          const signal = agentCommandArgsAt(0).abortSignal;
          expect(signal).toBeInstanceOf(AbortSignal);
          await manager.leave({ guildId: "g1" });
          expect(signal).toHaveProperty("aborted", false);
          if (outcome === "shutdown") {
            await manager.destroy();
            expect(signal).toHaveProperty("aborted", true);
          } else if (outcome === "replacement") {
            await manager.join({ guildId: "g1", channelId: "1002" });
          } else if (outcome === "revoked") {
            resolveVoiceIngressWithParticipantsMock.mockResolvedValue(null);
          }
          if (outcome === "cancel") {
            answer.reject(new DOMException("Explicit user cancellation", "AbortError"));
          } else {
            answer.resolve({ payloads: [{ text: "The ticket is resolved." }] });
          }
          await Promise.all([first, duplicate]);
          expect(agentCommandMock).toHaveBeenCalledTimes(1);
          expect(realtimeSessionMock.submitToolResult).not.toHaveBeenCalled();
          if (outcome === "reply" || outcome === "permission") {
            expect(sendMessageDiscord).toHaveBeenCalledExactlyOnceWith(
              "channel:1001",
              "The ticket is resolved.",
              expect.objectContaining({ accountId: "default" }),
            );
          } else {
            expect(sendMessageDiscord).not.toHaveBeenCalled();
          }
          if (outcome === "permission") {
            expect(loggerWarnMock).toHaveBeenCalledWith(
              expect.stringContaining(
                "text fallback dropped guild=g1 channel=1001: Missing Permissions",
              ),
            );
          }
        } finally {
          answer.resolve({ payloads: [] });
          await Promise.allSettled([first, duplicate]);
          await manager.destroy();
        }
      },
    );
  },
);
