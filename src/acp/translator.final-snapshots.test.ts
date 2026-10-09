import { describe, expect, it, vi } from "vitest";
import type { EventFrame } from "../../packages/gateway-protocol/src/index.js";
import {
  createToolEvent,
  expectOversizedPromptRejected,
} from "./translator.bridge-test-helpers.js";
import {
  createChatEvent,
  createPendingPromptHarness,
  DEFAULT_SESSION_KEY,
} from "./translator.prompt-harness.test-support.js";

vi.mock("./commands.js", () => ({ getAvailableCommands: () => [] }));

describe("acp final chat snapshots", () => {
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

  it("streams commentary once before tools without consuming the final answer snapshot", async () => {
    const { agent, sessionUpdate, promptPromise, runId } = await createPendingPromptHarness();
    const commentary = (phase: "update" | "end", progressText: string): EventFrame =>
      ({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: DEFAULT_SESSION_KEY,
          runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-1",
            phase,
            progressText,
          },
        },
      }) as EventFrame;

    await agent.handleGatewayEvent(commentary("update", "Checking"));
    await agent.handleGatewayEvent(commentary("update", "Checking files"));
    await agent.handleGatewayEvent(commentary("end", "Checking files"));
    await agent.handleGatewayEvent(commentary("end", "Checking files"));
    await agent.handleGatewayEvent(
      createToolEvent({
        sessionKey: DEFAULT_SESSION_KEY,
        phase: "start",
        toolCallId: "tool-1",
        name: "read",
        args: { path: "notes.txt" },
      }),
    );
    await agent.handleGatewayEvent(
      createChatEvent({
        sessionKey: DEFAULT_SESSION_KEY,
        runId,
        state: "final",
        message: { content: [{ type: "text", text: "Done" }] },
      }),
    );
    await expect(promptPromise).resolves.toEqual({ stopReason: "end_turn" });

    expect(
      sessionUpdate.mock.calls.flatMap(([notification]) => {
        const update = notification.update;
        if (update.sessionUpdate === "agent_message_chunk") {
          return [[update.sessionUpdate, update.content.text]];
        }
        return update.sessionUpdate === "tool_call"
          ? [[update.sessionUpdate, update.toolCallId]]
          : [];
      }),
    ).toEqual([
      ["agent_message_chunk", "Checking"],
      ["agent_message_chunk", " files"],
      ["tool_call", "tool-1"],
      ["agent_message_chunk", "Done"],
    ]);
  });

  it("ignores commentary shrink snapshots and resumes from the last emitted snapshot", async () => {
    const { agent, sessionUpdate, runId } = await createPendingPromptHarness();
    const commentary = (progressText: string): EventFrame =>
      ({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: DEFAULT_SESSION_KEY,
          runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-shrink",
            phase: "update",
            progressText,
          },
        },
      }) as EventFrame;

    await agent.handleGatewayEvent(commentary("Checking files"));
    await agent.handleGatewayEvent(commentary("Checking"));
    await agent.handleGatewayEvent(commentary("Checking files now"));

    expect(
      sessionUpdate.mock.calls.flatMap(([notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk"
          ? [notification.update.content.text]
          : [],
      ),
    ).toEqual(["Checking files", " now"]);
  });

  it("ignores commentary replacement snapshots and resumes from the last emitted snapshot", async () => {
    const { agent, sessionUpdate, runId } = await createPendingPromptHarness();
    const commentary = (progressText: string): EventFrame =>
      ({
        type: "event",
        event: "agent",
        payload: {
          sessionKey: DEFAULT_SESSION_KEY,
          runId,
          stream: "item",
          data: {
            kind: "preamble",
            itemId: "commentary-replacement",
            phase: "update",
            progressText,
          },
        },
      }) as EventFrame;

    await agent.handleGatewayEvent(commentary("Checking files"));
    await agent.handleGatewayEvent(commentary("Reading files"));
    await agent.handleGatewayEvent(commentary("Checking files now"));

    expect(
      sessionUpdate.mock.calls.flatMap(([notification]) =>
        notification.update.sessionUpdate === "agent_message_chunk"
          ? [notification.update.content.text]
          : [],
      ),
    ).toEqual(["Checking files", " now"]);
  });
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
