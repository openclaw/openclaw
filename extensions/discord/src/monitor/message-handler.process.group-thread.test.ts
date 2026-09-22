import { resolveGroupThreadMentionFacts } from "openclaw/plugin-sdk/channel-inbound";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import { setReplyPayloadMetadata } from "openclaw/plugin-sdk/reply-payload-testing";
import * as replyRuntime from "openclaw/plugin-sdk/reply-runtime";
import { describe, expect, it, vi } from "vitest";
import {
  BASE_CHANNEL_ROUTE,
  createAutomaticSourceDeliveryContext,
  createDiscordDraftStream,
  deliverDiscordReply,
  dispatchBufferedReplyForTest,
  registerDiscordProcessTestLifecycle,
  runProcessDiscordMessage,
} from "./message-handler.process.test-harness.js";

registerDiscordProcessTestLifecycle();

describe("Discord group-thread participant delivery", () => {
  it.each([
    { name: "ordinary route", agents: undefined },
    { name: "unlabeled participant", agents: ["alice"] },
    { name: "parallel participants", agents: ["alice", "bob"] },
    { name: "deferred warning", agents: ["alice"], warning: true },
  ])("binds delivery to the $name", async ({ agents, warning }) => {
    const cfg: OpenClawConfig = {
      agents: {
        ownership: "explicit",
        entries: {
          main: { workspace: "/tmp/.openclaw/workspace-main" },
          alice: { workspace: "/tmp/.openclaw/workspace-alice" },
          bob: { workspace: "/tmp/.openclaw/workspace-bob" },
        },
      },
      broadcast: agents ? { "discord:c1": agents } : undefined,
    };
    const ctx = await createAutomaticSourceDeliveryContext({
      cfg,
      route: BASE_CHANNEL_ROUTE,
      baseSessionKey: BASE_CHANNEL_ROUTE.sessionKey,
      discordConfig: { streaming: { mode: "partial" } },
      groupThread: resolveGroupThreadMentionFacts({
        cfg,
        channel: "discord",
        peerId: "c1",
        text: "Review this attachment.",
      }),
    });
    const actual = await vi.importActual<typeof replyRuntime>("openclaw/plugin-sdk/reply-runtime");
    const errors = vi.spyOn(ctx.runtime, "error");
    const participantRuns: string[] = [];
    dispatchBufferedReplyForTest.mockImplementationOnce((params) =>
      actual.dispatchReplyWithBufferedBlockDispatcher({
        ...params,
        dispatchReplyFromConfig: async ({ ctx: participant, dispatcher }) => {
          const agentId = participant.AgentId ?? "main";
          participantRuns.push(agentId);
          dispatcher.sendBlockReply({
            text: `Reasoning from ${agentId}`,
            isReasoning: true,
            mediaUrl: `/tmp/.openclaw/workspace-${agentId}/reasoning.txt`,
          });
          const queuedFinal = dispatcher.sendFinalReply(
            warning
              ? setReplyPayloadMetadata(
                  { text: "The attachment could not be processed.", isError: true },
                  { nonTerminalToolErrorWarning: true },
                )
              : {
                  text: `Answer from ${agentId}`,
                  mediaUrl: `/tmp/.openclaw/workspace-${agentId}/answer.txt`,
                },
          );
          return { queuedFinal, counts: dispatcher.getQueuedCounts() };
        },
      }),
    );
    await runProcessDiscordMessage(ctx);

    const responders = agents ?? ["main"];
    expect(errors.mock.calls).toEqual([]);
    expect(participantRuns).toEqual(responders);
    expect(deliverDiscordReply).toHaveBeenCalledTimes(responders.length * 2);
    for (const agentId of responders) {
      for (const kind of ["block", "final"]) {
        expect(deliverDiscordReply).toHaveBeenCalledWith(
          expect.objectContaining({
            target: "channel:c1",
            accountId: "default",
            sessionKey: `agent:${agentId}:discord:channel:c1`,
            mediaLocalRoots: expect.arrayContaining([`/tmp/.openclaw/workspace-${agentId}`]),
            kind,
            replies: [
              expect.objectContaining(
                warning && kind === "final"
                  ? { text: "The attachment could not be processed." }
                  : {
                      mediaUrl: `/tmp/.openclaw/workspace-${agentId}/${kind === "block" ? "reasoning" : "answer"}.txt`,
                    },
              ),
            ],
          }),
        );
      }
    }
    if (agents) {
      expect(createDiscordDraftStream).not.toHaveBeenCalled();
    }
  });
});
