// Full-entry coverage for before_agent_reply hook handling before embedded attempts.
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { OpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { makeAttemptResult } from "./run.overflow-compaction.fixture.js";
import {
  mockedGlobalHookRunner,
  mockedRunEmbeddedAttempt,
  createOverflowRunParams,
  resetSharedRunIntegrationHarnessMocks,
} from "./run.overflow-compaction.harness.js";
import {
  createSharedRunIntegrationSession,
  loadSharedRunIntegrationHarness,
} from "./run.shared-integration-harness.test-support.js";

let state: OpenClawTestState;
let runEmbeddedAgent: Awaited<ReturnType<typeof loadSharedRunIntegrationHarness>>;

function firstBeforeAgentReplyCall() {
  // Helper keeps assertions on the hook payload and context close to the tests
  // without leaking mock tuple details into every case.
  const call = mockedGlobalHookRunner.runBeforeAgentReply.mock.calls[0];
  if (!call) {
    throw new Error("expected before_agent_reply hook call");
  }
  return call;
}

function firstAttemptParams(): {
  cleanupBundleMcpOnRunEnd?: boolean;
  disableTrajectory?: boolean;
  modelRun?: boolean;
  promptMode?: string;
} {
  const call = mockedRunEmbeddedAttempt.mock.calls[0] as
    | [
        {
          cleanupBundleMcpOnRunEnd?: boolean;
          disableTrajectory?: boolean;
          modelRun?: boolean;
          promptMode?: string;
        },
      ]
    | undefined;
  if (!call) {
    throw new Error("expected embedded attempt call");
  }
  return call[0];
}

describe("runEmbeddedAgent before_agent_reply seam", () => {
  beforeAll(async () => {
    runEmbeddedAgent = await loadSharedRunIntegrationHarness();
  });

  beforeEach(async () => {
    resetSharedRunIntegrationHarnessMocks();
    const { createOpenClawTestState } = await import("../../test-utils/openclaw-test-state.js");
    state = await createOpenClawTestState({ label: "run.before-agent-reply-cron" });
  });

  afterEach(async () => {
    await state?.cleanup();
  });

  it.each(
    [
      {
        name: "persistent user turn",
        sessionPersistence: undefined,
        currentInboundEventKind: undefined,
        persists: true,
      },
      {
        name: "detached user turn",
        sessionPersistence: "detached" as const,
        currentInboundEventKind: undefined,
        persists: false,
      },
      {
        name: "room event",
        sessionPersistence: undefined,
        currentInboundEventKind: "room_event" as const,
        persists: false,
      },
    ].flatMap((testCase) =>
      [
        { name: "text", reply: { text: "user turn claimed" }, expected: "user turn claimed" },
        {
          name: "media only",
          reply: { mediaUrl: "https://example.com/photo.png?token=redacted" },
          expected: "photo.png",
        },
        {
          name: "captioned media",
          reply: { text: "caption", mediaUrl: "https://example.com/photo.png" },
          expected: "caption\nphoto.png",
        },
        {
          name: "multiple media",
          reply: {
            text: "caption",
            mediaUrls: ["https://example.com/photo.png", "https://example.com/report.pdf"],
            mediaUrl: "https://example.com/ignored.png",
          },
          expected: "caption\nphoto.png, report.pdf",
        },
      ].map((mediaCase) =>
        Object.assign({}, testCase, mediaCase, {
          name: `${testCase.name} with ${mediaCase.name}`,
        }),
      ),
    ),
  )("preserves transcript persistence for a hook-claimed $name", async (testCase) => {
    const session = await createSharedRunIntegrationSession();
    const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
    const { getReplyPayloadMetadata, setReplyPayloadMetadata } =
      await import("../../auto-reply/reply-payload.js");
    const { createRegisteredBeforeAgentReplyFixture } =
      await import("../before-agent-reply.test-support.js");
    try {
      const { hookRunner, handler } = createRegisteredBeforeAgentReplyFixture(
        setReplyPayloadMetadata({ ...testCase.reply }, { blockSourceText: "plugin-owned source" }),
      );
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply" && hookRunner.hasHooks(hookName),
      );
      mockedGlobalHookRunner.runBeforeAgentReply.mockImplementation(hookRunner.runBeforeAgentReply);

      const result = await runEmbeddedAgent({
        ...session.runParams,
        trigger: "user",
        sessionPersistence: testCase.sessionPersistence,
        currentInboundEventKind: testCase.currentInboundEventKind,
      });

      expect(result.payloads?.[0]).toEqual(testCase.reply);
      expect(handler).toHaveBeenCalledOnce();
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      const transcript = await loadTranscriptEvents(session.runParams.sessionTarget);
      if (testCase.persists) {
        expect(
          transcript.filter(
            (event) =>
              isRecord(event) && isRecord(event.message) && event.message.role === "assistant",
          ),
        ).toEqual([
          expect.objectContaining({
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: testCase.expected }],
            }),
          }),
        ]);
        expect(getReplyPayloadMetadata(result.payloads?.[0] ?? {})).toMatchObject({
          assistantTranscriptOwned: true,
          assistantTranscriptIdempotencyKey: `before-agent-reply:${session.runParams.runId}`,
          blockSourceText: "plugin-owned source",
        });
      } else {
        expect(transcript).toEqual([]);
      }
    } finally {
      await session.cleanup();
    }
  });

  it("does not persist a hook reply after its session writer is replaced", async () => {
    const session = await createSharedRunIntegrationSession();
    const { loadTranscriptEvents } = await import("../../config/sessions/session-accessor.js");
    const { claimAgentSessionWriter } = await import("./run/session-bootstrap.js");
    try {
      mockedGlobalHookRunner.hasHooks.mockImplementation(
        (hookName: string) => hookName === "before_agent_reply",
      );
      mockedGlobalHookRunner.runBeforeAgentReply.mockImplementationOnce(async () => {
        await claimAgentSessionWriter({
          ...session.runParams,
          runId: "replacement-writer",
        });
        return { handled: true, reply: { text: "stale writer reply" } };
      });

      await runEmbeddedAgent({ ...session.runParams, trigger: "user" });

      expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
      expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
      expect(await loadTranscriptEvents(session.runParams.sessionTarget)).toEqual([]);
    } finally {
      await session.cleanup();
    }
  });

  it("lets before_agent_reply claim cron runs before the embedded attempt starts", async () => {
    // Cron hooks can fully handle maintenance prompts before the model is
    // invoked, which avoids unnecessary prompt-cache and setup work.
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue({
      handled: true,
      reply: { text: "dreaming claimed" },
    });
    const onExecutionPhase = vi.fn();

    const result = await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "cron",
      jobId: "cron-job-123",
      prompt: "__openclaw_memory_core_short_term_promotion_dream__",
      onExecutionPhase,
    });

    expect(mockedGlobalHookRunner.runBeforeAgentReply).toHaveBeenCalledTimes(1);
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    const [hookPayload, hookContext] = firstBeforeAgentReplyCall();
    expect(hookPayload).toEqual({
      cleanedBody: "__openclaw_memory_core_short_term_promotion_dream__",
    });
    expect(hookContext?.jobId).toBe("cron-job-123");
    expect(hookContext?.agentId).toBe("main");
    expect(hookContext?.sessionId).toBe("test-session");
    expect(hookContext?.sessionKey).toBe(createOverflowRunParams(state).sessionKey);
    expect(hookContext?.workspaceDir).toBe(state.workspaceDir);
    expect(hookContext?.trigger).toBe("cron");
    expect(hookContext?.senderId).toBeUndefined();
    expect(hookContext?.chatId).toBeUndefined();
    expect(hookContext?.channel).toBeUndefined();
    expect(mockedRunEmbeddedAttempt).not.toHaveBeenCalled();
    expect(result.payloads?.[0]?.text).toBe("dreaming claimed");
  });

  it("re-arms setup progress when a cron hook does not claim", async () => {
    mockedGlobalHookRunner.hasHooks.mockImplementation(
      (hookName: string) => hookName === "before_agent_reply",
    );
    mockedGlobalHookRunner.runBeforeAgentReply.mockResolvedValue(undefined);
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());
    const onExecutionPhase = vi.fn();

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "cron",
      onExecutionPhase,
    });

    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "before_agent_reply" }),
    );
    expect(onExecutionPhase).toHaveBeenCalledWith(
      expect.objectContaining({ phase: "runtime_plugins" }),
    );
    expect(mockedRunEmbeddedAttempt).toHaveBeenCalledTimes(1);
  });

  it("forwards one-shot auxiliary-run flags and tool bindings into the embedded attempt", async () => {
    // Auxiliary-run flags are request-scoped; they must pass through to the
    // first attempt without becoming persistent session settings.
    const toolBindings = {
      browser: { kind: "tab", tabId: 7, target: "host", profile: "chrome", targetId: "target-7" },
    };
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      trigger: "user",
      toolBindings,
      disableTrajectory: true,
      modelRun: true,
      promptMode: "none",
    });

    const attemptParams = firstAttemptParams();
    expect(attemptParams.disableTrajectory).toBe(true);
    expect(attemptParams.modelRun).toBe(true);
    expect(attemptParams.promptMode).toBe("none");
    expect(attemptParams).toMatchObject({ toolBindings });
  });

  it("forwards one-shot bundle MCP cleanup into the embedded attempt", async () => {
    mockedRunEmbeddedAttempt.mockResolvedValueOnce(makeAttemptResult());

    await runEmbeddedAgent({
      ...createOverflowRunParams(state),
      cleanupBundleMcpOnRunEnd: true,
    });

    expect(firstAttemptParams().cleanupBundleMcpOnRunEnd).toBe(true);
  });
});
