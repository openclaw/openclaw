import path from "node:path";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/hook-runtime";
import { createMockPluginRegistry } from "openclaw/plugin-sdk/plugin-test-runtime";
import { asOptionalRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { castAgentMessage, makeAgentAssistantMessage } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, describe, expect, it, vi } from "vitest";
import { codexTranscriptMirrorRuntime } from "./transcript-mirror.js";
import {
  createTranscriptMirrorTestHarness,
  readMirrorMessages,
  readMirrorRaw,
} from "./transcript-mirror.test-harness.js";

const deliverAsyncMessageBestEffort = codexTranscriptMirrorRuntime.deliverAsyncMessageBestEffort;
const publishSessionTranscriptUpdateByIdentityMock = vi.hoisted(() => vi.fn());

vi.mock("openclaw/plugin-sdk/session-transcript-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/session-transcript-runtime")>();
  return {
    ...actual,
    publishSessionTranscriptUpdateByIdentity: publishSessionTranscriptUpdateByIdentityMock,
  };
});

const { createSqliteMirrorTarget } = createTranscriptMirrorTestHarness();

afterEach(() => {
  resetGlobalHookRunner();
  publishSessionTranscriptUpdateByIdentityMock.mockReset();
});

describe("deliverAsyncMessageBestEffort", () => {
  it("delivers the persisted async rewrite once across reconnect replay", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-async-reconnect-");
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        {
          hookName: "before_message_write",
          handler: (event) => {
            const message = asOptionalRecord(asOptionalRecord(event)?.message);
            expect(message).toHaveProperty("openclawAsyncDelivery.questions");
            const firstBlock = asOptionalRecord(
              Array.isArray(message?.content) ? message.content[0] : undefined,
            );
            if (!firstBlock) {
              throw new Error("Expected the async question text block");
            }
            firstBlock.text = "[redacted async update]";
            return {
              message: castAgentMessage({
                ...message,
                phase: "final_answer",
              }),
            };
          },
        },
      ]),
    );
    const message = castAgentMessage({
      ...makeAgentAssistantMessage({
        content: [{ type: "text", text: "Sensitive background update." }],
        timestamp: Date.now(),
      }),
      phase: "final_answer",
      openclawAsyncDelivery: {
        itemId: "async-update",
        questions: [{ title: "Sensitive question?", options: ["Sensitive choice"] }],
      },
    });
    const onBlockReply = vi.fn();
    const runParams = {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      workspaceDir: path.dirname(target.storePath),
      runId: "run-async",
      onBlockReply,
    } as unknown as EmbeddedRunAttemptParams;
    const delivery = {
      cwd: path.dirname(target.storePath),
      params: runParams,
      itemId: "async-update",
      message,
      text: "Sensitive background update.",
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");
    await expect(
      deliverAsyncMessageBestEffort({
        ...delivery,
        params: { ...runParams, runId: "run-async-reconnect" },
      }),
    ).resolves.toBe("settled");

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply).toHaveBeenNthCalledWith(
      1,
      { text: "[redacted async update]" },
      {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-update",
      },
    );
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply.mock.calls.map(([payload]) => payload)).not.toContainEqual({
      text: "Sensitive background update.",
    });
    expect(await readMirrorMessages(target)).toEqual([
      { role: "assistant", text: "[redacted async update]" },
    ]);
    const updates = publishSessionTranscriptUpdateByIdentityMock.mock.calls.map(
      ([update]) => update as Record<string, unknown> & { update?: Record<string, unknown> },
    );
    expect(updates).toHaveLength(1);
    expect(updates[0]?.update?.message).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "[redacted async update]" }],
      phase: "final_answer",
      idempotencyKey: "codex-app-server:thread-1:turn-1:async:async-update",
      openclawAsyncDelivery: { itemId: "async-update" },
      __openclaw: { runId: "run-async" },
    });
    expect(updates[0]?.update?.message).not.toHaveProperty("openclawAsyncDelivery.questions");
    expect(updates[0]?.update?.message).not.toHaveProperty("__openclaw.runTerminal");
    const persisted = await readMirrorRaw(target);
    expect(persisted).toContain('"runId":"run-async"');
    expect(persisted).not.toContain('"runId":"run-async-reconnect"');
  });

  it("retries a durable async callback from the persisted row", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-async-callback-fail-");
    const onBlockReply = vi
      .fn()
      .mockRejectedValueOnce(new Error("channel unavailable"))
      .mockResolvedValue(undefined);
    const runParams = {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      workspaceDir: path.dirname(target.storePath),
      runId: "run-async-callback-fail",
      onBlockReply,
    } as unknown as EmbeddedRunAttemptParams;
    const delivery = {
      cwd: path.dirname(target.storePath),
      params: runParams,
      itemId: "async-callback-fail",
      message: castAgentMessage({
        ...makeAgentAssistantMessage({
          content: [{ type: "text", text: "Persisted background update." }],
          timestamp: Date.now(),
        }),
        openclawAsyncDelivery: { itemId: "async-callback-fail" },
      }),
      text: "Persisted background update.",
      threadId: "thread-1",
      turnId: "turn-1",
    };

    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("retry");
    await expect(deliverAsyncMessageBestEffort(delivery)).resolves.toBe("settled");

    expect(onBlockReply).toHaveBeenCalledTimes(2);
    expect(onBlockReply.mock.calls[1]).toEqual(onBlockReply.mock.calls[0]);
    expect(onBlockReply).toHaveBeenCalledWith(
      { text: "Persisted background update." },
      {
        deliveryIntentId: "block-reply:v1:codex-app-server:thread-1:turn-1:async-callback-fail",
      },
    );
    expect(await readMirrorMessages(target)).toEqual([
      { role: "assistant", text: "Persisted background update." },
    ]);
    expect(publishSessionTranscriptUpdateByIdentityMock).toHaveBeenCalledOnce();
  });

  it("does not deliver async messages blocked by before_message_write", async () => {
    const target = await createSqliteMirrorTarget("openclaw-codex-mirror-async-blocked-");
    initializeGlobalHookRunner(
      createMockPluginRegistry([
        { hookName: "before_message_write", handler: () => ({ block: true }) },
      ]),
    );
    const onBlockReply = vi.fn();
    const runParams = {
      agentId: target.agentId,
      sessionId: target.sessionId,
      sessionKey: target.sessionKey,
      sessionTarget: target,
      workspaceDir: path.dirname(target.storePath),
      runId: "run-async-blocked",
      onBlockReply,
    } as unknown as EmbeddedRunAttemptParams;

    await expect(
      deliverAsyncMessageBestEffort({
        cwd: path.dirname(target.storePath),
        params: runParams,
        itemId: "async-blocked",
        message: castAgentMessage({
          ...makeAgentAssistantMessage({
            content: [{ type: "text", text: "Blocked update." }],
            timestamp: Date.now(),
          }),
          openclawAsyncDelivery: { itemId: "async-blocked" },
        }),
        text: "Blocked update.",
        threadId: "thread-1",
        turnId: "turn-1",
      }),
    ).resolves.toBe("settled");

    expect(onBlockReply).not.toHaveBeenCalled();
    expect(await readMirrorMessages(target)).toEqual([]);
    expect(publishSessionTranscriptUpdateByIdentityMock).not.toHaveBeenCalled();
  });
});
