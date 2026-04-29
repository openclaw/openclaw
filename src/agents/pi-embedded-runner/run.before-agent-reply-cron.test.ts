import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { ReplyPayload } from "../../auto-reply/reply-payload.js";
import { SILENT_REPLY_TOKEN } from "../../auto-reply/tokens.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  loadRunOverflowCompactionHarness,
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  overflowBaseRunParams,
  resetRunOverflowCompactionHarnessMocks,
} from "./run.overflow-compaction.harness.js";

let runEmbeddedPiAgent: typeof import("./run.js").runEmbeddedPiAgent;

describe("runEmbeddedPiAgent cron before_agent_reply seam", () => {
  beforeAll(async () => {
    ({ runEmbeddedPiAgent } = await loadRunOverflowCompactionHarness());
  });

  beforeEach(() => {
    resetRunOverflowCompactionHarnessMocks();
  });

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledWith(
      { cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__" },
      expect.objectContaining({
        jobId: "cron-job-123",
        agentId: "main",
        sessionId: "test-session",
        sessionKey: "test-key",
        workspaceDir: "/tmp/workspace",
        trigger: "cron",
      }),
    );
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("returns a silent payload when a cron hook claims without a reply body", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
    });

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
    });

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe(SILENT_REPLY_TOKEN);
  });

  it("preserves rich before_agent_reply payload fields for cron runs", async () => {
    const richReply = {
      text: "dreaming claimed with rich payload",
      presentation: {
        title: "Memory promotion",
        tone: "info",
        blocks: [{ type: "text", text: "promoted" }],
      },
      delivery: { pin: { enabled: true, notify: false } },
      interactive: {
        blocks: [{ type: "buttons", buttons: [{ label: "Open", value: "open" }] }],
      },
      btw: { question: "Review the promotion?" },
      channelData: { telegram: { parseMode: "Markdown" } },
      trustedLocalMedia: true,
      sensitiveMedia: true,
      spokenText: "spoken archive copy",
      replyToCurrent: true,
      replyToTag: true,
    } satisfies ReplyPayload;

    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: richReply,
    });

    const result = await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "cron",
    });

    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]).toBe(richReply);
    expect(result.payloads?.[0]).toMatchObject({
      presentation: richReply.presentation,
      delivery: richReply.delivery,
      interactive: richReply.interactive,
      btw: richReply.btw,
      channelData: richReply.channelData,
      trustedLocalMedia: true,
      sensitiveMedia: true,
    });
  });

  it("does not invoke before_agent_reply for non-cron embedded runs", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "user",
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).not.toHaveBeenCalled();
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("forwards one-shot model-run flags into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult({ promptError: null }));

    await runEmbeddedPiAgent({
      ...overflowBaseRunParams,
      trigger: "user",
      modelRun: true,
      promptMode: "none",
    });

    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledWith(
      expect.objectContaining({
        modelRun: true,
        promptMode: "none",
      }),
    );
  });
});
