import { describe, expect, it, vi } from "vitest";
import type { GatewayClient } from "../gateway/client.js";
import { expectOversizedPromptRejected } from "./translator.bridge-test-helpers.js";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
  createSessionAgentHarness,
  promptAgent,
} from "./translator.prompt-harness.test-support.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

describe("acp final chat snapshots", () => {
  it.each(["Hello", "A rewritten snapshot that is longer"])(
    "keeps the emitted answer baseline after %s",
    async (snapshot) => {
      const { agent, sessionUpdate, promptPromise, runId } = await createPendingPromptHarness();
      for (const [state, text] of [
        ["delta", "Hello wide"],
        ["delta", snapshot],
        ["final", "Hello wide world"],
      ]) {
        await agent.handleGatewayEvent(
          createChatEvent({
            sessionKey: DEFAULT_SESSION_KEY,
            runId,
            state,
            message: { content: [{ type: "text", text }] },
          }),
        );
      }
      await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        sessionUpdate.mock.calls.flatMap(([{ update }]) =>
          update.sessionUpdate === "agent_message_chunk" ? [update.content.text] : [],
        ),
      ).toEqual(["Hello wide", " world"]);
    },
  );

  it("streams append-only frames and emits only the final missing tail before settlement", async () => {
    const { agent, sessionUpdate, promptPromise, runId } = await createPendingPromptHarness();
    const send = (payload: Record<string, unknown>) =>
      agent.handleGatewayEvent(
        createChatEvent({ sessionKey: DEFAULT_SESSION_KEY, runId, ...payload }),
      );
    await send({ state: "delta", message: { content: [{ type: "text", text: "Hello" }] } });
    await send({ state: "delta", deltaText: " wide" });
    expect(sessionUpdate).toHaveBeenCalledWith({
      sessionId: "session-1",
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: " wide" } },
    });
    await send({
      state: "delta",
      message: { content: [{ type: "text", text: "Hello wide" }] },
    });
    await send({
      state: "final",
      stopReason: "max_tokens",
      message: { content: [{ type: "text", text: "Hello wide world" }] },
    });
    await expect(promptPromise).resolves.toEqual({ stopReason: "max_tokens" });
    expect(
      sessionUpdate.mock.calls.flatMap(([notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk"
          ? [notification.update.content]
          : [],
      ),
    ).toEqual([
      { type: "text", text: "Hello" },
      { type: "text", text: " wide" },
      { type: "text", text: " world" },
    ]);
  });

  it.each([
    { committed: "BRAVO", matchesRun: true, chunks: ["BRA", "VO"] },
    { committed: "rewritten", matchesRun: true, chunks: ["BRA"] },
    { committed: "BRAVO", matchesRun: false, chunks: ["BRA"] },
  ])(
    "recovers only the missing exact-run suffix from a message-less final: $committed/$matchesRun",
    async ({ committed, matchesRun, chunks }) => {
      let runId: string | undefined;
      const request = vi.fn(async (method: string, params?: Record<string, unknown>) => {
        if (method === "chat.send") {
          runId = params?.idempotencyKey as string | undefined;
          return new Promise<never>(() => {});
        }
        if (method === "chat.history" && params?.sessionKey === DEFAULT_SESSION_KEY) {
          return {
            sessionId: "committed-transcript",
            messages: [
              {
                role: "assistant",
                content: [{ type: "text", text: committed }],
                __openclaw: { runId: matchesRun ? runId : "other-run" },
              },
            ],
          };
        }
        return {};
      }) as GatewayClient["request"];
      const { agent, sessionId, sessionUpdate } = createSessionAgentHarness(request);
      const result = promptAgent(agent, sessionId);
      await vi.waitFor(() => expect(runId).toBeDefined());
      const send = (payload: Record<string, unknown>) =>
        agent.handleGatewayEvent(
          createChatEvent({ sessionKey: DEFAULT_SESSION_KEY, runId, ...payload }),
        );
      await send({ state: "delta", message: { content: [{ type: "text", text: "BRA" }] } });
      await send({ state: "delta", replace: true, deltaText: "", message: { content: [] } });
      await send({ state: "final" });
      await expect(result).resolves.toEqual({ stopReason: "end_turn" });
      expect(
        sessionUpdate.mock.calls.flatMap(([{ update }]) =>
          update.sessionUpdate === "agent_message_chunk" ? [update.content.text] : [],
        ),
      ).toEqual(chunks);
    },
  );
});

describe("acp prompt size hardening", () => {
  it("rejects oversized prompt blocks without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-oversize",
      text: "a".repeat(2 * 1024 * 1024 + 1),
    });
  });

  it("rejects oversize final messages from cwd prefix without leaking active runs", async () => {
    await expectOversizedPromptRejected({
      sessionId: "prompt-limit-prefix",
      text: "a".repeat(2 * 1024 * 1024),
    });
  });
});
